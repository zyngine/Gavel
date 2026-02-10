const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');

function createDashboard(client) {
  const app = express();
  const port = process.env.PORT || 3000;

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
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

    try {
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${req.session.user.accessToken}` }
      });
      const userGuilds = await guildsRes.json();

      if (!Array.isArray(userGuilds)) {
        req.session.destroy();
        return res.redirect('/auth/login');
      }

      const botGuilds = client.guilds.cache;
      const sharedGuilds = userGuilds.filter(g => botGuilds.has(g.id));

      let authorized = false;
      let authorizedGuilds = [];

      for (const guild of sharedGuilds) {
        const dashboardRoleIds = await db.getDashboardRoles(guild.id);
        if (dashboardRoleIds.length === 0) continue;

        const botGuild = botGuilds.get(guild.id);
        const member = await botGuild.members.fetch(req.session.user.id).catch(() => null);
        if (member && dashboardRoleIds.some(rid => member.roles.cache.has(rid))) {
          authorized = true;
          authorizedGuilds.push({ id: guild.id, name: guild.name });
        }
      }

      if (!authorized) {
        return res.status(403).send(`
          <html><body style="background:#000;color:#ff69b4;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
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

  // --- Auth middleware for API (returns JSON instead of redirect) ---
  async function requireApiAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

    try {
      // Cache authorized guilds in session for 60 seconds to avoid Discord API rate limits
      const now = Date.now();
      if (req.session.authorizedGuilds && req.session.authCacheTime && (now - req.session.authCacheTime) < 60000) {
        req.authorizedGuilds = req.session.authorizedGuilds;
        return next();
      }

      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${req.session.user.accessToken}` }
      });
      const userGuilds = await guildsRes.json();

      if (!Array.isArray(userGuilds)) {
        return res.status(401).json({ error: 'Session expired' });
      }

      const botGuilds = client.guilds.cache;
      const sharedGuilds = userGuilds.filter(g => botGuilds.has(g.id));

      let authorizedGuilds = [];

      for (const guild of sharedGuilds) {
        const dashboardRoleIds = await db.getDashboardRoles(guild.id);
        if (dashboardRoleIds.length === 0) continue;

        const botGuild = botGuilds.get(guild.id);
        const member = await botGuild.members.fetch(req.session.user.id).catch(() => null);
        if (member && dashboardRoleIds.some(rid => member.roles.cache.has(rid))) {
          authorizedGuilds.push({ id: guild.id, name: guild.name });
        }
      }

      req.session.authorizedGuilds = authorizedGuilds;
      req.session.authCacheTime = now;
      req.authorizedGuilds = authorizedGuilds;
      next();
    } catch (err) {
      console.error('API auth error:', err);
      res.status(401).json({ error: 'Auth failed' });
    }
  }

  // --- Pages ---
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

  app.get('/api/guilds', requireApiAuth, (req, res) => {
    res.json(req.authorizedGuilds);
  });

  // --- Roster ---
  app.get('/api/roster/:guildId', requireApiAuth, async (req, res) => {
    try {
      const guildId = req.params.guildId;
      if (!req.authorizedGuilds.find(g => g.id === guildId)) {
        return res.status(403).json({ error: 'Not authorized for this guild' });
      }

      const lawyers = await db.getLawyers(guildId);
      const roster = [];
      const guild = client.guilds.cache.get(guildId);

      for (const l of lawyers) {
        try {
          const lastActive = await db.getLastActivity(guildId, l.user_id);
          const activity7 = await db.getActivityCount(guildId, l.user_id, 7);
          const activity30 = await db.getActivityCount(guildId, l.user_id, 30);
          const strikeCount = await db.getStrikeCount(guildId, l.user_id);

          const member = guild ? await guild.members.fetch(l.user_id).catch(() => null) : null;

          let daysSince = null;
          if (lastActive) {
            daysSince = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
          }

          const memberRoles = member
            ? member.roles.cache
                .filter(r => r.id !== guildId)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
            : [];

          roster.push({
            userId: l.user_id,
            username: member ? member.user.tag : l.user_id,
            displayName: l.display_name || (member ? member.displayName : 'Unknown'),
            discordName: member ? member.displayName : 'Unknown',
            avatar: member ? member.user.displayAvatarURL({ size: 64 }) : null,
            addedAt: l.added_at,
            hireDate: l.hire_date,
            lastActive,
            daysSince,
            activity7,
            activity30,
            strikeCount,
            roles: memberRoles
          });
        } catch (memberErr) {
          console.error(`Error loading lawyer ${l.user_id}:`, memberErr.message);
          roster.push({
            userId: l.user_id,
            username: l.user_id,
            displayName: l.display_name || 'Unknown',
            discordName: 'Unknown',
            avatar: null,
            addedAt: l.added_at,
            hireDate: l.hire_date,
            lastActive: null,
            daysSince: null,
            activity7: 0,
            activity30: 0,
            strikeCount: 0,
            roles: []
          });
        }
      }

      const config = await db.getGuildConfig(guildId);
      const inactivityDays = config?.inactivity_days || 7;

      res.json({ roster, inactivityDays });
    } catch (err) {
      console.error('Roster endpoint error:', err);
      res.status(500).json({ error: 'Failed to load roster' });
    }
  });

  // --- Edit hire date ---
  app.put('/api/roster/:guildId/:userId/hire-date', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }
    const { hireDate } = req.body;
    if (!hireDate) return res.status(400).json({ error: 'hireDate is required' });

    try {
      const parsed = new Date(hireDate);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid date' });
      await db.updateHireDate(guildId, userId, parsed);
      res.json({ success: true });
    } catch (err) {
      console.error('Update hire date error:', err);
      res.status(500).json({ error: 'Failed to update' });
    }
  });

  // --- Edit display name ---
  app.put('/api/roster/:guildId/:userId/display-name', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }
    const { displayName } = req.body;
    if (!displayName || !displayName.trim()) return res.status(400).json({ error: 'displayName is required' });

    try {
      await db.updateDisplayName(guildId, userId, displayName.trim());
      res.json({ success: true });
    } catch (err) {
      console.error('Update display name error:', err);
      res.status(500).json({ error: 'Failed to update' });
    }
  });

  // --- Profile ---
  app.get('/api/profile/:guildId/:userId', requireApiAuth, async (req, res) => {
    try {
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
      const strikes = await db.getStrikes(guildId, userId);

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
        notes,
        strikes
      });
    } catch (err) {
      console.error('Profile endpoint error:', err);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  // --- Strikes ---
  app.get('/api/strikes/:guildId/:userId', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }
    const strikes = await db.getStrikes(guildId, userId);
    res.json(strikes);
  });

  // --- Activity log with filtering ---
  app.get('/api/activity/:guildId/:userId', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }
    const { startDate, endDate, channel, limit = 50, offset = 0 } = req.query;
    const activity = await db.getActivityLog(guildId, userId, {
      startDate, endDate, channelName: channel,
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0
    });
    res.json(activity);
  });

  // --- Tickets ---
  const ticketCache = new Map();
  const TICKET_CACHE_TTL = 60000;

  app.get('/api/tickets/:guildId/:userId', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }

    const cacheKey = `${guildId}:${userId}`;
    const cached = ticketCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TICKET_CACHE_TTL) {
      return res.json(cached.data);
    }

    const categoryIds = await db.getTicketCategories(guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!guild || categoryIds.length === 0) return res.json([]);

    const tickets = [];
    for (const catId of categoryIds) {
      const category = guild.channels.cache.get(catId);
      if (!category) continue;

      const channels = guild.channels.cache.filter(
        ch => ch.parentId === catId && ch.isTextBased()
      );

      for (const [, channel] of channels) {
        try {
          const messages = await channel.messages.fetch({ limit: 100 });
          const userMessages = messages.filter(m => m.author.id === userId);
          if (userMessages.size > 0) {
            const lastMsg = userMessages.first();
            tickets.push({
              channelId: channel.id,
              channelName: channel.name,
              categoryName: category.name,
              messageCount: userMessages.size,
              lastMessageAt: lastMsg.createdAt
            });
          }
        } catch (err) {
          // Bot may lack permissions; skip
        }
      }
    }

    ticketCache.set(cacheKey, { data: tickets, time: Date.now() });
    res.json(tickets);
  });

  // --- Archive ---
  app.get('/api/archive/:guildId', requireApiAuth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }

    const archived = await db.getArchivedLawyers(guildId);
    const result = [];

    for (const l of archived) {
      const lastActive = await db.getLastActivity(guildId, l.user_id);
      const strikeCount = await db.getStrikeCount(guildId, l.user_id);
      const guild = client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(l.user_id).catch(() => null) : null;

      result.push({
        userId: l.user_id,
        username: member ? member.user.tag : l.user_id,
        displayName: l.display_name || (member ? member.displayName : 'Unknown'),
        avatar: member ? member.user.displayAvatarURL({ size: 64 }) : null,
        addedAt: l.added_at,
        hireDate: l.hire_date,
        archivedAt: l.archived_at,
        archivedBy: l.archived_by,
        lastActive,
        strikeCount
      });
    }

    res.json(result);
  });

  app.get('/api/archive/:guildId/:userId', requireApiAuth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!req.authorizedGuilds.find(g => g.id === guildId)) {
      return res.status(403).json({ error: 'Not authorized for this guild' });
    }

    const recent = await db.getRecentActivity(guildId, userId, 50);
    const notes = await db.getNotes(guildId, userId);
    const strikes = await db.getStrikes(guildId, userId);
    const activity7 = await db.getActivityCount(guildId, userId, 7);
    const activity30 = await db.getActivityCount(guildId, userId, 30);
    const lastActive = await db.getLastActivity(guildId, userId);

    const guild = client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;

    res.json({
      username: member ? member.user.tag : userId,
      displayName: member ? member.displayName : 'Unknown',
      avatar: member ? member.user.displayAvatarURL({ size: 128 }) : null,
      recent, notes, strikes, activity7, activity30, lastActive
    });
  });

  app.listen(port, () => {
    console.log(`Dashboard running on port ${port}`);
  });

  return app;
}

module.exports = { createDashboard };
