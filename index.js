const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { createDashboard } = require('./dashboard');
const db = require('./db');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// --- Activity Tracking (passive) ---
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const userId = message.author.id;

  // Only track if user is a registered lawyer
  if (!(await db.isLawyer(guildId, userId))) return;

  // Only track if the channel (or its parent category) is monitored
  const parentId = message.channel.parentId || null;
  if (!(await db.isChannelMonitored(guildId, message.channel.id, parentId))) return;

  await db.logActivity(guildId, userId, message.channel.id, message.channel.name);
});

// --- Inactivity Check ---
async function checkInactivity() {
  try {
    for (const guild of client.guilds.cache.values()) {
      const config = await db.getGuildConfig(guild.id);
      if (!config || !config.alert_channel_id) continue;

      const days = config.inactivity_days || 7;
      const inactive = await db.getInactiveLawyers(guild.id, days);

      if (inactive.length === 0) continue;

      const channel = guild.channels.cache.get(config.alert_channel_id);
      if (!channel) continue;

      const list = inactive.map(l => {
        if (!l.last_active) {
          return `<@${l.user_id}> — **No recorded activity**`;
        }
        const daysAgo = Math.floor((Date.now() - new Date(l.last_active).getTime()) / 86400000);
        return `<@${l.user_id}> — Last active **${daysAgo} days ago**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('Inactivity Alert')
        .setColor(0xE74C3C)
        .setDescription(list)
        .setFooter({ text: `Lawyers with no activity in ${days}+ days` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Inactivity check error:', err);
  }
}

// --- Role Sync ---
async function syncRosterRoles(guild) {
  try {
    const roleIds = await db.getRosterRoles(guild.id);
    if (roleIds.length === 0) return;

    const members = await guild.members.fetch();
    for (const [, member] of members) {
      if (member.user.bot) continue;
      const hasRosterRole = roleIds.some(rid => member.roles.cache.has(rid));
      const isOnRoster = await db.isLawyer(guild.id, member.id);

      if (hasRosterRole && !isOnRoster) {
        await db.addLawyer(guild.id, member.id, 'auto-sync');
      } else if (!hasRosterRole && isOnRoster) {
        await db.archiveLawyer(guild.id, member.id, 'auto-sync');
      }
    }
  } catch (err) {
    console.error(`Role sync error for guild ${guild.id}:`, err);
  }
}

// Listen for role changes
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.user.bot) return;
  const roleIds = await db.getRosterRoles(newMember.guild.id);
  if (roleIds.length === 0) return;

  const hadRole = roleIds.some(rid => oldMember.roles.cache.has(rid));
  const hasRole = roleIds.some(rid => newMember.roles.cache.has(rid));

  if (!hadRole && hasRole) {
    await db.addLawyer(newMember.guild.id, newMember.id, 'auto-sync');
  } else if (hadRole && !hasRole) {
    await db.archiveLawyer(newMember.guild.id, newMember.id, 'auto-sync');
  }
});

client.once('ready', async () => {
  await db.initDb();
  console.log(`Gavel is online as ${client.user.tag}`);

  // Start the dashboard
  createDashboard(client);

  // Sync roster roles on startup
  for (const guild of client.guilds.cache.values()) {
    await syncRosterRoles(guild);
  }
  console.log('Roster role sync complete.');

  // Check inactivity once daily (every 24 hours)
  setInterval(checkInactivity, 86400000);
  // Also run once on startup after a short delay
  setTimeout(checkInactivity, 10000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild || !interaction.isChatInputCommand()) return;

  try {
  const guildId = interaction.guild.id;
  const { commandName } = interaction;

  // ==================== /config ====================
  if (commandName === 'config') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'alert-channel') {
      const channel = interaction.options.getChannel('channel');
      await db.setAlertChannel(guildId, channel.id);
      return interaction.reply({ content: `Inactivity alerts will be sent to ${channel}.`, ephemeral: true });
    }

    if (sub === 'inactivity-days') {
      const days = interaction.options.getInteger('days');
      await db.setInactivityDays(guildId, days);
      return interaction.reply({ content: `Lawyers will be flagged after **${days} days** of inactivity.`, ephemeral: true });
    }

    if (sub === 'add-channel') {
      const channel = interaction.options.getChannel('channel');
      await db.addMonitoredChannel(guildId, channel.id, 'channel');
      return interaction.reply({ content: `Now monitoring ${channel} for lawyer activity.`, ephemeral: true });
    }

    if (sub === 'add-category') {
      const channel = interaction.options.getChannel('category');
      await db.addMonitoredChannel(guildId, channel.id, 'category');
      return interaction.reply({ content: `Now monitoring all channels under **${channel.name}** for lawyer activity.`, ephemeral: true });
    }

    if (sub === 'remove-channel') {
      const channel = interaction.options.getChannel('channel');
      const removed = await db.removeMonitoredChannel(guildId, channel.id);
      if (!removed) return interaction.reply({ content: 'That channel/category is not being monitored.', ephemeral: true });
      return interaction.reply({ content: `Stopped monitoring ${channel}.`, ephemeral: true });
    }

    if (sub === 'list-channels') {
      const channels = await db.getMonitoredChannels(guildId);
      if (channels.length === 0) return interaction.reply({ content: 'No channels are being monitored.', ephemeral: true });
      const list = channels.map(c => {
        const label = c.channel_type === 'category' ? '(category)' : '(channel)';
        return `<#${c.channel_id}> ${label}`;
      }).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Monitored Channels')
        .setColor(0x3498DB)
        .setDescription(list);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'roster-role') {
      const role = interaction.options.getRole('role');
      await interaction.deferReply({ ephemeral: true });
      await db.addRosterRole(guildId, role.id);
      await syncRosterRoles(interaction.guild);
      return interaction.editReply({ content: `Members with **${role.name}** will now auto-populate the lawyer roster.` });
    }

    if (sub === 'remove-roster-role') {
      const role = interaction.options.getRole('role');
      const removed = await db.removeRosterRole(guildId, role.id);
      if (!removed) return interaction.reply({ content: 'That role is not a roster role.', ephemeral: true });
      return interaction.reply({ content: `**${role.name}** has been removed from roster roles.`, ephemeral: true });
    }

    if (sub === 'list-roster-roles') {
      const roleIds = await db.getRosterRoles(guildId);
      if (roleIds.length === 0) return interaction.reply({ content: 'No roster roles configured.', ephemeral: true });
      const list = roleIds.map(id => `<@&${id}>`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Roster Roles')
        .setColor(0x3498DB)
        .setDescription(list)
        .setFooter({ text: 'Members with these roles are auto-added to the roster' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'add-dashboard-role') {
      const role = interaction.options.getRole('role');
      await db.addDashboardRole(guildId, role.id);
      return interaction.reply({ content: `**${role.name}** can now access the dashboard.`, ephemeral: true });
    }

    if (sub === 'remove-dashboard-role') {
      const role = interaction.options.getRole('role');
      const removed = await db.removeDashboardRole(guildId, role.id);
      if (!removed) return interaction.reply({ content: 'That role does not have dashboard access.', ephemeral: true });
      return interaction.reply({ content: `**${role.name}** no longer has dashboard access.`, ephemeral: true });
    }

    if (sub === 'list-dashboard-roles') {
      const roleIds = await db.getDashboardRoles(guildId);
      if (roleIds.length === 0) return interaction.reply({ content: 'No dashboard roles configured.', ephemeral: true });
      const list = roleIds.map(id => `<@&${id}>`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Dashboard Roles')
        .setColor(0x3498DB)
        .setDescription(list)
        .setFooter({ text: 'Members with these roles can access the web dashboard' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'add-ticket-category') {
      const channel = interaction.options.getChannel('category');
      await db.addTicketCategory(guildId, channel.id);
      return interaction.reply({ content: `Now tracking tickets under **${channel.name}**.`, ephemeral: true });
    }

    if (sub === 'remove-ticket-category') {
      const channel = interaction.options.getChannel('category');
      const removed = await db.removeTicketCategory(guildId, channel.id);
      if (!removed) return interaction.reply({ content: 'That category is not being tracked for tickets.', ephemeral: true });
      return interaction.reply({ content: `Stopped tracking tickets under **${channel.name}**.`, ephemeral: true });
    }

    if (sub === 'list-ticket-categories') {
      const categories = await db.getTicketCategories(guildId);
      if (categories.length === 0) return interaction.reply({ content: 'No ticket categories configured.', ephemeral: true });
      const list = categories.map(id => `<#${id}>`).join('\n');
      const embed = new EmbedBuilder()
        .setTitle('Ticket Categories')
        .setColor(0x3498DB)
        .setDescription(list);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // ==================== /lawyer ====================
  if (commandName === 'lawyer') {
    const sub = interaction.options.getSubcommand();

    // --- /lawyer add ---
    if (sub === 'add') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const name = interaction.options.getString('name');
      await db.addLawyer(guildId, user.id, interaction.user.id, name);
      const nameText = name ? ` (${name})` : '';
      return interaction.reply({ content: `**${user.tag}**${nameText} has been added to the lawyer roster.`, ephemeral: true });
    }

    // --- /lawyer remove ---
    if (sub === 'remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const removed = await db.archiveLawyer(guildId, user.id, interaction.user.id);
      if (!removed) return interaction.reply({ content: `**${user.tag}** is not on the roster.`, ephemeral: true });
      return interaction.reply({ content: `**${user.tag}** has been removed from the roster and archived.`, ephemeral: true });
    }

    // --- /lawyer list ---
    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });
      const lawyers = await db.getLawyers(guildId);
      if (lawyers.length === 0) return interaction.editReply({ content: 'No lawyers on the roster.' });

      const lines = [];
      for (const l of lawyers) {
        const lastActive = await db.getLastActivity(guildId, l.user_id);
        let status;
        if (!lastActive) {
          status = 'No activity recorded';
        } else {
          const daysAgo = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
          status = daysAgo === 0 ? 'Active today' : `${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`;
        }
        const name = l.display_name ? `${l.display_name} (<@${l.user_id}>)` : `<@${l.user_id}>`;
        lines.push(`${name} — Last active: **${status}**`);
      }

      const embed = new EmbedBuilder()
        .setTitle('Lawyer Roster')
        .setColor(0x3498DB)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${lawyers.length} lawyer${lawyers.length === 1 ? '' : 's'} on roster` });

      return interaction.editReply({ embeds: [embed] });
    }

    // --- /lawyer profile ---
    if (sub === 'profile') {
      const user = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });

      if (!(await db.isLawyer(guildId, user.id))) {
        return interaction.editReply({ content: `**${user.tag}** is not on the roster.` });
      }

      const lastActive = await db.getLastActivity(guildId, user.id);
      const activity7 = await db.getActivityCount(guildId, user.id, 7);
      const activity14 = await db.getActivityCount(guildId, user.id, 14);
      const activity30 = await db.getActivityCount(guildId, user.id, 30);
      const recent = await db.getRecentActivity(guildId, user.id, 5);
      const notes = await db.getNotes(guildId, user.id);
      const strikes = await db.getStrikes(guildId, user.id);

      let lastActiveText;
      let daysSince;
      if (!lastActive) {
        lastActiveText = 'No activity recorded';
        daysSince = 'N/A';
      } else {
        const daysAgo = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
        const timeUnix = Math.floor(new Date(lastActive).getTime() / 1000);
        lastActiveText = `<t:${timeUnix}:F> (<t:${timeUnix}:R>)`;
        daysSince = `${daysAgo} day${daysAgo === 1 ? '' : 's'}`;
      }

      const embed = new EmbedBuilder()
        .setTitle(`${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .setColor(0x3498DB)
        .addFields(
          { name: 'Last Active', value: lastActiveText, inline: true },
          { name: 'Days Since Activity', value: daysSince, inline: true },
          { name: 'Strikes', value: `${strikes.length}`, inline: true },
          { name: 'Messages (7d)', value: `${activity7}`, inline: true },
          { name: 'Messages (14d)', value: `${activity14}`, inline: true },
          { name: 'Messages (30d)', value: `${activity30}`, inline: true }
        );

      if (recent.length > 0) {
        const recentText = recent.map(r => {
          const timeUnix = Math.floor(new Date(r.logged_at).getTime() / 1000);
          return `#${r.channel_name} — <t:${timeUnix}:R>`;
        }).join('\n');
        embed.addFields({ name: 'Recent Activity', value: recentText });
      }

      if (strikes.length > 0) {
        const strikesText = strikes.slice(0, 5).map(s => {
          const timeUnix = Math.floor(new Date(s.created_at).getTime() / 1000);
          return `#${s.id} — <t:${timeUnix}:d> by <@${s.issued_by}>: ${s.reason}`;
        }).join('\n');
        embed.addFields({ name: 'Strikes', value: strikesText.length > 1024 ? strikesText.slice(0, 1020) + '...' : strikesText });
      }

      if (notes.length > 0) {
        const notesText = notes.map(n => {
          const timeUnix = Math.floor(new Date(n.created_at).getTime() / 1000);
          return `<t:${timeUnix}:d> by <@${n.author_id}>: ${n.note}`;
        }).join('\n');
        embed.addFields({ name: 'Notes', value: notesText.length > 1024 ? notesText.slice(0, 1020) + '...' : notesText });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // --- /lawyer note ---
    if (sub === 'note') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const note = interaction.options.getString('note');

      if (!(await db.isLawyer(guildId, user.id))) {
        return interaction.reply({ content: `**${user.tag}** is not on the roster.`, ephemeral: true });
      }

      await db.addNote(guildId, user.id, interaction.user.id, note);
      return interaction.reply({ content: `Note added to **${user.tag}**'s profile.`, ephemeral: true });
    }

    // --- /lawyer review ---
    if (sub === 'review') {
      await interaction.deferReply({ ephemeral: true });
      const lawyers = await db.getLawyers(guildId);
      if (lawyers.length === 0) return interaction.editReply({ content: 'No lawyers on the roster.' });

      const config = await db.getGuildConfig(guildId);
      const threshold = config?.inactivity_days || 7;

      const lines = [];
      for (const l of lawyers) {
        const lastActive = await db.getLastActivity(guildId, l.user_id);
        const activity30 = await db.getActivityCount(guildId, l.user_id, 30);
        const strikeCount = await db.getStrikeCount(guildId, l.user_id);

        let statusIcon;
        if (!lastActive) {
          statusIcon = '🔴';
        } else {
          const daysAgo = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
          statusIcon = daysAgo >= threshold ? '🔴' : daysAgo >= Math.floor(threshold / 2) ? '🟡' : '🟢';
        }

        let daysText;
        if (!lastActive) {
          daysText = 'Never';
        } else {
          const daysAgo = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000);
          daysText = daysAgo === 0 ? 'Today' : `${daysAgo}d ago`;
        }

        const strikeText = strikeCount > 0 ? ` | ⚠️ ${strikeCount}` : '';
        lines.push(`${statusIcon} <@${l.user_id}> — Last: **${daysText}** | 30d msgs: **${activity30}**${strikeText}`);
      }

      const embed = new EmbedBuilder()
        .setTitle('Lawyer Activity Review')
        .setColor(0x3498DB)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `🟢 Active | 🟡 Warning | 🔴 Inactive (${threshold}+ days)` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  }

  // ==================== /strike ====================
  if (commandName === 'strike') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');

      if (!(await db.isLawyer(guildId, user.id))) {
        return interaction.reply({ content: `**${user.tag}** is not on the roster.`, ephemeral: true });
      }

      const strike = await db.addStrike(guildId, user.id, interaction.user.id, reason);
      return interaction.reply({ content: `Strike **#${strike.id}** added to **${user.tag}**: ${reason}`, ephemeral: true });
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const removed = await db.removeStrike(id, guildId);
      if (!removed) return interaction.reply({ content: `Strike #${id} not found.`, ephemeral: true });
      return interaction.reply({ content: `Strike **#${id}** has been removed.`, ephemeral: true });
    }

    if (sub === 'list') {
      const user = interaction.options.getUser('user');
      const strikes = await db.getStrikes(guildId, user.id);
      if (strikes.length === 0) {
        return interaction.reply({ content: `**${user.tag}** has no strikes.`, ephemeral: true });
      }
      const list = strikes.map(s => {
        const timeUnix = Math.floor(new Date(s.created_at).getTime() / 1000);
        return `**#${s.id}** — <t:${timeUnix}:d> by <@${s.issued_by}>: ${s.reason}`;
      }).join('\n');
      const embed = new EmbedBuilder()
        .setTitle(`Strikes for ${user.tag}`)
        .setColor(0xE74C3C)
        .setDescription(list)
        .setFooter({ text: `${strikes.length} total strike${strikes.length !== 1 ? 's' : ''}` });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: 'Something went wrong. Please try again.' });
      } else if (!interaction.replied) {
        await interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
      }
    } catch (_) {}
  }
});

client.login(process.env.DISCORD_TOKEN);
