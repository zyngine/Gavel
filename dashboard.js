const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');

function createDashboard(client) {
  const app = express();
  const port = process.env.PORT || 3000;

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'gavel-dashboard-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 }
  }));

  // --- Discord OAuth2 ---
  const CLIENT_ID = process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.CLIENT_SECRET;
  const REDIRECT_URI = process.env.DASHBOARD_URL ? `${process.env.DASHBOARD_URL}/auth/callback` : `http://localhost:${port}/auth/callback`;

  app.get('/auth/login', (req, res) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds guilds.members.read'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
      // Exchange code for token
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        })
      });
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        console.error('OAuth2 token error:', tokenData);
        return res.redirect('/?error=auth_failed');
      }

      // Get user info
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const user = await userRes.json();

      req.session.user = {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        avatar: user.avatar,
        accessToken: tokenData.access_token
      };

      res.redirect('/dashboard');
    } catch (err) {
      console.error('OAuth2 callback error:', err);
      res.redirect('/?error=auth_failed');
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
  });

  // --- Auth middleware ---
  async function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/auth/login');

    // Check if user has the dashboard role in any guild the bot is in
    try {
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${req.session.user.accessToken}` }
      });
      const userGuilds = await guildsRes.json();

      if (!Array.isArray(userGuilds)) {
        req.session.destroy();
        return res.redirect('/auth/login');
      }

      // Find guilds the bot is also in
      const botGuilds = client.guilds.cache;
      const sharedGuilds = userGuilds.filter(g => botGuilds.has(g.id));

      let authorized = false;
      let authorizedGuilds = [];

      for (const guild of sharedGuilds) {
        const config = await db.getGuildConfig(guild.id);
        if (!config || !config.dashboard_role_id) continue;

        const botGuild = botGuilds.get(guild.id);
        const member = await botGuild.members.fetch(req.session.user.id).catch(() => null);
        if (member && member.roles.cache.has(config.dashboard_role_id)) {
          authorized = true;
          authorizedGuilds.push({ id: guild.id, name: guild.name });
        }
      }

      if (!authorized) {
        return res.status(403).send(`
          <html><body style="background:#0a0a0a;color:#ff69b4;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
          <div style="text-align:center"><h1>Access Denied</h1><p>You don't have the required role to view this dashboard.</p><a href="/auth/logout" style="color:#ff69b4">Logout</a></div>
          </body></html>
        `);
      }

      req.authorizedGuilds = authorizedGuilds;
      next();
    } catch (err) {
      console.error('Auth check error:', err);
      req.session.destroy();
      res.redirect('/auth/login');
    }
  }

  // --- Dashboard pages ---
  app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.get('/dashboard', requireAuth, async (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  // --- API endpoints ---
  app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    const { accessToken, ...user } = req.session.user;
    res.json(user);
  });

  app.get('/api/guilds', requireAuth, (req, res) => {
    res.json(req.authorizedGuilds);
  });

  app.get('/api/roster/:guildId', requireAuth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }

    const lawyers = await db.getLawyers(guildId);
    const roster = [];

    for (const l of lawyers) {
      const lastActive = await db.getLastActivity(guildId, l.user_id);
      const activity7 = await db.getActivityCount(guildId, l.user_id, 7);
      const activity30 = await db.getActivityCount(guildId, l.user_id, 30);

      const guild = client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(l.user_id).catch(() => null) : null;

      let daysSince = null;
      if (lastActive) {
        daysSince = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
      }

      roster.push({
        userId: l.user_id,
        username: member ? member.user.tag : l.user_id,
        displayName: member ? member.displayName : 'Unknown',
        avatar: member ? member.user.displayAvatarURL({ size: 64 }) : null,
        addedAt: l.added_at,
        lastActive,
        daysSince,
        activity7,
        activity30
      });
    }

    const config = await db.getGuildConfig(guildId);
    const inactivityDays = config?.inactivity_days || 7;

    res.json({ roster, inactivityDays });
  });

  app.get('/api/profile/:guildId/:userId', requireAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }

    if (!(await db.isLawyer(guildId, userId))) {
      return res.status(404).json({ error: 'Lawyer not found' });
    }

    const lastActive = await db.getLastActivity(guildId, userId);
    const activity7 = await db.getActivityCount(guildId, userId, 7);
    const activity14 = await db.getActivityCount(guildId, userId, 14);
    const activity30 = await db.getActivityCount(guildId, userId, 30);
    const recent = await db.getRecentActivity(guildId, userId, 15);
    const notes = await db.getNotes(guildId, userId);

    const guild = client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;

    let daysSince = null;
    if (lastActive) {
      daysSince = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
    }

    res.json({
      userId,
      username: member ? member.user.tag : userId,
      displayName: member ? member.displayName : 'Unknown',
      avatar: member ? member.user.displayAvatarURL({ size: 128 }) : null,
      lastActive,
      daysSince,
      activity7,
      activity14,
      activity30,
      recent,
      notes: notes.map(n => ({
        ...n,
        authorName: null
      }))
    });
  });

  app.listen(port, () => {
    console.log(`Dashboard running on port ${port}`);
  });

  return app;
}

module.exports = { createDashboard };
