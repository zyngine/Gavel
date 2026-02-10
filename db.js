const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lawyers (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'channel',
      PRIMARY KEY (guild_id, channel_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      logged_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lawyer_notes (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      alert_channel_id TEXT,
      inactivity_days INTEGER DEFAULT 7,
      dashboard_role_id TEXT
    )
  `);
  await pool.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS dashboard_role_id TEXT`).catch(() => {});
  console.log('Database tables ready.');
}

// --- Lawyers ---
async function addLawyer(guildId, userId, addedBy) {
  await pool.query(
    `INSERT INTO lawyers (guild_id, user_id, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [guildId, userId, addedBy]
  );
}

async function removeLawyer(guildId, userId) {
  const res = await pool.query('DELETE FROM lawyers WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return res.rowCount > 0;
}

async function getLawyers(guildId) {
  const res = await pool.query('SELECT * FROM lawyers WHERE guild_id = $1 ORDER BY added_at ASC', [guildId]);
  return res.rows;
}

async function isLawyer(guildId, userId) {
  const res = await pool.query('SELECT 1 FROM lawyers WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
  return res.rows.length > 0;
}

// --- Monitored Channels ---
async function addMonitoredChannel(guildId, channelId, type) {
  await pool.query(
    `INSERT INTO monitored_channels (guild_id, channel_id, channel_type) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, channel_id) DO NOTHING`,
    [guildId, channelId, type]
  );
}

async function removeMonitoredChannel(guildId, channelId) {
  const res = await pool.query('DELETE FROM monitored_channels WHERE guild_id = $1 AND channel_id = $2', [guildId, channelId]);
  return res.rowCount > 0;
}

async function getMonitoredChannels(guildId) {
  const res = await pool.query('SELECT * FROM monitored_channels WHERE guild_id = $1', [guildId]);
  return res.rows;
}

async function isChannelMonitored(guildId, channelId, parentId) {
  const res = await pool.query(
    'SELECT 1 FROM monitored_channels WHERE guild_id = $1 AND (channel_id = $2 OR channel_id = $3)',
    [guildId, channelId, parentId || '']
  );
  return res.rows.length > 0;
}

// --- Activity ---
async function logActivity(guildId, userId, channelId, channelName) {
  await pool.query(
    'INSERT INTO activity_log (guild_id, user_id, channel_id, channel_name) VALUES ($1, $2, $3, $4)',
    [guildId, userId, channelId, channelName]
  );
}

async function getActivityCount(guildId, userId, days) {
  const res = await pool.query(
    `SELECT COUNT(*) as count FROM activity_log
     WHERE guild_id = $1 AND user_id = $2 AND logged_at > NOW() - INTERVAL '1 day' * $3`,
    [guildId, userId, days]
  );
  return parseInt(res.rows[0].count);
}

async function getLastActivity(guildId, userId) {
  const res = await pool.query(
    'SELECT logged_at FROM activity_log WHERE guild_id = $1 AND user_id = $2 ORDER BY logged_at DESC LIMIT 1',
    [guildId, userId]
  );
  return res.rows[0]?.logged_at || null;
}

async function getRecentActivity(guildId, userId, limit) {
  const res = await pool.query(
    'SELECT channel_name, logged_at FROM activity_log WHERE guild_id = $1 AND user_id = $2 ORDER BY logged_at DESC LIMIT $3',
    [guildId, userId, limit]
  );
  return res.rows;
}

// --- Notes ---
async function addNote(guildId, userId, authorId, note) {
  await pool.query(
    'INSERT INTO lawyer_notes (guild_id, user_id, author_id, note) VALUES ($1, $2, $3, $4)',
    [guildId, userId, authorId, note]
  );
}

async function getNotes(guildId, userId) {
  const res = await pool.query(
    'SELECT * FROM lawyer_notes WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10',
    [guildId, userId]
  );
  return res.rows;
}

// --- Guild Config ---
async function getGuildConfig(guildId) {
  const res = await pool.query('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
  return res.rows[0] || null;
}

async function setAlertChannel(guildId, channelId) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, alert_channel_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET alert_channel_id = $2`,
    [guildId, channelId]
  );
}

async function setDashboardRole(guildId, roleId) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, dashboard_role_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET dashboard_role_id = $2`,
    [guildId, roleId]
  );
}

async function setInactivityDays(guildId, days) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, inactivity_days) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET inactivity_days = $2`,
    [guildId, days]
  );
}

async function getInactiveLawyers(guildId, days) {
  const res = await pool.query(
    `SELECT l.user_id, l.added_at,
       (SELECT MAX(a.logged_at) FROM activity_log a WHERE a.guild_id = l.guild_id AND a.user_id = l.user_id) as last_active
     FROM lawyers l
     WHERE l.guild_id = $1
     HAVING (SELECT MAX(a.logged_at) FROM activity_log a WHERE a.guild_id = l.guild_id AND a.user_id = l.user_id) IS NULL
        OR (SELECT MAX(a.logged_at) FROM activity_log a WHERE a.guild_id = l.guild_id AND a.user_id = l.user_id) < NOW() - INTERVAL '1 day' * $2
     ORDER BY last_active ASC NULLS FIRST`,
    [guildId, days]
  );
  return res.rows;
}

module.exports = {
  initDb, addLawyer, removeLawyer, getLawyers, isLawyer,
  addMonitoredChannel, removeMonitoredChannel, getMonitoredChannels, isChannelMonitored,
  logActivity, getActivityCount, getLastActivity, getRecentActivity,
  addNote, getNotes,
  getGuildConfig, setAlertChannel, setDashboardRole, setInactivityDays, getInactiveLawyers
};
