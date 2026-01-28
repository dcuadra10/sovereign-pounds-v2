require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType, PermissionFlagsBits, AttachmentBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ActivityType } = require('discord.js');
const { pool: db, initializeDatabase } = require('./database');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Prevent process crashes on unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Custom Emojis Configuration (Reverted to Unicode)
/*
const EMOJIS = {
  coin: '💰',
  ticket: '🎫',
  check: '✅',
  cross: '❌',
  lock: '🔒',
  gear: '⚙️',
  gift: '🎁',
  tada: '🎉'
};
*/
// Using Unicode literals in code.

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

// Helper function to safely check if a member has administrator permission
function hasAdminPermission(member) {
  if (!member) return false;

  // Explicitly allow Guild Owner
  if (member.guild && member.guild.ownerId === member.id) {
    return true;
  }

  const perms = member.permissions;
  if (!perms) return false;
  // Handle both cases: permissions as BitField object or as a raw bigint/string
  if (typeof perms.has === 'function') {
    return perms.has(PermissionFlagsBits.Administrator);
  }
  // Fallback: try to interpret as bigint
  try {
    return (BigInt(perms) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
  } catch {
    return false;
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
const ticketCreationSessions = new Map(); // userId -> { catId, answers: [] }

// Configuration: Roles that cannot join giveaways (from .env)
const EXCLUDED_GIVEAWAY_ROLES = (process.env.EXCLUDED_GIVEAWAY_ROLES || 'bot,bots,muted,banned,restricted,excluded').split(',');

// Configuration: Default role to ping for giveaways (from .env)
const DEFAULT_GIVEAWAY_PING_ROLE = process.env.DEFAULT_GIVEAWAY_PING_ROLE;

// --- Logging Function ---
async function logActivity(title, message, color = 'Blue', attachment = null, guildId = null) {
  let logChannelId = process.env.LOG_CHANNEL_ID;

  if (guildId) {
    try {
      const { rows } = await safeQuery('SELECT log_channel_id FROM guild_configs WHERE guild_id = $1', [guildId]);
      if (rows.length > 0 && rows[0].log_channel_id) {
        logChannelId = rows[0].log_channel_id;
      }
    } catch (e) { console.error('Error fetching log channel:', e); }
  }

  if (!logChannelId) return;

  try {
    const channel = await client.channels.fetch(logChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(message)
        .setColor(color)
        .setTimestamp();

      const payload = { embeds: [embed] };
      if (attachment) payload.files = [attachment];

      await channel.send(payload);
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


async function logItemPurchaseToSheet(username, itemName, price) {
  const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;
  if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) return;

  try {
    const jwt = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, jwt);
    await doc.loadInfo();

    const sheetTitle = 'Product Sales';
    let sheet = doc.sheetsByTitle[sheetTitle];

    if (!sheet) {
      sheet = await doc.addSheet({ title: sheetTitle, headerValues: ['Timestamp', 'User', 'Item', 'Price'] });
    } else {
      try { await sheet.loadHeaderRow(); } catch (e) { }
      if (!sheet.headerValues || sheet.headerValues.length === 0) {
        await sheet.setHeaderRow(['Timestamp', 'User', 'Item', 'Price']);
      }
    }

    await sheet.addRow({
      Timestamp: new Date().toLocaleString('en-US', { timeZone: 'UTC' }),
      User: username,
      Item: itemName,
      Price: price
    });
    console.log(`Successfully logged item purchase to "${sheetTitle}".`);
  } catch (error) {
    console.error('Error logging item purchase:', error);
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

// Helper function to seed the shop with default items
// Helper function to seed the shop with default items
async function seedShop() {
  try {
    console.log('🛍️ Checking shop defaults...');
    const defaults = [
      { name: 'Gold Package', price: 10, emoji: '🪙', description: '50,000 Gold', resource: 'gold', quantity: 50000 },
      { name: 'Wood Package', price: 10, emoji: '🪵', description: '150,000 Wood', resource: 'wood', quantity: 150000 },
      { name: 'Food Package', price: 10, emoji: '🌽', description: '150,000 Food', resource: 'food', quantity: 150000 },
      { name: 'Stone Package', price: 10, emoji: '🪨', description: '112,000 Stone', resource: 'stone', quantity: 112000 },
    ];

    for (const item of defaults) {
      const { rows } = await safeQuery('SELECT * FROM shop_items WHERE name = $1', [item.name]);
      if (rows.length === 0) {
        console.log(`Adding missing default item: ${item.name}`);
        // Calculate ID manually for Postgres compatibility without sequence
        const { rows: maxRows } = await safeQuery('SELECT MAX(id) as max_id FROM shop_items');
        const nextId = (maxRows[0]?.max_id || 0) + 1;

        await safeQuery(
          'INSERT INTO shop_items (id, name, price, emoji, description, resource_type, quantity, requires_ticket, stock) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, -1)',
          [nextId, item.name, item.price, item.emoji, item.description, item.resource, item.quantity]
        );
      }
    }
  } catch (error) {
    console.error('Error seeding shop:', error);
  }
}

// Helper to update presence
const updateBotPresence = () => {
  const serverCount = client.guilds.cache.size;
  client.user.setPresence({
    activities: [{ name: `${serverCount} Server${serverCount !== 1 ? 's' : ''}`, type: ActivityType.Watching }],
    status: 'online'
  });
};

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  updateBotPresence();

  client.guilds.cache.forEach(async (guild) => {
    try {
      const invites = await guild.invites.fetch();
      invites.forEach(invite => {
        cachedInvites.set(invite.code, invite.uses);
      });
    } catch (err) {
      console.log(`Failed to fetch invites for guild ${guild.name}: ${err.message}`);
    }
  });

  // Seed the shop if empty
  await seedShop();

  // Database Migrations (Auto-Add Columns for Advanced Ticket Features)
  try {
    await db.query(`ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS claim_enabled BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS reward_role_id VARCHAR(255)`);
    await db.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by_id VARCHAR(255)`);
    console.log('✅ Database schema updated (Ticket Features: Claim/Reward/Dashboard).');
  } catch (e) {
    console.error('Schema update error:', e);
  }

  // Initial Dashboard Update
  // Initial Dashboard Update for all guilds that have config
  client.guilds.cache.forEach(guild => updateTicketDashboard(guild));
});

client.on(Events.GuildCreate, () => updateBotPresence());
client.on(Events.GuildDelete, () => updateBotPresence());



// QOTD Scheduler
setInterval(async () => {
  const now = new Date();
  // Check if it's 00:00 UTC
  if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
    const dateStr = now.toISOString().split('T')[0];

    try {
      // Check for question
      const { rows } = await db.query('SELECT * FROM qotd_questions WHERE date = $1 AND posted = 0', [dateStr]);
      if (rows.length > 0) {
        const qotd = rows[0];

        // Fetch settings
        const { rows: settingsRows } = await db.query('SELECT * FROM qotd_settings');

        for (const settings of settingsRows) {
          const guild = client.guilds.cache.get(settings.guild_id);
          if (!guild) continue;

          const channel = guild.channels.cache.get(settings.channel_id);
          if (channel && channel.isTextBased()) {
            const rolePing = settings.role_id ? `<@&${settings.role_id}>` : '';

            const embed = new EmbedBuilder()
              .setTitle('❓ Question of the Day')
              .setDescription(qotd.question)
              .setColor('Gold')
              .setFooter({ text: `Date: ${dateStr}` });

            const msg = await channel.send({ content: rolePing, embeds: [embed] });

            // Create Thread
            await msg.startThread({
              name: `QOTD: ${dateStr}`,
              autoArchiveDuration: 1440
            });

            console.log(`✅ QOTD posted for ${dateStr} in ${guild.name}`);
          }
        }

        // Mark as posted
        await db.query('UPDATE qotd_questions SET posted = 1 WHERE id = $1', [qotd.id]);
      }
    } catch (err) {
      console.error('Error in QOTD scheduler:', err);
    }
  }
}, 60 * 1000); // Check every minute

// Backup Cleanup Scheduler (Check every hour)
setInterval(async () => {
  try {
    // Delete backups older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { rowCount } = await safeQuery('DELETE FROM ticket_transcripts WHERE closed_at < $1', [sevenDaysAgo]);
    if (rowCount > 0) {
      console.log(`🗑️ Deleted ${rowCount} old ticket backups.`);
    }
  } catch (err) {
    console.error('Error cleaning up backups:', err);
  }
}, 60 * 60 * 1000);


/* Welcome Module Removed */

async function updateTicketDashboard(guild) {
  const ticketerChannelId = '1413983349969780787'; // Dashboard Channel
  const channel = guild.channels.cache.get(ticketerChannelId);
  if (!channel) return;

  try {
    const { rows: tickets } = await db.query(`
            SELECT t.*, tc.emoji, tc.name as cat_name 
            FROM tickets t 
            LEFT JOIN ticket_categories tc ON t.category_id = tc.id 
            WHERE t.closed = FALSE
            ORDER BY t.created_at DESC
        `);

    // Build Description
    const description = tickets.length > 0 ? tickets.map(t => {
      const claimStatus = t.claimed_by_id ? `🔒 Claimed by <@${t.claimed_by_id}>` : '👐 Unclaimed';
      // Discord timestamps are cool too
      // <t:${Math.floor(new Date(t.created_at).getTime()/1000)}:R>
      return `> **<#${t.channel_id}>** • <@${t.user_id}> • ${t.emoji || '🎫'} ${t.cat_name}\n> ╚ ${claimStatus}\n`;
    }).join('\n') : '✅ **No active tickets.** Good job team!';

    const embed = new EmbedBuilder()
      .setTitle('📋 Active Ticket Dashboard')
      .setDescription(description)
      .setColor('Blurple')
      .setFooter({ text: `Last Updated: ${new Date().toLocaleTimeString()}` });

    // Search for existing dashboard message to edit to avoid spam
    // We look for the last message by the bot in this channel
    const messages = await channel.messages.fetch({ limit: 10 });
    const dashboardMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === '📋 Active Ticket Dashboard');

    if (dashboardMsg) {
      await dashboardMsg.edit({ embeds: [embed] });
    } else {
      // Delete clutter if possible? No.
      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Error updating dashboard:', e);
  }
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // --- Leveling System (Message XP) ---
  if (message.guild) {
    // Check cooldown (e.g. 1 minute)
    // We need to fetch 'last_xp_time' from DB. This might be heavy for every message.
    // Optimization: Cache or just query. Queries are 1-2ms on local inv-mem. Postgres is fast.
    // But let's check config first.

    // We'll optimistically fetch user_levels first as it contains last_xp_time.
    // But we need to know if it's enabled.
    // Let's rely on a memory cache for configs eventually. For now, DB query.

    // To reduce DB load, we process XP only if user is in cache or randomly? No, robustness first.

    (async () => {
      try {
        const { rows: configRows } = await safeQuery('SELECT leveling_enabled, xp_rate_message FROM guild_configs WHERE guild_id = $1', [message.guildId]);
        if (configRows.length && configRows[0].leveling_enabled) {
          const xpRate = configRows[0].xp_rate_message || 20;

          const { rows: userRows } = await safeQuery('SELECT last_xp_time FROM user_levels WHERE guild_id = $1 AND user_id = $2', [message.guildId, message.author.id]);
          const lastTime = userRows[0]?.last_xp_time;

          const now = new Date();
          if (!lastTime || (now - new Date(lastTime)) > 10000) { // 10s cooldown
            await addXp(message.guildId, message.author.id, xpRate, message.channel);
          }
        }
      } catch (e) { console.error('XP Error:', e); }
    })();
  }


  // --- Ticket Interview Logic ---
  if (message.channel.isThread()) {
    const { rows } = await safeQuery('SELECT * FROM tickets WHERE channel_id = $1 AND closed = FALSE', [message.channelId]);
    if (rows.length > 0) {
      const ticket = rows[0];
      let pendingQs = [];
      try {
        if (ticket.pending_questions) {
          pendingQs = typeof ticket.pending_questions === 'string' ? JSON.parse(ticket.pending_questions) : ticket.pending_questions;
        }
      } catch (e) { }

      if (pendingQs && Array.isArray(pendingQs) && pendingQs.length > 0) {
        const currentIndex = ticket.current_question_index || 0;

        if (currentIndex < pendingQs.length) {
          let answers = [];
          try {
            if (ticket.answers) {
              answers = typeof ticket.answers === 'string' ? JSON.parse(ticket.answers) : ticket.answers;
            }
          } catch (e) { }

          const currentQ = pendingQs[currentIndex]; // Object {text, type, options}

          let answerContent = message.content;

          // Validation for File Type
          if (currentQ.type === 'file') {
            if (message.attachments.size === 0) {
              // If strict, we could return here and ask for file.
              // For now, let's accept text if they didn't upload, or maybe they posted a link.
              // But let's check attachments
            } else {
              answerContent = message.attachments.first().url;
            }
          }

          answers.push({ question: currentQ.text, answer: answerContent });

          const nextIndex = currentIndex + 1;

          await safeQuery('UPDATE tickets SET answers = $1, current_question_index = $2 WHERE channel_id = $3', [JSON.stringify(answers), nextIndex, message.channelId]);

          // Proceed to next step
          if (nextIndex < pendingQs.length) {
            // Ask next question
            const nextQ = pendingQs[nextIndex];
            const embed = new EmbedBuilder()
              .setTitle(`Question ${nextIndex + 1}/${pendingQs.length}`)
              .setDescription(nextQ.text)
              .setColor('Blue');

            const components = [];
            if (nextQ.type === 'dropdown' && nextQ.options) {
              const select = new StringSelectMenuBuilder()
                .setCustomId('ticket_interview_dropdown')
                .setPlaceholder('Select an option...')
                .addOptions(nextQ.options.map(opt => ({ label: opt, value: opt })));
              components.push(new ActionRowBuilder().addComponents(select));
            } else if (nextQ.type === 'file') {
              embed.setFooter({ text: 'Please upload a file/image as your answer.' });
            }

            await message.channel.send({ embeds: [embed], components: components });
          } else {
            // Finished!
            await safeQuery('UPDATE tickets SET pending_questions = NULL WHERE channel_id = $1', [message.channelId]);

            const formattedAnswers = answers.map((a, i) => `**${i + 1}. ${a.question}**\n${a.answer}`).join('\n\n');

            const { rows: catRows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [ticket.category_id]);
            const category = catRows[0];
            const rolePing = category ? `<@&${category.staff_role_id}>` : '';

            const embed = new EmbedBuilder()
              .setTitle('✅ Application Completed')
              .setDescription(`**Applicant:** <@${message.author.id}>\n\n${formattedAnswers}`)
              .setColor('Green')
              .setFooter({ text: 'Interview Complete' });

            const closeButtons = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
              new ButtonBuilder().setCustomId('close_ticket_reason_btn').setLabel('Close with Reason').setStyle(ButtonStyle.Secondary).setEmoji('📝')
            );

            await message.channel.send({ content: `${rolePing} <@${message.author.id}> has completed the application!`, embeds: [embed], components: [closeButtons] });
          }
        }
      }
    }
  }

  await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [message.author.id]);

  /*
  // Increment total message count
  const { rows } = await db.query(`
      INSERT INTO message_counts (user_id, count, rewarded_messages)
      VALUES ($1, 1, 0)
      ON CONFLICT (user_id)
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count, rewarded_messages
  `, [message.author.id]);

  const { count, rewarded_messages } = rows[0];
  */

  // Increment total and daily message count  
  const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const { rows } = await db.query(`
      INSERT INTO message_counts (user_id, count, rewarded_messages, daily_count, last_message_date)
      VALUES ($1, 1, 0, 1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET 
        count = message_counts.count + 1,
        daily_count = CASE 
          WHEN message_counts.last_message_date = $2 THEN message_counts.daily_count + 1 
          ELSE 1 
        END,
        last_message_date = $2
      RETURNING count, rewarded_messages
  `, [message.author.id, todayStr]);

  const { count, rewarded_messages } = rows[0];
  const unrewardedCount = count - rewarded_messages;

  if (unrewardedCount >= 100) {
    const rewardsToGive = Math.floor(unrewardedCount / 100);
    const totalReward = rewardsToGive * 5;
    await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [totalReward, message.author.id]);
    await db.query('UPDATE message_counts SET rewarded_messages = rewarded_messages + $1 WHERE user_id = $2', [rewardsToGive * 100, message.author.id]);
    logActivity('💬 Message Reward', `<@${message.author.id}> received **${totalReward}** 💰 for sending ${rewardsToGive * 100} messages.`, 'Green');
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
          const hoursToReward = Math.floor(unrewardedMinutes / 60);
          const totalReward = hoursToReward * 20;
          await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [totalReward, member.id]);
          await db.query('UPDATE voice_times SET rewarded_minutes = rewarded_minutes + $1 WHERE user_id = $2', [hoursToReward * 60, member.id]);

          logActivity('🎙️ Voice Reward', `<@${member.id}> received **${totalReward}** 💰 for spending ${hoursToReward} hour(s) in voice channels.`, 'Green');
        }

        // --- Leveling System (Voice XP) ---
        // Reward per minute (tracked in minutes variable) is tricky because 'minutes' in DB is cumulative total.
        // But here we just calculated 'minutesSpent' (diff).
        // Wait, the logic above (lines 680-700) tracks 'minutes' for currency rewards which resets or accumulates?
        // Ah, logic: 'minutes' is total. 'rewarded_minutes' is tracked.
        // We can replicate logic for XP or just give XP for minutesSpent.

        // We don't have 'minutesSpent' variable exposed easily in lines 690-700 without reading the diff.
        // The diff is implied by 'minutes - rewarded_minutes'.
        // Currency is given per HOUR (60 mins).
        // XP should be per MINUTE. 

        // Use separate query/logic for XP or hook into the update?
        // Let's hook into the "minute update" logic if it exists. 
        // Currently, the bot updates voice_times on JOIN/LEAVE.
        // If someone is in VC for 5 hours, they get rewards on LEAVE?
        // Line 704: `} else if (!oldState.channelId && newState.channelId) { // joined`
        // Line 651: `if (oldState.channelId && !newState.channelId) { // left`
        // It calculates duration on LEAVE.

        const durationMs = Date.now() - startTime;
        const minutesSpent = Math.floor(durationMs / 1000 / 60);

        if (minutesSpent > 0) {
          // Get rate
          const { rows: configRows } = await safeQuery('SELECT xp_rate_voice FROM guild_configs WHERE guild_id = $1', [member.guild.id]);
          const xpRateVoice = configRows[0]?.xp_rate_voice || 10;
          const xpToGive = Math.floor(minutesSpent * xpRateVoice);
          if (xpToGive > 0) {
            await addXp(member.guild.id, member.id, xpToGive);
          }
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
        logActivity('🚀 Server Boost Reward', `<@${newMember.id}> received **${reward}** 💰 for **${newBoosts}** new boost(s).`, 'Gold');
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

      logActivity('🚀 Server Boost Reward', `<@${newMember.id}> received **${reward}** 💰 for **${newBoosts}** new boost(s).`, 'Gold');
    }
  }
});

