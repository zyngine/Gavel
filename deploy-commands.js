const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Gavel configuration')
    .addSubcommand(sub =>
      sub.setName('alert-channel')
        .setDescription('Set the channel for inactivity alerts')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Alert channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('inactivity-days')
        .setDescription('Set how many days before a lawyer is flagged inactive')
        .addIntegerOption(opt =>
          opt.setName('days').setDescription('Number of days').setMinValue(1).setMaxValue(90).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('add-channel')
        .setDescription('Add a channel to monitor for activity')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to monitor').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('add-category')
        .setDescription('Monitor all channels under a category')
        .addChannelOption(opt =>
          opt.setName('category').setDescription('Category to monitor').addChannelTypes(ChannelType.GuildCategory).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove-channel')
        .setDescription('Stop monitoring a channel or category')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel or category to remove').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list-channels')
        .setDescription('List all monitored channels and categories')
    )
    .addSubcommand(sub =>
      sub.setName('roster-role')
        .setDescription('Add a role that auto-populates the lawyer roster')
        .addRoleOption(opt => opt.setName('role').setDescription('The role to sync to the roster').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove-roster-role')
        .setDescription('Remove a role from auto-populating the roster')
        .addRoleOption(opt => opt.setName('role').setDescription('The role to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list-roster-roles')
        .setDescription('List all roles that auto-populate the roster')
    )
    .addSubcommand(sub =>
      sub.setName('add-dashboard-role')
        .setDescription('Add a role that grants dashboard access')
        .addRoleOption(opt => opt.setName('role').setDescription('The role to grant dashboard access').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove-dashboard-role')
        .setDescription('Remove a role from dashboard access')
        .addRoleOption(opt => opt.setName('role').setDescription('The role to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list-dashboard-roles')
        .setDescription('List all roles that have dashboard access')
    )
    .addSubcommand(sub =>
      sub.setName('add-ticket-category')
        .setDescription('Add a category for ticket tracking')
        .addChannelOption(opt =>
          opt.setName('category').setDescription('The category channel').addChannelTypes(ChannelType.GuildCategory).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove-ticket-category')
        .setDescription('Remove a ticket tracking category')
        .addChannelOption(opt =>
          opt.setName('category').setDescription('The category to remove').addChannelTypes(ChannelType.GuildCategory).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('list-ticket-categories')
        .setDescription('List all ticket tracking categories')
    ),
  new SlashCommandBuilder()
    .setName('lawyer')
    .setDescription('Lawyer roster management')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a lawyer to the roster')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer to add').setRequired(true))
        .addStringOption(opt => opt.setName('name').setDescription('Real name of the lawyer').setRequired(false))
        .addStringOption(opt => opt.setName('rank').setDescription('Rank or title of the lawyer').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a lawyer from the roster (archives their data)')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View the full lawyer roster')
    )
    .addSubcommand(sub =>
      sub.setName('profile')
        .setDescription('View a lawyer\'s activity profile')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer to view').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('note')
        .setDescription('Add a note to a lawyer\'s profile')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer').setRequired(true))
        .addStringOption(opt => opt.setName('note').setDescription('The note to add').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('review')
        .setDescription('View activity overview of all lawyers with status indicators')
    ),
  new SlashCommandBuilder()
    .setName('strike')
    .setDescription('Strike management for lawyers')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a strike to a lawyer')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer to strike').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for the strike').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a strike by ID')
        .addIntegerOption(opt => opt.setName('id').setDescription('The strike ID to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('View all strikes for a lawyer')
        .addUserOption(opt => opt.setName('user').setDescription('The lawyer to view strikes for').setRequired(true))
    )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering global slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Global slash commands registered successfully.');
  } catch (error) {
    console.error(error);
  }
})();
