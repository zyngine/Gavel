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
    CREATE TABLE IF NOT EXISTS roster_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strikes (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_categories (
      guild_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, category_id)
    )
  `);

  // New columns on lawyers
  await pool.query(`ALTER TABLE lawyers ADD COLUMN IF NOT EXISTS display_name TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE lawyers ADD COLUMN IF NOT EXISTS hire_date TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE lawyers ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE lawyers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE lawyers ADD COLUMN IF NOT EXISTS archived_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS dashboard_role_id TEXT`).catch(() => {});

  // Backfill hire_date from added_at
  await pool.query(`UPDATE lawyers SET hire_date = added_at WHERE hire_date IS NULL`).catch(() => {});

  // Migrate old single dashboard_role_id to new dashboard_roles table
  await pool.query(`
    INSERT INTO dashboard_roles (guild_id, role_id)
    SELECT guild_id, dashboard_role_id FROM guild_config
    WHERE dashboard_role_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `).catch(() => {});

  console.log('Database tables ready.');
}

// --- Lawyers ---
async function addLawyer(guildId, userId, addedBy, displayName) {
  await pool.query(
    `INSERT INTO lawyers (guild_id, user_id, added_by, display_name, hire_date)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       archived = FALSE, archived_at = NULL, archived_by = NULL,
       added_by = $3, added_at = NOW(), hire_date = COALESCE(lawyers.hire_date, NOW()),
       display_name = COALESCE($4, lawyers.display_name)`,
    [guildId, userId, addedBy, displayName || null]
  );
}

async function archiveLawyer(guildId, userId, archivedBy) {
  const res = await pool.query(
    `UPDATE lawyers SET archived = TRUE, archived_at = NOW(), archived_by = $3
     WHERE guild_id = $1 AND user_id = $2 AND archived = FALSE`,
    [guildId, userId, archivedBy]
  );
  return res.rowCount > 0;
}

async function getLawyers(guildId) {
  const res = await pool.query(
    'SELECT * FROM lawyers WHERE guild_id = $1 AND archived = FALSE ORDER BY added_at ASC',
    [guildId]
  );
  return res.rows;
}

async function getArchivedLawyers(guildId) {
  const res = await pool.query(
    'SELECT * FROM lawyers WHERE guild_id = $1 AND archived = TRUE ORDER BY archived_at DESC',
    [guildId]
  );
  return res.rows;
}

async function isLawyer(guildId, userId) {
  const res = await pool.query(
    'SELECT 1 FROM lawyers WHERE guild_id = $1 AND user_id = $2 AND archived = FALSE',
    [guildId, userId]
  );
  return res.rows.length > 0;
}

async function updateHireDate(guildId, userId, hireDate) {
  await pool.query(
    'UPDATE lawyers SET hire_date = $3 WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId, hireDate]
  );
}

async function updateDisplayName(guildId, userId, displayName) {
  await pool.query(
    'UPDATE lawyers SET display_name = $3 WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId, displayName]
  );
}

// --- Roster Roles ---
async function addRosterRole(guildId, roleId) {
  await pool.query(
    `INSERT INTO roster_roles (guild_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [guildId, roleId]
  );
}

async function removeRosterRole(guildId, roleId) {
  const res = await pool.query('DELETE FROM roster_roles WHERE guild_id = $1 AND role_id = $2', [guildId, roleId]);
  return res.rowCount > 0;
}

async function getRosterRoles(guildId) {
  const res = await pool.query('SELECT role_id FROM roster_roles WHERE guild_id = $1', [guildId]);
  return res.rows.map(r => r.role_id);
}