client.on('guildMemberAdd', async member => {
  try {
    const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [member.guild.id]);
    const config = rows[0];
    if (!config) return;

    // 1. Auto-Role
    if (config.auto_role_id) {
      const role = member.guild.roles.cache.get(config.auto_role_id);
      if (role) {
        await member.roles.add(role).catch(err => console.error(`Failed to assign auto-role to ${member.user.tag}:`, err));
      }
    }

    // 2. Welcome Message
    if (config.welcome_enabled && config.welcome_channel_id) {
      const channel = member.guild.channels.cache.get(config.welcome_channel_id);
      if (channel && channel.isTextBased()) {
        const msgContent = (config.welcome_message || 'Welcome {user} to {guild}!')
          .replace(/{user}/g, `<@${member.id}>`)
          .replace(/{guild}/g, member.guild.name)
          .replace(/{memberCount}/g, member.guild.memberCount)
          .replace(/{avatar}/g, member.user.displayAvatarURL({ dynamic: true }));

        const embed = new EmbedBuilder()
          .setDescription(msgContent)
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
          .setColor('Blurple')
          .setTimestamp();

        if (config.welcome_image_url) {
          embed.setImage(config.welcome_image_url);
        }

        // If message contains basic text outside embed?
        // Usually people want a ping outside embed.
        // We can regex for {user} to decide content vs embed description?
        // For simplicity: Content = Ping, Embed = Message.

        await channel.send({ content: `Welcome <@${member.id}>!`, embeds: [embed] });
      }
    }
  } catch (err) {
    console.error('Error in guildMemberAdd:', err);
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
  console.log(`Received interaction: type=${interaction.type}, command=${interaction.commandName}, customId=${interaction.customId}, user=${interaction.user.tag}`);

  if (interaction.isAutocomplete()) {
    const commandName = interaction.commandName;
    if (commandName === 'ticket-category') {
      const focusedValue = interaction.options.getFocused();
      try {
        const { rows } = await safeQuery(
          'SELECT name FROM ticket_categories WHERE guild_id = $1 AND name ILIKE $2 LIMIT 25',
          [interaction.guildId, `%${focusedValue}%`]
        );
        const choices = rows.map(row => row.name);
        await interaction.respond(
          choices.map(choice => ({ name: choice, value: choice }))
        );
      } catch (error) {
        console.error('Error handling autocomplete:', error);
      }
    }
    return;
  }

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
          `🪨 Stone: ${(row?.stone || 0).toLocaleString('en-US')}`
        );


      await interaction.editReply({ embeds: [embed] });
    } else if (commandName === 'shop') {
      try {
        // Fetch shop items from database
        const { rows: items } = await safeQuery('SELECT * FROM shop_items ORDER BY price ASC');

        // Check balance
        const { rows: userRows } = await safeQuery('SELECT balance FROM users WHERE users.id = $1', [interaction.user.id]);
        const balance = userRows[0]?.balance || 0;

        let description = `Select an item below to purchase.\n\n💰 **Your Balance:** ${balance.toLocaleString('en-US')} 💰\n\n`;

        if (items.length > 0) {
          description += `**__Available Items__**\n`;
          items.slice(0, 20).forEach(item => {
            const stockDisplay = item.stock === -1 ? '♾️ Infinite' : item.stock;
            const itemDesc = item.description ? `\n> *${item.description}*` : '';
            description += `> ${item.emoji || '📦'} **${item.name}** \`ID: ${item.id}\` — **${item.price.toLocaleString('en-US')}** 💰\n> 📦 Stock: ${stockDisplay}${itemDesc}\n\n`;
          });
          if (items.length > 20) description += `\n*(...and ${items.length - 20} more items in the menu)*`;
        } else {
          description += '\n🚫 The shop is currently empty.';
        }

        const embed = new EmbedBuilder()
          .setColor('Blue')
          .setTitle(`💰 Sovereign Empire Shop`)
          .setDescription(description.substring(0, 4096));

        if (items.length === 0) {
          return await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('shop_buy_select')
          .setPlaceholder('Browse the catalog...');

        // Discord limits Select Menu to 25 items
        items.slice(0, 25).forEach(item => {
          // Parse emoji: If it's a custom ID string, use it. If unicode, use it.
          // StringSelectMenuOptionBuilder setEmoji accepts ID or Unicode.
          // My EMOJIS const has full string `<:name:id>`. extract ID.
          let emojiIdOrChar = '📦';
          if (item.emoji) {
            const match = item.emoji.match(/:(\d+)>/);
            emojiIdOrChar = match ? match[1] : item.emoji;
          }

          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(`${item.name}`)
              .setValue(item.id.toString())
              .setDescription(`${item.price.toLocaleString('en-US')} 💰 - ${item.description || ''}`.substring(0, 100))
              .setEmoji(emojiIdOrChar)
          );
        });

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });

      } catch (error) {
        console.error('Error in shop command:', error);
        await interaction.reply({ content: `❌ An error occurred while opening the shop.`, ephemeral: true });
      }

    } else if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setTitle(`💰 Sovereign Empire Bot Help`)
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
\`/shop-add\` \`/shop-remove\`
\`/giveaway\` \`/add-emoji\`
\`/ticket-setup\` \`/reset-all\``)
        .setFooter({ text: 'Sovereign Empire Economy', iconURL: interaction.guild.iconURL() });

      await interaction.reply({ embeds: [embed] });
    } else if (commandName === 'daily') {
      const subcommand = interaction.options.getSubcommand(false) || 'claim'; // Default to claim if no subcommand for backward compatibility if possible, though Discord usually enforces it.

      if (subcommand === 'stats') {
        await interaction.deferReply();
        const targetUser = interaction.options.getUser('user') || interaction.user;
        // Query message_counts for daily_count and last_message_date
        const todayStr = new Date().toISOString().split('T')[0];

        const { rows } = await db.query('SELECT daily_count, last_message_date FROM message_counts WHERE user_id = $1', [targetUser.id]);
        const row = rows[0];

        let dailyCount = 0;
        if (row && row.last_message_date === todayStr) {
          dailyCount = row.daily_count || 0;
        }

        await interaction.editReply({
          content: `📅 **Daily Stats for ${targetUser.username}**\n\n💬 Messages sent today (since 00:00 UTC): **${dailyCount}**`
        });
      } else {
        // Default: Claim
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
          logActivity(`🎁 Daily Reward`, `<@${userId}> claimed their daily reward of **${reward}** 💰 (Streak: ${streak}).`, 'Aqua');
        } catch (err) {
          console.error(err);
          return await interaction.editReply({ content: '❌ An error occurred while processing your daily reward.' });
        }
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
            { name: '💬 Lifetime Messages', value: `**${totalMessages.toLocaleString('en-US')}** sent\n(${messageProgress}/100 for next reward)`, inline: true },
            { name: '🎙️ Lifetime Voice Chat', value: `**${totalVoiceMinutes}** minutes\n(${voiceProgress}/60 for next reward)`, inline: true }
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
        const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
        const adminRole = configRows[0]?.admin_role_id;
        if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
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
        await interaction.editReply({ content: `❌ An error occurred while giving currency.` });
      }

    } else if (commandName === 'take') {
      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
        const adminRole = configRows[0]?.admin_role_id;
        if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
          return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
        }

        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getNumber('amount');

        if (!targetUser || !amount || amount <= 0) {
          return await interaction.editReply({ content: '❌ Invalid user or amount provided.' });
        }

        const userBalanceResult = await db.query('SELECT balance FROM users WHERE id = $1', [targetUser.id]);
        const userBalance = userBalanceResult.rows[0]?.balance || 0;

        if (userBalance < amount) {
          return await interaction.editReply({ content: `❌ The user only has **${userBalance.toLocaleString('en-US')}** 💰.` });
        }

        await db.query('UPDATE server_stats SET pool_balance = pool_balance + $1 WHERE id = $2', [amount, interaction.guildId]);
        await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, targetUser.id]);

        await interaction.editReply({ content: `✅ Successfully took **${amount.toLocaleString('en-US')}** 💰 from ${targetUser}.` });
        logActivity('💸 Admin Take', `<@${interaction.user.id}> took **${amount.toLocaleString('en-US')}** 💰 from ${targetUser}.`, 'Orange');
      } catch (error) {
        console.error('Error taking currency:', error);
        await interaction.editReply({ content: `❌ An error occurred while taking currency.` });
      }

    } else if (commandName === 'take-resource') {
      try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
        const adminRole = configRows[0]?.admin_role_id;
        if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
          return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
        }

        const targetUser = interaction.options.getUser('user');
        const resource = interaction.options.getString('resource'); // wood, food, stone, gold
        const amount = interaction.options.getInteger('amount');

        if (!targetUser || !amount || amount <= 0) {
          return await interaction.editReply({ content: '❌ Invalid user or amount provided.' });
        }

        // Check user balance
        const { rows: userRows } = await safeQuery(`SELECT ${resource} FROM users WHERE id = $1`, [targetUser.id]);
        const currentAmount = userRows[0]?.[resource] || 0;

        if (currentAmount < amount) {
          return await interaction.editReply({ content: `❌ User only has **${currentAmount.toLocaleString('en-US')}** ${resource}.` });
        }

        await safeQuery(`UPDATE users SET ${resource} = ${resource} - $1 WHERE id = $2`, [amount, targetUser.id]);

        await interaction.editReply({ content: `✅ Successfully took **${amount.toLocaleString('en-US')}** ${resource} from ${targetUser}.` });
        logActivity('🪵 Admin Take Resource', `<@${interaction.user.id}> took **${amount.toLocaleString('en-US')}** ${resource} from ${targetUser}.`, 'Orange', null, interaction.guildId);

      } catch (error) {
        console.error('Error taking resource:', error);
        await interaction.editReply({ content: `❌ An error occurred while taking resources.` });
      }

    } else if (commandName === 'shop-add') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const name = interaction.options.getString('name');
      const price = interaction.options.getNumber('price');
      const emoji = interaction.options.getString('emoji') || '📦';
      const description = interaction.options.getString('description');
      const role = interaction.options.getRole('role');
      const resource = interaction.options.getString('resource');
      const quantity = interaction.options.getInteger('quantity') || 1;
      const requiresTicket = interaction.options.getBoolean('requires_ticket') || false;

      try {
        const { rows: maxRows } = await safeQuery('SELECT MAX(id) as max_id FROM shop_items');
        const nextId = (maxRows[0]?.max_id || 0) + 1;

        await safeQuery(
          'INSERT INTO shop_items (id, name, price, emoji, description, role_id, resource_type, quantity, requires_ticket, stock) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, -1)',
          [nextId, name, price, emoji, description, role?.id, resource, quantity, requiresTicket ? 1 : 0]
        );

        await interaction.reply({ content: `✅ Added **${name}** to the shop for ${price} 💰.`, ephemeral: true });
      } catch (error) {
        console.error('Error adding shop item:', error);
        await interaction.reply({ content: `❌ Failed to add item.`, ephemeral: true });
      }

    } else if (commandName === 'shop-remove') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const id = interaction.options.getInteger('id');
      try {
        await safeQuery('DELETE FROM shop_items WHERE id = $1', [id]);
        await interaction.reply({ content: `✅ Removed shop item ID **${id}**.`, ephemeral: true });
      } catch (error) {
        console.error('Error removing shop item:', error);
        await interaction.reply({ content: `❌ Failed to remove item.`, ephemeral: true });
      }

    } else if (commandName === 'shop-stock') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });
      }

      const id = interaction.options.getInteger('id');
      const amountStr = interaction.options.getString('amount');

      let amount;
      let setInfinite = false;

      if (['inf', 'infinite', 'unlimited'].includes(amountStr.toLowerCase())) {
        setInfinite = true;
        amount = 0;
      } else {
        amount = parseShorthand(amountStr);
      }

      if (isNaN(amount) && !setInfinite) {
        return interaction.reply({ content: '❌ Invalid amount format (use 1k, 1m, 100, or "inf").', ephemeral: true });
      }

      try {
        const { rows } = await safeQuery('SELECT * FROM shop_items WHERE id = $1', [id]);
        if (rows.length === 0) return interaction.reply({ content: '❌ Item not found.', ephemeral: true });

        const current = rows[0].stock;
        let newStock;

        if (setInfinite) {
          newStock = -1;
        } else if (current === -1) {
          // Switching from infinite to finite
          newStock = amount;
          if (newStock < 0) newStock = 0;
        } else {
          newStock = current + amount;
          if (newStock < 0) newStock = 0;
        }

        await safeQuery('UPDATE shop_items SET stock = $1 WHERE id = $2', [newStock, id]);
        await interaction.reply({ content: `✅ Updated stock for **${rows[0].name}**. Old: ${current === -1 ? 'Infinite' : current}, Added: ${amount}, New: **${newStock}**.` });
      } catch (e) {
        console.error(e);
        interaction.reply({ content: '❌ Error updating stock.', ephemeral: true });
      }

    } else if (commandName === 'qotd-setup') {
      await interaction.deferReply({ ephemeral: true });
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.editReply({ content: '🚫 Admin only.' });

      const channel = interaction.options.getChannel('channel');
      const role = interaction.options.getRole('role');

      await safeQuery(`
            INSERT INTO qotd_settings (guild_id, channel_id, role_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2, role_id = $3
        `, [interaction.guildId, channel.id, role.id]);

      await interaction.editReply({ content: `✅ QOTD configured: Channel ${channel}, Role ${role}.` });

    } else if (commandName === 'qotd-add') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });

      const dateStr = interaction.options.getString('date');
      const question = interaction.options.getString('question');

      // Validate date
      // Validate date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return interaction.reply({ content: '❌ Invalid date format. Use YYYY-MM-DD.', ephemeral: true });
      }

      const { rows: maxRows } = await safeQuery('SELECT MAX(id) as max_id FROM qotd_questions');
      const nextId = (maxRows[0]?.max_id || 0) + 1;

      await safeQuery('INSERT INTO qotd_questions (id, date, question) VALUES ($1, $2, $3)', [nextId, dateStr, question]);
      await interaction.reply({ content: `✅ Scheduled QOTD for **${dateStr}**: "${question}"`, ephemeral: true });

    } else if (commandName === 'qotd-list') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });

      const { rows } = await safeQuery('SELECT * FROM qotd_questions WHERE posted = 0 ORDER BY date ASC LIMIT 20');

      if (rows.length === 0) return interaction.reply({ content: 'No pending questions.', ephemeral: true });

      const description = rows.map(q => `**ID ${q.id}** (${q.date}): ${q.question.substring(0, 50)}...`).join('\n');
      const embed = new EmbedBuilder().setTitle('📅 Scheduled QOTD').setDescription(description).setColor('Gold');
      await interaction.reply({ embeds: [embed], ephemeral: true });

    } else if (commandName === 'qotd-remove') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });

      const id = interaction.options.getInteger('id');
      await safeQuery('DELETE FROM qotd_questions WHERE id = $1', [id]);
      await interaction.reply({ content: `✅ Removed question ID **${id}**.`, ephemeral: true });

    } else if (commandName === 'ticket-setup') {
      await interaction.deferReply({ ephemeral: true });

      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return await interaction.editReply({ content: '🚫 You do not have permission to use this command.' });
      }

      const channel = interaction.options.getChannel('channel');

      // Fetch categories
      const { rows: categories } = await db.query('SELECT * FROM ticket_categories WHERE guild_id = $1 ORDER BY id ASC', [interaction.guildId]);

      const validCategories = categories.filter(cat => cat.id != null).slice(0, 25);

      if (validCategories.length === 0) {
        return await interaction.editReply({ content: '❌ No valid ticket categories found. Please use `/ticket-category add` first.' });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('ticket_select')
        .setPlaceholder('Select a category to open a ticket');

      validCategories.forEach(cat => {
        if (cat.id != null) {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(cat.name)
            .setValue(cat.id.toString());

          // Handle custom emojis for Select Menu
          const customEmojiMatch = (cat.emoji || '').match(/<a?:.+:(\d+)>/);
          if (customEmojiMatch) {
            option.setEmoji(customEmojiMatch[1]); // Use ID
          } else {
            // Basic check: if it's purely ASCII text (letters/numbers) and not a known unicode symbol, it's likely invalid text like ":smile:"
            // Emojis are typically multi-byte.
            const isAscii = /^[\x00-\x7F]*$/.test(cat.emoji || '');
            if (isAscii && (cat.emoji || '').length > 0) {
              // It's likely invalid text, fallback
              option.setEmoji('🎫');
            } else {
              option.setEmoji(cat.emoji || '🎫');
            }
          }

          selectMenu.addOptions(option);
        }
      });

      const row = new ActionRowBuilder().addComponents(selectMenu);

      const panelEmbed = new EmbedBuilder()
        .setColor('2B2D31')
        .setDescription('# 🎫 Tickets\nSelect a category to contact support.');

      const sentMessage = await channel.send({ embeds: [panelEmbed], components: [row] });

      // Save panel info to update it later
      await db.query(`
        INSERT INTO ticket_panels_v2 (guild_id, channel_id, message_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
      `, [interaction.guildId, channel.id, sentMessage.id]);

      await interaction.editReply({ content: `✅ Ticket panel created in ${channel}.` });

    } else if (commandName === 'ticket-category') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'edit') {
        const currentName = interaction.options.getString('name');
        const newName = interaction.options.getString('new_name');
        const newRole = interaction.options.getRole('role');
        const newEmoji = interaction.options.getString('emoji');
        const editQuestions = interaction.options.getBoolean('edit_questions');

        const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE guild_id = $1 AND name = $2', [interaction.guildId, currentName]);
        if (rows.length === 0) {
          return await interaction.reply({ content: `❌ Category **${currentName}** not found.`, ephemeral: true });
        }
        const categoryId = rows[0].id;

        // If editQuestions is requested, launch wizard logic for questions
        if (editQuestions) {
          await interaction.reply({ content: `🧙‍♂️ Launching question editor for **${currentName}**...`, ephemeral: true });
          try {
            const thread = await interaction.channel.threads.create({
              name: `edit-questions-${currentName}`,
              type: ChannelType.PrivateThread,
              autoArchiveDuration: 60,
              reason: 'Edit Ticket Questions'
            });
            await thread.members.add(interaction.user.id);

            let questions = [];
            try {
              const rawData = rows[0].form_questions;
              if (Array.isArray(rawData)) {
                questions = rawData;
              } else if (rawData && typeof rawData === 'string' && rawData.trim().length > 0) {
                questions = JSON.parse(rawData);
              }
            } catch (e) {
              console.error('Error parsing existing questions:', e);
              questions = [];
            }

            const embed = new EmbedBuilder()
              .setTitle(`Edit Questions: ${currentName}`)
              .setDescription(`Current Questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n') || 'None'}`)
              .setColor('Purple');

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`wizard_add_single_q_${categoryId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId(`wizard_delete_q_menu_${categoryId}`).setLabel('Delete Question').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(`wizard_clear_q_${categoryId}`).setLabel('Clear All').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`wizard_finish_${categoryId}`).setLabel('Finish').setStyle(ButtonStyle.Success)
            );

            await thread.send({ embeds: [embed], components: [row] });
            await interaction.editReply({ content: `✅ Question editor started: <#${thread.id}>` });
          } catch (err) {
            console.error('Error starting question editor:', err);
            await interaction.editReply({ content: '❌ Failed to create editor thread.' });
          }
        }

        const updates = [];
        const params = [];
        let paramIndex = 1;

        if (newName) {
          updates.push(`name = $${paramIndex}`);
          params.push(newName);
          paramIndex++;
        }
        if (newRole) {
          updates.push(`staff_role_id = $${paramIndex}`);
          params.push(newRole.id);
          paramIndex++;
        }
        if (newEmoji) {
          updates.push(`emoji = $${paramIndex}`);
          params.push(newEmoji);
          paramIndex++;
        }

        if (updates.length > 0) {
          params.push(interaction.guildId);
          params.push(currentName);
          const query = `UPDATE ticket_categories SET ${updates.join(', ')} WHERE guild_id = $${paramIndex} AND name = $${paramIndex + 1}`;
          await safeQuery(query, params);
          if (!editQuestions) {
            await interaction.reply({ content: `✅ Category **${currentName}** updated.`, ephemeral: true });
          }
        } else {
          if (!editQuestions) {
            await interaction.reply({ content: '⚠️ No changes requested.', ephemeral: true });
          }
        }

      } else if (subcommand === 'remove') {
        const name = interaction.options.getString('name');
        await db.query('DELETE FROM ticket_categories WHERE guild_id = $1 AND name = $2', [interaction.guildId, name]);
        await interaction.reply({ content: `✅ Category **${name}** removed.`, ephemeral: true });
      }

    } else if (commandName === 'ticket-wizard') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        console.log('[Wizard Debug] Permission denied.');
        return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      await interaction.reply({ content: '🧙‍♂️ Starting Ticket Wizard...', ephemeral: true });
      console.log('[Wizard Debug] Reply sent. Creating thread...');

      try {
        // Create private thread
        const thread = await interaction.channel.threads.create({
          name: 'ticket-creation-zone',
          type: ChannelType.PrivateThread,
          autoArchiveDuration: 60,
          reason: 'Ticket Setup Wizard'
        });
        console.log(`[Wizard Debug] Thread created: ${thread.id}`);

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

      // Log the closure
      logActivity(
        '🔒 Ticket Closed',
        `**Ticket:** ${interaction.channel.name}\n**Closed by:** <@${interaction.user.id}>\n**Owner:** <@${ticket.user_id}>\n**Reason:** No reason provided.`,
        'Red'
      );

      // Create Transcript
      try {
        let transcriptText = `TRANSCRIPT FOR TICKET: ${interaction.channel.name} (${interaction.channelId})\n`;
        transcriptText += `USER: ${ticket.user_id}\n`;
        transcriptText += `CLOSED BY: ${interaction.user.tag} (${interaction.user.id})\n`;
        transcriptText += `REASON: No reason provided.\n`;
        transcriptText += `DATE: ${new Date().toISOString()}\n`;
        transcriptText += `--------------------------------------------------\n\n`;

        if (ticket.pending_questions && ticket.answers) {
          // Interview Mode
          const answers = typeof ticket.answers === 'string' ? JSON.parse(ticket.answers) : ticket.answers;
          answers.forEach((a, i) => {
            transcriptText += `Q${i + 1}: ${a.question}\nA: ${a.answer}\n\n`;
          });
        }

        // Fetch last 100 messages for context if needed (optional simple text dump)
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        messages.reverse().forEach(m => {
          transcriptText += `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content} ${m.attachments.size > 0 ? '[Attachment]' : ''}\n`;
        });

        // Save to Backup Table
        await db.query(
          'INSERT INTO ticket_transcripts (channel_id, guild_id, user_id, transcript, reason, closed_by, closed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
          [interaction.channelId, interaction.guildId, ticket.user_id, transcriptText, 'No reason provided.', interaction.user.id]
        );
      } catch (err) {
        console.error('Error creating transcript:', err);
      }

      // Delete thread after 5 seconds
      setTimeout(async () => {
        try {
          await thread.delete();
        } catch (err) {
          console.error('Failed to delete ticket thread:', err);
        }
      }, 5000);

    } else if (commandName === 'set-bot-profile') {
      if (!hasAdminPermission(interaction.member)) {
        return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const newUsername = interaction.options.getString('username');
      const newAvatar = interaction.options.getAttachment('avatar');

      const updates = [];

      try {
        if (newUsername) {
          await client.user.setUsername(newUsername);
          updates.push(`✅ Username updated to **${newUsername}**`);
        }

        if (newAvatar) {
          if (!newAvatar.contentType.startsWith('image/')) {
            updates.push(`❌ Invalid file type for avatar. Please upload an image.`);
          } else {
            await client.user.setAvatar(newAvatar.url);
            updates.push(`✅ Avatar updated successfully.`);
          }
        }

        if (updates.length === 0) {
          await interaction.editReply({ content: '⚠️ No changes were provided.' });
        } else {
          await interaction.editReply({ content: updates.join('\n') });
        }

      } catch (error) {
        console.error('Error updating profile:', error);
        // Discord rate limits these changes heavily (2 per hour)
        if (error.code === 50035) {
          await interaction.editReply({ content: `❌ Invalid form body. Ensure requirements are met.` });
        } else if (error.status === 429) {
          await interaction.editReply({ content: `❌ You are being rate limited. Discord only allows changing username/avatar 2 times per hour.` });
        } else {
          await interaction.editReply({ content: `❌ An error occurred: ${error.message}` });
        }
      }

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
    } else if (commandName === 'ticket-panel-edit') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const channel = interaction.options.getChannel('channel');
      const messageId = interaction.options.getString('message_id');
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const imageUrl = interaction.options.getString('image_url');
      const thumbnailUrl = interaction.options.getString('thumbnail_url');

      try {
        if (!channel.isTextBased()) return interaction.reply({ content: 'Invalid channel type.', ephemeral: true });
        const message = await channel.messages.fetch(messageId);
        if (!message) return interaction.reply({ content: 'Message not found.', ephemeral: true });

        if (message.author.id !== client.user.id) return interaction.reply({ content: 'I can only edit my own messages.', ephemeral: true });

        const oldEmbed = message.embeds[0];
        if (!oldEmbed) return interaction.reply({ content: 'Message has no embed to edit.', ephemeral: true });

        const newEmbed = EmbedBuilder.from(oldEmbed);
        if (title) newEmbed.setTitle(title);
        if (description) newEmbed.setDescription(description);
        if (imageUrl) newEmbed.setImage(imageUrl);
        if (thumbnailUrl) newEmbed.setThumbnail(thumbnailUrl);

        await message.edit({ embeds: [newEmbed] });
        await interaction.reply({ content: '✅ Ticket panel updated successfully.', ephemeral: true });

      } catch (error) {
        console.error('Error editing panel:', error);
        await interaction.reply({ content: `❌ Failed to edit panel: ${error.message}`, ephemeral: true });
      }

    } else if (commandName === 'setup') {
      // Main Configuration Wizard Entry Point
      if (!hasAdminPermission(interaction.member)) {
        return interaction.reply({ content: '❌ You need Administrator permissions to use this.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle('🛠️ ALL in One Configuration')
        .setDescription('Select a module to configure for this server.')
        .addFields(
          { name: '📢 Welcome Module', value: 'Customize welcome messages, images, and auto-roles.', inline: true },
          { name: '🎫 Ticket System', value: 'Manage support tickets and panels.', inline: true },
          { name: '🛡️ Logging', value: 'Set up audit logs for server events.', inline: true },
          { name: '📈 Leveling System', value: 'Configure XP rates and level-up rewards.', inline: true }
        )
        .setColor('Blurple')
        .setFooter({ text: 'All In One Bot • Setup Wizard' });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_btn').setLabel('Welcome').setStyle(ButtonStyle.Primary).setEmoji('📢'),
        new ButtonBuilder().setCustomId('setup_tickets_btn').setLabel('Tickets').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
        new ButtonBuilder().setCustomId('setup_logs_btn').setLabel('Logging').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
        new ButtonBuilder().setCustomId('setup_levels_btn').setLabel('Leveling').setStyle(ButtonStyle.Success).setEmoji('📈')
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_admin_btn').setLabel('Admin Role').setStyle(ButtonStyle.Secondary).setEmoji('👮'),
        new ButtonBuilder().setCustomId('setup_giveaways_btn').setLabel('Giveaways').setStyle(ButtonStyle.Secondary).setEmoji('🎁'),
        new ButtonBuilder().setCustomId('setup_close_btn').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌')
      );

      await interaction.editReply({ embeds: [embed], components: [row1, row2] });

    } else if (commandName === 'reset-all') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
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

    } else if (commandName === 'export-data') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        // Fetch all users data
        const { rows: users } = await safeQuery('SELECT * FROM users');
        const { rows: messageCounts } = await safeQuery('SELECT * FROM message_counts');
        const { rows: voiceTimes } = await safeQuery('SELECT * FROM voice_times');
        const { rows: invites } = await safeQuery('SELECT * FROM invites');
        const { rows: boosts } = await safeQuery('SELECT * FROM boosts');

        // Create CSV content
        let csv = 'User ID,Balance,Gold,Wood,Food,Stone,Last Daily,Daily Streak,Messages,Voice Minutes,Invites,Boosts\n';

        // Create a map for quick lookups
        const msgMap = new Map(messageCounts.map(m => [m.user_id, m.count || 0]));
        const voiceMap = new Map(voiceTimes.map(v => [v.user_id, v.minutes || 0]));
        const inviteMap = new Map(invites.map(i => [i.user_id, i.invites || 0]));
        const boostMap = new Map(boosts.map(b => [b.user_id, b.boosts || 0]));

        for (const user of users) {
          const msgs = msgMap.get(user.id) || 0;
          const voice = voiceMap.get(user.id) || 0;
          const inv = inviteMap.get(user.id) || 0;
          const boost = boostMap.get(user.id) || 0;

          csv += `${user.id},${user.balance || 0},${user.gold || 0},${user.wood || 0},${user.food || 0},${user.stone || 0},${user.last_daily || ''},${user.daily_streak || 0},${msgs},${voice},${inv},${boost}\n`;
        }

        const buffer = Buffer.from(csv, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `export-${interaction.guildId}-${Date.now()}.csv` });

        await interaction.editReply({
          content: `📊 **Data Export Complete!**\n\nExported **${users.length}** user records.`,
          files: [attachment]
        });
      } catch (error) {
        console.error('Error exporting data:', error);
        await interaction.editReply({ content: `❌ Error exporting data: ${error.message}` });
      }

    } else if (commandName === 'ticket-backup') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });
      }

      const ticketId = interaction.options.getString('ticket_id');

      // If no ID provided, show list of all closed tickets with pagination
      if (!ticketId) {
        // Count total
        const { rows: countRows } = await safeQuery('SELECT COUNT(*) as total FROM ticket_transcripts WHERE guild_id = $1', [interaction.guildId]);
        const totalTickets = parseInt(countRows[0]?.total || 0);

        if (totalTickets === 0) {
          return interaction.reply({ content: '📭 No ticket backups found for this server.', ephemeral: true });
        }

        const page = 0;
        const perPage = 25;
        const totalPages = Math.ceil(totalTickets / perPage);

        const { rows: allTranscripts } = await safeQuery('SELECT channel_id, user_id, reason, closed_at FROM ticket_transcripts WHERE guild_id = $1 ORDER BY closed_at DESC LIMIT $2 OFFSET $3', [interaction.guildId, perPage, page * perPage]);

        const options = allTranscripts.map(t =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`Ticket ${t.channel_id.slice(-6)}`)
            .setDescription(`User: ${t.user_id} | ${t.reason?.substring(0, 50) || 'No reason'}`)
            .setValue(t.channel_id)
        );

        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_ticket_backup')
            .setPlaceholder('Select a ticket to view')
            .addOptions(options)
        );

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ticket_backup_page_${page - 1}`).setLabel('⬅️ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('ticket_backup_info').setLabel(`Page ${page + 1}/${totalPages} (${totalTickets} total)`).setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId(`ticket_backup_page_${page + 1}`).setLabel('Next ➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );

        return interaction.reply({ content: '📂 **Select a ticket backup to view:**', components: [selectRow, buttonRow], ephemeral: true });
      }

      const { rows } = await safeQuery('SELECT * FROM ticket_transcripts WHERE channel_id = $1', [ticketId]);

      if (rows.length === 0) return interaction.reply({ content: '❌ Backup not found or expired (backups are kept for 7 days).', ephemeral: true });

      const transcript = rows[0];
      const buffer = Buffer.from(transcript.transcript || 'No Content', 'utf-8');

      const attachment = new AttachmentBuilder(buffer, { name: `transcript-${transcript.channel_id}.txt` });

      const embed = new EmbedBuilder()
        .setTitle('📂 Ticket Transcript')
        .setDescription(`**Ticket ID:** ${transcript.channel_id}\n**User:** <@${transcript.user_id}>\n**Closed By:** <@${transcript.closed_by}>\n**Reason:** ${transcript.reason}\n**Date:** <t:${Math.floor(new Date(transcript.closed_at).getTime() / 1000)}:f>`)
        .setColor('Blue');

      await interaction.reply({ embeds: [embed], files: [attachment], ephemeral: true });


    } else if (commandName === 'giveaway') {
      const { rows: configRows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const adminRole = configRows[0]?.admin_role_id;
      if (!hasAdminPermission(interaction.member) && !(adminRole && interaction.member.roles.cache.has(adminRole))) {
        return interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const duration = interaction.options.getString('duration');
      const totalPrize = interaction.options.getNumber('total_prize');
      const winnerCount = interaction.options.getInteger('winners') || 1;
      const entryCost = interaction.options.getNumber('entry_cost') || 10;

      let pingRole = interaction.options.getRole('ping_role');

      // Automatic fallback removed per user request

      const modal = new ModalBuilder()
        .setCustomId(`giveaway_modal_${Date.now()}_${pingRole ? pingRole.id : 'none'}`)
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
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_ticket_backup') {
      const channelId = interaction.values[0];
      const { rows } = await safeQuery('SELECT transcript FROM ticket_transcripts WHERE channel_id = $1', [channelId]);
      if (rows.length === 0) return interaction.reply({ content: '❌ Transcript not found.', ephemeral: true });

      const transcript = rows[0].transcript;
      const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), { name: `transcript-${channelId}.txt` });

      await interaction.reply({ content: `📜 **Transcript for Ticket ${channelId}**`, files: [attachment], ephemeral: true });

    } else if (interaction.customId === 'shop_buy_select') {
      const itemId = interaction.values[0];
      try {
        const { rows } = await safeQuery('SELECT * FROM shop_items WHERE id = $1', [itemId]);
        if (rows.length === 0) return interaction.reply({ content: `❌ Item no longer exists.`, ephemeral: true });
        const item = rows[0];


        // Stock Check
        if (item.stock !== -1 && item.stock <= 0) {
          return interaction.reply({ content: `❌ This item is currently out of stock.`, ephemeral: true });
        }

        const { rows: userRows } = await safeQuery('SELECT balance FROM users WHERE id = $1', [interaction.user.id]);
        const balance = userRows[0]?.balance || 0;

        if (balance < item.price) {
          return interaction.reply({ content: `❌ Insufficient funds. You need **${item.price.toLocaleString('en-US')}** 💰 to buy **${item.name}**.`, ephemeral: true });
        }

        await safeQuery('UPDATE users SET balance = balance - $1 WHERE id = $2', [item.price, interaction.user.id]);

        // Decrement Stock
        if (item.stock !== -1) {
          await safeQuery('UPDATE shop_items SET stock = stock - 1 WHERE id = $1', [item.id]);
        }

        let rewardMsg = '';
        if (item.resource_type) {
          const colName = item.resource_type.toLowerCase();
          if (['gold', 'wood', 'food', 'stone'].includes(colName)) {
            const qty = item.quantity || 1;
            await safeQuery(`UPDATE users SET ${colName} = ${colName} + $1 WHERE id = $2`, [qty, interaction.user.id]);
            await logPurchaseToSheet(interaction.user.tag, colName, qty, item.price);
            rewardMsg = `Received **${qty.toLocaleString('en-US')}** ${item.resource_type}.`;
          } else {
            await logItemPurchaseToSheet(interaction.user.tag, item.name, item.price);
          }
        } else {
          await logItemPurchaseToSheet(interaction.user.tag, item.name, item.price);
        }

        if (item.role_id) {
          const role = interaction.guild.roles.cache.get(item.role_id);
          if (role) {
            await interaction.member.roles.add(role);
            rewardMsg += ` Assigned role **${role.name}**.`;
          }
        }

        if (item.requires_ticket) {
          try {
            const safeName = (item.name || 'item').replace(/[^a-zA-Z0-9-]/g, '');
            const threadName = `order-${interaction.user.username}-${safeName}`.substring(0, 32);

            const thread = await interaction.channel.threads.create({
              name: threadName,
              type: ChannelType.PrivateThread,
              autoArchiveDuration: 1440,
              reason: 'Shop Purchase Ticket'
            });
            await thread.members.add(interaction.user.id);

            const orderEmbed = new EmbedBuilder()
              .setTitle('🛍️ New Order')
              .setDescription(`User <@${interaction.user.id}> purchased **${item.name}**.\n\n**Price:** ${item.price.toLocaleString('en-US')} 💰\n**Status:** Paid ✅\n\nPlease describe your request below. Staff will be with you shortly.`)
              .setColor('Green');

            const adminIds = (process.env.ADMIN_IDS || '').split(',');
            const adminPings = adminIds.map(id => `<@${id}>`).join(' ');

            await thread.send({ content: `${adminPings} <@${interaction.user.id}>`, embeds: [orderEmbed] });
            rewardMsg += `\n🎫 **Ticket created:** <#${thread.id}>`;
          } catch (error) {
            console.error('Failed to create ticket thread:', error);
            rewardMsg += `\n⚠️ Failed to create ticket (Check permissions).`;
          }
        }

        // Update the shop embed with new balance
        try {
          const { rows: updatedCols } = await safeQuery('SELECT balance FROM users WHERE id = $1', [interaction.user.id]);
          const newBalance = updatedCols[0]?.balance || 0;

          const oldEmbed = interaction.message.embeds[0];
          if (oldEmbed && oldEmbed.description) {
            const newDescription = oldEmbed.description.replace(
              /💰 \*\*Your Balance:\*\* [\d,.]+ 💰/,
              `💰 **Your Balance:** ${newBalance.toLocaleString('en-US')} 💰`
            );

            const newEmbed = EmbedBuilder.from(oldEmbed).setDescription(newDescription);
            await interaction.message.edit({ embeds: [newEmbed] });
          }
        } catch (e) {
          console.error("Failed to update shop message balance:", e);
        }

        await interaction.reply({ content: `✅ Successfully purchased **${item.name}** for **${item.price.toLocaleString('en-US')}** 💰.\n${rewardMsg}`, ephemeral: true });
        logActivity('🛒 Shop Purchase', `<@${interaction.user.id}> bought **${item.name}** for ${item.price} 💰.\n${rewardMsg}`, 'Blue');

      } catch (err) {
        console.error(err);
        interaction.reply({ content: `❌ Transaction failed.`, ephemeral: true });
      }
    } else if (interaction.customId === 'ticket_select') {
      await initiateTicketCreation(interaction, interaction.values[0]);
    } else if (interaction.customId === 'ticket_select_legacy') {
      const catId = interaction.values[0];
      console.log(`[Ticket Select] User ${interaction.user.tag} selected category ID: ${catId}`);
      try {
        const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
        if (rows.length === 0) {
          console.log('[Ticket Select] Category not found in DB.');
          return interaction.reply({ content: 'Category not found.', ephemeral: true });
        }

        const category = rows[0];
        console.log(`[Ticket Select] Found category: ${category.name}`);
        let parsedQs = category.form_questions;
        if (typeof parsedQs === 'string') try { parsedQs = JSON.parse(parsedQs); } catch (e) {
          console.error('[Ticket Select] Error parsing questions JSON:', e);
        }
        if (!Array.isArray(parsedQs)) parsedQs = [];

        if (parsedQs.length === 0) parsedQs = ['Please describe your request:'];

        console.log(`[Ticket Select] Questions to ask: ${parsedQs.length}`);

        // Initialize session
        const totalPages = Math.ceil(parsedQs.length / 5);
        ticketCreationSessions.set(interaction.user.id, {
          catId: catId,
          questions: parsedQs,
          answers: [],
          totalPages: totalPages
        });

        // Show first modal (Page 0)
        const modal = new ModalBuilder()
          .setCustomId(`modal_ticket_submit_${catId}_0`)
          .setTitle(`Open Ticket: ${category.name.substring(0, 45)}`);

        parsedQs.slice(0, 5).forEach((q, i) => {
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`q_${i}`)
              .setLabel(q.length > 45 ? q.substring(0, 42) + '...' : q)
              .setPlaceholder(q.substring(0, 100))
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ));
        });

        await interaction.showModal(modal);
        // Reset the select menu
        await interaction.message.edit({ components: interaction.message.components });
        console.log('[Ticket Select] Modal Page 0 shown.');

        /*
        if (parsedQs.length > 5) {
          // Legacy Interview Mode Code Removed
        }
        */
        return;

        /* Legacy Single Page Modal Logic Removed (Combined above) */
      } catch (err) {
        console.error('[Ticket Select] Error opening form:', err);
      }
    } else if (interaction.customId === 'select_welcome_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET welcome_channel_id = $1 WHERE guild_id = $2', [channelId, interaction.guildId]);
      await interaction.update({ content: `✅ Welcome channel set to <#${channelId}>.`, components: [] });
      // Re-render welcome menu
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: (config.welcome_message ? config.welcome_message.substring(0, 1000) : 'Default: "Welcome {user} to {guild}!"') + '\n\n*Variables: {user}, {guild}, {memberCount}, {avatar}*' })
        .setColor('Green');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.message.edit({ embeds: [embed], components: [row1, row2] });
    } else if (interaction.customId === 'select_welcome_autorole') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET auto_role_id = $1 WHERE guild_id = $2', [roleId, interaction.guildId]);
      await interaction.update({ content: `✅ Auto-role set to <@&${roleId}>.`, components: [] });
      // Re-render welcome menu
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: (config.welcome_message ? config.welcome_message.substring(0, 1000) : 'Default: "Welcome {user} to {guild}!"') + '\n\n*Variables: {user}, {guild}, {memberCount}, {avatar}*' })
        .setColor('Green');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.message.edit({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'modal_setup_levels_msg') {
      const rate = parseFloat(interaction.fields.getTextInputValue('xp_rate'));
      if (isNaN(rate) || rate < 0) return interaction.reply({ content: '❌ Invalid rate.', ephemeral: true });
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET xp_rate_message = $1 WHERE guild_id = $2', [rate, interaction.guildId]);
      await interaction.update({ content: `✅ Message XP set to ${rate}.`, components: [] });
      // Logic to refresh UI skipped for brevity, user can re-open menu or we can duplicate refresh logic. 
      // For better UX, we should refresh.
      // (Refreshing logic is identical to above, maybe I should have made a function...)

    } else if (interaction.customId === 'modal_setup_levels_voice') {
      const rate = parseFloat(interaction.fields.getTextInputValue('xp_rate'));
      if (isNaN(rate) || rate < 0) return interaction.reply({ content: '❌ Invalid rate.', ephemeral: true });
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET xp_rate_voice = $1 WHERE guild_id = $2', [rate, interaction.guildId]);
      await interaction.update({ content: `✅ Voice XP set to ${rate}.`, components: [] });

    } else if (interaction.customId === 'modal_setup_levels_voice') {
      const rate = parseFloat(interaction.fields.getTextInputValue('xp_rate'));
      if (isNaN(rate) || rate < 0) return interaction.reply({ content: '❌ Invalid rate.', ephemeral: true });
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET xp_rate_voice = $1 WHERE guild_id = $2', [rate, interaction.guildId]);
      await interaction.update({ content: `✅ Voice XP set to ${rate}.`, components: [] });

    } else if (interaction.customId === 'modal_setup_levels_reward_lvl') {
      const level = parseInt(interaction.fields.getTextInputValue('level_input'));
      if (isNaN(level) || level <= 0) return interaction.reply({ content: '❌ Invalid level.', ephemeral: true });

      const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`select_levels_reward_role_${level}`)
          .setPlaceholder(`Select Role for Level ${level}`)
      );
      await interaction.reply({ content: `Select the role to receive at Level ${level}:`, components: [row], ephemeral: true });

    } else if (interaction.customId.startsWith('select_levels_reward_role_')) {
      const level = parseInt(interaction.customId.split('_')[4]);
      const roleId = interaction.values[0];

      await db.query('INSERT INTO level_rewards (guild_id, level, role_id) VALUES ($1, $2, $3)', [interaction.guildId, level, roleId]);
      await interaction.update({ content: `✅ Role <@&${roleId}> set for Level ${level}.`, components: [] });

    } else if (interaction.customId === 'select_levels_remove_reward') {
      const idToDelete = interaction.values[0];
      await db.query('DELETE FROM level_rewards WHERE id = $1', [idToDelete]);
      await interaction.update({ content: '✅ Reward removed.', components: [] });

    } else if (interaction.customId === 'select_levels_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET level_up_channel_id = $1 WHERE guild_id = $2', [channelId, interaction.guildId]);
      await interaction.update({ content: `✅ Level Up channel set to <#${channelId}>.`, components: [] });

    } else if (interaction.customId === 'select_logs_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET log_channel_id = $1 WHERE guild_id = $2', [channelId, interaction.guildId]);
      await interaction.update({ content: `✅ Log channel set to <#${channelId}>.`, components: [] });

    } else if (interaction.customId === 'select_admin_role') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET admin_role_id = $1 WHERE guild_id = $2', [roleId, interaction.guildId]);
      await interaction.update({ content: `✅ Admin role set to <@&${roleId}>.`, components: [] });

    } else if (interaction.customId === 'modal_setup_sheet_id') {
      const sheetId = interaction.fields.getTextInputValue('sheet_id');
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET spreadsheet_id = $1 WHERE guild_id = $2', [sheetId, interaction.guildId]);
      await interaction.update({ content: `✅ Spreadsheet ID saved. Make sure you invited the bot's email!`, components: [] });

    } else if (interaction.customId === 'select_giveaway_role') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET giveaway_role_id = $1 WHERE guild_id = $2', [roleId, interaction.guildId]);
      await interaction.update({ content: `✅ Giveaway ping role set to <@&${roleId}>.`, components: [] });

    } else if (interaction.customId === 'select_ticket_backup') {
      const ticketId = interaction.values[0];
      const { rows } = await safeQuery('SELECT * FROM ticket_transcripts WHERE channel_id = $1', [ticketId]);

      if (rows.length === 0) return interaction.update({ content: '❌ Backup not found.', components: [] });

      const transcript = rows[0];
      const buffer = Buffer.from(transcript.transcript || 'No Content', 'utf-8');
      const attachment = new AttachmentBuilder(buffer, { name: `transcript-${transcript.channel_id}.txt` });

      const embed = new EmbedBuilder()
        .setTitle('📂 Ticket Transcript')
        .setDescription(`**Ticket ID:** ${transcript.channel_id}\n**User:** <@${transcript.user_id}>\n**Closed By:** <@${transcript.closed_by}>\n**Reason:** ${transcript.reason}\n**Date:** <t:${Math.floor(new Date(transcript.closed_at).getTime() / 1000)}:f>`)
        .setColor('Blue');

      await interaction.update({ content: '', embeds: [embed], files: [attachment], components: [] });

    } else if (interaction.customId === 'select_ticket_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET ticket_dashboard_channel_id = $1 WHERE guild_id = $2', [channelId, interaction.guildId]);
      await interaction.update({ content: `✅ Ticket dashboard channel set to <#${channelId}>.`, components: [] });

    } else if (interaction.customId === 'select_ticket_parent') {
      const categoryId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET ticket_parent_id = $1 WHERE guild_id = $2', [categoryId, interaction.guildId]);
      await interaction.update({ content: `✅ Ticket parent category set to <#${categoryId}>.`, components: [] });

    } else if (interaction.customId === 'select_del_ticket_cat') {
      const catId = interaction.values[0];
      await safeQuery('DELETE FROM ticket_categories WHERE id = $1', [catId]);
      await interaction.update({ content: `✅ Category removed.`, components: [] });
      await updateTicketDashboard(interaction.guild);

    } else if (interaction.customId.startsWith('wizard_delete_q_select_')) {
      const catId = interaction.customId.split('_')[4];
      const indexToDelete = parseInt(interaction.values[0]);

      const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = [];
      try {
        const rawData = rows[0].form_questions;
        if (Array.isArray(rawData)) {
          questions = rawData;
        } else if (rawData && typeof rawData === 'string' && rawData.trim().length > 0) {
          questions = JSON.parse(rawData);
        }
      } catch (e) { questions = []; }

      // Normalize
      questions = questions.map(q => (typeof q === 'string' ? { text: q, type: 'text' } : q));

      if (indexToDelete >= 0 && indexToDelete < questions.length) {
        questions.splice(indexToDelete, 1);
        await safeQuery('UPDATE ticket_categories SET form_questions = $1 WHERE id = $2', [JSON.stringify(questions), catId]);
      }

      const embed = new EmbedBuilder()
        .setTitle(rows[0].name ? `Edit Questions: ${rows[0].name}` : 'Edit Questions')
        .setDescription(`Current Questions:\n${questions.map((q, i) => {
          let typeLabel = '[Text]';
          if (q.type === 'file') typeLabel = '[File]';
          if (q.type === 'dropdown') typeLabel = '[Dropdown]';
          return `${i + 1}. ${typeLabel} ${q.text}`;
        }).join('\n') || 'None'}`)
        .setColor('Purple');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_add_single_q_${catId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_edit_q_menu_${catId}`).setLabel('Edit Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_delete_q_menu_${catId}`).setLabel('Delete Question').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`wizard_settings_menu_${catId}`).setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
        new ButtonBuilder().setCustomId(`wizard_finish_${catId}`).setLabel('Finish').setStyle(ButtonStyle.Success)
      );

      await interaction.update({ embeds: [embed], components: [row] });
    } else if (interaction.customId.startsWith('wizard_edit_q_select_')) {
      const catId = interaction.customId.split('_')[4];
      const index = parseInt(interaction.values[0]);

      const { rows } = await safeQuery('SELECT form_questions FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = JSON.parse(rows[0].form_questions || '[]');
      // Normalize
      questions = questions.map(q => (typeof q === 'string' ? { text: q, type: 'text' } : q));

      const question = questions[index];
      if (!question) return interaction.reply({ content: 'Question not found.', ephemeral: true });

      const type = question.type || 'text';

      // Show Edit Modal
      let modal;
      if (type === 'dropdown') {
        modal = new ModalBuilder().setCustomId(`modal_wizard_edit_q_${type}_${catId}_${index}`).setTitle('Edit Dropdown Question');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('question_text').setLabel('Question Text').setStyle(TextInputStyle.Short).setValue(question.text).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('dropdown_options').setLabel('Options (comma separated)').setStyle(TextInputStyle.Paragraph).setValue(question.options ? question.options.join(', ') : '').setRequired(true)
          )
        );
      } else {
        modal = new ModalBuilder().setCustomId(`modal_wizard_edit_q_${type}_${catId}_${index}`).setTitle(`Edit ${type === 'file' ? 'File' : 'Text'} Question`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('question_text').setLabel('Question Text').setStyle(TextInputStyle.Short).setValue(question.text).setRequired(true)
          )
        );
      }

      await interaction.showModal(modal);
      // Delete the selection menu message, safe fall back to hide
      try { await interaction.message.delete(); } catch (e) { await interaction.message.edit({ components: [] }).catch(() => { }); }

    } else if (interaction.customId.startsWith('wizard_q_type_select_')) {
      const catId = interaction.customId.split('_')[4];
      const type = interaction.values[0];

      if (type === 'text' || type === 'file') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_wizard_add_q_${type}_${catId}`)
          .setTitle(`Add ${type === 'text' ? 'Text' : 'File'} Question`);

        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('question_text')
            .setLabel('Question Text')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ));

        await interaction.showModal(modal);
      } else if (type === 'dropdown') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_wizard_add_q_${type}_${catId}`)
          .setTitle('Add Dropdown Question');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('question_text')
              .setLabel('Question Text')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('dropdown_options')
              .setLabel('Options (comma separated)')
              .setPlaceholder('Option 1, Option 2, Option 3')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
      }
      // Clean up the selection message, safe fallback to hide
      try { await interaction.message.delete(); } catch (e) { await interaction.message.edit({ components: [] }).catch(() => { }); }
    } else if (interaction.customId === 'select_levels_remove_reward') {
      const rewardId = interaction.values[0];
      await db.query('DELETE FROM level_rewards WHERE id = $1', [rewardId]);
      await interaction.update({ content: '✅ Reward removed.', components: [] });

    } else {
      console.log(`[Select Menu] Unknown Custom ID: '${interaction.customId}'`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Menu handler not found for ID: \`${interaction.customId}\`.`, ephemeral: true });
      }
    }
  }


  if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) {
    if (interaction.customId === 'select_ticket_parent') {
      const parentId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, ticket_parent_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET ticket_parent_id = $2', [interaction.guildId, parentId]);
      await interaction.update({ content: `✅ Ticket category parent set to <#${parentId}>. Future tickets will be created in this category used as 'Channels' mode.`, components: [] });

    } else if (interaction.customId === 'select_logs_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, log_channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET log_channel_id = $2', [interaction.guildId, channelId]);
      await interaction.update({ content: `✅ Log channel set to <#${channelId}>`, components: [] });

    } else if (interaction.customId === 'select_admin_role') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, admin_role_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET admin_role_id = $2', [interaction.guildId, roleId]);
      await interaction.update({ content: `✅ Admin role set to <@&${roleId}>`, components: [] });

    } else if (interaction.customId === 'select_giveaway_role') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, giveaway_role_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET giveaway_role_id = $2', [interaction.guildId, roleId]);
      await interaction.update({ content: `✅ Giveaway ping role set to <@&${roleId}>`, components: [] });

    } else if (interaction.customId === 'select_levels_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, level_up_channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET level_up_channel_id = $2', [interaction.guildId, channelId]);
      await interaction.update({ content: `✅ Level up channel set to <#${channelId}>`, components: [] });

    } else if (interaction.customId === 'select_welcome_channel') {
      const channelId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, welcome_channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET welcome_channel_id = $2', [interaction.guildId, channelId]);
      await interaction.update({ content: `✅ Welcome channel set to <#${channelId}>`, components: [] });

    } else if (interaction.customId === 'select_welcome_autorole') {
      const roleId = interaction.values[0];
      await db.query('INSERT INTO guild_configs (guild_id, auto_role_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET auto_role_id = $2', [interaction.guildId, roleId]);
      await interaction.update({ content: `✅ Auto-role set to <@&${roleId}>`, components: [] });
    }
  }

  if (interaction.isModalSubmit()) { // Handle Modal Submissions
    if (interaction.customId === 'modal_wizard_cat') {
      const name = interaction.fields.getTextInputValue('cat_name');
      const emoji = interaction.fields.getTextInputValue('cat_emoji');
      const roleId = interaction.fields.getTextInputValue('cat_role_id');

      try {
        const { rows } = await db.query(
          'INSERT INTO ticket_categories (guild_id, name, emoji, staff_role_id, form_questions) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [interaction.guildId, name, emoji, roleId, JSON.stringify([])]
        );
        console.log('[Wizard Debug] Create Category Rows:', rows);
        const newCatId = rows[0]?.id;

        if (!newCatId) {
          throw new Error('Failed to retrieve new category ID');
        }

        const embed = new EmbedBuilder()
          .setTitle('Ticket Creation Zone')
          .setDescription(`**Category:** ${emoji} ${name}\n**Role:** <@&${roleId}>\n\n**Questions:**\n*None*`)
          .setColor('Green')
          .setFooter({ text: 'Sovereign Empire • Ticket System', iconURL: interaction.guild.iconURL() });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`wizard_add_single_q_${newCatId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`wizard_edit_q_menu_${newCatId}`).setLabel('Edit Question').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`wizard_finish_${newCatId}`).setLabel('Finish Setup').setStyle(ButtonStyle.Success)
        );

        await interaction.reply({ embeds: [embed], components: [row] });
        // ...
      } catch (err) {
        console.error(err);
        await interaction.reply({ content: '❌ Error creating category. Check role ID.', ephemeral: true });
      }
    } else if (interaction.customId === 'modal_setup_welcome_msg') {
      const message = interaction.fields.getTextInputValue('msg_content');
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET welcome_message = $1 WHERE guild_id = $2', [message, interaction.guildId]);

      // Re-render welcome menu
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: (config.welcome_message ? config.welcome_message.substring(0, 1000) : 'Default: "Welcome {user} to {guild}!"') + '\n\n*Variables: {user}, {guild}, {memberCount}, {avatar}*' })
        .setColor('Green');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'modal_setup_welcome_image') {
      const imageUrl = interaction.fields.getTextInputValue('img_url');
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET welcome_image_url = $1 WHERE guild_id = $2', [imageUrl || null, interaction.guildId]);

      // Re-render welcome menu
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: (config.welcome_message ? config.welcome_message.substring(0, 1000) : 'Default: "Welcome {user} to {guild}!"') + '\n\n*Variables: {user}, {guild}, {memberCount}, {avatar}*' })
        .setColor('Green');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });
    } else if (interaction.customId.startsWith('modal_wizard_add_q_')) {
      // CustomID: modal_wizard_add_q_TYPE_CATID
      // TYPE could be 'text', 'file', 'dropdown'
      const parts = interaction.customId.split('_');
      const type = parts[4];
      const catId = parts[5];

      const questionText = interaction.fields.getTextInputValue('question_text');
      let questionObj = { text: questionText, type: type };

      if (type === 'dropdown') {
        const optionsRaw = interaction.fields.getTextInputValue('dropdown_options');
        const options = optionsRaw.split(',').map(o => o.trim()).filter(o => o.length > 0);
        if (options.length === 0) {
          return interaction.reply({ content: '❌ You must provide at least one option for the dropdown.', ephemeral: true });
        }
        if (options.length > 25) {
          return interaction.reply({ content: '❌ Maximum 25 options allowed.', ephemeral: true });
        }
        questionObj.options = options;
      }

      // Fetch existing questions
      const { rows } = await db.query('SELECT form_questions, name, emoji, staff_role_id FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = rows[0].form_questions || [];
      if (typeof questions === 'string') {
        try { questions = JSON.parse(questions); } catch (e) { questions = []; }
      }
      if (!Array.isArray(questions)) questions = [];

      // Migrate existing string-only questions to objects if necessary
      questions = questions.map(q => {
        if (typeof q === 'string') return { text: q, type: 'text' };
        return q;
      });

      questions.push(questionObj);

      await db.query('UPDATE ticket_categories SET form_questions = $1 WHERE id = $2', [JSON.stringify(questions), catId]);

      // Update the embed in the thread
      const embed = new EmbedBuilder()
        .setTitle('Ticket Creation Zone')
        .setDescription(`**Category:** ${rows[0].emoji} ${rows[0].name}\n**Role:** <@&${rows[0].staff_role_id}>\n\n**Questions:**\n${questions.map((q, i) => {
          let typeLabel = '[Text]';
          if (q.type === 'file') typeLabel = '[File]';
          if (q.type === 'dropdown') typeLabel = '[Dropdown]';
          return `${i + 1}. ${typeLabel} ${q.text}`;
        }).join('\n')}`)
        .setColor('Green');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_add_single_q_${catId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_edit_q_menu_${catId}`).setLabel('Edit Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_delete_q_menu_${catId}`).setLabel('Delete Question').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`wizard_settings_menu_${catId}`).setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
        new ButtonBuilder().setCustomId(`wizard_finish_${catId}`).setLabel('Finish Setup').setStyle(ButtonStyle.Success)
      );

      // Find the message to update? 
      // This is a modal submission, so we can't easily look up "the message".
      // But we can reply or try to edit a message if we had context. 
      // The wizard flow is usually: Button -> Modal -> Update Button Message
      // BUT `interaction.update` only works if the interaction was a Component. This is a Modal Submit.
      // So we have to `.reply` to confirm, OR we can try to fetch the Wizard Panel if it's the last message in channel?
      // Since `wizard-wizard` runs in a dedicated ephemeral thread or ephemeral logic... wait.
      // The original `wizard` command doesn't create a thread, it sends a message.
      // Actually, looking at the code: `wizard_finish` deletes the channel? No, `interaction.channel.delete()`?
      // It seems the wizard creates a temporary channel or thread?
      // Ah, `wizard-wizard` creates a "config thread" per comment in deploy-commands.

      // Let's assume we are in the config channel/thread.
      // We should ideally send the updated Embed as a new message or attempt to find the last one.
      // Simplest: Send new Embed state.

      await interaction.reply({ embeds: [embed], components: [row] });

    } else if (interaction.customId.startsWith('modal_wizard_single_q_')) {
      /* Legacy Handler - Leaving stub or removing? Removing to avoid confusion */
      /* Merged into modal_wizard_add_q_ logic above */
      const catId = interaction.customId.split('_')[4];
      /* ... Just redirect/error ... */
      await interaction.reply({ content: '❌ Legacy interface used. Please restart wizard.', ephemeral: true });

    } else if (interaction.customId.startsWith('modal_wizard_edit_q_')) {
      // modal_wizard_edit_q_TYPE_CATID_INDEX
      const parts = interaction.customId.split('_');
      const type = parts[4];
      const catId = parts[5];
      const index = parseInt(parts[6]);

      const questionText = interaction.fields.getTextInputValue('question_text');

      const { rows } = await db.query('SELECT form_questions, name, emoji, staff_role_id FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = [];
      try { questions = JSON.parse(rows[0].form_questions || '[]'); } catch (e) { }

      // Normalize
      questions = questions.map(q => (typeof q === 'string' ? { text: q, type: 'text' } : q));

      if (index < 0 || index >= questions.length) {
        return interaction.reply({ content: 'Question not found.', ephemeral: true });
      }

      // Update Question
      questions[index].text = questionText;
      questions[index].type = type; // Usually type doesnt change in this simple edit flow, but we pass it.

      if (type === 'dropdown') {
        const optionsRaw = interaction.fields.getTextInputValue('dropdown_options');
        const options = optionsRaw.split(',').map(o => o.trim()).filter(o => o.length > 0);
        if (options.length === 0) return interaction.reply({ content: '❌ Dropdown must have options.', ephemeral: true });
        if (options.length > 25) return interaction.reply({ content: '❌ Max 25 options.', ephemeral: true });
        questions[index].options = options;
      }

      await db.query('UPDATE ticket_categories SET form_questions = $1 WHERE id = $2', [JSON.stringify(questions), catId]);

      // Refresh Embed
      const embed = new EmbedBuilder()
        .setTitle('Ticket Creation Zone')
        .setDescription(`**Category:** ${rows[0].emoji} ${rows[0].name}\n**Role:** <@&${rows[0].staff_role_id}>\n\n**Questions:**\n${questions.map((q, i) => {
          let typeLabel = '[Text]';
          if (q.type === 'file') typeLabel = '[File]';
          if (q.type === 'dropdown') typeLabel = '[Dropdown]';
          return `${i + 1}. ${typeLabel} ${q.text}`;
        }).join('\n')}`)
        .setColor('Green');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_add_single_q_${catId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_edit_q_menu_${catId}`).setLabel('Edit Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_delete_q_menu_${catId}`).setLabel('Delete Question').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`wizard_settings_menu_${catId}`).setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
        new ButtonBuilder().setCustomId(`wizard_finish_${catId}`).setLabel('Finish Setup').setStyle(ButtonStyle.Success)
      );

      await interaction.reply({ embeds: [embed], components: [row] });



    } else if (interaction.customId.startsWith('modal_wizard_set_role_')) {
      const catId = interaction.customId.split('_')[4];
      const roleId = interaction.fields.getTextInputValue('role_id');

      await db.query('UPDATE ticket_categories SET reward_role_id = $1 WHERE id = $2', [roleId || null, catId]);
      await interaction.reply({ content: `✅ Reward role updated to: ${roleId ? `<@&${roleId}>` : 'None'}`, ephemeral: true });

    } else if (interaction.customId.startsWith('modal_ticket_create_') || interaction.customId.startsWith('modal_ticket_submit_')) {
      const parts = interaction.customId.split('_');
      // format: modal_ticket_submit_CATID_PAGE or modal_ticket_create_CATID (legacy)

      let catId, page;
      if (interaction.customId.startsWith('modal_ticket_submit_')) {
        catId = parts[3];
        page = parseInt(parts[4]);
      } else {
        // Handle legacy or simple single page
        catId = parts[3];
        page = 0;
      }

      let parsedQs = [];
      let category = null;
      try {
        const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
        if (rows.length > 0) {
          category = rows[0];
          const rawData = category.form_questions;
          if (rawData) {
            if (typeof rawData === 'string') {
              try { parsedQs = JSON.parse(rawData); } catch (e) { }
            } else {
              parsedQs = rawData;
            }
          }
        }
      } catch (e) { console.error('Error fetching questions:', e); }

      if (!category) {
        // Fallback if category deleted mid-process?
        category = { name: 'Support', id: catId };
      }

      if (!parsedQs || parsedQs.length === 0) parsedQs = [{ text: 'Please describe your request:', type: 'text' }];

      console.log(`[Ticket Select] Questions to ask: ${parsedQs.length}`);

      // Check for complex questions
      const hasComplex = parsedQs.some(q => q.type && q.type !== 'text');

      if (hasComplex) {
        // Interactive Thread Mode
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const safeName = interaction.user.username.replace(/[^a-zA-Z0-9-]/g, '');
        const channelName = `ticket-${safeName}-${category.name}`.substring(0, 32);

        try {
          const ticketThread = await interaction.channel.threads.create({
            name: channelName,
            type: ChannelType.PrivateThread,
            reason: `Ticket created by ${interaction.user.tag}`,
            autoArchiveDuration: 1440
          });
          await ticketThread.members.add(interaction.user.id);

          await safeQuery(
            'INSERT INTO tickets (channel_id, guild_id, user_id, category_id, pending_questions, current_question_index, answers) VALUES ($1, $2, $3, $4, $5, 0, $6)',
            [ticketThread.id, guild.id, interaction.user.id, category.id, JSON.stringify(parsedQs), JSON.stringify([])]
          );

          const welcomeEmbed = new EmbedBuilder()
            .setTitle(`${category.emoji} ${category.name} Ticket`)
            .setDescription(`Welcome <@${interaction.user.id}>!\n\nThis application has **${parsedQs.length}** questions.\nPlease answer them one by one below.`)
            .setColor('Green');

          await ticketThread.send({ embeds: [welcomeEmbed] });

          // Send First Question
          const firstQ = parsedQs[0];
          const qText = firstQ.text || firstQ;
          const qType = firstQ.type || 'text';

          const qEmbed = new EmbedBuilder()
            .setTitle(`Question 1/${parsedQs.length}`)
            .setDescription(qText)
            .setColor('Blue');

          const components = [];
          if (qType === 'dropdown' && firstQ.options) {
            const select = new StringSelectMenuBuilder()
              .setCustomId('ticket_interview_dropdown')
              .setPlaceholder('Select an option...')
              .addOptions(firstQ.options.map(opt => ({ label: opt, value: opt })));
            components.push(new ActionRowBuilder().addComponents(select));
          } else if (qType === 'file') {
            qEmbed.setFooter({ text: 'Please upload a file/image as your answer.' });
          }

          await ticketThread.send({ embeds: [qEmbed], components: components });
          await interaction.editReply({ content: `✅ Ticket created: <#${ticketThread.id}>` });
          await interaction.message.edit({ components: interaction.message.components }); // reset menu
        } catch (err) {
          console.error('Error creating interview thread:', err);
          await interaction.editReply({ content: '❌ Failed to create ticket thread.' });
        }
        return;
      }

      // Initialize session (Simple Text Modals)
      const totalPages = Math.ceil(parsedQs.length / 5);
      ticketCreationSessions.set(interaction.user.id, {
        catId: catId,
        questions: parsedQs,
        answers: [],
        totalPages: totalPages
      });

      // Show first modal (Page 0)
      const modal = new ModalBuilder()
        .setCustomId(`modal_ticket_submit_${catId}_0`)
        .setTitle(`Open Ticket: ${category.name.substring(0, 45)}`);

      parsedQs.slice(0, 5).forEach((q, i) => {
        const label = q.text || q;
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`q_${i}`)
            .setLabel(label.length > 45 ? label.substring(0, 42) + '...' : label)
            .setPlaceholder(label.substring(0, 100))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        ));
      });

      await interaction.showModal(modal);
      // Reset the select menu
      await interaction.message.edit({ components: interaction.message.components });
      console.log('[Ticket Select] Modal Page 0 shown.');

      if (!session) {
        return interaction.reply({ content: '❌ Session expired. Please try again.', ephemeral: true });
      }

      // Extract answers from this page
      // Inputs are named q_0, q_1... relative to the slice
      // But wait... for page 0, indices are 0-4. For page 1, indices are 5-9?
      // No, usually in modal I'll name them q_0 ... q_4 relative to the modal. 
      // Let's check how I created them: 
      // .setCustomId(`q_${i}`) where i is the actual index in the big array.

      const startIdx = page * 5;
      const endIdx = Math.min((page + 1) * 5, session.questions.length);

      for (let i = startIdx; i < endIdx; i++) {
        const answer = interaction.fields.getTextInputValue(`q_${i}`);
        // Store answer
        session.answers[i] = { question: session.questions[i].text, answer: answer }; // Store question.text for consistency
      }

      // Check for next page
      const nextPage = page + 1;
      if (nextPage < session.totalPages) {
        // Show Next Modal
        const modal = new ModalBuilder()
          .setCustomId(`modal_ticket_submit_${catId}_${nextPage}`)
          .setTitle(`Page ${nextPage + 1}/${session.totalPages}`);

        const qStart = nextPage * 5;
        const qEnd = Math.min((nextPage + 1) * 5, session.questions.length);

        session.questions.slice(qStart, qEnd).forEach((q, i) => {
          // i is relative to slice 0..4
          // but we want unique customId for the field? 
          // Actually, standard practice across modals is fine to reuse IDs if different modal, 
          // BUT I used `q_${actualIndex}` in generation.
          const actualIndex = qStart + i;
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`q_${actualIndex}`)
              .setLabel(q.text.length > 45 ? q.text.substring(0, 42) + '...' : q.text)
              .setPlaceholder(q.text.substring(0, 100))
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ));
        });

        await interaction.showModal(modal);
        return; // Done for this specific interaction
      }

      // If no more pages, CREATE TICKET
      // Fetch category info again for role/emoji
      const { rows } = await db.query('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
      const category = rows[0];

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

        const answerFields = session.answers.map(a => `**${a.question}**\n${a.answer}`).join('\n\n');

        const welcomeEmbed = new EmbedBuilder()
          .setTitle(`${category.emoji} ${category.name} Ticket`)
          .setDescription(`Welcome <@${interaction.user.id}>!\n\n${answerFields}\n\n<@&${category.staff_role_id}> will be with you shortly.`)
          .setColor('Green');

        const closeButtons = new ActionRowBuilder();
        if (category.claim_enabled) closeButtons.addComponents(new ButtonBuilder().setCustomId('claim_ticket_btn').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️'));
        if (category.reward_role_id) closeButtons.addComponents(new ButtonBuilder().setCustomId('accept_ticket_btn').setLabel('Accept & Reward').setStyle(ButtonStyle.Primary).setEmoji('✅'));
        closeButtons.addComponents(
          new ButtonBuilder().setCustomId('close_ticket_reason_btn').setLabel('Close with Reason').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
          new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );

        await ticketThread.send({ embeds: [welcomeEmbed], components: [closeButtons] });
        await interaction.reply({ content: `✅ Ticket created: <#${ticketThread.id}>`, ephemeral: true });

        // Cleanup Session
        ticketCreationSessions.delete(interaction.user.id);

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

      await db.query('UPDATE server_stats SET pool_balance = pool_balance - $1 WHERE id = $2', [totalPrize, interaction.guildId]);

      // Create giveaway embed
      const giveawayEmbed = new EmbedBuilder()
        .setTitle(`🎁 **GIVEAWAY** 🎁`)
        .setDescription(`🎉 **Prize:** ${totalPrize.toLocaleString('en-US')} 💰\n` +
          `🎉 **Winners:** ${winnerCount}\n` +
          `⏱️ **Ends:** <t:${Math.floor(endTime / 1000)}:R>\n` +
          `💸 **Entry Cost:** ${entryCost.toLocaleString('en-US')} 💰\n` +
          `\nClick the button below to join!`)
        .setColor('Purple')
        .setFooter({ text: `Hosted by ${interaction.user.tag}` });

      const joinButton = new ButtonBuilder()
        .setCustomId(`join_giveaway_${giveawayId}`)
        .setLabel(`Join (${entryCost.toLocaleString('en-US')} SE)`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎁');

      const row = new ActionRowBuilder().addComponents(joinButton);



      // Prepare content with ping if role is specified
      const roleToPing = pingRole;

      const content = roleToPing ? `${roleToPing} **New Giveaway Available!** 🎉` : undefined;
      const allowedMentions = roleToPing ? { roles: [roleToPing.id] } : undefined;

      // Send the giveaway message
      const giveawayMessage = await interaction.reply({
        content: content,
        embeds: [giveawayEmbed],
        components: [row],
        allowedMentions: allowedMentions,
        fetchReply: true
      });

      // Get the reply message for database storage
      const replyMessage = giveawayMessage; // Already fetched with fetchReply: true or explicitly fetched

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
    } else if (interaction.customId === 'modal_close_ticket_reason') {
      const reason = interaction.fields.getTextInputValue('close_reason');

      const { rows } = await safeQuery('SELECT * FROM tickets WHERE channel_id = $1', [interaction.channelId]);
      const ticket = rows[0];
      const ticketOwnerID = ticket ? ticket.user_id : null;

      // DM the user
      if (ticketOwnerID) {
        try {
          const user = await interaction.guild.members.fetch(ticketOwnerID);
          const dmEmbed = new EmbedBuilder()
            .setTitle('Ticket Closed')
            .setDescription(`Your ticket **${interaction.channel.name}** has been closed by <@${interaction.user.id}>.`)
            .addFields({ name: 'Reason', value: reason })
            .setColor('Red');
          await user.send({ embeds: [dmEmbed] });
        } catch (e) {
          console.log(`Could not DM user ${ticketOwnerID}: ${e.message}`);
        }
      }

      await interaction.reply({ content: `🔒 Closing ticket. Reason sent to user: ${reason}` });
      // Update Dashboard
      setTimeout(() => updateTicketDashboard(interaction.guild), 2000);

      // (Proceed to close logic...)

      // Update DB
      await db.query('UPDATE tickets SET closed = TRUE WHERE channel_id = $1', [interaction.channelId]);

      // Log the closure
      const transcriptFile = await generateTranscriptFile(interaction, ticket, reason);

      logActivity(
        '🔒 Ticket Closed',
        `**Ticket:** ${interaction.channel.name}\n**Closed by:** <@${interaction.user.id}>\n**Owner:** <@${ticketOwnerID}>\n**Reason:** ${reason}\n\n*Transcript attached.*`,
        'Red',
        transcriptFile
      );
      updateTicketDashboard(interaction.guild);

      // Create Transcript
      try {
        let transcriptText = `TRANSCRIPT FOR TICKET: ${interaction.channel.name} (${interaction.channelId})\n`;
        transcriptText += `USER: ${ticketOwner}\n`;
        transcriptText += `CLOSED BY: ${interaction.user.tag} (${interaction.user.id})\n`;
        transcriptText += `REASON: ${reason}\n`;
        transcriptText += `DATE: ${new Date().toISOString()}\n`;
        transcriptText += `--------------------------------------------------\n\n`;

        if (ticket.pending_questions && ticket.answers) {
          // Interview Mode
          const answers = typeof ticket.answers === 'string' ? JSON.parse(ticket.answers) : ticket.answers;
          answers.forEach((a, i) => {
            transcriptText += `Q${i + 1}: ${a.question}\nA: ${a.answer}\n\n`;
          });
        }

        // Fetch last 100 messages for context if needed (optional simple text dump)
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        messages.reverse().forEach(m => {
          transcriptText += `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content} ${m.attachments.size > 0 ? '[Attachment]' : ''}\n`;
        });

        // Save to Backup Table
        await db.query(
          'INSERT INTO ticket_transcripts (channel_id, guild_id, user_id, transcript, reason, closed_by, closed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
          [interaction.channelId, interaction.guildId, ticketOwner, transcriptText, reason, interaction.user.id]
        );
      } catch (err) {
        console.error('Error creating transcript:', err);
      }

      // Delete thread after 5 seconds
      setTimeout(async () => {
        try {
          await interaction.channel.delete();
        } catch (err) {
          console.error('Failed to delete ticket thread:', err);
        }
      }, 5000);
    }
  } else if (interaction.isButton() || interaction.isModalSubmit()) { // Handle Button Clicks & Modals
    // --- TICKET CREATION BUTTONS ---
    if (interaction.customId.startsWith('create_ticket_')) {
      const catId = interaction.customId.replace('create_ticket_', '');
      await initiateTicketCreation(interaction, catId);
      return;
    }

    // --- SETUP WIZARD HANDLERS ---
    if (interaction.customId === 'setup_close_btn') {
      await interaction.update({ content: '✅ Configuration closed.', embeds: [], components: [] });

    } else if (interaction.customId === 'setup_back_btn') {
      // Return to Main Menu
      const embed = new EmbedBuilder()
        .setTitle('🛠️ ALL in One Configuration')
        .setDescription('Select a module to configure for this server.')
        .addFields(
          { name: '📢 Welcome Module', value: 'Customize welcome messages, images, and auto-roles.', inline: true },
          { name: '🎫 Ticket System', value: 'Manage support tickets and panels.', inline: true },
          { name: '🛡️ Logging', value: 'Set up audit logs for server events.', inline: true },
          { name: '📈 Leveling', value: 'Configure XP rates and level up notifications.', inline: true }
        )
        .setColor('Blurple');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_btn').setLabel('Welcome').setStyle(ButtonStyle.Primary).setEmoji('📢'),
        new ButtonBuilder().setCustomId('setup_tickets_btn').setLabel('Tickets').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
        new ButtonBuilder().setCustomId('setup_logs_btn').setLabel('Logging').setStyle(ButtonStyle.Primary).setEmoji('🛡️'),
        new ButtonBuilder().setCustomId('setup_levels_btn').setLabel('Leveling').setStyle(ButtonStyle.Success).setEmoji('📈')
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_admin_btn').setLabel('Admin Role').setStyle(ButtonStyle.Secondary).setEmoji('👮'),
        new ButtonBuilder().setCustomId('setup_giveaways_btn').setLabel('Giveaways').setStyle(ButtonStyle.Secondary).setEmoji('🎁'),
        new ButtonBuilder().setCustomId('setup_close_btn').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('❌')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });

      // --- TICKETS WIZARD ---
    } else if (interaction.customId === 'setup_tickets_btn') {
      const { rows: configRows } = await safeQuery('SELECT ticket_mode, ticket_parent_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = configRows[0] || {};
      const { rows: catRows } = await safeQuery('SELECT * FROM ticket_categories WHERE guild_id = $1', [interaction.guildId]);

      const categoriesList = catRows.length > 0 ? catRows.map(c => `${c.emoji} **${c.name}**`).join('\n') : 'No categories configured.';
      const ticketMode = config.ticket_mode === 'channels' ? 'Channels 📁' : 'Threads 🧵';

      const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket System Dashboard')
        .setDescription(`Manage your ticket system settings and panels.
        
        **Ticket Mode:** ${ticketMode}
        ${config.ticket_mode === 'channels' ? `**Ticket Category:** ${config.ticket_parent_id ? `<#${config.ticket_parent_id}>` : 'Not Set'}` : ''}
        
        **Global Categories:**
        ${categoriesList}`)
        .setColor('Blue');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_tickets_panels_btn').setLabel('Manage Panels').setStyle(ButtonStyle.Primary).setEmoji('🖥️'),
        new ButtonBuilder().setCustomId('setup_tickets_mode_btn').setLabel('Switch Mode').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
        new ButtonBuilder().setCustomId('setup_tickets_parent_btn').setLabel('Set Parent Category').setStyle(ButtonStyle.Secondary).setEmoji('📂').setDisabled(config.ticket_mode !== 'channels'),
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_tickets_add_cat_btn').setLabel('Add Category').setStyle(ButtonStyle.Success).setEmoji('➕'),
        new ButtonBuilder().setCustomId('setup_tickets_del_cat_btn').setLabel('Remove Category').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'setup_tickets_panels_btn') {
      // List Panels
      const { rows: panels } = await safeQuery('SELECT * FROM ticket_panels_v2 WHERE guild_id = $1 ORDER BY id ASC', [interaction.guildId]);

      const embed = new EmbedBuilder()
        .setTitle('🖥️ Ticket Panels')
        .setDescription(`You have **${panels.length}** active ticket panels.\nUse the menu below to edit an existing panel or create a new one.`)
        .setColor('Blue');

      const components = [];

      if (panels.length > 0) {
        const options = panels.map(p => ({
          label: p.title || `Panel #${p.id}`,
          description: `Channel: ${p.channel_id ? `<#${p.channel_id}>` : 'Not Set'} | Style: ${p.button_style}`,
          value: p.id.toString(),
          emoji: '📝'
        }));

        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_panel_edit')
            .setPlaceholder('Select a panel to manage')
            .addOptions(options)
        );
        components.push(selectRow);
      }

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_panel_create').setLabel('Create New Panel').setStyle(ButtonStyle.Success).setEmoji('➕'),
        new ButtonBuilder().setCustomId('setup_tickets_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      components.push(btnRow);

      await interaction.update({ embeds: [embed], components: components });

    } else if (interaction.customId === 'setup_panel_create') {
      // Create default panel
      await db.query(`INSERT INTO ticket_panels_v2 (guild_id, title, description, button_style) VALUES ($1, '🎫 Support Tickets', 'Open a ticket below', 'buttons')`, [interaction.guildId]);
      // Refresh list
      // Reuse logic from setup_tickets_panels_btn
      // Or just redirect to editing the new panel?
      // Let's redirect to list for simplicity
      const { rows: panels } = await safeQuery('SELECT * FROM ticket_panels_v2 WHERE guild_id = $1 ORDER BY id ASC', [interaction.guildId]);
      const embed = new EmbedBuilder()
        .setTitle('🖥️ Ticket Panels')
        .setDescription(`Panel Created! You have **${panels.length}** active ticket panels.`)
        .setColor('Green');

      const components = [];
      if (panels.length > 0) {
        const options = panels.map(p => ({
          label: p.title || `Panel #${p.id}`,
          description: `Channel: ${p.channel_id ? `<#${p.channel_id}>` : 'Not Set'} | Style: ${p.button_style}`,
          value: p.id.toString(),
          emoji: '📝'
        }));
        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_panel_edit')
            .setPlaceholder('Select a panel to manage')
            .addOptions(options)
        );
        components.push(selectRow);
      }
      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_panel_create').setLabel('Create New Panel').setStyle(ButtonStyle.Success).setEmoji('➕'),
        new ButtonBuilder().setCustomId('setup_tickets_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      components.push(btnRow);
      await interaction.update({ embeds: [embed], components: components });

    } else if (interaction.customId === 'select_panel_edit') {
      const panelId = interaction.values[0];
      // Redirect to Edit Handler (Simulated)
      // We need to call a function or just emit logic. 
      // Logic below for setup_panel_edit_
      // But we need to Change the customId logic to support extraction.
      // Let's manually trigger the logic:
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('setup_panel_edit_')) {
      const panelId = interaction.customId.replace('setup_panel_edit_', '');
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_refresh_')) {
      const panelId = interaction.customId.replace('panel_refresh_', '');
      await sendTicketPanel(interaction.guild, panelId);
      await interaction.reply({ content: '✅ Panel message updated!', ephemeral: true });

    } else if (interaction.customId.startsWith('panel_delete_')) {
      const panelId = interaction.customId.replace('panel_delete_', '');
      await db.query('DELETE FROM ticket_panels_v2 WHERE id = $1', [panelId]);
      await interaction.update({ content: '🗑️ Panel deleted.', embeds: [], components: [] });
      return; // Exit


    } else if (interaction.customId.startsWith('panel_set_channel_')) {
      const panelId = interaction.customId.replace('panel_set_channel_', '');
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`select_panel_channel_${panelId}`)
          .setPlaceholder('Select Panel Channel')
          .setChannelTypes([ChannelType.GuildText])
      );
      await interaction.reply({ content: 'Select the channel where this panel will be sent:', components: [row], ephemeral: true });

    } else if (interaction.customId.startsWith('select_panel_channel_')) {
      const panelId = interaction.customId.replace('select_panel_channel_', '');
      const channelId = interaction.values[0];
      await db.query('UPDATE ticket_panels_v2 SET channel_id = $1 WHERE id = $2', [channelId, panelId]);
      await interaction.update({ content: `✅ Panel channel set to <#${channelId}>.`, components: [] });

    } else if (interaction.customId.startsWith('panel_toggle_style_')) {
      const panelId = interaction.customId.replace('panel_toggle_style_', '');
      await db.query(`UPDATE ticket_panels_v2 SET button_style = CASE WHEN button_style = 'buttons' THEN 'dropdown' ELSE 'buttons' END WHERE id = $1`, [panelId]);
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_categories_')) {
      const panelId = interaction.customId.replace('panel_categories_', '');
      await handlePanelCategories(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_cat_toggle_')) {
      const [_, , , panelId, catId] = interaction.customId.split('_');
      const { rows } = await safeQuery('SELECT panel_id FROM ticket_categories WHERE id = $1', [catId]);
      const currentPanel = rows[0]?.panel_id;

      if (currentPanel == panelId) {
        await db.query('UPDATE ticket_categories SET panel_id = NULL WHERE id = $1', [catId]);
      } else {
        await db.query('UPDATE ticket_categories SET panel_id = $1 WHERE id = $2', [panelId, catId]);
      }
      await handlePanelCategories(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_cat_back_')) {
      const panelId = interaction.customId.replace('panel_cat_back_', '');
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_set_title_')) {
      const panelId = interaction.customId.replace('panel_set_title_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_title_${panelId}`).setTitle('Set Panel Title');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_desc_')) {
      const panelId = interaction.customId.replace('panel_set_desc_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_desc_${panelId}`).setTitle('Set Panel Description');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_color_')) {
      const panelId = interaction.customId.replace('panel_set_color_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_color_${panelId}`).setTitle('Set Panel Color');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Color').setStyle(TextInputStyle.Short).setPlaceholder('#HEX or Name').setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_image_')) {
      const panelId = interaction.customId.replace('panel_set_image_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_image_${panelId}`).setTitle('Set Panel Image');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Image URL').setStyle(TextInputStyle.Short).setRequired(false)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_thumb_')) {
      const panelId = interaction.customId.replace('panel_set_thumb_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_thumb_${panelId}`).setTitle('Set Panel Thumbnail');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Thumbnail URL').setStyle(TextInputStyle.Short).setRequired(false)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('modal_panel_')) {
      const parts = interaction.customId.split('_');
      const field = parts[2];
      const panelId = parts[3];
      const val = interaction.fields.getTextInputValue('val');
      const colMap = { 'title': 'title', 'desc': 'description', 'color': 'color', 'image': 'image_url', 'thumb': 'thumbnail_url' };
      const col = colMap[field];
      if (col) {
        await db.query(`UPDATE ticket_panels_v2 SET ${col} = $1 WHERE id = $2`, [val || null, panelId]);
        await interaction.reply({ content: `✅ ${field} updated!`, ephemeral: true });
      }

    } else if (interaction.customId === 'setup_tickets_add_cat_btn') {
      const modal = new ModalBuilder().setCustomId('modal_add_ticket_cat').setTitle('Add Ticket Category');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_name').setLabel('Category Name').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_emoji').setLabel('Emoji').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 🎫').setRequired(true))
      );
      try {
        await interaction.showModal(modal);
      } catch (error) {
        console.error('Error showing setup_tickets_add_cat_btn modal:', error);
        // We cannot reply if the interaction is unknown/invalid, but we can log it.
      }

    } else if (interaction.customId === 'modal_add_ticket_cat') {
      console.log('[Modal] processing modal_add_ticket_cat');
      // Attempt to acknowledge the modal submission immediately.
      try {
        await interaction.deferUpdate();
      } catch (err) {
        console.error('[Modal] Failed to deferUpdate:', err);
        return;
      }

      try {
        const name = interaction.fields.getTextInputValue('cat_name');
        const emoji = interaction.fields.getTextInputValue('cat_emoji');
        console.log(`[Modal] Inputs: name=${name}, emoji=${emoji}`);

        // Insert into DB
        await db.query('INSERT INTO ticket_categories (guild_id, name, emoji) VALUES ($1, $2, $3)', [interaction.guildId, name, emoji]);
        console.log('[Modal] DB Insert success');

        // Re-fetch data 
        const { rows: configRows } = await safeQuery('SELECT ticket_mode, ticket_parent_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
        const config = configRows[0] || {};
        const { rows: catRows } = await safeQuery('SELECT * FROM ticket_categories WHERE guild_id = $1', [interaction.guildId]);

        const categoriesList = catRows.length > 0 ? catRows.map(c => `${c.emoji} **${c.name}**`).join('\n') : 'No categories configured.';
        const ticketMode = config.ticket_mode === 'channels' ? 'Channels 📁' : 'Threads 🧵';

        const embed = new EmbedBuilder()
          .setTitle('🎫 Ticket System Dashboard')
          .setDescription(`Manage your ticket system settings and panels.
           
           **Ticket Mode:** ${ticketMode}
           ${config.ticket_mode === 'channels' ? `**Ticket Category:** ${config.ticket_parent_id ? `<#${config.ticket_parent_id}>` : 'Not Set'}` : ''}
           
           **Global Categories:**
           ${categoriesList}`)
          .setColor('Blue');

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('setup_tickets_panels_btn').setLabel('Manage Panels').setStyle(ButtonStyle.Primary).setEmoji('🖥️'),
          new ButtonBuilder().setCustomId('setup_tickets_mode_btn').setLabel('Switch Mode').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
          new ButtonBuilder().setCustomId('setup_tickets_parent_btn').setLabel('Set Parent Category').setStyle(ButtonStyle.Secondary).setEmoji('📂').setDisabled(config.ticket_mode !== 'channels'),
        );

        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('setup_tickets_add_cat_btn').setLabel('Add Category').setStyle(ButtonStyle.Success).setEmoji('➕'),
          new ButtonBuilder().setCustomId('setup_tickets_del_cat_btn').setLabel('Remove Category').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
        );

        // Update the dashboard message
        if (interaction.message) {
          await interaction.message.edit({ embeds: [embed], components: [row1, row2] });
        }

        // Confirm to user
        await interaction.followUp({ content: '✅ Category added successfully!', ephemeral: true });

      } catch (error) {
        console.error('Error adding ticket category:', error);
        await interaction.followUp({ content: '❌ Failed to add category. Please check your emoji format or database connection.', ephemeral: true });
      }

    } else if (interaction.customId === 'setup_tickets_del_cat_btn') {
      const { rows: catRows } = await safeQuery('SELECT * FROM ticket_categories WHERE guild_id = $1', [interaction.guildId]);
      if (catRows.length === 0) return interaction.reply({ content: 'No categories to remove.', ephemeral: true });

      const options = catRows.map(c => new StringSelectMenuOptionBuilder()
        .setLabel(c.name)
        .setValue(c.id.toString())
        .setEmoji(parseEmoji(c.emoji)) // Use helper to handle custom emoji strings
      );
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('select_del_ticket_cat').setPlaceholder('Select category to remove').addOptions(options)
      );
      await interaction.reply({ content: 'Select category to remove:', components: [row], ephemeral: true });

    } else if (interaction.customId === 'setup_tickets_mode_btn') {
      await db.query(`
        INSERT INTO guild_configs (guild_id, ticket_mode) VALUES ($1, 'channels') 
        ON CONFLICT (guild_id) DO UPDATE SET ticket_mode = CASE WHEN COALESCE(guild_configs.ticket_mode, 'threads') = 'threads' THEN 'channels' ELSE 'threads' END
      `, [interaction.guildId]);

      // Refresh Main Dashboard
      // We can manually trigger the dashboard refresh by recursively calling the logic for 'setup_tickets_btn'
      // But since we can't easily recurse without extracting functions, we will just copy the dashboard logic basic update.
      // Actually, let's just update the interaction properties to simulate a click and call a shared update function if we had one.
      // For now, I'll assume the user presses it and we just update the embed.

      const { rows: configRows } = await safeQuery('SELECT ticket_mode, ticket_parent_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = configRows[0] || {};
      const { rows: catRows } = await safeQuery('SELECT * FROM ticket_categories WHERE guild_id = $1', [interaction.guildId]);
      const categoriesList = catRows.length > 0 ? catRows.map(c => `${c.emoji} **${c.name}**`).join('\n') : 'No categories configured.';
      const ticketMode = config.ticket_mode === 'channels' ? 'Channels 📁' : 'Threads 🧵';

      const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket System Dashboard')
        .setDescription(`Manage your ticket system settings and panels.
        
        **Ticket Mode:** ${ticketMode}
        ${config.ticket_mode === 'channels' ? `**Ticket Category:** ${config.ticket_parent_id ? `<#${config.ticket_parent_id}>` : 'Not Set'}` : ''}
        
        **Global Categories:**
        ${categoriesList}`)
        .setColor('Blue');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_tickets_panels_btn').setLabel('Manage Panels').setStyle(ButtonStyle.Primary).setEmoji('🖥️'),
        new ButtonBuilder().setCustomId('setup_tickets_mode_btn').setLabel('Switch Mode').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
        new ButtonBuilder().setCustomId('setup_tickets_parent_btn').setLabel('Set Parent Category').setStyle(ButtonStyle.Secondary).setEmoji('📂').setDisabled(config.ticket_mode !== 'channels'),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_tickets_add_cat_btn').setLabel('Add Category').setStyle(ButtonStyle.Success).setEmoji('➕'),
        new ButtonBuilder().setCustomId('setup_tickets_del_cat_btn').setLabel('Remove Category').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });


    } else if (interaction.customId === 'setup_tickets_parent_btn') {
      // Show Category channel select (for Discord category, not ticket category)
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('select_ticket_parent')
          .setPlaceholder('Select Parent Category')
          .setChannelTypes([ChannelType.GuildCategory])
      );
      await interaction.reply({ content: 'Select the channel where new ticket channels will be created:', components: [row], ephemeral: true });

    } else if (interaction.customId.startsWith('panel_set_channel_')) {
      const panelId = interaction.customId.replace('panel_set_channel_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_channel_${panelId}`).setTitle('Set Panel Channel');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('modal_panel_channel_')) {
      const panelId = interaction.customId.replace('modal_panel_channel_', '');
      const channelId = interaction.fields.getTextInputValue('channel_id');

      // Validate
      const channel = interaction.guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        return interaction.reply({ content: `❌ Invalid channel ID or channel is not text-based.`, ephemeral: true });
      }

      await db.query('UPDATE ticket_panels_v2 SET channel_id = $1 WHERE id = $2', [channelId, panelId]);
      await interaction.reply({ content: `✅ Panel channel set to <#${channelId}>.`, ephemeral: true });

    } else if (interaction.customId.startsWith('select_panel_channel_')) {
      const panelId = interaction.customId.replace('select_panel_channel_', '');
      const channelId = interaction.values[0];
      await db.query('UPDATE ticket_panels_v2 SET channel_id = $1 WHERE id = $2', [channelId, panelId]);
      await interaction.update({ content: `✅ Panel channel set to <#${channelId}>.`, components: [] });

    } else if (interaction.customId.startsWith('panel_toggle_style_')) {
      const panelId = interaction.customId.replace('panel_toggle_style_', '');
      await db.query(`UPDATE ticket_panels_v2 SET button_style = CASE WHEN button_style = 'buttons' THEN 'dropdown' ELSE 'buttons' END WHERE id = $1`, [panelId]);
      // Refresh
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_categories_')) {
      const panelId = interaction.customId.replace('panel_categories_', '');
      await handlePanelCategories(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_cat_toggle_')) {
      const [_, , , panelId, catId] = interaction.customId.split('_');
      // panel_cat_toggle_{panelId}_{catId}

      // Toggle: check if currently linked.
      const { rows } = await safeQuery('SELECT panel_id FROM ticket_categories WHERE id = $1', [catId]);
      const currentPanel = rows[0]?.panel_id;

      if (currentPanel == panelId) {
        // Unlink
        await db.query('UPDATE ticket_categories SET panel_id = NULL WHERE id = $1', [catId]);
      } else {
        // Link
        await db.query('UPDATE ticket_categories SET panel_id = $1 WHERE id = $2', [panelId, catId]);
      }
      await handlePanelCategories(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_cat_back_')) {
      const panelId = interaction.customId.replace('panel_cat_back_', '');
      await handlePanelEdit(interaction, panelId);

    } else if (interaction.customId.startsWith('panel_set_title_')) {
      const panelId = interaction.customId.replace('panel_set_title_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_title_${panelId}`).setTitle('Set Panel Title');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_desc_')) {
      const panelId = interaction.customId.replace('panel_set_desc_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_desc_${panelId}`).setTitle('Set Panel Description');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_color_')) {
      const panelId = interaction.customId.replace('panel_set_color_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_color_${panelId}`).setTitle('Set Panel Color');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Color').setStyle(TextInputStyle.Short).setPlaceholder('#HEX or Name').setRequired(true)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_image_')) {
      const panelId = interaction.customId.replace('panel_set_image_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_image_${panelId}`).setTitle('Set Panel Image');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Image URL').setStyle(TextInputStyle.Short).setRequired(false)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('panel_set_thumb_')) {
      const panelId = interaction.customId.replace('panel_set_thumb_', '');
      const modal = new ModalBuilder().setCustomId(`modal_panel_thumb_${panelId}`).setTitle('Set Panel Thumbnail');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('val').setLabel('Thumbnail URL').setStyle(TextInputStyle.Short).setRequired(false)));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('modal_panel_')) {
      // Generic modal handler for panel edits
      const parts = interaction.customId.split('_'); // modal, panel, [field], [id]
      const field = parts[2]; // title, desc, color, image, thumb
      const panelId = parts[3];
      const val = interaction.fields.getTextInputValue('val');

      // Map field to db column
      const colMap = { 'title': 'title', 'desc': 'description', 'color': 'color', 'image': 'image_url', 'thumb': 'thumbnail_url' };
      const col = colMap[field];
      if (col) {
        await db.query(`UPDATE ticket_panels_v2 SET ${col} = $1 WHERE id = $2`, [val || null, panelId]);
        await interaction.reply({ content: `✅ ${field} updated!`, ephemeral: true });
      }

      const page = parseInt(interaction.customId.split('_')[3]);
      if (isNaN(page) || page < 0) return;

      const perPage = 25;
      const { rows: countRows } = await safeQuery('SELECT COUNT(*) as total FROM ticket_transcripts WHERE guild_id = $1', [interaction.guildId]);
      const totalTickets = parseInt(countRows[0]?.total || 0);
      const totalPages = Math.ceil(totalTickets / perPage);

      if (page >= totalPages) return interaction.reply({ content: 'No more pages.', ephemeral: true });

      const { rows: allTranscripts } = await safeQuery('SELECT channel_id, user_id, reason, closed_at FROM ticket_transcripts WHERE guild_id = $1 ORDER BY closed_at DESC LIMIT $2 OFFSET $3', [interaction.guildId, perPage, page * perPage]);

      const options = allTranscripts.map(t =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Ticket ${t.channel_id.slice(-6)}`)
          .setDescription(`User: ${t.user_id} | ${t.reason?.substring(0, 50) || 'No reason'}`)
          .setValue(t.channel_id)
      );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_ticket_backup')
          .setPlaceholder('Select a ticket to view')
          .addOptions(options)
      );

      const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_backup_page_${page - 1}`).setLabel('⬅️ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('ticket_backup_info').setLabel(`Page ${page + 1}/${totalPages} (${totalTickets} total)`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`ticket_backup_page_${page + 1}`).setLabel('Next ➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
      );

      await interaction.update({ content: '📂 **Select a ticket backup to view:**', components: [selectRow, buttonRow] });

      // --- LOGS WIZARD ---
    } else if (interaction.customId === 'setup_logs_btn') {
      const { rows } = await safeQuery('SELECT log_channel_id, log_options FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};

      // Parse log options - defaults all true
      const defaultOpts = { tickets: true, purchases: true, giveaways: true, levels: true, moderation: true, voice: true, messages: true, members: true, roles: true, commands: true, server: true };
      let logOptions = { ...defaultOpts };
      try {
        if (config.log_options) {
          const parsed = typeof config.log_options === 'string' ? JSON.parse(config.log_options) : config.log_options;
          logOptions = { ...defaultOpts, ...parsed };
        }
      } catch (e) { }

      const embed = new EmbedBuilder()
        .setTitle('🛡️ Logging Configuration')
        .setDescription(`Configure where the bot logs events and which events to log.
            
**Log Channel:** ${config.log_channel_id ? `<#${config.log_channel_id}>` : 'Not Set'}
            
**Log Options:**
${logOptions.tickets !== false ? '✅' : '❌'} Tickets • ${logOptions.purchases !== false ? '✅' : '❌'} Purchases • ${logOptions.giveaways !== false ? '✅' : '❌'} Giveaways
${logOptions.levels !== false ? '✅' : '❌'} Levels • ${logOptions.moderation !== false ? '✅' : '❌'} Moderation • ${logOptions.voice !== false ? '✅' : '❌'} Voice
${logOptions.messages !== false ? '✅' : '❌'} Messages • ${logOptions.members !== false ? '✅' : '❌'} Members • ${logOptions.roles !== false ? '✅' : '❌'} Roles
${logOptions.commands !== false ? '✅' : '❌'} Commands • ${logOptions.server !== false ? '✅' : '❌'} Server Changes`)
        .setColor('Blue');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_logs_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_tickets').setLabel('Tickets').setStyle(logOptions.tickets !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎫'),
        new ButtonBuilder().setCustomId('log_toggle_purchases').setLabel('Purchases').setStyle(logOptions.purchases !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🛒'),
        new ButtonBuilder().setCustomId('log_toggle_giveaways').setLabel('Giveaways').setStyle(logOptions.giveaways !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎁'),
        new ButtonBuilder().setCustomId('log_toggle_levels').setLabel('Levels').setStyle(logOptions.levels !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('📈'),
        new ButtonBuilder().setCustomId('log_toggle_moderation').setLabel('Moderation').setStyle(logOptions.moderation !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🔨')
      );

      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_voice').setLabel('Voice').setStyle(logOptions.voice !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🔊'),
        new ButtonBuilder().setCustomId('log_toggle_messages').setLabel('Messages').setStyle(logOptions.messages !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('💬'),
        new ButtonBuilder().setCustomId('log_toggle_members').setLabel('Members').setStyle(logOptions.members !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('👤'),
        new ButtonBuilder().setCustomId('log_toggle_roles').setLabel('Roles').setStyle(logOptions.roles !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🏷️'),
        new ButtonBuilder().setCustomId('log_toggle_server').setLabel('Server').setStyle(logOptions.server !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🏠')
      );

      const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_commands').setLabel('Commands').setStyle(logOptions.commands !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('⚙️')
      );

      await interaction.update({ embeds: [embed], components: [row1, row2, row3, row4] });

    } else if (interaction.customId.startsWith('log_toggle_')) {
      const option = interaction.customId.replace('log_toggle_', '');

      // Get current options
      const { rows } = await safeQuery('SELECT log_options FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const defaultOpts = { tickets: true, purchases: true, giveaways: true, levels: true, moderation: true, voice: true, messages: true, members: true, roles: true, commands: true, server: true };
      let logOptions = { ...defaultOpts };
      try {
        if (rows[0]?.log_options) {
          const parsed = typeof rows[0].log_options === 'string' ? JSON.parse(rows[0].log_options) : rows[0].log_options;
          logOptions = { ...defaultOpts, ...parsed };
        }
      } catch (e) { }

      // Toggle the option
      logOptions[option] = logOptions[option] === false ? true : false;

      // Save to DB
      await db.query('INSERT INTO guild_configs (guild_id, log_options) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET log_options = $2', [interaction.guildId, JSON.stringify(logOptions)]);

      // Refresh the menu
      const { rows: configRows } = await safeQuery('SELECT log_channel_id, log_options FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = configRows[0] || {};
      logOptions = { ...defaultOpts };
      try {
        if (config.log_options) {
          const parsed = typeof config.log_options === 'string' ? JSON.parse(config.log_options) : config.log_options;
          logOptions = { ...defaultOpts, ...parsed };
        }
      } catch (e) { }

      const embed = new EmbedBuilder()
        .setTitle('🛡️ Logging Configuration')
        .setDescription(`Configure where the bot logs events and which events to log.
            
**Log Channel:** ${config.log_channel_id ? `<#${config.log_channel_id}>` : 'Not Set'}
            
**Log Options:**
${logOptions.tickets !== false ? '✅' : '❌'} Tickets • ${logOptions.purchases !== false ? '✅' : '❌'} Purchases • ${logOptions.giveaways !== false ? '✅' : '❌'} Giveaways
${logOptions.levels !== false ? '✅' : '❌'} Levels • ${logOptions.moderation !== false ? '✅' : '❌'} Moderation • ${logOptions.voice !== false ? '✅' : '❌'} Voice
${logOptions.messages !== false ? '✅' : '❌'} Messages • ${logOptions.members !== false ? '✅' : '❌'} Members • ${logOptions.roles !== false ? '✅' : '❌'} Roles
${logOptions.commands !== false ? '✅' : '❌'} Commands • ${logOptions.server !== false ? '✅' : '❌'} Server Changes`)
        .setColor('Blue');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_logs_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Primary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_tickets').setLabel('Tickets').setStyle(logOptions.tickets !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎫'),
        new ButtonBuilder().setCustomId('log_toggle_purchases').setLabel('Purchases').setStyle(logOptions.purchases !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🛒'),
        new ButtonBuilder().setCustomId('log_toggle_giveaways').setLabel('Giveaways').setStyle(logOptions.giveaways !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎁'),
        new ButtonBuilder().setCustomId('log_toggle_levels').setLabel('Levels').setStyle(logOptions.levels !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('📈'),
        new ButtonBuilder().setCustomId('log_toggle_moderation').setLabel('Moderation').setStyle(logOptions.moderation !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🔨')
      );

      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_voice').setLabel('Voice').setStyle(logOptions.voice !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🔊'),
        new ButtonBuilder().setCustomId('log_toggle_messages').setLabel('Messages').setStyle(logOptions.messages !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('💬'),
        new ButtonBuilder().setCustomId('log_toggle_members').setLabel('Members').setStyle(logOptions.members !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('👤'),
        new ButtonBuilder().setCustomId('log_toggle_roles').setLabel('Roles').setStyle(logOptions.roles !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🏷️'),
        new ButtonBuilder().setCustomId('log_toggle_server').setLabel('Server').setStyle(logOptions.server !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🏠')
      );

      const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('log_toggle_commands').setLabel('Commands').setStyle(logOptions.commands !== false ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('⚙️')
      );

      await interaction.update({ embeds: [embed], components: [row1, row2, row3, row4] });

    } else if (interaction.customId === 'setup_logs_channel_btn') {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('select_logs_channel')
          .setPlaceholder('Select Log Channel')
          .setChannelTypes([ChannelType.GuildText])
      );
      await interaction.reply({ content: 'Select the channel for logs:', components: [row], ephemeral: true });

      // --- ADMIN ROLE WIZARD ---
    } else if (interaction.customId === 'setup_admin_btn') {
      const { rows } = await safeQuery('SELECT admin_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};

      const embed = new EmbedBuilder()
        .setTitle('👮 Admin Role Configuration')
        .setDescription(`Set the role that has full access to bot commands and dashboards.
            
            **Current Role:** ${config.admin_role_id ? `<@&${config.admin_role_id}>` : 'Not Set (Using Default/Hardcoded)'}`)
        .setColor('Grey');

      const row1 = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('select_admin_role').setPlaceholder('Select Admin Role')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      await interaction.update({ embeds: [embed], components: [row1, row2] });

      // --- GOOGLE SHEET WIZARD ---
    } else if (interaction.customId === 'setup_sheet_btn') {
      const { rows } = await safeQuery('SELECT spreadsheet_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || 'bot-email@example.com';

      const embed = new EmbedBuilder()
        .setTitle('📊 Google Sheet Configuration')
        .setDescription(`Link a Google Sheet to log purchases.
            
            **Current Sheet ID:** ${config.spreadsheet_id || 'Not Set'}
            
            **Instructions:**
            1. Create a Google Sheet.
            2. Share it (Editor access) with: \`${serviceEmail}\`
            3. Copy the Sheet ID from the URL (part between /d/ and /edit).
            4. Click "Set Sheet ID" below.`)
        .setColor('Green');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_sheet_id_btn').setLabel('Set Sheet ID').setStyle(ButtonStyle.Success).setEmoji('📝'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row] });

    } else if (interaction.customId === 'setup_sheet_id_btn') {
      const modal = new ModalBuilder().setCustomId('modal_setup_sheet_id').setTitle('Set Google Sheet ID');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sheet_id').setLabel('Spreadsheet ID').setStyle(TextInputStyle.Short).setPlaceholder('1BxiMVs0XRA5nFMdKb...').setRequired(true)
      ));
      await interaction.showModal(modal);

      // --- GIVEAWAY CONFIG WIZARD ---
    } else if (interaction.customId === 'setup_giveaways_btn') {
      const { rows } = await safeQuery('SELECT giveaway_role_id FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};

      const embed = new EmbedBuilder()
        .setTitle('🎁 Giveaway Configuration')
        .setDescription(`Set the default role to ping when a giveaway starts.
            
            **Current Ping Role:** ${config.giveaway_role_id ? `<@&${config.giveaway_role_id}>` : 'None (Everyone/None)'}`)
        .setColor('Purple');

      const row1 = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('select_giveaway_role').setPlaceholder('Select Role to Ping')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'setup_levels_btn') {
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};
      const { rows: rewardRows } = await safeQuery('SELECT * FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [interaction.guildId]);
      const rewardsList = rewardRows.length ? rewardRows.map(r => `• Level ${r.level}: <@&${r.role_id}>`).join('\n') : 'None';
      config.rewards_list = rewardsList;

      const embed = new EmbedBuilder()
        .setTitle('📈 Leveling System Settings')
        .setDescription(`Configure XP rates and level up notifications.
             
             **Status:** ${config.leveling_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Message XP:** ${config.xp_rate_message || 20} XP per message
             **Voice XP:** ${config.xp_rate_voice || 10} XP per minute
             **Level Up Channel:** ${config.level_up_channel_id ? `<#${config.level_up_channel_id}>` : 'Current Channel'}
             `)
        .setColor('Gold');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_levels_toggle_btn').setLabel(config.leveling_enabled ? 'Disable' : 'Enable').setStyle(config.leveling_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_levels_msg_rate_btn').setLabel('Set Message XP').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
        new ButtonBuilder().setCustomId('setup_levels_voice_rate_btn').setLabel('Set Voice XP').setStyle(ButtonStyle.Secondary).setEmoji('🎙️')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_levels_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_levels_roles_btn').setLabel('Manage Roles').setStyle(ButtonStyle.Primary).setEmoji('🏅'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'setup_levels_toggle_btn') {
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET leveling_enabled = NOT COALESCE(leveling_enabled, FALSE) WHERE guild_id = $1', [interaction.guildId]);

      // Refresh Logic (Common)
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0];
      const { rows: rewardRows } = await safeQuery('SELECT * FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [interaction.guildId]);
      const rewardsList = rewardRows.length ? rewardRows.map(r => `• Level ${r.level}: <@&${r.role_id}>`).join('\n') : 'None';

      const embed = new EmbedBuilder()
        .setTitle('📈 Leveling System Settings')
        .setDescription(`Configure XP rates and level up notifications.
             
             **Status:** ${config.leveling_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Message XP:** ${config.xp_rate_message || 20} XP per message
             **Voice XP:** ${config.xp_rate_voice || 10} XP per minute
             **Level Up Channel:** ${config.level_up_channel_id ? `<#${config.level_up_channel_id}>` : 'Current Channel'}
             
             **Role Rewards:**
             ${rewardsList}
             `)
        .setColor('Gold');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_levels_toggle_btn').setLabel(config.leveling_enabled ? 'Disable' : 'Enable').setStyle(config.leveling_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_levels_msg_rate_btn').setLabel('Set Message XP').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
        new ButtonBuilder().setCustomId('setup_levels_voice_rate_btn').setLabel('Set Voice XP').setStyle(ButtonStyle.Secondary).setEmoji('🎙️')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_levels_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_levels_roles_btn').setLabel('Manage Roles').setStyle(ButtonStyle.Primary).setEmoji('🏅'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'setup_levels_roles_btn') {
      const { rows: rewardRows } = await safeQuery('SELECT * FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [interaction.guildId]);
      const rewardsList = rewardRows.length ? rewardRows.map(r => `• Level ${r.level}: <@&${r.role_id}>`).join('\n') : 'No rewards set.';

      const embed = new EmbedBuilder()
        .setTitle('🏅 Level Role Rewards')
        .setDescription(`Manage roles given at specific levels.\n\n${rewardsList}`)
        .setColor('Gold');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_levels_add_reward_btn').setLabel('Add Reward').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_levels_remove_reward_btn').setLabel('Remove Reward').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('setup_levels_btn').setLabel('Back').setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({ embeds: [embed], components: [row] });

    } else if (interaction.customId === 'setup_levels_add_reward_btn') {
      const modal = new ModalBuilder().setCustomId('modal_setup_levels_reward_lvl').setTitle('Add Reward: Select Level');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('level_input').setLabel('Level Requirement').setStyle(TextInputStyle.Short).setPlaceholder('e.g. 5, 10, 20').setRequired(true)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId === 'setup_levels_remove_reward_btn') {
      const { rows: rewardRows } = await safeQuery('SELECT * FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [interaction.guildId]);
      if (!rewardRows.length) return interaction.reply({ content: 'No rewards to remove.', ephemeral: true });

      const options = rewardRows.map(r => ({ label: `Level ${r.level}`, value: r.id.toString(), description: `Role ID: ${r.role_id}` }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_levels_remove_reward')
          .setPlaceholder('Select reward to remove')
          .addOptions(options)
      );
      await interaction.reply({ content: 'Select a reward to remove:', components: [row], ephemeral: true });

    } else if (interaction.customId === 'setup_levels_msg_rate_btn') {
      const modal = new ModalBuilder().setCustomId('modal_setup_levels_msg').setTitle('Set Message XP Rate');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('xp_rate').setLabel('XP per Message').setStyle(TextInputStyle.Short).setPlaceholder('20').setRequired(true)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId === 'setup_levels_voice_rate_btn') {
      const modal = new ModalBuilder().setCustomId('modal_setup_levels_voice').setTitle('Set Voice XP Rate');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('xp_rate').setLabel('XP per Minute in VC').setStyle(TextInputStyle.Short).setPlaceholder('10').setRequired(true)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId === 'setup_levels_channel_btn') {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('select_levels_channel')
          .setPlaceholder('Select Level Up Channel')
          .setChannelTypes([ChannelType.GuildText])
      );
      await interaction.reply({ content: 'Select the channel for level up announcements:', components: [row], ephemeral: true });

    } else if (interaction.customId === 'setup_welcome_btn') {
      // Fetch current config
      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0] || {};

      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: (config.welcome_message ? config.welcome_message.substring(0, 1000) : 'Default: "Welcome {user} to {guild}!"') + '\n\n*Variables: {user}, {guild}, {memberCount}, {avatar}*' })
        .setColor('Green');

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );

      if (interaction.isButton() && interaction.customId === 'setup_welcome_btn') {
        await interaction.update({ embeds: [embed], components: [row1, row2] });
      } else {
        // If coming from modal/select
        await interaction.update({ embeds: [embed], components: [row1, row2] });
      }

    } else if (interaction.customId === 'setup_welcome_toggle_btn') {
      // Toggle Logic
      // Ensure config exists
      await db.query('INSERT INTO guild_configs (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [interaction.guildId]);
      await db.query('UPDATE guild_configs SET welcome_enabled = NOT COALESCE(welcome_enabled, FALSE) WHERE guild_id = $1', [interaction.guildId]);

      // Refresh Menu (Call logic manually or re-trigger)
      // We need to re-fetch and re-render. Ideally functionize but inline for now.
      // Let's create a recursive call by emitting a fake interaction? No.
      // Just copy the render logic or "click" the back button then welcome button?
      // Let's just update based on known state or re-fetch. Re-fetch is safer.

      const { rows } = await safeQuery('SELECT * FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const config = rows[0];
      const embed = new EmbedBuilder()
        .setTitle('📢 Welcome Module Settings')
        .setDescription(`Configure how new members are welcomed.
             
             **Status:** ${config.welcome_enabled ? '✅ Enabled' : '❌ Disabled'}
             **Channel:** ${config.welcome_channel_id ? `<#${config.welcome_channel_id}>` : 'Not Set'}
             **Auto-Role:** ${config.auto_role_id ? `<@&${config.auto_role_id}>` : 'None'}
             `)
        .addFields({ name: 'Message Preview', value: config.welcome_message ? config.welcome_message.substring(0, 1024) : 'Default: "Welcome {user} to {guild}!"' })
        .setColor('Green');
      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_toggle_btn').setLabel(config.welcome_enabled ? 'Disable' : 'Enable').setStyle(config.welcome_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_welcome_channel_btn').setLabel('Set Channel').setStyle(ButtonStyle.Secondary).setEmoji('#️⃣'),
        new ButtonBuilder().setCustomId('setup_welcome_msg_btn').setLabel('Edit Message').setStyle(ButtonStyle.Secondary).setEmoji('📝')
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_welcome_autorole_btn').setLabel('Set Auto-Role').setStyle(ButtonStyle.Secondary).setEmoji('👔'),
        new ButtonBuilder().setCustomId('setup_welcome_image_btn').setLabel('Set Image URL').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
        new ButtonBuilder().setCustomId('setup_back_btn').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
      );
      await interaction.update({ embeds: [embed], components: [row1, row2] });

    } else if (interaction.customId === 'setup_welcome_channel_btn') {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('select_welcome_channel')
          .setPlaceholder('Select Welcome Channel')
          .setChannelTypes([ChannelType.GuildText])
      );
      await interaction.reply({ content: 'Select the channel for welcome messages:', components: [row], ephemeral: true });

    } else if (interaction.customId === 'modal_setup_tickets_title') {
      const title = interaction.fields.getTextInputValue('title_input');
      await db.query('UPDATE guild_configs SET ticket_panel_title = $1 WHERE guild_id = $2', [title, interaction.guildId]);
      await interaction.reply({ content: '✅ Title updated! Go back to "Customize Panel" to see changes.', ephemeral: true });

    } else if (interaction.customId === 'modal_setup_tickets_desc') {
      const desc = interaction.fields.getTextInputValue('desc_input');
      await db.query('UPDATE guild_configs SET ticket_panel_description = $1 WHERE guild_id = $2', [desc, interaction.guildId]);
      await interaction.reply({ content: '✅ Description updated! Go back to "Customize Panel" to see changes.', ephemeral: true });

    } else if (interaction.customId === 'modal_setup_tickets_image') {
      const image = interaction.fields.getTextInputValue('image_input');
      await db.query('UPDATE guild_configs SET ticket_panel_image_url = $1 WHERE guild_id = $2', [image || null, interaction.guildId]);
      await interaction.reply({ content: '✅ Image URL updated! Go back to "Customize Panel" to see changes.', ephemeral: true });

    } else if (interaction.customId === 'modal_setup_tickets_thumb') {
      const thumb = interaction.fields.getTextInputValue('thumb_input');
      await db.query('UPDATE guild_configs SET ticket_panel_thumbnail_url = $1 WHERE guild_id = $2', [thumb || null, interaction.guildId]);
      await interaction.reply({ content: '✅ Thumbnail URL updated! Go back to "Customize Panel" to see changes.', ephemeral: true });

    } else if (interaction.customId === 'modal_setup_tickets_color') {
      const color = interaction.fields.getTextInputValue('color_input');
      await db.query('UPDATE guild_configs SET ticket_panel_color = $1 WHERE guild_id = $2', [color, interaction.guildId]);
      await interaction.reply({ content: '✅ Color updated! Go back to "Customize Panel" to see changes.', ephemeral: true });

    } else if (interaction.customId === 'setup_welcome_msg_btn') {
      const { rows } = await safeQuery('SELECT welcome_message FROM guild_configs WHERE guild_id = $1', [interaction.guildId]);
      const currentMsg = rows[0]?.welcome_message || 'Welcome {user} to {guild}!';

      const modal = new ModalBuilder().setCustomId('modal_setup_welcome_msg').setTitle('Edit Welcome Message');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('msg_content').setLabel('Message').setStyle(TextInputStyle.Paragraph).setValue(currentMsg).setRequired(true)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId === 'setup_welcome_autorole_btn') {
      // Use Role Select Menu
      const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('select_welcome_autorole')
          .setPlaceholder('Select Auto-Role')
      );
      await interaction.reply({ content: 'Select the role to give to new members:', components: [row], ephemeral: true });


    } else if (interaction.customId === 'setup_welcome_image_btn') {
      const modal = new ModalBuilder().setCustomId('modal_setup_welcome_image').setTitle('Set Welcome Image');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('img_url').setLabel('Image URL').setStyle(TextInputStyle.Short).setPlaceholder('https://example.com/image.png').setRequired(false)
      ));
      await interaction.showModal(modal);



    } else if (interaction.customId === 'wizard_create_cat_btn') {
      const modal = new ModalBuilder().setCustomId('modal_wizard_cat').setTitle('Create Ticket Category');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_name').setLabel('Category Name').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_emoji').setLabel('Emoji').setStyle(TextInputStyle.Short).setPlaceholder('🎫').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_role_id').setLabel('Staff Role ID').setStyle(TextInputStyle.Short).setPlaceholder('1234567890').setRequired(true))
      );
      await interaction.showModal(modal);
      return;
    } else if (interaction.customId === 'claim_ticket_btn') {
      const { rows } = await safeQuery('SELECT * FROM tickets WHERE channel_id = $1', [interaction.channelId]);
      const ticket = rows[0];

      if (ticket.claimed_by_id) {
        return interaction.reply({ content: `❌ Already claimed by <@${ticket.claimed_by_id}>`, ephemeral: true });
      }

      await db.query('UPDATE tickets SET claimed_by_id = $1 WHERE channel_id = $2', [interaction.user.id, interaction.channelId]);

      const claimEmbed = new EmbedBuilder()
        .setDescription(`🙋‍♂️ Ticket claimed by <@${interaction.user.id}>`)
        .setColor('Gold');

      await interaction.reply({ embeds: [claimEmbed] });
      updateTicketDashboard(interaction.guild);

    } else if (interaction.customId === 'accept_ticket_btn') {
      const { rows } = await safeQuery(`
            SELECT t.*, tc.reward_role_id 
            FROM tickets t 
            JOIN ticket_categories tc ON t.category_id = tc.id 
            WHERE t.channel_id = $1`,
        [interaction.channelId]
      );
      const ticket = rows[0];

      if (!ticket || !ticket.reward_role_id) {
        return interaction.reply({ content: '❌ No reward role configured for this category.', ephemeral: true });
      }

      const member = await interaction.guild.members.fetch(ticket.user_id).catch(() => null);
      if (member) {
        await member.roles.add(ticket.reward_role_id).catch(e => console.error(e));
        await interaction.reply({ content: `✅ Application Accepted! <@${ticket.user_id}> has been given the <@&${ticket.reward_role_id}> role.` });
      } else {
        await interaction.reply({ content: '❌ User left the server.', ephemeral: true });
      }

    } else if (interaction.customId.startsWith('wizard_add_single_q_')) {
      const catId = interaction.customId.split('_')[4];

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`wizard_q_type_select_${catId}`)
          .setPlaceholder('Select Question Type')
          .addOptions(
            { label: 'Text Input', value: 'text', description: 'Standard text answer', emoji: '📝' },
            { label: 'Dropdown Selection', value: 'dropdown', description: 'User selects from a list', emoji: '🔽' },
            { label: 'File Upload', value: 'file', description: 'User uploads an image/file', emoji: '📎' }
          )
      );

      await interaction.reply({ content: 'Choose the type of answer for this question:', components: [row], ephemeral: true });
      return;

    } else if (interaction.customId.startsWith('wizard_edit_q_menu_')) {
      const catId = interaction.customId.split('_')[4];
      const { rows } = await db.query('SELECT form_questions FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = JSON.parse(rows[0].form_questions || '[]');
      questions = questions.map(q => (typeof q === 'string' ? { text: q, type: 'text' } : q));

      if (questions.length === 0) return interaction.reply({ content: 'No questions to edit.', ephemeral: true });

      const select = new StringSelectMenuBuilder()
        .setCustomId(`wizard_edit_q_select_${catId}`)
        .setPlaceholder('Select a question to edit')
        .addOptions(questions.map((q, i) => ({
          label: q.text.length > 50 ? q.text.substring(0, 47) + '...' : q.text,
          value: i.toString(),
          description: `Edit Question #${i + 1} (${q.type})`
        })));

      const row = new ActionRowBuilder().addComponents(select);
      const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wizard_cancel_delete_${catId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)); // Reuse cancel

      await interaction.reply({ content: 'Select a question to edit:', components: [row, cancelRow], ephemeral: true });
      return;

    } else if (interaction.customId.startsWith('wizard_finish_')) {
      await interaction.reply({ content: '✅ Setup finished! The category has been configured.', ephemeral: true });
      try { await interaction.channel.delete(); } catch (e) { }
      return;

    } else if (interaction.customId.startsWith('wizard_settings_menu_')) {
      const catId = interaction.customId.split('_')[3];

      const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });
      const cat = rows[0];

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Category Settings')
        .setDescription(`Configure advanced options for **${cat.name}**`)
        .addFields(
          { name: '🙋‍♂️ Claiming System', value: cat.claim_enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
          { name: '🎁 Reward Role', value: cat.reward_role_id ? `<@&${cat.reward_role_id}>` : 'None', inline: true }
        )
        .setColor('Grey');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_toggle_claim_${catId}`).setLabel(cat.claim_enabled ? 'Disable Claiming' : 'Enable Claiming').setStyle(cat.claim_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`wizard_set_role_btn_${catId}`).setLabel('Set Reward Role').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_back_main_${catId}`).setLabel('Back').setStyle(ButtonStyle.Secondary)
      );

      // Check if updating or replying
      if (interaction.message.embeds[0].title === '⚙️ Category Settings') {
        await interaction.update({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

    } else if (interaction.customId.startsWith('wizard_toggle_claim_')) {
      const catId = interaction.customId.split('_')[3];
      // Toggle
      await db.query('UPDATE ticket_categories SET claim_enabled = NOT claim_enabled WHERE id = $1', [catId]);

      // Refresh Settings Menu (Re-trigger logic)
      // We can just call the logic above or recursing?
      // Let's copy-paste for safety/simplicity in this tool constraint
      const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
      const cat = rows[0];

      const embed = new EmbedBuilder()
        .setTitle('⚙️ Category Settings')
        .setDescription(`Configure advanced options for **${cat.name}**`)
        .addFields(
          { name: '🙋‍♂️ Claiming System', value: cat.claim_enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
          { name: '🎁 Reward Role', value: cat.reward_role_id ? `<@&${cat.reward_role_id}>` : 'None', inline: true }
        )
        .setColor('Grey');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_toggle_claim_${catId}`).setLabel(cat.claim_enabled ? 'Disable Claiming' : 'Enable Claiming').setStyle(cat.claim_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`wizard_set_role_btn_${catId}`).setLabel('Set Reward Role').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_back_main_${catId}`).setLabel('Back').setStyle(ButtonStyle.Secondary)
      );

      await interaction.update({ embeds: [embed], components: [row] });

    } else if (interaction.customId.startsWith('wizard_set_role_btn_')) {
      const catId = interaction.customId.split('_')[4];
      const modal = new ModalBuilder().setCustomId(`modal_wizard_set_role_${catId}`).setTitle('Set Reward Role');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('role_id').setLabel('Role ID').setPlaceholder('123456789...').setStyle(TextInputStyle.Short).setRequired(false)
      ));
      await interaction.showModal(modal);

    } else if (interaction.customId.startsWith('wizard_back_main_')) {
      const catId = interaction.customId.split('_')[3];
      // Trigger the Main Panel Logic (Refresh)
      // We need to fetch questions etc.
      // We can just delete this settings message?
      // Since settings was ephemeral reply or update...
      // If it was update, we need to restore main view.
      // But main view logic is complex (fetching questions etc).
      // Let's try to just delete the settings message if it's ephemeral?
      // Or if we edited the main message...
      // The wizard buttons usually `.reply` ephemeral.
      // So `wizard_settings_menu` sends a NEW ephemeral message.
      // `back` can just delete this ephemeral message.
      try { await interaction.message.delete(); } catch (e) { }
      // Also we might want to ensure the previous message is still there. 
      // Just return.

    } else if (interaction.customId.startsWith('wizard_delete_q_menu_')) {
      const catId = interaction.customId.split('_')[4];
      const { rows } = await db.query('SELECT form_questions FROM ticket_categories WHERE id = $1', [catId]);
      if (rows.length === 0) return interaction.reply({ content: 'Category not found.', ephemeral: true });

      let questions = [];
      try {
        const rawData = rows[0].form_questions;
        if (Array.isArray(rawData)) {
          questions = rawData;
        } else if (rawData && typeof rawData === 'string' && rawData.trim().length > 0) {
          questions = JSON.parse(rawData);
        }
      } catch (e) { questions = []; }

      if (questions.length === 0) return interaction.reply({ content: 'No questions to delete.', ephemeral: true });

      // Normalize strings to objects
      questions = questions.map(q => (typeof q === 'string' ? { text: q, type: 'text' } : q));

      const select = new StringSelectMenuBuilder()
        .setCustomId(`wizard_delete_q_select_${catId}`)
        .setPlaceholder('Select a question to delete')
        .addOptions(questions.map((q, i) => ({
          label: q.text.length > 50 ? q.text.substring(0, 47) + '...' : q.text,
          value: i.toString(),
          description: `Question #${i + 1} (${q.type || 'text'})`
        })));

      const row = new ActionRowBuilder().addComponents(select);
      const cancelRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wizard_cancel_delete_${catId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));

      await interaction.update({ components: [row, cancelRow] });

    } else if (interaction.customId.startsWith('wizard_cancel_delete_')) {
      const catId = interaction.customId.split('_')[3];
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wizard_add_single_q_${catId}`).setLabel('Add Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_edit_q_menu_${catId}`).setLabel('Edit Question').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wizard_delete_q_menu_${catId}`).setLabel('Delete Question').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`wizard_settings_menu_${catId}`).setLabel('Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
        new ButtonBuilder().setCustomId(`wizard_finish_${catId}`).setLabel('Finish').setStyle(ButtonStyle.Success)
      );
      await interaction.update({ components: [row] });

    } else if (interaction.customId.startsWith('wizard_clear_q_')) {
      const catId = interaction.customId.split('_')[3];
      await db.query('UPDATE ticket_categories SET form_questions = $1 WHERE id = $2', [JSON.stringify([]), catId]);

      const embed = EmbedBuilder.from(interaction.message.embeds[0]);
      embed.setDescription('Current Questions:\nNone');
      await interaction.update({ embeds: [embed] });
    } else if (interaction.customId === 'close_ticket_btn') {
      await interaction.reply({ content: '🔒 Closing ticket...' });

      const { rows } = await safeQuery('SELECT * FROM tickets WHERE channel_id = $1', [interaction.channelId]);
      const ticket = rows[0];
      const ticketOwner = ticket ? ticket.user_id : 'Unknown';

      // Update DB
      await db.query('UPDATE tickets SET closed = TRUE WHERE channel_id = $1', [interaction.channelId]);

      const transcriptFile = await generateTranscriptFile(interaction, ticket, 'No reason provided');

      // Log the closure
      logActivity(
        '🔒 Ticket Closed',
        `**Ticket:** ${interaction.channel.name}\n**Closed by:** <@${interaction.user.id}>\n**Owner:** <@${ticketOwner}>\n**Reason:** No reason provided.\n\n*Transcript attached.*`,
        'Red',
        transcriptFile,
        interaction.guildId
      );
      updateTicketDashboard(interaction.guild);

      // Save to Backup Table
      try {
        await db.query(
          'INSERT INTO ticket_transcripts (channel_id, guild_id, user_id, transcript, reason, closed_by, closed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
          [interaction.channelId, interaction.guildId, ticketOwner, transcriptFile.attachment.toString('utf-8'), 'No reason provided.', interaction.user.id]
        );
      } catch (err) {
        console.error('Error creating transcript:', err);
      }

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
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    } else if (interaction.customId.startsWith('confirm_buy_')) {
      await interaction.deferUpdate();
    } else if (interaction.customId === 'cancel_buy') {
      await interaction.deferUpdate();
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

        logActivity('🎁 Giveaway Joined', `<@${interaction.user.id}> joined giveaway`, 'Blue');
      } catch (error) {
        console.error('Error joining giveaway:', error);
        await interaction.editReply({ content: '❌ An error occurred.' });
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
  res.send('All In One Bot is alive!');
});

// Endpoint for monitoring services (UptimeRobot, Healthchecks.io)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Self-ping logic or external service ping
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL;
if (HEALTHCHECK_URL) {
  // If user provided a Healthchecks.io URL, ping it periodically
  setInterval(() => {
    fetch(HEALTHCHECK_URL)
      .then(() => console.log('Successfully pinged Healthchecks.io'))
      .catch(err => console.error('Failed to ping Healthchecks.io:', err.message));
  }, 300 * 1000); // Every 5 minutes
}

// API endpoint to get real-time Discord server stats
// API endpoint to get real-time Discord server stats
app.get('/api/stats', async (req, res) => {
  try {
    // Enable CORS for Vercel
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    if (!client.isReady()) {
      return res.status(503).json({
        error: 'Bot not ready',
        serverName: 'Sovereign Empire',
        status: 'Offline',
        totalMembers: 0,
        onlineMembers: 0,
        notes: 'Bot is starting up...'
      });
    }

    const totalGuilds = client.guilds.cache.size;
    const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

    const stats = {
      serverName: `${totalGuilds} Servers`,
      status: 'Online',
      totalMembers: totalMembers,
      onlineMembers: 0,
      notes: 'All Systems Operational'
    };

    if (req.query.guild_id) {
      const guild = client.guilds.cache.get(req.query.guild_id);
      if (guild) {
        stats.serverName = guild.name;
        stats.totalMembers = guild.memberCount;
      }
    }

    res.json(stats);

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


app.get('/terms', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Terms of Service - ALL in One Bot</title>
        <style>body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; } h1 { color: #5865F2; }</style>
      </head>
      <body>
        <h1>Terms of Service</h1>
        <p><strong>Effective Date: January 12, 2026</strong></p>
        <p>By using the "ALL in One" Discord Bot, you agree to the following terms:</p>
        <ul>
          <li><strong>Usage:</strong> You may use the bot for managing your Discord server, including tickets, logging, leveling, and welcome messages.</li>
          <li><strong>Abuse:</strong> You may not use the bot to spam, harass, or violate Discord's Terms of Service.</li>
          <li><strong>Data:</strong> We store minimal data required for functionality (Guild IDs, User IDs, XP, Configuration). We do not sell your data.</li>
          <li><strong>Liability:</strong> The bot is provided "as is". We are not responsible for any data loss or service interruptions.</li>
          <li><strong>Changes:</strong> We reserve the right to modify these terms at any time.</li>
        </ul>
        <p>Contact the developer for any questions.</p>
      </body>
    </html>
  `);
});

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Privacy Policy - ALL in One Bot</title>
        <style>body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; } h1 { color: #5865F2; }</style>
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p><strong>Effective Date: January 12, 2026</strong></p>
        <p>We respect your privacy. Here is how we handle your data:</p>
        <h2>1. Data We Collect</h2>
        <ul>
            <li><strong>Discord User ID & Username:</strong> To track leveling (XP), economy balances, and ticket ownership.</li>
            <li><strong>Guild ID:</strong> To save server-specific configurations (welcome messages, log channels, etc.).</li>
            <li><strong>Message & Voice Activity:</strong> We count message frequency and voice duration solely for the purpose of calculating XP and currency rewards. We do not store message content permanently (except for ticket transcripts generated at your request).</li>
        </ul>
        <h2>2. Data Storage</h2>
        <p>Your data is stored securely in our database. Ticket transcripts are stored only upon ticket closure for logging purposes.</p>
        <h2>3. Data Deletion</h2>
        <p>You may request deletion of your data by contacting the bot owner or kicking the bot from your server (which may not immediately delete historical logs).</p>
        <h2>4. Third Parties</h2>
        <p>We do not share your data with third parties.</p>
      </body>
    </html>
  `);
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

// --- Advanced Server Logging ---

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author.bot) return;

  let alertText = "";
  if (message.content.includes('discord.gg/') || message.content.includes('http')) alertText += "\n⚠️ **Alert:** Deleted message contained a link.";
  if (message.mentions.users.size > 5) alertText += "\n🔴 **Critical:** Mass mention detected.";

  logActivity(
    '🗑️ Message Deleted',
    `**Author:** <@${message.author.id}>\n**Channel:** <#${message.channel.id}>\n**Content:**\n${message.content.substring(0, 1000)}${alertText}`,
    'Orange',
    null,
    message.guild.id
  );
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!oldMessage.guild || oldMessage.author.bot || oldMessage.content === newMessage.content) return;

  logActivity(
    '📝 Message Edited',
    `**Author:** <@${oldMessage.author.id}>\n**Channel:** <#${oldMessage.channel.id}>\n**Old:**\n${oldMessage.content.substring(0, 500)}\n**New:**\n${newMessage.content.substring(0, 500)}`,
    'Yellow',
    null,
    oldMessage.guild.id
  );
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  logActivity('📂 Channel Created', `**Name:** ${channel.name}\n**Type:** ${channel.type}\n\n*Recommendation: Check permissions for this new channel.*`, 'Green', null, channel.guild.id);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  logActivity('🗑️ Channel Deleted', `**Name:** ${channel.name}\n**Type:** ${channel.type}`, 'Red', null, channel.guild.id);
});

