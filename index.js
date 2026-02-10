const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
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

client.once('ready', async () => {
  await db.initDb();
  console.log(`Gavel is online as ${client.user.tag}`);

  // Check inactivity once daily (every 24 hours)
  setInterval(checkInactivity, 86400000);
  // Also run once on startup after a short delay
  setTimeout(checkInactivity, 10000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild || !interaction.isChatInputCommand()) return;

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
      await db.addLawyer(guildId, user.id, interaction.user.id);
      return interaction.reply({ content: `**${user.tag}** has been added to the lawyer roster.`, ephemeral: true });
    }

    // --- /lawyer remove ---
    if (sub === 'remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** permission.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      const removed = await db.removeLawyer(guildId, user.id);
      if (!removed) return interaction.reply({ content: `**${user.tag}** is not on the roster.`, ephemeral: true });
      return interaction.reply({ content: `**${user.tag}** has been removed from the lawyer roster.`, ephemeral: true });
    }

    // --- /lawyer list ---
    if (sub === 'list') {
      const lawyers = await db.getLawyers(guildId);
      if (lawyers.length === 0) return interaction.reply({ content: 'No lawyers on the roster.', ephemeral: true });

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
        lines.push(`<@${l.user_id}> — Last active: **${status}**`);
      }

      const embed = new EmbedBuilder()
        .setTitle('Lawyer Roster')
        .setColor(0x3498DB)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${lawyers.length} lawyer${lawyers.length === 1 ? '' : 's'} on roster` });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // --- /lawyer profile ---
    if (sub === 'profile') {
      const user = interaction.options.getUser('user');

      if (!(await db.isLawyer(guildId, user.id))) {
        return interaction.reply({ content: `**${user.tag}** is not on the roster.`, ephemeral: true });
      }

      const lastActive = await db.getLastActivity(guildId, user.id);
      const activity7 = await db.getActivityCount(guildId, user.id, 7);
      const activity14 = await db.getActivityCount(guildId, user.id, 14);
      const activity30 = await db.getActivityCount(guildId, user.id, 30);
      const recent = await db.getRecentActivity(guildId, user.id, 5);
      const notes = await db.getNotes(guildId, user.id);

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
          { name: '\u200b', value: '\u200b', inline: true },
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

      if (notes.length > 0) {
        const notesText = notes.map(n => {
          const timeUnix = Math.floor(new Date(n.created_at).getTime() / 1000);
          return `<t:${timeUnix}:d> by <@${n.author_id}>: ${n.note}`;
        }).join('\n');
        embed.addFields({ name: 'Notes', value: notesText.length > 1024 ? notesText.slice(0, 1020) + '...' : notesText });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
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
      const lawyers = await db.getLawyers(guildId);
      if (lawyers.length === 0) return interaction.reply({ content: 'No lawyers on the roster.', ephemeral: true });

      const config = await db.getGuildConfig(guildId);
      const threshold = config?.inactivity_days || 7;

      const lines = [];
      for (const l of lawyers) {
        const lastActive = await db.getLastActivity(guildId, l.user_id);
        const activity30 = await db.getActivityCount(guildId, l.user_id, 30);

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

        lines.push(`${statusIcon} <@${l.user_id}> — Last: **${daysText}** | 30d msgs: **${activity30}**`);
      }

      const embed = new EmbedBuilder()
        .setTitle('Lawyer Activity Review')
        .setColor(0x3498DB)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `🟢 Active | 🟡 Warning | 🔴 Inactive (${threshold}+ days)` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
