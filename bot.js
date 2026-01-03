require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { pool: db, initializeDatabase } = require('./database');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Helper function to safely execute database queries
async function safeQuery(query, params = []) {
  try {
    const result = await db.query(query, params);
    // Ensure result always has a rows array
    if (!result || typeof result !== 'object') {
      console.error('Database query returned invalid result:', result);
      return { rows: [] };
    }
    if (!Array.isArray(result.rows)) {
      console.error('Database query result.rows is not an array:', result);
      return { rows: [] };
    }
    return result;
  } catch (error) {
    console.error('Database query error:', error);
    return { rows: [] };
  }
}

// Helper function to parse duration string (e.g. 1d, 2h, 30m)
function parseDuration(durationStr) {
  if (!durationStr) return null;
  const match = durationStr.toLowerCase().match(/^(\d+)([dhms])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'm': return value * 60 * 1000;
    case 's': return value * 1000;
    default: return null;
  }
}

// Helper function to parse shorthand numbers (e.g. 1k, 1.5m)
function parseShorthand(str) {
  if (!str) return NaN;
  const match = str.toLowerCase().replace(/,/g, '').match(/^([\d.]+)([kmb])?$/);
  if (!match) return NaN;
  let val = parseFloat(match[1]);
  const multiplier = match[2];
  if (multiplier === 'k') val *= 1000;
  else if (multiplier === 'm') val *= 1000000;
  else if (multiplier === 'b') val *= 1000000000;
  return Math.floor(val);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const cachedInvites = new Map(); // code -> uses
const voiceTimes = new Map(); // userId -> startTime

// Configuration: Roles that cannot join giveaways (from .env)
const EXCLUDED_GIVEAWAY_ROLES = (process.env.EXCLUDED_GIVEAWAY_ROLES || 'bot,bots,muted,banned,restricted,excluded').split(',');

// Configuration: Default role to ping for giveaways (from .env)
const DEFAULT_GIVEAWAY_PING_ROLE = process.env.DEFAULT_GIVEAWAY_PING_ROLE;

// --- Logging Function ---
async function logActivity(title, message, color = 'Blue') {
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId) return; // Do nothing if the channel ID is not set

  try {
    const channel = await client.channels.fetch(logChannelId);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(message)
        .setColor(color)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('Failed to send log message:', error);
  }
}

// --- Google Sheets Reset Function ---
async function resetGoogleSheet() {
  const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.log('Google Sheets credentials not configured. Skipping sheet reset.');
    return { success: false, message: 'Google Sheets credentials not configured' };
  }

  try {
    const jwt = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, jwt);
    await doc.loadInfo();

    const sheetTitle = 'Purchases';
    let sheet = doc.sheetsByTitle[sheetTitle];

    if (!sheet) {
      console.log(`Sheet "${sheetTitle}" not found. No need to reset.`);
      return { success: true, message: 'Sheet does not exist, no reset needed' };
    }

    // Get all rows
    const rows = await sheet.getRows();
    const rowCount = rows.length;

    // Delete all rows
    for (const row of rows) {
      await row.delete();
    }

    // Ensure headers are set
    try {
      await sheet.loadHeaderRow();
      if (!sheet.headerValues || sheet.headerValues.length === 0) {
        await sheet.setHeaderRow(['Timestamp', 'User', 'Gold', 'Wood', 'Food', 'Stone', 'HP Cost']);
      }
    } catch (headerError) {
      // If loading header row fails, set headers
      await sheet.setHeaderRow(['Timestamp', 'User', 'Gold', 'Wood', 'Food', 'Stone', 'HP Cost']);
    }

    console.log(`✅ Reset Google Sheet "${sheetTitle}": Deleted ${rowCount} rows`);
    return { success: true, message: `Reset Google Sheet: Deleted ${rowCount} rows` };
  } catch (error) {
    console.error('Error resetting Google Sheet:', error);
    return { success: false, message: error.message };
  }
}

// --- Google Sheets Logging Function ---
async function logPurchaseToSheet(username, resource, resourceAmount, cost) {
  const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;

  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.log('Google Sheets credentials not configured. Skipping sheet log.');
    return;
  }

  try {
    const jwt = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, jwt);
    await doc.loadInfo();

    const sheetTitle = 'Purchases';
    let sheet = doc.sheetsByTitle[sheetTitle];

    if (!sheet) {
      console.log(`Sheet "${sheetTitle}" not found. Creating it now...`);
      sheet = await doc.addSheet({ title: sheetTitle, headerValues: ['Timestamp', 'User', 'Gold', 'Wood', 'Food', 'Stone', 'HP Cost'] });
    } else {
      // If sheet exists, ensure headers are loaded and correct
      try {
        await sheet.loadHeaderRow();
        // Check if headers are empty or incorrect
        if (!sheet.headerValues || sheet.headerValues.length === 0) {
          console.log(`Sheet "${sheetTitle}" has no headers. Setting headers now...`);
          await sheet.setHeaderRow(['Timestamp', 'User', 'Gold', 'Wood', 'Food', 'Stone', 'HP Cost']);
        }
      } catch (headerError) {
        // If loading header row fails (sheet is empty), set headers
        if (headerError.message.includes('No values in the header row') || headerError.message.includes('header')) {
          console.log(`Sheet "${sheetTitle}" has no headers. Setting headers now...`);
          await sheet.setHeaderRow(['Timestamp', 'User', 'Gold', 'Wood', 'Food', 'Stone', 'HP Cost']);
        } else {
          throw headerError; // Re-throw if it's a different error
        }
      }
    }

    // --- Find existing user row or add/update ---
    const rows = await sheet.getRows();
    let userRow = rows.find(r => r.get('User') === username && r.get('Timestamp') !== 'TOTALS');

    if (userRow) {
      // Update existing row by adding the new amounts
      const resourceColumnName = resource.charAt(0).toUpperCase() + resource.slice(1);
      const currentResourceAmount = parseFloat(userRow.get(resourceColumnName)) || 0;
      const currentCost = parseFloat(userRow.get('HP Cost')) || 0;

      userRow.set(resourceColumnName, currentResourceAmount + resourceAmount);
      userRow.set('HP Cost', currentCost + cost);
      await userRow.save();
    } else {
      // Add a new row for the user's first purchase
      const newRowData = {
        Timestamp: new Date().toLocaleString('en-US', { timeZone: 'UTC' }),
        User: username,
        Gold: resource === 'gold' ? resourceAmount : 0,
        Wood: resource === 'wood' ? resourceAmount : 0,
        Food: resource === 'food' ? resourceAmount : 0,
        Stone: resource === 'stone' ? resourceAmount : 0,
        'HP Cost': cost,
      };
      await sheet.addRow(newRowData);
    }

    // --- Update Totals Row ---
    const totalsRow = rows.find(r => r.get('Timestamp') === 'TOTALS');
    if (totalsRow) {
      await totalsRow.delete();
    }

    // Calculate totals from all purchase rows
    const totals = { Gold: 0, Wood: 0, Food: 0, Stone: 0, 'HP Cost': 0 };
    // We need to re-fetch the rows after potential deletion and addition
    const updatedRows = await sheet.getRows();
    updatedRows.forEach(row => {
      totals.Gold += parseFloat(row.get('Gold')) || 0;
      totals.Wood += parseFloat(row.get('Wood')) || 0;
      totals.Food += parseFloat(row.get('Food')) || 0;
      totals.Stone += parseFloat(row.get('Stone')) || 0;
      totals['HP Cost'] += parseFloat(row.get('HP Cost')) || 0;
    });

    // Add the new totals row at the very end
    await sheet.addRow({
      Timestamp: 'TOTALS',
      User: '',
      ...totals
    });

    console.log(`Successfully logged purchase to "${sheetTitle}" sheet.`);
    await logActivity('📄 Google Sheet Updated', `Successfully logged a purchase from **${username}** to the **${sheetTitle}** sheet.`, 'DarkGreen');
  } catch (error) {
    console.error('Error logging purchase to Google Sheet:', error);
    await logActivity('⚠️ Google Sheet Error', `Failed to log a purchase from **${username}**.\n**Error:** \`${error.message}\``, 'Red');
  }
}

// --- Helper Function to Parse Shorthand ---
function parseShorthand(value) {
  if (typeof value !== 'string') return value;

  const lastChar = value.slice(-1).toLowerCase();
  const numPart = value.slice(0, -1);

  if (!isNaN(numPart) && numPart !== '') {
    const num = parseFloat(numPart);
    switch (lastChar) {
      case 'k':
        return num * 1e3;
      case 'm':
        return num * 1e6;
      case 'b':
        return num * 1e9;
    }
  }
  return parseFloat(value);
}

// --- Helper Function to Parse Duration ---
function parseDuration(durationString) {
  const durationRegex = /^(\d+)(m|h|d)$/i;
  const match = durationString.match(durationRegex);

  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let milliseconds = 0;

  switch (unit) {
    case 'm':
      milliseconds = value * 60 * 1000;
      break;
    case 'h':
      milliseconds = value * 60 * 60 * 1000;
      break;
    case 'd':
      milliseconds = value * 24 * 60 * 60 * 1000;
      break;
  }
  return milliseconds;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    const invites = await guild.invites.fetch();
    invites.forEach(invite => {
      cachedInvites.set(invite.code, invite.uses);
    });
  }

  // Reset daily counts if needed, but for simplicity, not implemented
});