client.on('roleCreate', async (role) => {
  logActivity('🛡️ Role Created', `**Name:** ${role.name}\n**Color:** ${role.hexColor}\n\n*Tip: Ensure this role is below Admin roles in hierarchy.*`, 'Green', null, role.guild.id);
});

client.on('roleDelete', async (role) => {
  logActivity('🗑️ Role Deleted', `**Name:** ${role.name}`, 'Red', null, role.guild.id);
});

client.on('roleUpdate', async (oldRole, newRole) => {
  if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
    let alert = "";
    if (newRole.permissions.has(PermissionFlagsBits.Administrator) && !oldRole.permissions.has(PermissionFlagsBits.Administrator)) {
      alert = "\n🔴 **CRITICAL ALERT:** Administrator permission granted!";
    }
    if (newRole.permissions.has(PermissionFlagsBits.BanMembers) && !oldRole.permissions.has(PermissionFlagsBits.BanMembers)) {
      alert = "\n⚠️ **Warning:** Ban Members permission granted.";
    }

    logActivity(
      '🛡️ Role Permissions Updated',
      `**Role:** ${newRole.name}\n**Changes:** Permissions changed.${alert}`,
      alert.includes('CRITICAL') ? 'DarkRed' : 'Orange',
      null,
      newRole.guild.id
    );
  }
});

