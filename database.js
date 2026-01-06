const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const isSqlite = !!process.env.DB_PATH && !process.env.DATABASE_URL;
let pool;

if (isSqlite) {
  console.log(`Using SQLite database at ${process.env.DB_PATH}`);
  const db = new sqlite3.Database(process.env.DB_PATH);

  pool = {
    connect: async () => ({
      query: (text, params) => executeSqlite(db, text, params),
      release: () => { }
    }),
    query: (text, params) => executeSqlite(db, text, params),
  };
} else {
  if (!process.env.DATABASE_URL) {
    throw new Error('FATAL ERROR: DATABASE_URL environment variable is not set. Please set it in your hosting provider.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

function executeSqlite(db, text, params = []) {
  // Convert Postgres $n syntax to SQLite ? syntax
  const sql = text.replace(/\$\d+/g, '?');
  // console.log(`[SQL] Executing: ${sql.substring(0, 100)}...`); // Uncomment for verbose SQL logging

  // Serialize array/object parameters to JSON strings for SQLite
  const serializedParams = params.map(p => (typeof p === 'object' && p !== null) ? JSON.stringify(p) : p);

  return new Promise((resolve, reject) => {
    // Check if it's a SELECT or RETURNING query (needs .all) or UPDATE/INSERT/DELETE (needs .run)
    // Note: SQLite supports RETURNING in newer versions.
    if (sql.trim().match(/^(SELECT|WITH)/i) || sql.includes('RETURNING')) {
      db.all(sql, serializedParams, (err, rows) => {
        if (err) return reject(err);
        // Attempt to parse JSON strings back to objects/arrays for compatibility
        const parsedRows = rows.map(row => {
          const newRow = { ...row };
          for (const key in newRow) {
            if (typeof newRow[key] === 'string' && (newRow[key].startsWith('[') || newRow[key].startsWith('{'))) {
              try {
                newRow[key] = JSON.parse(newRow[key]);
              } catch (e) {
                // Not JSON, keep as string
              }
            }
          }
          return newRow;
        });
        resolve({ rows: parsedRows, rowCount: rows.length });
      });
    } else {
      db.run(sql, serializedParams, function (err) {
        if (err) return reject(err);
        resolve({ rows: [], rowCount: this.changes, oid: this.lastID });
      });
    }
  });
}

async function initializeDatabase() {
  // ... (Update CREATE statements) use isSqlite flag
  const client = await pool.connect();
  try {
    // ...

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        gold BIGINT DEFAULT 0,
        wood BIGINT DEFAULT 0,
        food BIGINT DEFAULT 0,
        stone BIGINT DEFAULT 0,
        last_daily DATE,
        daily_streak INTEGER DEFAULT 0
      )
    `);

    // Message count for rewards
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_counts (
        user_id TEXT PRIMARY KEY,
        count BIGINT DEFAULT 0,
        rewarded_messages BIGINT DEFAULT 0
      )
    `);

    // Migration: Add rewarded_messages to message_counts
    try {
      await client.query('ALTER TABLE message_counts ADD COLUMN rewarded_messages BIGINT DEFAULT 0');
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        console.log('Migration note (message_counts):', err.message);
      }
    }

    // Migration: Fix missing PK/Unique constraint for message_counts (fixing ON CONFLICT error)
    try {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_counts_user_id ON message_counts(user_id)');
    } catch (err) {
      console.log('Migration warning (message_counts index):', err.message);
    }

    // Voice time in minutes
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_times (
        user_id TEXT PRIMARY KEY,
        minutes BIGINT DEFAULT 0,
        rewarded_minutes BIGINT DEFAULT 0
      )
    `);

    // Migration: Add rewarded_minutes to voice_times
    try {
      await client.query('ALTER TABLE voice_times ADD COLUMN rewarded_minutes BIGINT DEFAULT 0');
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        console.log('Migration note (voice_times):', err.message);
      }
    }

    // Migration: Fix missing PK/Unique constraint for voice_times
    try {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_times_user_id ON voice_times(user_id)');
    } catch (err) {
      console.log('Migration warning (voice_times index):', err.message);
    }

    // Invites
    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        user_id TEXT PRIMARY KEY,
        invites INTEGER DEFAULT 0
      )
    `);

    // Track invited members to prevent duplicate rewards
    await client.query(`
      CREATE TABLE IF NOT EXISTS invited_members (
        inviter_id TEXT NOT NULL,
        invited_member_id TEXT NOT NULL,
        first_invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (inviter_id, invited_member_id)
      )
    `);

    // Shop Items Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id INTEGER PRIMARY KEY, 
        name TEXT NOT NULL,
        price REAL NOT NULL,
        emoji TEXT,
        description TEXT,
        role_id TEXT,
        resource_type TEXT,
        quantity INTEGER DEFAULT 1,
        requires_ticket INTEGER DEFAULT 0,
        stock INTEGER DEFAULT -1
      )
    `);

    // Migration: Add quantity to shop_items
    try {
      await client.query('ALTER TABLE shop_items ADD COLUMN quantity INTEGER DEFAULT 1');
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        console.log('Migration note (shop_items quantity):', err.message);
      }
    }

    // Migration: Add requires_ticket to shop_items
    try {
      await client.query('ALTER TABLE shop_items ADD COLUMN requires_ticket INTEGER DEFAULT 0');
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        console.log('Migration note (shop_items requires_ticket):', err.message);
      }
    }

    // Migration: Add stock to shop_items
    try {
      await client.query('ALTER TABLE shop_items ADD COLUMN stock INTEGER DEFAULT -1');
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        console.log('Migration note (shop_items stock):', err.message);
      }
    }

    // Boosts
    await client.query(`
      CREATE TABLE IF NOT EXISTS boosts (
        user_id TEXT PRIMARY KEY,
        boosts INTEGER DEFAULT 0
      )
    `);

    // QOTD Settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS qotd_settings (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT,
        role_id TEXT
      )
    `);

    // QOTD Questions
    await client.query(`
      CREATE TABLE IF NOT EXISTS qotd_questions (
        id INTEGER PRIMARY KEY, 
        date TEXT,
        question TEXT,
        posted INTEGER DEFAULT 0
      )
    `);

    // Server-wide stats
    await client.query(`
      CREATE TABLE IF NOT EXISTS server_stats (
        id TEXT PRIMARY KEY,
        rewarded_boosts INTEGER DEFAULT 0,
        pool_balance REAL DEFAULT 0
      )
    `);

    // Giveaways
    await client.query(`
      CREATE TABLE IF NOT EXISTS giveaways (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        entry_cost REAL NOT NULL,
        total_prize REAL NOT NULL DEFAULT 0,
        winner_count INTEGER NOT NULL,
        end_time TIMESTAMP NOT NULL,
        creator_id TEXT NOT NULL,
        participants ${isSqlite ? 'TEXT' : 'TEXT[]'} DEFAULT ${isSqlite ? "'[]'" : "'{}'"},
        winners ${isSqlite ? 'TEXT' : 'TEXT[]'} DEFAULT ${isSqlite ? "'[]'" : "'{}'"},
        ended BOOLEAN DEFAULT FALSE,
        required_role_id TEXT
      )
    `);

    // Migration: Add total_prize column if it doesn't exist
    try {
      await client.query('ALTER TABLE giveaways ADD COLUMN total_prize REAL NOT NULL DEFAULT 0');
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('already exists')) {
        console.log('Migration note:', err.message);
      }
    }

    // Migration: Remove prize column if it exists
    try {
      await client.query('ALTER TABLE giveaways DROP COLUMN IF EXISTS prize');
    } catch (err) {
      // Column doesn't exist, ignore error
      console.log('Migration note:', err.message);
    }

    // Migration: Add required_role_id column if it doesn't exist
    try {
      await client.query('ALTER TABLE giveaways ADD COLUMN required_role_id TEXT');
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('already exists')) {
        console.log('Migration note:', err.message);
      }
    }

    // Migration: Remove giveaway_rewards table if it exists (no longer needed)
    try {
      await client.query('DROP TABLE IF EXISTS giveaway_rewards');
    } catch (err) {
      // Table doesn't exist, ignore error
      console.log('Migration note:', err.message);
    }

    // Server Growth Tracking


    // Ticket System Tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_categories (
        id ${isSqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'},
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT,
        staff_role_id TEXT,
        form_questions ${isSqlite ? 'TEXT' : 'JSONB'},
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration to add form_questions if it doesn't exist
    try {
      await client.query(`ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS form_questions ${isSqlite ? 'TEXT' : 'JSONB'}`);
    } catch (err) {
      // Ignore if column exists (though ADD COLUMN IF NOT EXISTS handles it in newer PG, node-pg might throw on syntax if old PG)
      console.log('Safe migration: form_questions column check passed.');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_panels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        category_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed BOOLEAN DEFAULT FALSE
      )
    `);

    console.log('Database tables checked/created successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initializeDatabase,
};