client.on('guildMemberAdd', async member => {
  const guild = member.guild;

  // Send welcome message
  try {
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
    if (welcomeChannelId) {
      const welcomeChannel = await guild.channels.fetch(welcomeChannelId);
      if (welcomeChannel && welcomeChannel.isTextBased()) {
        // Channel IDs
        const verificationChannelId = '1421649198331199619';
        const informationChannelId = '1421306924363681912';
        const usefulLinksChannelId = '1424495381202473141';
        const ticketerChannelId = '1413983349969780787';

        const welcomeVideoUrl = process.env.WELCOME_VIDEO_URL; // Define welcomeVideoUrl here

        const welcomeEmbed = new EmbedBuilder()
          .setDescription(`# Welcome to Sovereign Empire\n<@${member.id}>\n\n> 📜 <#${informationChannelId}>\n> 🔗 <#${usefulLinksChannelId}>\n> 🔐 <#${verificationChannelId}>\n> 💬 <#${ticketerChannelId}>`)
          .setColor('Gold')
          .setImage(process.env.WELCOME_VIDEO_URL || null);

        const welcomeRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setLabel('📜 Information')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${informationChannelId}`),
            new ButtonBuilder()
              .setLabel('🔗 Useful Links')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${usefulLinksChannelId}`),
            new ButtonBuilder()
              .setLabel('🔐 Verification')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${verificationChannelId}`),
            new ButtonBuilder()
              .setLabel('💬 Support')
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${guild.id}/${ticketerChannelId}`)
          );

        await welcomeChannel.send({ embeds: [welcomeEmbed], components: [welcomeRow] });
      }
    }
  } catch (error) {
    console.error('Error sending welcome message:', error);
  }

  // Handle invite rewards
  const newInvites = await guild.invites.fetch();
  let inviterId = null;
  newInvites.forEach(invite => {
    const oldUses = cachedInvites.get(invite.code) || 0;
    if (invite.uses > oldUses) {
      inviterId = invite.inviter.id;
    }
    cachedInvites.set(invite.code, invite.uses);
  });
  if (inviterId && inviterId !== member.id) { // avoid self
    // Check if this member was already invited by this inviter before
    const checkResult = await safeQuery(
      'SELECT * FROM invited_members WHERE inviter_id = $1 AND invited_member_id = $2',
      [inviterId, member.id]
    );

    // Only give reward if this is the first time this member was invited by this inviter
    if (!checkResult.rows || checkResult.rows.length === 0) {
      await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [inviterId]);
      await db.query('UPDATE users SET balance = balance + 20 WHERE id = $1', [inviterId]);
      await db.query('INSERT INTO invites (user_id, invites) VALUES ($1, 1) ON CONFLICT (user_id) DO UPDATE SET invites = invites.invites + 1', [inviterId]);

      // Record that this member was invited by this inviter
      await db.query(
        'INSERT INTO invited_members (inviter_id, invited_member_id) VALUES ($1, $2) ON CONFLICT (inviter_id, invited_member_id) DO NOTHING',
        [inviterId, member.id]
      );

      logActivity('💌 Invite Reward', `<@${inviterId}> received **20** Sovereign Pounds for inviting ${member.user.tag}.`, 'Green');
    } else {
      // Member was already invited before, no reward
      console.log(`Member ${member.user.tag} (${member.id}) was already invited by ${inviterId} before. No duplicate reward.`);
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [message.author.id]);

  // Increment total message count
  const { rows } = await db.query(`
      INSERT INTO message_counts (user_id, count, rewarded_messages)
      VALUES ($1, 1, 0)
      ON CONFLICT (user_id)
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count, rewarded_messages
  `, [message.author.id]);

  const { count, rewarded_messages } = rows[0];
  const unrewardedCount = count - rewarded_messages;

  if (unrewardedCount >= 100) {
    const rewardsToGive = Math.floor(unrewardedCount / 100);
    const totalReward = rewardsToGive * 5;
    await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [totalReward, message.author.id]);
    await db.query('UPDATE message_counts SET rewarded_messages = rewarded_messages + $1 WHERE user_id = $2', [rewardsToGive * 100, message.author.id]);
    logActivity('💬 Message Reward', `<@${message.author.id}> received **${totalReward}** Sovereign Pounds for sending ${rewardsToGive * 100} messages.`, 'Green');
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (member.user.bot) return;
  await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [member.id]);
  if (oldState.channelId && !newState.channelId) { // left
    const start = voiceTimes.get(member.id);
    if (start) {
      const minutesInSession = Math.floor((Date.now() - start) / 60000);
      voiceTimes.delete(member.id);

      if (minutesInSession > 0) {
        const { rows } = await db.query(`
          INSERT INTO voice_times (user_id, minutes, rewarded_minutes)
          VALUES ($1, $2, 0)
          ON CONFLICT (user_id)
          DO UPDATE SET minutes = voice_times.minutes + $2
          RETURNING minutes, rewarded_minutes
        `, [member.id, minutesInSession]);

        const { minutes, rewarded_minutes } = rows[0];
        const unrewardedMinutes = minutes - rewarded_minutes;

        if (unrewardedMinutes >= 60) {
          const rewardsToGive = Math.floor(unrewardedMinutes / 60);
          const totalReward = rewardsToGive * 5;
          await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [totalReward, member.id]);
          await db.query('UPDATE voice_times SET rewarded_minutes = rewarded_minutes + $1 WHERE user_id = $2', [rewardsToGive * 60, member.id]);
          logActivity('🎤 Voice Chat Reward', `<@${member.id}> received **${totalReward}** Sovereign Pounds for spending ${rewardsToGive * 60} minutes in voice chat.`, 'Green');
        }
      }
    }
  } else if (!oldState.channelId && newState.channelId) { // joined
    voiceTimes.set(member.id, Date.now());
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  // Check if the member started boosting or if their roles changed (which can indicate a boost)
  if (!oldMember.premiumSince && newMember.premiumSince) {
    const guild = newMember.guild;
    const currentBoosts = guild.premiumSubscriptionCount;

    const result = await db.query('SELECT rewarded_boosts FROM server_stats WHERE id = $1', [guild.id]);
    if (!result || !result.rows || result.rows.length === 0) {
      // Initialize server_stats if it doesn't exist
      await db.query('INSERT INTO server_stats (id, pool_balance, rewarded_boosts) VALUES ($1, 100000, 0) ON CONFLICT (id) DO NOTHING', [guild.id]);
      const retryResult = await db.query('SELECT rewarded_boosts FROM server_stats WHERE id = $1', [guild.id]);
      if (!retryResult || !retryResult.rows || retryResult.rows.length === 0) {
        return; // Can't proceed without server_stats
      }
      const rewardedBoosts = retryResult.rows[0]?.rewarded_boosts || 0;
      const newBoosts = currentBoosts - rewardedBoosts;
      if (newBoosts > 0) {
        const reward = newBoosts * 500;
        await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [newMember.id]);
        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reward, newMember.id]);
        await db.query('INSERT INTO boosts (user_id, boosts) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET boosts = boosts.boosts + $2', [newMember.id, newBoosts]);
        await db.query('INSERT INTO server_stats (id, rewarded_boosts) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET rewarded_boosts = $2', [guild.id, currentBoosts]);
        logActivity('🚀 Server Boost Reward', `<@${newMember.id}> received **${reward}** Sovereign Pounds for **${newBoosts}** new boost(s).`, 'Gold');
      }
      return;
    }
    const rewardedBoosts = result.rows[0]?.rewarded_boosts || 0;
    const newBoosts = currentBoosts - rewardedBoosts;

    if (newBoosts > 0) {
      const reward = newBoosts * 500;
      await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [newMember.id]);
      await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [reward, newMember.id]);

      // Update the user's personal boost count
      await db.query('INSERT INTO boosts (user_id, boosts) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET boosts = boosts.boosts + $2', [newMember.id, newBoosts]);

      // Update the total rewarded boosts for the server
      await db.query('INSERT INTO server_stats (id, rewarded_boosts) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET rewarded_boosts = $2', [guild.id, currentBoosts]);

      logActivity('🚀 Server Boost Reward', `<@${newMember.id}> received **${reward}** Sovereign Pounds for **${newBoosts}** new boost(s).`, 'Gold');
    }
  }
});

client.on('messageDelete', async (message) => {
  // Check if this is a giveaway message
  if (!message.embeds || message.embeds.length === 0) return;

  const embed = message.embeds[0];
  if (!embed.footer || !embed.footer.text || !embed.footer.text.startsWith('Giveaway ID:')) return;

  const giveawayId = embed.footer.text.replace('Giveaway ID: ', '');

  try {
    // Find the giveaway in database
    const { rows } = await db.query('SELECT * FROM giveaways WHERE id = $1 AND ended = FALSE', [giveawayId]);
    if (rows.length === 0) return;

    const giveaway = rows[0];

    // Cancel the giveaway
    await cancelGiveaway(giveawayId, 'Message deleted');

    logActivity('❌ Giveaway Cancelled', `Giveaway **${giveaway.prize}** was cancelled because the message was deleted.`, 'Red');

  } catch (error) {
    console.error('Error handling giveaway message deletion:', error);
  }
});