client.on('guildBanAdd', async (ban) => {
  logActivity('🔨 Member Banned', `**User:** ${ban.user.tag} (${ban.user.id})`, 'Red', null, ban.guild.id);
});

client.on('guildBanRemove', async (ban) => {
  logActivity('🔓 Member Unbanned', `**User:** ${ban.user.tag} (${ban.user.id})`, 'Green', null, ban.guild.id);
});

client.on('guildMemberRemove', async (member) => {
  logActivity('👋 Member Left', `**User:** ${member.user.tag} (${member.id})\n**Joined At:** ${member.joinedAt ? member.joinedAt.toLocaleDateString() : 'Unknown'}`, 'Red', null, member.guild.id);
});

client.on('guildMemberAdd', async (member) => {
  // Alt Account Detection
  const createdAt = member.user.createdTimestamp;
  const now = Date.now();
  const diff = now - createdAt;
  const daysOld = Math.floor(diff / (1000 * 60 * 60 * 24));

  let alert = "";
  if (daysOld < 3) {
    alert = "\n🔴 **Warning:** Account created less than 3 days ago. Possible Alt/Bot.";
  } else if (daysOld < 30) {
    alert = "\n⚠️ **Note:** New account (created < 30 days ago).";
  }

  // We already handle welcome messages elsewhere, this is for security logs
  if (alert) {
    logActivity('👤 New Member Suspect', `**User:** ${member.user.tag} (${member.id})\n**Account Age:** ${daysOld} days.${alert}`, 'Orange', null, member.guild.id);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.nickname !== newMember.nickname) {
    logActivity('👤 Nickname Changed', `**User:** ${newMember.user.tag}\n**Old:** ${oldMember.nickname || 'None'}\n**New:** ${newMember.nickname || 'None'}`, 'Blue', null, newMember.guild.id);
  }
});

