const { pool, initializeDatabase } = require('./database');
require('dotenv').config();

async function resetAllData() {
  const client = await pool.connect();
  try {
    console.log('🔄 Starting data reset...');
    
    // Reset user balances and resources
    await client.query(`
      UPDATE users 
      SET balance = 0, 
          gold = 0, 
          wood = 0, 
          food = 0, 
          stone = 0,
          daily_streak = 0,
          last_daily = NULL
    `);
    console.log('✅ Reset all user balances and resources');
    
    // Reset message counts
    await client.query(`
      UPDATE message_counts 
      SET count = 0, 
          rewarded_messages = 0
    `);
    console.log('✅ Reset all message counts');
    
    // Reset voice times
    await client.query(`
      UPDATE voice_times 
      SET minutes = 0, 
          rewarded_minutes = 0
    `);
    console.log('✅ Reset all voice times');
    
    // Reset invites
    await client.query(`
      UPDATE invites 
      SET invites = 0
    `);
    console.log('✅ Reset all invites');
    
    // Reset boosts
    await client.query(`
      UPDATE boosts 
      SET boosts = 0
    `);
    console.log('✅ Reset all boosts');
    
    // Reset invited_members (optional - clears invite tracking)
    await client.query(`
      DELETE FROM invited_members
    `);
    console.log('✅ Reset invited members tracking');
    
    // Reset server pool to default (optional)
    await client.query(`
      UPDATE server_stats 
      SET pool_balance = 100000
      WHERE pool_balance != 100000
    `);
    console.log('✅ Reset server pool to 100,000');
    
    console.log('🎉 All data has been reset successfully!');
  } catch (error) {
    console.error('❌ Error resetting data:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the reset
resetAllData()
  .then(() => {
    console.log('✅ Reset completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Reset failed:', error);
    process.exit(1);
  });