client.on('guildCreate', async (guild) => {
  console.log(`Joined a new guild: ${guild.name}`);
  try {
    // Initialize server pool with 100k
    await db.query('INSERT INTO server_stats (id, pool_balance) VALUES ($1, 100000) ON CONFLICT (id) DO NOTHING', [guild.id]);
    logActivity('🏦 Server Pool Initialized', `The bot joined a new server. The pool has been initialized with **100,000** 💰.`, 'Green');
  } catch (err) {
    console.error('Failed to initialize server pool on guild join:', err.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) { // Handle Slash Commands
    const { commandName } = interaction;
    await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [interaction.user.id]);

    if (commandName === 'balance') {
      // Defer the reply to prevent interaction timeout
      await interaction.deferReply();
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [interaction.user.id]);
      const row = rows[0];
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setDescription(`# 📊 ${interaction.user.username}'s Balance\n\n` +
          `💰 **${(row?.balance || 0).toLocaleString('en-US')}** Sovereign Pounds\n\n` +
          `**Inventory**\n` +
          `🪙 Gold: ${(row?.gold || 0).toLocaleString('en-US')}\n` +
          `🪵 Wood: ${(row?.wood || 0).toLocaleString('en-US')}\n` +
          `🌽 Food: ${(row?.food || 0).toLocaleString('en-US')}\n` +
          `🪨 Stone: ${(row?.stone || 0).toLocaleString('en-US')}\n\n` +
          `*Resources granted upon temple conquest.*`
        );

      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === 'shop') {
      try {
        const embed = new EmbedBuilder()
          .setColor('Blue')
          .setDescription('# 🛍️ Shop\nSelect a resource to purchase.\n\n> **Price:** 10 HP per package.');

        const goldButton = new ButtonBuilder()
          .setCustomId('buy_gold')
          .setLabel('🪙 Buy Gold')
          .setStyle(ButtonStyle.Primary);

        const woodButton = new ButtonBuilder()
          .setCustomId('buy_wood')
          .setLabel('🪵 Buy Wood')
          .setStyle(ButtonStyle.Primary);

        const foodButton = new ButtonBuilder()
          .setCustomId('buy_food')
          .setLabel('🌽 Buy Food')
          .setStyle(ButtonStyle.Primary);

        const stoneButton = new ButtonBuilder()
          .setCustomId('buy_stone')
          .setLabel('🪨 Buy Stone')
          .setStyle(ButtonStyle.Primary);

        const row1 = new ActionRowBuilder().addComponents(goldButton, woodButton);
        const row2 = new ActionRowBuilder().addComponents(foodButton, stoneButton);

        await interaction.reply({ embeds: [embed], components: [row1, row2] });
      } catch (error) {
        console.error('Error in shop command:', error);
        try {
          await interaction.reply({ content: '❌ An error occurred while opening the shop. Please try again.', ephemeral: true });
        } catch (replyError) {
          console.error('Error replying to shop command:', replyError);
        }
      }

    } else if (commandName === 'help') {
      await interaction.deferReply();
      const helpEmbed = new EmbedBuilder()
        .setColor('2B2D31')
        .setDescription(`# Command List
        
**Earn Currency**
> **Invites**: 20 💰
> **Messages**: 5 💰 / 100 msgs
> **Voice**: 5 💰 / hour
> **Boosts**: 500 💰

**User Commands**
\`/balance\` \`/shop\` \`/daily\`
\`/stats\` \`/leaderboard\` \`/help\`

**Admin Commands**
\`/pool\` \`/give\` \`/take\`
\`/giveaway\``);

      await interaction.editReply({ embeds: [helpEmbed] });
    } else if (commandName === 'daily') {
      await interaction.deferReply();
      const userId = interaction.user.id;
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD

      try {
        const { rows } = await db.query('SELECT last_daily, daily_streak FROM users WHERE id = $1', [userId]);
        const row = rows[0];

        const lastDaily = row?.last_daily ? new Date(row.last_daily).toISOString().slice(0, 10) : null;
        let streak = row?.daily_streak || 0;

        if (lastDaily === todayStr) {
          // Calculate time until next claim (UTC midnight)
          const tomorrow = new Date(today);
          tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
          tomorrow.setUTCHours(0, 0, 0, 0);
          return await interaction.editReply({ content: `You have already claimed your daily reward today! Please come back <t:${Math.floor(tomorrow.getTime() / 1000)}:R>.` });
        }

        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        if (lastDaily === yesterdayStr) {
          // Continue the streak
          streak++;
        } else {
          // Reset the streak
          streak = 1;
        }

        // Cap the streak at 15 and calculate reward (5 + streak, max 20)
        const cappedStreak = Math.min(streak, 15);
        const reward = 5 + cappedStreak;

        await db.query('UPDATE users SET balance = balance + $1, last_daily = $2, daily_streak = $3 WHERE id = $4', [reward, todayStr, streak, userId]);

        const replyEmbed = new EmbedBuilder()
          .setColor('Gold')
          .setDescription(`## 🎉 Daily Reward\nReceived **${reward}** 💰\nStreak: ${streak} days`);

        await interaction.editReply({ embeds: [replyEmbed] });
        logActivity('🎁 Daily Reward', `<@${userId}> claimed their daily reward of **${reward}** 💰 (Streak: ${streak}).`, 'Aqua');
      } catch (err) {
        console.error(err);
        return await interaction.editReply({ content: '❌ An error occurred while processing your daily reward.' });
      }
    } else if (commandName === 'stats') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('user');
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      const isUserAdmin = adminIds.includes(interaction.user.id);

      if (targetUser && targetUser.id !== interaction.user.id && !isUserAdmin) {
        return await interaction.editReply({ content: '🚫 You can only view your own stats. Only admins can view stats for other users.' });
      }
      const user = interaction.options.getUser('user') || interaction.user;

      const statsPromises = [
        db.query('SELECT invites FROM invites WHERE user_id = $1', [user.id]),
        db.query('SELECT boosts FROM boosts WHERE user_id = $1', [user.id]),
        db.query('SELECT count, rewarded_messages FROM message_counts WHERE user_id = $1', [user.id]),
        db.query('SELECT minutes, rewarded_minutes FROM voice_times WHERE user_id = $1', [user.id]),
      ];

      await Promise.all(statsPromises).then(async ([invitesRes, boostsRes, messagesRes, voiceMinutesRes]) => {
        const invites = invitesRes.rows[0]?.invites || 0;
        const boosts = boostsRes.rows[0]?.boosts || 0;
        const totalMessages = messagesRes.rows[0]?.count || 0;
        const rewardedMessages = messagesRes.rows[0]?.rewarded_messages || 0;
        const totalVoiceMinutes = voiceMinutesRes.rows[0]?.minutes || 0;
        const rewardedVoiceMinutes = voiceMinutesRes.rows[0]?.rewarded_minutes || 0;

        const messageProgress = ((totalMessages - rewardedMessages) % 100);
        const voiceProgress = ((totalVoiceMinutes - rewardedVoiceMinutes) % 60);

        const statsEmbed = new EmbedBuilder()
          .setTitle(`📈 Stats for ${user.username}`)
          .setThumbnail(user.displayAvatarURL())
          .setColor('Blue')
          .addFields(
            { name: '💌 Invites', value: `**${invites}** total`, inline: true },
            { name: '🚀 Server Boosts', value: `**${boosts}** total`, inline: true },
            { name: '💬 Lifetime Messages', value: `**${totalMessages.toLocaleString('en-US')}** sent\n(${messageProgress}/100 for next reward)` },
            { name: '🎤 Lifetime Voice Chat', value: `**${totalVoiceMinutes}** minutes\n(${voiceProgress}/60 for next reward)` }
          );
        await interaction.editReply({ embeds: [statsEmbed] });
      });

    } else if (commandName === 'leaderboard') {
      try {
        await interaction.deferReply();
        const { rows: allUsers } = await db.query('SELECT id, balance FROM users ORDER BY balance DESC');

        const top10Users = allUsers.slice(0, 10);
        const embed = new EmbedBuilder()
          .setTitle('🏆 Sovereign Pounds Leaderboard')
          .setColor('Gold');

        let description = '';
        for (let i = 0; i < top10Users.length; i++) {
          try {
            const user = await client.users.fetch(top10Users[i].id);
            const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
            description += `${medal} <@${user.id}> - **${top10Users[i].balance.toLocaleString('en-US')}** 💰\n`;
          } catch {
            // User might not be in the server anymore
            description += `**${i + 1}.** *Unknown User* - **${top10Users[i].balance.toLocaleString('en-US')}** 💰\n`;
          }
        }

        if (description === '') {
          description = 'The leaderboard is empty!';
        }

        // Find the user's rank and add it if they are not in the top 10
        const userRankIndex = allUsers.findIndex(user => user.id === interaction.user.id);
        if (userRankIndex !== -1 && userRankIndex >= 10) {
          const userRank = userRankIndex + 1;
          const userBalance = allUsers[userRankIndex].balance;
          description += `\n...\n**${userRank}.** <@${interaction.user.id}> - **${userBalance.toLocaleString('en-US')}** 💰`;
        }

        embed.setDescription(description);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error(err);
        return await interaction.editReply({ content: '❌ An error occurred while fetching the leaderboard.' });
      }
    } else if (commandName === 'pool') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
        return interaction.reply('🚫 You do not have permission to use this command.');
      }
      // Defer the reply and make it ephemeral
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      try {
        // Ensure server_stats record exists
        await safeQuery('INSERT INTO server_stats (id, pool_balance) VALUES ($1, 100000) ON CONFLICT (id) DO NOTHING', [interaction.guildId]);

        const result = await safeQuery('SELECT pool_balance FROM server_stats WHERE id = $1', [interaction.guildId]);
        if (!result || !result.rows || result.rows.length === 0) {
          return await interaction.editReply({ content: '❌ Error: Could not access server pool. Please try again.' });
        }

        const poolBalance = result.rows[0]?.pool_balance || 0;
        const embed = new EmbedBuilder()
          .setTitle('🏦 Server Pool Balance')
          .setDescription(`The server pool currently holds **${poolBalance.toLocaleString('en-US')}** 💰.`)
          .setColor('Aqua');
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Error checking pool balance:', error);
        try {
          await interaction.editReply({ content: `❌ Error checking pool balance: ${error.message}. Please check the console for more details.` });
        } catch (replyError) {
          console.error('Error replying to interaction:', replyError);
        }
      }
    } else if (commandName === 'give') {
      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
        }

        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getNumber('amount');

        if (!targetUser || !amount || amount <= 0) {
          return await interaction.editReply({ content: '❌ Invalid user or amount provided.' });
        }

        // Ensure server_stats record exists
        await safeQuery('INSERT INTO server_stats (id, pool_balance) VALUES ($1, 100000) ON CONFLICT (id) DO NOTHING', [interaction.guildId]);

        const result = await safeQuery('SELECT pool_balance FROM server_stats WHERE id = $1', [interaction.guildId]);
        if (!result || !result.rows || result.rows.length === 0) {
          return await interaction.editReply({ content: '❌ Error: Could not access server pool. Please try again.' });
        }

        const poolBalance = result.rows[0]?.pool_balance || 0;

        if (amount > poolBalance) {
          return await interaction.editReply({ content: `❌ Not enough funds in the server pool! The pool only has **${poolBalance.toLocaleString('en-US')}** 💰.` });
        }

        await db.query('UPDATE server_stats SET pool_balance = pool_balance - $1 WHERE id = $2', [amount, interaction.guildId]);
        await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [targetUser.id]);
        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, targetUser.id]);

        await interaction.editReply({ content: `✅ Successfully gave **${amount.toLocaleString('en-US')}** 💰 to ${targetUser}.` });
        logActivity('💸 Admin Give', `<@${interaction.user.id}> gave **${amount.toLocaleString('en-US')}** 💰 to ${targetUser}.`, 'Yellow');
      } catch (error) {
        console.error('Error giving currency:', error);
        await interaction.editReply({ content: '❌ An error occurred while giving currency.' });
      }


    } else if (commandName === 'take') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
        return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
        logActivity('💸 Admin Take', `<@${interaction.user.id}> took **${amountTaken.toLocaleString('en-US')}** 💰 from ${targetUser}. The amount was added to the server pool.`, 'Orange');
      } else if (commandName === 'ticket-setup') {
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
        }

        const channel = interaction.options.getChannel('channel');

        // Fetch categories
        const { rows: categories } = await db.query('SELECT * FROM ticket_categories WHERE guild_id = $1 ORDER BY id ASC', [interaction.guildId]);

        if (categories.length === 0) {
          return await interaction.reply({ content: '❌ No ticket categories found. Please use `/ticket-category add` first.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('ticket_select')
          .setPlaceholder('Select a category to open a ticket');

        categories.forEach(cat => {
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(cat.name)
              .setValue(cat.id.toString())
              .setEmoji(cat.emoji || '🎫')
          );
        });

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const panelEmbed = new EmbedBuilder()
          .setColor('2B2D31')
          .setDescription('# 🎫 Tickets\nSelect a category to contact support.');

        const sentMessage = await channel.send({ embeds: [panelEmbed], components: [row] });

        // Save panel info to update it later
        await db.query(`
        INSERT INTO ticket_panels (guild_id, channel_id, message_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild_id) 
        DO UPDATE SET channel_id = $2, message_id = $3
      `, [interaction.guildId, channel.id, sentMessage.id]);

        await interaction.editReply({ content: `✅ Ticket panel created in ${channel}.` });

      } else if (commandName === 'ticket-category') {
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'add') {
          const name = interaction.options.getString('name');
          const role = interaction.options.getRole('role');
          const emoji = interaction.options.getString('emoji') || '🎫';

          await db.query(
            'INSERT INTO ticket_categories (guild_id, name, emoji, staff_role_id) VALUES ($1, $2, $3, $4)',
            [interaction.guildId, name, emoji, role.id]
          );

          await interaction.reply({ content: `✅ Category **${name}** added with role ${role} and emoji ${emoji}.`, ephemeral: true });

          // TODO: Auto-update panel if exists
        } else if (subcommand === 'remove') {
          const name = interaction.options.getString('name');
          await db.query('DELETE FROM ticket_categories WHERE guild_id = $1 AND name = $2', [interaction.guildId, name]);
          await interaction.reply({ content: `✅ Category **${name}** removed.`, ephemeral: true });
        }

      } else if (commandName === 'ticket-wizard') {
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
        }

        await interaction.reply({ content: '🧙‍♂️ Starting Ticket Wizard...', ephemeral: true });

        try {
          // Create private thread
          const thread = await interaction.channel.threads.create({
            name: 'ticket-setup-wizard',
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 60,
            reason: 'Ticket Setup Wizard'
          });
          await thread.members.add(interaction.user.id);

          const embed = new EmbedBuilder()
            .setTitle('🧙‍♂️ Ticket Category Wizard')
            .setDescription('Click the button below to create a new Ticket Category.\nThis will prompt you for the Name, Emoji, and Role ID.')
            .setColor('Purple');

          const btn = new ButtonBuilder()
            .setCustomId('wizard_create_cat_btn')
            .setLabel('Create Category')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✨');

          await thread.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
          await interaction.editReply({ content: `✅ Wizard started: <#${thread.id}>` });
        } catch (err) {
          console.error('Error starting wizard:', err);
          await interaction.editReply({ content: '❌ Failed to create wizard thread. Check permissions.' });
        }

      } else if (commandName === 'close') {
        // Check if channel is a ticket (which is now a thread)
        const { rows } = await db.query('SELECT * FROM tickets WHERE channel_id = $1 AND closed = FALSE', [interaction.channelId]);
        if (rows.length === 0) {
          // Also check if it's a thread just in case
          if (!interaction.channel.isThread()) {
            return await interaction.reply({ content: '❌ This command can only be used in active ticket threads.', ephemeral: true });
          }
          // If it is a thread but not in DB, maybe just error?
          return await interaction.reply({ content: '❌ Ticket not found in database.', ephemeral: true });
        }

        await interaction.reply({ content: '🔒 Closing ticket...' });

        const ticket = rows[0];
        const thread = interaction.channel;

        // Update DB
        await db.query('UPDATE tickets SET closed = TRUE WHERE channel_id = $1', [thread.id]);

        // Delete thread after 5 seconds
        setTimeout(async () => {
          try {
            await thread.delete();
          } catch (err) {
            console.error('Failed to delete ticket thread:', err);
          }
        }, 5000);

      } else if (commandName === 'add-user') {
        if (!interaction.channel.isThread()) {
          return await interaction.reply({ content: '❌ This command can only be used in active ticket threads.', ephemeral: true });
        }

        const user = interaction.options.getUser('user');
        try {
          await interaction.channel.members.add(user.id);
          await interaction.reply({ content: `✅ Added ${user} to the ticket.` });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: '❌ Failed to add user to the thread.' });
        }

      } else if (commandName === 'remove-user') {
        if (!interaction.channel.isThread()) {
          return await interaction.reply({ content: '❌ This command can only be used in active ticket threads.', ephemeral: true });
        }

        const user = interaction.options.getUser('user');
        try {
          await interaction.channel.members.remove(user.id);
          await interaction.reply({ content: `✅ Removed ${user} from the ticket.` });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: '❌ Failed to remove user from the thread.' });
        }
      } else if (commandName === 'reset-all') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
        }

        try {
          console.log('🔄 Starting data reset...');

          // Reset user balances and resources
          const usersResult = await db.query(`
          UPDATE users 
          SET balance = 0, 
              gold = 0, 
              wood = 0, 
              food = 0, 
              stone = 0,
              daily_streak = 0,
              last_daily = NULL
        `);
          console.log(`✅ Reset ${usersResult.rowCount || 0} user records`);

          // Reset message counts
          const messagesResult = await db.query(`
          UPDATE message_counts 
          SET count = 0, 
              rewarded_messages = 0
        `);
          console.log(`✅ Reset ${messagesResult.rowCount || 0} message count records`);

          // Reset voice times
          const voiceResult = await db.query(`
          UPDATE voice_times 
          SET minutes = 0, 
              rewarded_minutes = 0
        `);
          console.log(`✅ Reset ${voiceResult.rowCount || 0} voice time records`);

          // Reset invites
          const invitesResult = await db.query(`
          UPDATE invites 
          SET invites = 0
        `);
          console.log(`✅ Reset ${invitesResult.rowCount || 0} invite records`);

          // Reset boosts
          const boostsResult = await db.query(`
          UPDATE boosts 
          SET boosts = 0
        `);
          console.log(`✅ Reset ${boostsResult.rowCount || 0} boost records`);

          // Reset invited_members tracking
          const invitedResult = await db.query(`
          DELETE FROM invited_members
        `);
          console.log(`✅ Deleted ${invitedResult.rowCount || 0} invited member records`);

          // Ensure server_stats exists and reset pool to default
          await db.query(`
          INSERT INTO server_stats (id, pool_balance) 
          VALUES ($1, 100000) 
          ON CONFLICT (id) 
          DO UPDATE SET pool_balance = 100000
        `, [interaction.guildId]);
          console.log(`✅ Reset server pool to 100,000`);

          // Reset Google Sheet
          const sheetResetResult = await resetGoogleSheet();
          if (sheetResetResult.success) {
            console.log(`✅ ${sheetResetResult.message}`);
          } else {
            console.log(`⚠️ Google Sheet reset failed: ${sheetResetResult.message}`);
          }

          console.log('🎉 All data reset completed successfully!');
          const resetMessage = '✅ **All data has been reset successfully!**\n\n- All user balances: **0** 💰\n- All resources (Gold, Wood, Food, Stone): **0**\n- All message counts: **0**\n- All voice times: **0**\n- All invites: **0**\n- All boosts: **0**\n- Server pool: **100,000** 💰\n- Invite tracking: **Cleared**' +
            (sheetResetResult.success ? '\n- Google Sheet: **Reset** ✅' : '\n- Google Sheet: **Reset failed** ⚠️');
          await interaction.editReply({ content: resetMessage });
          logActivity('🔄 Admin Reset', `<@${interaction.user.id}> reset ALL user data (balances, stats, resources${sheetResetResult.success ? ', Google Sheet' : ''}).`, 'Red');
        } catch (error) {
          console.error('❌ Error resetting data:', error);
          await interaction.editReply({ content: `❌ Error resetting data: ${error.message}\n\nPlease check the console for more details.` });
        }
      } else if (commandName === 'giveaway') {
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        if (!adminIds.includes(interaction.user.id)) {
          return interaction.reply('🚫 You do not have permission to use this command.');
        }

        const duration = interaction.options.getString('duration');
        const totalPrize = interaction.options.getNumber('total_prize');
        const winnerCount = interaction.options.getInteger('winners') || 1;
        const entryCost = interaction.options.getNumber('entry_cost') || 10; // Default to 10 if not specified
        const pingRole = interaction.options.getRole('ping_role') || (DEFAULT_GIVEAWAY_PING_ROLE ? interaction.guild.roles.cache.get(DEFAULT_GIVEAWAY_PING_ROLE) : null);

        const modal = new ModalBuilder()
          .setCustomId(`giveaway_modal_${Date.now()}_${pingRole?.id || 'none'}`)
          .setTitle('Create Giveaway');

        const durationInput = new TextInputBuilder()
          .setCustomId('giveaway_duration')
          .setLabel('Duration (e.g., 1h, 30m, 2d)')
          .setPlaceholder('1h, 30m, 2d...')
          .setValue(duration)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const totalPrizeInput = new TextInputBuilder()
          .setCustomId('giveaway_total_prize')
          .setLabel('Total Prize (Sovereign Pounds)')
          .setPlaceholder('Enter the total amount to distribute...')
          .setValue(totalPrize.toString())
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const entryCostInput = new TextInputBuilder()
          .setCustomId('giveaway_entry_cost')
          .setLabel('Entry Cost (Sovereign Pounds)')
          .setPlaceholder('Enter the cost to participate...')
          .setValue(entryCost.toString())
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const winnersInput = new TextInputBuilder()
          .setCustomId('giveaway_winners')
          .setLabel('Number of Winners')
          .setPlaceholder('1')
          .setValue(winnerCount.toString())
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(totalPrizeInput),
          new ActionRowBuilder().addComponents(entryCostInput),
          new ActionRowBuilder().addComponents(winnersInput)
        );

        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) { // Handle Modal Submissions
      if (interaction.customId === 'modal_wizard_cat') {
        const name = interaction.fields.getTextInputValue('cat_name');
        const emoji = interaction.fields.getTextInputValue('cat_emoji');
        const roleId = interaction.fields.getTextInputValue('cat_role_id');

        try {
          const { rows } = await db.query(
            'INSERT INTO ticket_categories (guild_id, name, emoji, staff_role_id) VALUES ($1, $2, $3, $4) RETURNING id',
            [interaction.guildId, name, emoji, roleId]
          );
          const newCatId = rows[0].id;

          const embed = new EmbedBuilder()
            .setTitle('✅ Category Created')
            .setDescription(`**Name:** ${name}\n**Emoji:** ${emoji}\n**Role:** <@&${roleId}>\n\nDo you want to add questions for this ticket category?`)
            .setColor('Green');

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`wizard_add_questions_${newCatId}`).setLabel('Add Entry Questions').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`wizard_finish_${newCatId}`).setLabel('Finish').setStyle(ButtonStyle.Secondary)
          );

          await interaction.reply({ embeds: [embed], components: [row] });
        } catch (err) {
          console.error(err);
          await interaction.reply({ content: '❌ Error creating category. Check role ID.', ephemeral: true });
        }
      } else if (interaction.customId.startsWith('modal_wizard_questions_')) {
        const catId = interaction.customId.split('_')[3];
        const q1 = interaction.fields.getTextInputValue('q1');
        const q2 = interaction.fields.getTextInputValue('q2');
        const q3 = interaction.fields.getTextInputValue('q3');
        const q4 = interaction.fields.getTextInputValue('q4');
        const q5 = interaction.fields.getTextInputValue('q5');

        const questions = [q1, q2, q3, q4, q5].filter(q => q && q.trim().length > 0);

        await db.query('UPDATE ticket_categories SET form_questions = $1 WHERE id = $2', [JSON.stringify(questions), catId]);
        await interaction.reply({ content: `✅ Added ${questions.length} questions to category.`, ephemeral: true });

      } else if (interaction.customId.startsWith('modal_ticket_create_')) {
        const catId = interaction.customId.split('_')[3];

        // Fetch category to get question texts corresponding to answers
        const { rows } = await db.query('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
        if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });
        const category = rows[0];
        const formQuestions = category.form_questions || [];

        const answers = [];
        formQuestions.slice(0, 5).forEach((q, index) => {
          const answer = interaction.fields.getTextInputValue(`q_${index}`);
          answers.push({ question: q, answer: answer });
        });

        // NOW create the thread with answers
        const guild = interaction.guild;
        const channelName = `ticket-${interaction.user.username}-${category.name}`;

        try {
          const ticketThread = await interaction.channel.threads.create({
            name: channelName,
            type: ChannelType.PrivateThread,
            reason: `Ticket created by ${interaction.user.tag}`,
            autoArchiveDuration: 1440,
          });
          await ticketThread.members.add(interaction.user.id);

          await db.query(
            'INSERT INTO tickets (channel_id, guild_id, user_id, category_id) VALUES ($1, $2, $3, $4)',
            [ticketThread.id, guild.id, interaction.user.id, category.id]
          );

          const answerFields = answers.map(a => `**${a.question}**\n${a.answer}`).join('\n\n');

          const welcomeEmbed = new EmbedBuilder()
            .setTitle(`${category.emoji} ${category.name} Ticket`)
            .setDescription(`Welcome <@${interaction.user.id}>!\n\n${answerFields}\n\n<@&${category.staff_role_id}> will be with you shortly.`)
            .setColor('Green');

          const closeButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );

          await ticketThread.send({ embeds: [welcomeEmbed], components: [closeButton] });
          await interaction.reply({ content: `✅ Ticket created: <#${ticketThread.id}>`, ephemeral: true });

        } catch (err) {
          console.error(err);
          await interaction.reply({ content: '❌ Failed to create ticket.', ephemeral: true });
        }

      } else if (interaction.customId.startsWith('buy_modal_')) {
        const resource = interaction.customId.split('_')[2];
        const quantityString = interaction.fields.getTextInputValue('hp_quantity_input');
        const cost = parseShorthand(quantityString);

        if (isNaN(cost) || cost <= 0) {
          return interaction.reply({ content: '⚠️ Please provide a valid quantity of Sovereign Pounds to spend.', flags: [MessageFlags.Ephemeral] });
        }

        // Define how many resources you get for 10 HP
        const quantities = { gold: 50000, wood: 150000, food: 150000, stone: 112000 };
        const pricePerPackage = 10;

        // Calculate the proportional amount of resources
        const desiredResourceAmount = Math.floor((cost / pricePerPackage) * quantities[resource]);

        if (desiredResourceAmount < 1) {
          return interaction.reply({ content: '⚠️ The amount of Sovereign Pounds is too small to buy at least 1 unit of this resource.', flags: [MessageFlags.Ephemeral] });
        }

        const confirmationEmbed = new EmbedBuilder()
          .setTitle('🛒 Purchase Confirmation')
          .setDescription(`You are about to spend **${cost.toLocaleString('en-US')}** 💰 to receive **${desiredResourceAmount.toLocaleString('en-US')} ${resource}**.\n\nPlease confirm your purchase.`)
          .setColor('Orange');

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`confirm_buy_${resource}_${cost}_${desiredResourceAmount}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cancel_buy').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          );

        await interaction.reply({
          embeds: [confirmationEmbed],
          components: [row],
          flags: [MessageFlags.Ephemeral],
        });
      } else if (interaction.customId.startsWith('giveaway_modal_')) {
        const durationStr = interaction.fields.getTextInputValue('giveaway_duration');
        const totalPrize = parseFloat(interaction.fields.getTextInputValue('giveaway_total_prize'));
        const entryCost = parseFloat(interaction.fields.getTextInputValue('giveaway_entry_cost'));
        const winnerCount = parseInt(interaction.fields.getTextInputValue('giveaway_winners'));

        // Extract pingRole from customId
        const pingRoleId = interaction.customId.split('_')[3];
        const pingRole = pingRoleId && pingRoleId !== 'none' ? interaction.guild.roles.cache.get(pingRoleId) : null;

        if (isNaN(totalPrize) || totalPrize <= 0) {
          return interaction.reply({ content: '⚠️ Please provide a valid total prize amount.', flags: [MessageFlags.Ephemeral] });
        }

        if (isNaN(entryCost) || entryCost <= 0) {
          return interaction.reply({ content: '⚠️ Please provide a valid entry cost.', flags: [MessageFlags.Ephemeral] });
        }

        if (isNaN(winnerCount) || winnerCount <= 0) {
          return interaction.reply({ content: '⚠️ Please provide a valid number of winners.', flags: [MessageFlags.Ephemeral] });
        }

        const duration = parseDuration(durationStr);
        if (!duration) {
          return interaction.reply({ content: '⚠️ Please provide a valid duration (e.g., 1h, 30m, 2d).', flags: [MessageFlags.Ephemeral] });
        }

        const endTime = Date.now() + duration;
        const giveawayId = `giveaway_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Calculate prize per winner
        const prizePerWinner = Math.floor(totalPrize / winnerCount);

        // Ensure server_stats record exists
        await db.query('INSERT INTO server_stats (id, pool_balance) VALUES ($1, 100000) ON CONFLICT (id) DO NOTHING', [interaction.guildId]);

        // Check if server pool has enough funds
        const result = await db.query('SELECT pool_balance FROM server_stats WHERE id = $1', [interaction.guildId]);
        if (!result || !result.rows || result.rows.length === 0) {
          return interaction.reply({
            content: '❌ Error: Could not access server pool. Please try again.',
            flags: [MessageFlags.Ephemeral]
          });
        }

        const poolBalance = result.rows[0]?.pool_balance || 0;

        if (poolBalance < totalPrize) {
          return interaction.reply({
            content: `❌ Not enough funds in server pool! Need **${totalPrize.toLocaleString('en-US')}** 💰 but pool only has **${poolBalance.toLocaleString('en-US')}** 💰.`,
            flags: [MessageFlags.Ephemeral]
          });
        }

        // Deduct total prize from pool
        await db.query('UPDATE server_stats SET pool_balance = pool_balance - $1 WHERE id = $2', [totalPrize, interaction.guildId]);

        // Create giveaway embed
        const giveawayEmbed = new EmbedBuilder()
          .setTitle('🎉 Giveaway! 🎉')
          .setDescription(`**Total Prize:** ${totalPrize.toLocaleString('en-US')} 💰\n**Prize per Winner:** ${prizePerWinner.toLocaleString('en-US')} 💰\n**Entry Cost:** ${entryCost.toLocaleString('en-US')} 💰\n**Winners:** ${winnerCount}\n**Ends:** <t:${Math.floor(endTime / 1000)}:R>`)
          .setColor('Gold')
          .setFooter({ text: `Giveaway ID: ${giveawayId}` })
          .setTimestamp();

        const joinButton = new ButtonBuilder()
          .setCustomId(`join_giveaway_${giveawayId}`)
          .setLabel(`Join Giveaway (${entryCost.toLocaleString('en-US')} 💰)`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎁');

        const row = new ActionRowBuilder().addComponents(joinButton);

        // Prepare content with ping if role is specified
        const content = pingRole ? `${pingRole} **New Giveaway Available!** 🎉` : undefined;
        const allowedMentions = pingRole ? { roles: [pingRole.id] } : undefined;

        // Send the giveaway message
        const giveawayMessage = await interaction.reply({
          content: content,
          embeds: [giveawayEmbed],
          components: [row],
          allowedMentions: allowedMentions
        });

        // Get the reply message for database storage
        const replyMessage = await interaction.fetchReply();

        // Store giveaway in database
        await db.query(`
        INSERT INTO giveaways (id, guild_id, channel_id, message_id, entry_cost, total_prize, winner_count, end_time, creator_id, participants, required_role_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [giveawayId, interaction.guildId, interaction.channelId, replyMessage.id, entryCost, totalPrize, winnerCount, new Date(endTime), interaction.user.id, [], null]);

        // Set timeout to end giveaway
        setTimeout(async () => {
          await endGiveaway(giveawayId);
        }, duration);

        logActivity('🎁 Giveaway Created', `<@${interaction.user.id}> created a giveaway: **${totalPrize.toLocaleString('en-US')} 💰** total prize (${entryCost.toLocaleString('en-US')} 💰 entry, ${winnerCount} winner(s))`, 'Gold');
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket_select') {
        const categoryId = interaction.values[0];

        // Fetch category details
        const { rows: cats } = await db.query('SELECT * FROM ticket_categories WHERE id = $1', [categoryId]);
        if (cats.length === 0) {
          return await interaction.reply({ content: '❌ Category not found.', ephemeral: true });
        }
        const category = cats[0];

        // Check if category has form questions
        if (category.form_questions && category.form_questions.length > 0) {
          const modal = new ModalBuilder()
            .setCustomId(`modal_ticket_create_${category.id}`)
            .setTitle(`${category.name} - Info`);

          category.form_questions.slice(0, 5).forEach((q, index) => {
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId(`q_${index}`).setLabel(q.substring(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true)
            ));
          });

          await interaction.showModal(modal);
          return;
        }

        // If no questions, proceed with standard ticket creation
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const channelName = `ticket-${interaction.user.username}-${category.name}`;

        try {
          // Create a private thread in the current channel
          const ticketThread = await interaction.channel.threads.create({
            name: channelName,
            type: ChannelType.PrivateThread,
            reason: `Ticket created by ${interaction.user.tag}`,
            autoArchiveDuration: 1440, // 24 hours
          });

          // Add user and staff to thread
          await ticketThread.members.add(interaction.user.id);

          // Save to DB
          await db.query(
            'INSERT INTO tickets (channel_id, guild_id, user_id, category_id) VALUES ($1, $2, $3, $4)',
            [ticketThread.id, guild.id, interaction.user.id, category.id]
          );

          const welcomeEmbed = new EmbedBuilder()
            .setTitle(`${category.emoji} ${category.name} Ticket`)
            .setDescription(`Welcome <@${interaction.user.id}>!\nPlease describe your issue here. <@&${category.staff_role_id}> will be with you shortly.`)
            .setColor('Green');

          const closeButton = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('close_ticket_btn')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
            );

          await ticketThread.send({ embeds: [welcomeEmbed], components: [closeButton] });

          await interaction.editReply({ content: `✅ Ticket created: <#${ticketThread.id}>` });

        } catch (err) {
          console.error('Error creating ticket thread:', err);
          await interaction.editReply({ content: '❌ Failed to create ticket thread. Ensure the bot has "Create Private Threads" and "Manage Threads" permissions or that the channel allows threads.' });
        }
      }
    } else if (interaction.isButton()) { // Handle Button Clicks
      if (interaction.customId === 'wizard_create_cat_btn') {
        const modal = new ModalBuilder().setCustomId('modal_wizard_cat').setTitle('Create Ticket Category');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_name').setLabel('Category Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_emoji').setLabel('Emoji').setStyle(TextInputStyle.Short).setPlaceholder('🎫').setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_role_id').setLabel('Staff Role ID').setStyle(TextInputStyle.Short).setPlaceholder('1234567890').setRequired(true))
        );
        await interaction.showModal(modal);
        return;
      } else if (interaction.customId.startsWith('wizard_add_questions_')) {
        const catId = interaction.customId.split('_')[3];
        const modal = new ModalBuilder().setCustomId(`modal_wizard_questions_${catId}`).setTitle('Add Entry Questions');
        // Add 5 optional inputs
        for (let i = 1; i <= 5; i++) {
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(`q${i}`).setLabel(`Question ${i}`).setStyle(TextInputStyle.Short).setRequired(false)
          ));
        }
        await interaction.showModal(modal);
        return;
      } else if (interaction.customId.startsWith('wizard_finish_')) {
        await interaction.reply({ content: '✅ Setup finished. Don\'t forget to use /ticket-setup to refresh the panel!', ephemeral: true });
        return;
      }

      if (interaction.customId === 'close_ticket_btn') {
        await interaction.reply({ content: '🔒 Closing ticket...' });

        // Update DB
        await db.query('UPDATE tickets SET closed = TRUE WHERE channel_id = $1', [interaction.channelId]);

        // Delete thread after 5 seconds
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (err) {
            console.error('Failed to delete ticket thread:', err);
          }
        }, 5000);
        return;
      }
      if (interaction.customId.startsWith('buy_') && ['buy_gold', 'buy_wood', 'buy_food', 'buy_stone'].includes(interaction.customId)) {
        // Handle shop buy buttons - show modal
        const resource = interaction.customId.split('_')[1];

        const modal = new ModalBuilder()
          .setCustomId(`buy_modal_${resource}`)
          .setTitle(`Buy ${resource.charAt(0).toUpperCase() + resource.slice(1)}`);

        const quantityInput = new TextInputBuilder()
          .setCustomId('hp_quantity_input')
          .setLabel("How many HP do you want to spend?")
          .setPlaceholder('e.g., 10, 5.5, 100k, 1.5m')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const actionRow = new ActionRowBuilder().addComponents(quantityInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
      } else if (interaction.customId.startsWith('join_giveaway_')) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // Don't delete the message
      } else {
        await interaction.deferUpdate(); // Acknowledge the button click immediately
      }
      if (interaction.customId.startsWith('confirm_buy_')) {
        const [, , resource, costStr, resourceAmountStr] = interaction.customId.split('_');
        const cost = parseFloat(costStr);
        const resourceAmount = parseInt(resourceAmountStr, 10);

        const { rows: userRows } = await db.query('SELECT balance FROM users WHERE id = $1', [interaction.user.id]);
        if ((userRows[0]?.balance || 0) < cost) {
          return interaction.editReply({ content: `❌ Oops! You no longer have enough Sovereign Pounds.`, embeds: [], components: [] });
        }
        await db.query(`UPDATE users SET balance = balance - $1, ${resource} = ${resource} + $2 WHERE id = $3`, [cost, resourceAmount, interaction.user.id]);
        await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [cost, interaction.guildId]);
        await interaction.editReply({ content: `✅ Success! You spent **${cost.toLocaleString('en-US')}** 💰 and received **${resourceAmount.toLocaleString('en-US')} ${resource}**!`, embeds: [], components: [] });
        logActivity('🛒 Shop Purchase', `<@${interaction.user.id}> bought **${resourceAmount.toLocaleString('en-US')} ${resource}** for **${cost.toLocaleString('en-US')}** Sovereign Pounds.`, 'Blue')
          .then(() => logPurchaseToSheet(interaction.user.username, resource, resourceAmount, cost));
      } else if (interaction.customId === 'cancel_buy') {
        await interaction.editReply({ content: 'Purchase canceled.', embeds: [], components: [] });
      } else if (interaction.customId.startsWith('join_giveaway_')) {
        const giveawayId = interaction.customId.replace('join_giveaway_', '');

        try {
          // Get giveaway info
          const { rows } = await db.query('SELECT * FROM giveaways WHERE id = $1', [giveawayId]);
          if (rows.length === 0) {
            return interaction.editReply({ content: '❌ Giveaway not found or has ended.' });
          }

          const giveaway = rows[0];

          // Check if giveaway has ended
          if (new Date() > new Date(giveaway.end_time)) {
            return interaction.editReply({ content: '❌ This giveaway has already ended.' });
          }


          // Check if user already joined
          const participants = giveaway.participants || [];
          if (participants.includes(interaction.user.id)) {
            return interaction.editReply({ content: '❌ You have already joined this giveaway!' });
          }

          // Check if user has enough balance
          const { rows: userRows } = await db.query('SELECT balance FROM users WHERE id = $1', [interaction.user.id]);
          const userBalance = userRows[0]?.balance || 0;

          if (userBalance < giveaway.entry_cost) {
            return interaction.editReply({
              content: `❌ You need **${giveaway.entry_cost.toLocaleString('en-US')}** 💰 to join this giveaway. You only have **${userBalance.toLocaleString('en-US')}** 💰.`
            });
          }

          // Check if user has excluded roles
          const userRoleIds = interaction.member.roles.cache.map(role => role.id);
          const hasExcludedRole = userRoleIds.some(roleId => EXCLUDED_GIVEAWAY_ROLES.includes(roleId));

          if (hasExcludedRole) {
            return interaction.editReply({
              content: `❌ You cannot join this giveaway due to your current roles. Please contact an administrator if you believe this is an error.`
            });
          }

          // Deduct entry cost from user and add to pool
          await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [giveaway.entry_cost, interaction.user.id]);
          await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [giveaway.entry_cost, interaction.guildId]);


          // Add user to participants
          participants.push(interaction.user.id);
          await db.query('UPDATE giveaways SET participants = $1 WHERE id = $2', [participants, giveawayId]);

          // Update the giveaway embed to show new participant count
          await updateGiveawayEmbed(giveawayId, participants.length);

          await interaction.editReply({
            content: `✅ You have successfully joined the giveaway! **${giveaway.entry_cost.toLocaleString('en-US')}** 💰 entry cost deducted from your balance.`
          });

          logActivity('🎁 Giveaway Joined', `<@${interaction.user.id}> joined giveaway for **${giveaway.entry_cost.toLocaleString('en-US')}** 💰 entry cost.`, 'Blue');

        } catch (error) {
          console.error('Error joining giveaway:', error);
          await interaction.editReply({ content: '❌ An error occurred while joining the giveaway.' });
        }
      }
    }
  }
});