client.on('inviteCreate', async (invite) => {
  logActivity('✉️ Invite Created', `**Creator:** ${invite.inviter?.tag || 'Unknown'}\n**Code:** ${invite.code}\n**Channel:** <#${invite.channelId}>`, 'Blue', null, invite.guild.id);
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (oldChannel.type !== ChannelType.GuildText) return; // Focus on text channels for now

  // Check for @everyone permission changes (making channel public/private)
  const oldPerms = oldChannel.permissionOverwrites.cache.get(oldChannel.guild.id);
  const newPerms = newChannel.permissionOverwrites.cache.get(newChannel.guild.id);

  // Simple check if specific deny flags changed (ViewChannel = 1024)
  const viewFlag = PermissionFlagsBits.ViewChannel;

  let oldDeny = oldPerms ? (oldPerms.deny.bitfield & viewFlag) : 0;
  let newDeny = newPerms ? (newPerms.deny.bitfield & viewFlag) : 0;

  if (oldDeny && !newDeny) {
    logActivity('🔓 Channel Made Public', `**Channel:** <#${newChannel.id}>\n⚠️ **Alert:** @everyone can now view this channel.`, 'Orange', null, newChannel.guild.id);
  } else if (!oldDeny && newDeny) {
    logActivity('🔒 Channel Made Private', `**Channel:** <#${newChannel.id}>\nInfo: @everyone can no longer view this channel.`, 'Blue', null, newChannel.guild.id);
  }
});


