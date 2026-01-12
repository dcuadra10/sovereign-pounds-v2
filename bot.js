require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Events, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { pool: db, initializeDatabase } = require('./database');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

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
async function logActivity(title, message, color = 'Blue', attachment = null) {
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

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    const invites = await guild.invites.fetch();
    invites.forEach(invite => {
      cachedInvites.set(invite.code, invite.uses);
    });
  }

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
  const guildObj = client.guilds.cache.get(process.env.GUILD_ID);
  if (guildObj) updateTicketDashboard(guildObj);

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
});

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
          `🪨 Stone: ${(row?.stone || 0).toLocaleString('en-US')}\n\n` +
          `*Resources granted upon temple conquest.*`
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
        await interaction.editReply({ content: `❌ An error occurred while giving currency.` });
      }

    } else if (commandName === 'take') {
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

    } else if (commandName === 'shop-add') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
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
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
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
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });

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

      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
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
            option.setEmoji(cat.emoji || '🎫'); // Use Unicode
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
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      console.log(`[Wizard Debug] User: ${interaction.user.id}, Admins: ${JSON.stringify(adminIds)}`);

      if (!adminIds.includes(interaction.user.id)) {
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
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
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

    } else if (commandName === 'ticket-backup') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });

      const ticketId = interaction.options.getString('ticket_id');
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

    } else if (commandName === 'add-emoji') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
        return await interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }

      const image = interaction.options.getAttachment('image');
      const name = interaction.options.getString('name');

      await interaction.deferReply({ ephemeral: true });

      try {
        // Upload to Bot Application (Global Emojis)
        await client.application.fetch();
        const emoji = await client.application.emojis.create({ attachment: image.url, name: name });
        await interaction.editReply({ content: `✅ **Bot Emoji** created successfully! ${emoji}\nID: \`${emoji.id}\`\nUsage: ${emoji.toString()}` });
      } catch (error) {
        console.error('Error creating app emoji:', error);
        // Fallback to Guild Emoji? The user explicitly asked for Bot Emoji.
        await interaction.editReply({ content: `❌ Failed to create **Bot** emoji. Error: ${error.message}\n\n*Make sure the bot is owned by you or a Team and has slots available.*` });
      }
    } else if (commandName === 'giveaway') {
      const adminIds = (process.env.ADMIN_IDS || '').split(',');
      if (!adminIds.includes(interaction.user.id)) {
        return interaction.reply('🚫 You do not have permission to use this command.');
      }

      const duration = interaction.options.getString('duration');
      const totalPrize = interaction.options.getNumber('total_prize');
      const winnerCount = interaction.options.getInteger('winners') || 1;
      const entryCost = interaction.options.getNumber('entry_cost') || 10;

      let pingRole = interaction.options.getRole('ping_role');
      if (!pingRole && DEFAULT_GIVEAWAY_PING_ROLE) {
        pingRole = interaction.guild.roles.cache.get(DEFAULT_GIVEAWAY_PING_ROLE);
      }

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
    if (interaction.customId === 'shop_buy_select') {
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
      // Delete the selection menu message
      try { await interaction.message.delete(); } catch (e) { }

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
      // Clean up the selection message
      try { await interaction.message.delete(); } catch (e) { }
    } else {
      console.log(`[Select Menu] Unknown Custom ID: '${interaction.customId}'`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Menu handler not found for ID: \`${interaction.customId}\`.`, ephemeral: true });
      }
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

      if (parsedQs.length === 0) parsedQs = [{ text: 'Please describe your request:', type: 'text' }];

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
        transcriptFile
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
  res.send('Sovereign Pounds bot is alive!');
});

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

    const guildId = process.env.GUILD_ID;
    if (!guildId) {
      return res.status(500).json({ error: 'Guild ID not configured' });
    }

    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    let totalMembers = guild.memberCount;
    let onlineMembers = 0;

    // Default fallback note
    let notes = `Serving ${totalMembers} members.`;

    // Stats Channel IDs provided by user
    const MEMBER_COUNT_CHANNEL_ID = '1457131100546531398';
    const ONLINE_COUNT_CHANNEL_ID = '1457132406711779339';

    // Fetch specifically these channels
    const memberChannel = guild.channels.cache.get(MEMBER_COUNT_CHANNEL_ID);
    const onlineChannel = guild.channels.cache.get(ONLINE_COUNT_CHANNEL_ID);

    if (memberChannel) {
      // Extract just the number
      const match = memberChannel.name.match(/(\d+)/);
      if (match) {
        totalMembers = parseInt(match[1]);
        // Update notes roughly, but keep it clean (no emojis from channel name)
        notes = `Serving ${totalMembers} members.`;
      }
    }

    if (onlineChannel) {
      const match = onlineChannel.name.match(/(\d+)/);
      if (match) {
        onlineMembers = parseInt(match[1]);
      }
    } else {
      // Fallback if specific channel not found/accessible
      try {
        const members = await guild.members.fetch();
        onlineMembers = members.filter(m =>
          !m.user.bot &&
          ['online', 'dnd', 'idle'].includes(m.presence?.status)
        ).size;
      } catch (e) {
        console.log("Failed to fetch members for presence:", e);
        onlineMembers = 0;
      }
      if (onlineMembers === 0) onlineMembers = Math.floor(totalMembers * 0.3);
    }

    res.json({
      serverName: guild.name,
      status: "Online",
      totalMembers: totalMembers,
      onlineMembers: onlineMembers,
      notes: notes
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