// Web server to keep the bot alive on hosting platforms like Koyeb/Railway
const app = express();
const port = process.env.PORT || 8080;

// Middleware to log incoming health check requests
app.use((req, res, next) => {
  console.log(`[${new Date().toUTCString()}] Received a ping to keep the bot alive.`);
  next();
});

app.get('/', (req, res) => {
  res.send('Sovereign Pounds bot is alive!');
});

// API endpoint to get real-time Discord server stats
app.get('/api/guild-info', async (req, res) => {
  try {
    // Enable CORS for Vercel
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    if (!client.isReady()) {
      return res.status(503).json({
        error: 'Bot not ready',
        serverName: 'Heavens of Glory',
        status: 'Offline',
        totalMembers: 0,
        onlineMembers: 0,
        notes: 'Bot is starting up...'
      });
    }

    const guildId = process.env.GUILD_ID;
    if (!guildId) {
      return res.status(500).json({ error: 'Guild ID not configured' });
    }

    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Fetch all members to count online status
    const members = await guild.members.fetch();
    const onlineCount = members.filter(m =>
      !m.user.bot &&
      ['online', 'dnd', 'idle'].includes(m.presence?.status)
    ).size;

    const totalMembers = guild.memberCount;

    res.json({
      serverName: guild.name,
      status: 'Online',
      totalMembers: totalMembers,
      onlineMembers: onlineCount,
      notes: `Serving ${totalMembers} members`
    });

  } catch (error) {
    console.error('[API /guild-info] Error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch guild info',
      details: error.message,
      serverName: 'Heavens of Glory',
      status: 'Error',
      totalMembers: 0,
      onlineMembers: 0,
      notes: 'Unable to fetch server data'
    });
  }
});