// --- Dashboard Roles ---
async function addDashboardRole(guildId, roleId) {
  await pool.query(
    `INSERT INTO dashboard_roles (guild_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [guildId, roleId]
  );
}

async function removeDashboardRole(guildId, roleId) {
  const res = await pool.query('DELETE FROM dashboard_roles WHERE guild_id = $1 AND role_id = $2', [guildId, roleId]);
  return res.rowCount > 0;
}

async function getDashboardRoles(guildId) {
  const res = await pool.query('SELECT role_id FROM dashboard_roles WHERE guild_id = $1', [guildId]);
  return res.rows.map(r => r.role_id);
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

async function getActivityLog(guildId, userId, options = {}) {
  const conditions = ['guild_id = $1', 'user_id = $2'];
  const params = [guildId, userId];
  let idx = 3;

  if (options.startDate) {
    conditions.push(`logged_at >= $${idx}`);
    params.push(options.startDate);
    idx++;
  }
  if (options.endDate) {
    conditions.push(`logged_at <= $${idx}`);
    params.push(options.endDate);
    idx++;
  }
  if (options.channelName) {
    conditions.push(`channel_name ILIKE $${idx}`);
    params.push(`%${options.channelName}%`);
    idx++;
  }

  const res = await pool.query(
    `SELECT * FROM activity_log WHERE ${conditions.join(' AND ')}
     ORDER BY logged_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, options.limit || 50, options.offset || 0]
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

// --- Strikes ---
async function addStrike(guildId, userId, issuedBy, reason) {
  const res = await pool.query(
    'INSERT INTO strikes (guild_id, user_id, issued_by, reason) VALUES ($1, $2, $3, $4) RETURNING *',
    [guildId, userId, issuedBy, reason]
  );
  return res.rows[0];
}

async function removeStrike(strikeId, guildId) {
  const res = await pool.query(
    'DELETE FROM strikes WHERE id = $1 AND guild_id = $2',
    [strikeId, guildId]
  );
  return res.rowCount > 0;
}

async function getStrikes(guildId, userId) {
  const res = await pool.query(
    'SELECT * FROM strikes WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC',
    [guildId, userId]
  );
  return res.rows;
}

async function getStrikeCount(guildId, userId) {
  const res = await pool.query(
    'SELECT COUNT(*) as count FROM strikes WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return parseInt(res.rows[0].count);
}

// --- Ticket Categories ---
async function addTicketCategory(guildId, categoryId) {
  await pool.query(
    `INSERT INTO ticket_categories (guild_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [guildId, categoryId]
  );
}

async function removeTicketCategory(guildId, categoryId) {
  const res = await pool.query(
    'DELETE FROM ticket_categories WHERE guild_id = $1 AND category_id = $2',
    [guildId, categoryId]
  );
  return res.rowCount > 0;
}

async function getTicketCategories(guildId) {
  const res = await pool.query('SELECT category_id FROM ticket_categories WHERE guild_id = $1', [guildId]);
  return res.rows.map(r => r.category_id);
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

async function setInactivityDays(guildId, days) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, inactivity_days) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET inactivity_days = $2`,
    [guildId, days]
  );
}

async function getInactiveLawyers(guildId, days) {
  const res = await pool.query(
    `SELECT user_id, added_at, last_active FROM (
       SELECT l.user_id, l.added_at,
         (SELECT MAX(a.logged_at) FROM activity_log a WHERE a.guild_id = l.guild_id AND a.user_id = l.user_id) as last_active
       FROM lawyers l
       WHERE l.guild_id = $1 AND l.archived = FALSE
     ) sub
     WHERE last_active IS NULL OR last_active < NOW() - INTERVAL '1 day' * $2
     ORDER BY last_active ASC NULLS FIRST`,
    [guildId, days]
  );
  return res.rows;
}

module.exports = {
  initDb, addLawyer, archiveLawyer, getLawyers, getArchivedLawyers, isLawyer,
  updateHireDate, updateDisplayName,
  addRosterRole, removeRosterRole, getRosterRoles,
  addDashboardRole, removeDashboardRole, getDashboardRoles,
  addMonitoredChannel, removeMonitoredChannel, getMonitoredChannels, isChannelMonitored,
  logActivity, getActivityCount, getLastActivity, getRecentActivity, getActivityLog,
  addNote, getNotes,
  addStrike, removeStrike, getStrikes, getStrikeCount,
  addTicketCategory, removeTicketCategory, getTicketCategories,
  getGuildConfig, setAlertChannel, setInactivityDays, getInactiveLawyers
};