startBot();

async function generateTranscriptFile(interaction, ticket, reason) {
  let transcriptText = `TRANSCRIPT FOR TICKET: ${interaction.channel.name} (${interaction.channelId})\n`;
  transcriptText += `USER ID: ${ticket.user_id}\n`;
  transcriptText += `CLOSED BY: ${interaction.user.tag} (${interaction.user.id})\n`;
  transcriptText += `REASON: ${reason}\n`;
  transcriptText += `DATE: ${new Date().toISOString()}\n`;
  transcriptText += `--------------------------------------------------\n\n`;

  if (ticket.pending_questions && ticket.answers) {
    // Interview Mode Content
    try {
      const answers = typeof ticket.answers === 'string' ? JSON.parse(ticket.answers) : ticket.answers;
      answers.forEach((a, i) => {
        transcriptText += `Q${i + 1}: ${a.question}\nA: ${a.answer}\n\n`;
      });
    } catch (e) { }
  }

  // Fetch messages
  try {
    const messages = await interaction.channel.messages.fetch({ limit: 100 });
    messages.reverse().forEach(m => {
      const time = m.createdAt.toISOString().split('T')[1].split('.')[0];
      const author = m.author.tag;
      const content = m.content;
      const attachments = m.attachments.size > 0 ? ` [Attachments: ${m.attachments.map(a => a.url).join(', ')}] ` : '';
      transcriptText += `[${time}] ${author}: ${content}${attachments}\n`;
    });
  } catch (e) {
    transcriptText += `\n[Error fetching messages: ${e.message}]\n`;
  }

  return {
    attachment: Buffer.from(transcriptText, 'utf-8'),
    name: `transcript-${interaction.channel.name}-${Date.now()}.txt`
  };
}