app.listen(port, () => console.log(`Health check server listening on port ${port}`));

// --- Healthchecks.io Ping ---
function setupHealthchecksPing() {
  const healthcheckUrl = process.env.HEALTHCHECK_URL;
  if (!healthcheckUrl) {
    console.log('HEALTHCHECK_URL not found, skipping Healthchecks.io setup.');
    return;
  }

  console.log('Setting up ping to Healthchecks.io...');
  // Ping immediately on start and then every 50 seconds
  const ping = () => {
    fetch(healthcheckUrl)
      .then(res => {
        if (res.ok) {
          console.log(`[${new Date().toUTCString()}] Successfully pinged Healthchecks.io.`);
        } else {
          console.error(`[${new Date().toUTCString()}] Failed to ping Healthchecks.io. Status: ${res.status}`);
        }
      })
      .catch(err => console.error('Failed to ping Healthchecks.io:', err.message));
  };

  ping();
  setInterval(ping, 50 * 1000); // 50 seconds
}


// --- Giveaway Functions ---
async function updateGiveawayEmbed(giveawayId, participantCount) {
  try {
    const { rows } = await db.query('SELECT * FROM giveaways WHERE id = $1', [giveawayId]);
    if (rows.length === 0) return;

    const giveaway = rows[0];
    const channel = await client.channels.fetch(giveaway.channel_id);
    if (!channel) return;

    // Find the giveaway message
    const messages = await channel.messages.fetch({ limit: 50 });
    const giveawayMessage = messages.find(msg =>
      msg.embeds.length > 0 &&
      msg.embeds[0].footer &&
      msg.embeds[0].footer.text &&
      msg.embeds[0].footer.text.includes(giveawayId)
    );

    if (!giveawayMessage) return;

    // Create updated embed
    const prizePerWinner = Math.floor((giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count) / giveaway.winner_count);

    // Check if there are enough participants and set appropriate color/warning
    const hasEnoughParticipants = participantCount >= giveaway.winner_count;
    const embedColor = hasEnoughParticipants ? 'Gold' : 'Orange';
    const warningText = !hasEnoughParticipants ? `\n\n⚠️ **Warning:** Need at least ${giveaway.winner_count} participants! (Currently: ${participantCount})` : '';

    const updatedEmbed = new EmbedBuilder()
      .setTitle('🎉 Giveaway! 🎉')
      .setDescription(`**Total Prize:** ${(giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count).toLocaleString('en-US')} 💰\n**Prize per Winner:** ${prizePerWinner.toLocaleString('en-US')} 💰\n**Entry Cost:** ${giveaway.entry_cost.toLocaleString('en-US')} 💰\n**Participants:** ${participantCount}\n**Winners:** ${giveaway.winner_count}\n**Ends:** <t:${Math.floor(new Date(giveaway.end_time).getTime() / 1000)}:R>${warningText}`)
      .setColor(embedColor)
      .setFooter({ text: `Giveaway ID: ${giveawayId}` })
      .setTimestamp();

    const joinButton = new ButtonBuilder()
      .setCustomId(`join_giveaway_${giveawayId}`)
      .setLabel(`Join Giveaway (${giveaway.entry_cost.toLocaleString('en-US')} 💰)`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎁');

    const row = new ActionRowBuilder().addComponents(joinButton);

    await giveawayMessage.edit({ embeds: [updatedEmbed], components: [row] });

  } catch (error) {
    console.error('Error updating giveaway embed:', error);
  }
}

async function cancelGiveaway(giveawayId, reason = 'Cancelled') {
  try {
    const { rows } = await db.query('SELECT * FROM giveaways WHERE id = $1 AND ended = FALSE', [giveawayId]);
    if (rows.length === 0) return;

    const giveaway = rows[0];
    const participants = giveaway.participants || [];

    // Refund all participants their entry cost
    for (const participantId of participants) {
      await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [participantId]);
      await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [giveaway.entry_cost, participantId]);
    }

    // Return the original prize amount to pool (if no participants joined)
    if (participants.length === 0) {
      await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [giveaway.entry_cost * giveaway.winner_count, giveaway.guild_id]);
    }

    // Mark giveaway as ended
    await db.query('UPDATE giveaways SET ended = TRUE WHERE id = $1', [giveawayId]);

    // Send cancellation message to the channel
    try {
      const channel = await client.channels.fetch(giveaway.channel_id);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('❌ Giveaway Cancelled')
          .setDescription(`**Prize:** ${giveaway.prize}\n**Reason:** ${reason}\n**Participants:** ${participants.length}\n\n${participants.length > 0 ? `All participants have been refunded **${giveaway.entry_cost.toLocaleString('en-US')}** 💰 each.` : 'No participants joined this giveaway.'}`)
          .setColor('Red')
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Error sending giveaway cancellation message:', error);
    }

    logActivity('❌ Giveaway Cancelled', `Giveaway **${giveaway.prize}** was cancelled (${reason}). ${participants.length} participants refunded.`, 'Red');

  } catch (error) {
    console.error('Error cancelling giveaway:', error);
  }
}

