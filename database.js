const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('FATAL ERROR: DATABASE_URL environment variable is not set. Please set it in your hosting provider (e.g., Koyeb).');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Users table
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

    // Voice time in minutes
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_times (
        user_id TEXT PRIMARY KEY,
        minutes BIGINT DEFAULT 0,
        rewarded_minutes BIGINT DEFAULT 0
      )
    `);

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

    // Boosts
    await client.query(`
      CREATE TABLE IF NOT EXISTS boosts (
        user_id TEXT PRIMARY KEY,
        boosts INTEGER DEFAULT 0
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
        participants TEXT[] DEFAULT '{}',
        winners TEXT[] DEFAULT '{}',
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