async function addXp(guildId, userId, xpToAdd, channel = null) {
  try {
    // Check if leveling is enabled
    const { rows: configRows } = await safeQuery('SELECT leveling_enabled, level_up_channel_id FROM guild_configs WHERE guild_id = $1', [guildId]);
    if (!configRows.length || !configRows[0].leveling_enabled) return;

    const config = configRows[0];

    // Get current XP
    const { rows } = await safeQuery('SELECT * FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
    let userData = rows[0];

    if (!userData) {
      // Initialize
      await db.query('INSERT INTO user_levels (guild_id, user_id, xp, level, last_xp_time) VALUES ($1, $2, $3, $4, NOW())', [guildId, userId, xpToAdd, 0]);
      return;
    }

    let newXp = parseInt(userData.xp) + xpToAdd;
    let currentLevel = parseInt(userData.level);
    let xpNeeded = 5 * (currentLevel ** 2) + 50 * currentLevel + 100;

    let leveledUp = false;
    while (newXp >= xpNeeded) {
      newXp -= xpNeeded;
      currentLevel++;
      leveledUp = true;
      xpNeeded = 5 * (currentLevel ** 2) + 50 * currentLevel + 100;
    }

    await db.query('UPDATE user_levels SET xp = $1, level = $2, last_xp_time = NOW() WHERE guild_id = $3 AND user_id = $4', [newXp, currentLevel, guildId, userId]);

    if (leveledUp) {
      const announceChannelId = config.level_up_channel_id || (channel ? channel.id : null);
      if (announceChannelId) {
        try {
          const announceChannel = client.channels.cache.get(announceChannelId);
          if (announceChannel && announceChannel.isTextBased()) {
            await announceChannel.send(`🎉 <@${userId}> has reached **Level ${currentLevel}**! 🎉`);
          }
        } catch (e) { console.log('Level up announce failed:', e.message); }
      }

      // Role Rewards Logic
      try {
        const { rows: rewards } = await safeQuery('SELECT level, role_id FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [guildId]);
        if (rewards.length > 0) {
          const guild = client.guilds.cache.get(guildId);
          const member = await guild.members.fetch(userId);

          // Find the highest role appropriate for current level
          // We want to give the role for the HIGHEST milestone reached, and remove others.
          // Assuming rewards are sorted level ASC. [[5, A], [10, B], [20, C]]
          // If level 20: Target C. Remove A, B.

          let targetRole = null;
          const rolesToRemove = [];

          for (const r of rewards) {
            if (r.level <= currentLevel) {
              targetRole = r.role_id; // Keep updating as we find higher levels
            }
          }

          // Identify roles to remove (all other reward roles that are NOT the target)
          for (const r of rewards) {
            if (r.role_id !== targetRole) {
              rolesToRemove.push(r.role_id);
            }
          }

          if (targetRole) {
            const roleToAdd = guild.roles.cache.get(targetRole);
            if (roleToAdd && !member.roles.cache.has(targetRole)) {
              await member.roles.add(roleToAdd);
              // console.log(`Added level role ${roleToAdd.name} to ${member.user.tag}`);
            }
          }

          for (const rid of rolesToRemove) {
            const roleToRemove = guild.roles.cache.get(rid);
            if (roleToRemove && member.roles.cache.has(rid)) {
              await member.roles.remove(roleToRemove);
              // console.log(`Removed previous level role ${roleToRemove.name} from ${member.user.tag}`);
            }
          }
        }
      } catch (err) {
        console.error('Error handling level roles:', err);
      }
    }

  } catch (err) {
    console.error('Error adding XP:', err);
  }
}

async function initiateTicketCreation(interaction, catId) {
  console.log(`[Ticket Create] User ${interaction.user.tag} selected category ID: ${catId}`);
  try {
    const { rows } = await safeQuery('SELECT * FROM ticket_categories WHERE id = $1', [catId]);
    if (rows.length === 0) {
      return interaction.reply({ content: 'Category not found.', ephemeral: true });
    }

    const category = rows[0];
    let parsedQs = category.form_questions;
    if (typeof parsedQs === 'string') try { parsedQs = JSON.parse(parsedQs); } catch (e) {
      console.error('[Ticket Create] Error parsing questions JSON:', e);
    }
    if (!Array.isArray(parsedQs)) parsedQs = [];

    if (parsedQs.length === 0) parsedQs = ['Please describe your request:'];

    // Initialize session
    const totalPages = Math.ceil(parsedQs.length / 5);
    ticketCreationSessions.set(interaction.user.id, {
      catId: catId,
      questions: parsedQs,
      answers: [],
      totalPages: totalPages
    });

    // Show first modal (Page 0)
    const modal = new ModalBuilder()
      .setCustomId(`modal_ticket_submit_${catId}_0`)
      .setTitle(`Open Ticket: ${category.name.substring(0, 45)}`);

    parsedQs.slice(0, 5).forEach((q, i) => {
      const qText = typeof q === 'object' ? q.text : q;
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q_${i}`)
          .setLabel(qText.length > 45 ? qText.substring(0, 42) + '...' : qText)
          .setPlaceholder(qText.substring(0, 100))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      ));
    });

    await interaction.showModal(modal);
    try {
      if (interaction.message) await interaction.message.edit({ components: interaction.message.components });
    } catch (e) { }

  } catch (err) {
    console.error('[Ticket Create] Error opening form:', err);
  }
}

// Function to generate the user-facing Ticket Panel
async function sendTicketPanel(guild, panelId) {
  try {
    const { rows: panelRows } = await db.query('SELECT * FROM ticket_panels_v2 WHERE id = $1', [panelId]);
    if (panelRows.length === 0) return;
    const panel = panelRows[0];

    if (!panel.channel_id) return;
    const channel = guild.channels.cache.get(panel.channel_id);
    if (!channel) return;

    // Get categories for THIS panel
    const { rows: categories } = await db.query('SELECT * FROM ticket_categories WHERE guild_id = $1 AND panel_id = $2 ORDER BY id ASC', [guild.id, panelId]);

    // Default Values
    const title = panel.title || '🎫 Support Tickets';
    const description = panel.description || 'Click a button below to open a ticket for support.';
    const color = panel.color || 'Blue';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color);

    if (panel.image_url) embed.setImage(panel.image_url);
    if (panel.thumbnail_url) embed.setThumbnail(panel.thumbnail_url);

    const components = [];

    if (panel.button_style === 'dropdown') {
      const select = new StringSelectMenuBuilder()
        .setCustomId('ticket_select')
        .setPlaceholder('Select a category to open a ticket')
        .addOptions(categories.map(c => ({
          label: c.name,
          value: c.id.toString(),
          emoji: parseEmoji(c.emoji),
          description: `Open a ${c.name} ticket`
        })));
      components.push(new ActionRowBuilder().addComponents(select));
    } else {
      // Buttons (max 5 rows of 5 buttons)
      let currentRow = new ActionRowBuilder();
      categories.forEach((cat) => {
        if (currentRow.components.length >= 5) {
          components.push(currentRow);
          currentRow = new ActionRowBuilder();
        }
        currentRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`create_ticket_${cat.id}`)
            .setLabel(cat.name)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(parseEmoji(cat.emoji))
        );
      });
      if (currentRow.components.length > 0) components.push(currentRow);
    }

    // Send or Edit
    // If we stored message_id, try to fetch it
    let messageToEdit = null;
    if (panel.message_id) {
      try {
        messageToEdit = await channel.messages.fetch(panel.message_id);
      } catch (e) { /* Message deleted */ }
    }

    if (messageToEdit) {
      await messageToEdit.edit({ embeds: [embed], components: components });
    } else {
      const msg = await channel.send({ embeds: [embed], components: components });
      // Update DB with new message ID
      await db.query('UPDATE ticket_panels_v2 SET message_id = $1 WHERE id = $2', [msg.id, panelId]);
    }

  } catch (err) {
    console.error('Error sending ticket panel:', err);
  }
}


// Helper to parse emoji string for Discord components
function parseEmoji(emoji) {
  if (!emoji) return null;
  // Check if it's a custom emoji: <:name:id> or <a:name:id>
  const customEmojiRegex = /<(a?):(\w+):(\d+)>/;
  const match = emoji.match(customEmojiRegex);
  if (match) {
    return match[3]; // Return the ID
  }
  return emoji; // Return unicode
}