async function endGiveaway(giveawayId) {
  try {
    const { rows } = await db.query('SELECT * FROM giveaways WHERE id = $1 AND ended = FALSE', [giveawayId]);
    if (rows.length === 0) return;

    const giveaway = rows[0];
    const participants = giveaway.participants || [];

    if (participants.length === 0) {
      // No participants, refund to pool
      await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [giveaway.entry_cost * giveaway.winner_count, giveaway.guild_id]);
      await db.query('UPDATE giveaways SET ended = TRUE WHERE id = $1', [giveawayId]);

      const channel = await client.channels.fetch(giveaway.channel_id);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 Giveaway Ended')
          .setDescription(`**Prize:** ${giveaway.prize}\n**Result:** No participants joined this giveaway.\n**Refund:** ${(giveaway.entry_cost * giveaway.winner_count).toLocaleString('en-US')} 💰 returned to server pool.`)
          .setColor('Red')
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }
      return;
    }

    // Check if there are enough participants for the number of winners
    if (participants.length < giveaway.winner_count) {
      // Not enough participants - cancel giveaway and refund everyone
      for (const participantId of participants) {
        await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [participantId]);
        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [giveaway.entry_cost, participantId]);
      }

      // Return the prize amount to pool
      const totalPrize = giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count;
      await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [totalPrize, giveaway.guild_id]);

      // Mark giveaway as ended
      await db.query('UPDATE giveaways SET ended = TRUE WHERE id = $1', [giveawayId]);

      // Send cancellation message
      const channel = await client.channels.fetch(giveaway.channel_id);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('❌ Giveaway Cancelled')
          .setDescription(`**Reason:** Not enough participants!\n**Participants:** ${participants.length}\n**Required Winners:** ${giveaway.winner_count}\n\nAll participants have been refunded their entry cost (${giveaway.entry_cost.toLocaleString('en-US')} 💰 each).\nThe prize amount (${totalPrize.toLocaleString('en-US')} 💰) has been returned to the server pool.`)
          .setColor('Red')
          .setFooter({ text: `Giveaway ID: ${giveawayId}` })
          .setTimestamp();
        await channel.send({ embeds: [embed] });
      }

      logActivity('❌ Giveaway Cancelled', `Giveaway **${totalPrize.toLocaleString('en-US')} 💰** cancelled due to insufficient participants (${participants.length}/${giveaway.winner_count}). All participants refunded.`, 'Red');
      return;
    }

    // Select winners
    const shuffled = participants.sort(() => 0.5 - Math.random());
    const winners = shuffled.slice(0, Math.min(giveaway.winner_count, participants.length));

    // Give rewards to winners
    const prizePerWinner = Math.floor((giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count) / giveaway.winner_count);
    for (const winnerId of winners) {
      await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [winnerId]);
      await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [prizePerWinner, winnerId]);
    }

    // Send ephemeral congratulations to each winner
    const giveawayChannel = await client.channels.fetch(giveaway.channel_id);
    if (giveawayChannel) {
      for (const winnerId of winners) {
        try {
          const winnerEmbed = new EmbedBuilder()
            .setTitle('🎉 Congratulations! You Won! 🎉')
            .setDescription(`**🎁 You won the giveaway!**\n\n**💰 Prize Received:** ${prizePerWinner.toLocaleString('en-US')} 💰\n**🏆 Total Winners:** ${winners.length}\n**👥 Total Participants:** ${participants.length}\n\nYour prize has been added to your balance! Enjoy your winnings! 🎊`)
            .setColor('Gold')
            .setFooter({ text: `Giveaway ID: ${giveawayId}` })
            .setTimestamp();

          // Try to send ephemeral message to the winner
          const winner = await client.users.fetch(winnerId);
          if (winner) {
            await winner.send({
              content: `🎉 **Congratulations!** You won the giveaway in <#${giveawayChannel.id}>! 🎊`,
              embeds: [winnerEmbed]
            });
          }
        } catch (error) {
          console.log(`Could not send DM to winner ${winnerId}:`, error.message);
          // If DM fails, we'll continue with other winners
        }
      }
    }

    // Update giveaway as ended
    await db.query('UPDATE giveaways SET ended = TRUE, winners = $1 WHERE id = $2', [winners, giveawayId]);

    // Send winner announcement message
    const channel = await client.channels.fetch(giveaway.channel_id);
    if (channel) {
      const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
      const totalPrize = giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count;

      const winnerEmbed = new EmbedBuilder()
        .setTitle('🎉 GIVEAWAY ENDED! 🎉')
        .setDescription(`**🎁 Total Prize Pool:** ${totalPrize.toLocaleString('en-US')} 💰\n**👥 Participants:** ${participants.length}\n**🏆 Winner(s):** ${winnerMentions}\n\n**💰 Each winner received:** ${prizePerWinner.toLocaleString('en-US')} 💰!\n\nCongratulations to the winners! 🎊`)
        .setColor('Gold')
        .setFooter({ text: `Giveaway ID: ${giveawayId}` })
        .setTimestamp();

      await channel.send({
        content: `🎉 **GIVEAWAY RESULTS** 🎉\n\n**Winner(s):** ${winnerMentions}\n\nCongratulations! 🎊`,
        embeds: [winnerEmbed]
      });
    }

    logActivity('🎁 Giveaway Ended', `Giveaway **${(giveaway.total_prize || giveaway.entry_cost * giveaway.winner_count).toLocaleString('en-US')} 💰** ended with ${participants.length} participants. Winners: ${winners.join(', ')}`, 'Gold');

  } catch (error) {
    console.error('Error ending giveaway:', error);
  }
}

async function startBot() {
  try {
    // Ensure the database is initialized before logging in
    await initializeDatabase();

    // Log in to Discord
    await client.login(process.env.DISCORD_TOKEN);

    // Set up the keep-alive ping if configured
    setupHealthchecksPing();
  } catch (error) {
    console.error('Failed to start the bot:', error);
    process.exit(1);
  }
}

startBot();