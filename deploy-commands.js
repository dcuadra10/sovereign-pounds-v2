const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your Sovereign Pounds balance and inventory'),

  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View the shop to exchange Sovereign Pounds for resources'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows how to earn currency and lists all commands'),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily Sovereign Pounds reward!'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription("Check your or another user's contribution stats")
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to check stats for (admin only)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Shows the top users with the most Sovereign Pounds'),

  new SlashCommandBuilder()
    .setName('pool')
    .setDescription('Admin: Check the server pool balance'),

  new SlashCommandBuilder()
    .setName('give')
    .setDescription('Admin: Give Sovereign Pounds to a user from the server pool.')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to give currency to.')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('amount')
        .setDescription('The amount of Sovereign Pounds to give.')
        .setRequired(true)
        .setMinValue(0.01)),

  new SlashCommandBuilder()
    .setName('take')
    .setDescription('Admin: Take Sovereign Pounds from a user.')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to take currency from.')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('amount')
        .setDescription('The amount of Sovereign Pounds to take.')
        .setRequired(true)
        .setMinValue(0.01)),

  new SlashCommandBuilder()
    .setName('shop-add')
    .setDescription('Admin: Add an item to the shop')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the item')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('price')
        .setDescription('Price in Sovereign Pounds')
        .setRequired(true)
        .setMinValue(0.01))
    .addStringOption(option =>
      option.setName('emoji')
        .setDescription('Emoji for the item (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Description of the item (optional)')
        .setRequired(false))
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('Role to give upon purchase (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('resource')
        .setDescription('Resource type (wood, food, stone, gold) (optional)')
        .setRequired(false)
        .addChoices(
          { name: 'Wood', value: 'wood' },
          { name: 'Food', value: 'food' },
          { name: 'Stone', value: 'stone' },
          { name: 'Gold', value: 'gold' }
        ))
    .addIntegerOption(option =>
      option.setName('quantity')
        .setDescription('Amount of resource to give (default: 1)')
        .setRequired(false)
        .setMinValue(1))
    .addBooleanOption(option =>
      option.setName('requires_ticket')
        .setDescription('Create a staff ticket upon purchase?')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('shop-remove')
    .setDescription('Admin: Remove an item from the shop')
    .addIntegerOption(option =>
      option.setName('id')
        .setDescription('ID of the item to remove')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('shop-stock')
    .setDescription('Admin: Add stock to a shop item')
    .addIntegerOption(option =>
      option.setName('id')
        .setDescription('ID of the shop item')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('amount')
        .setDescription('Amount of stock to add (e.g. 1k, 1m)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Admin: Create a paid giveaway')
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('How long the giveaway should last (e.g., 1h, 30m, 2d)')
        .setRequired(true))
    .addNumberOption(option =>
      option.setName('total_prize')
        .setDescription('Total amount of Sovereign Pounds to be distributed among winners')
        .setRequired(true)
        .setMinValue(1))
    .addIntegerOption(option =>
      option.setName('winners')
        .setDescription('Number of winners (default: 1)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10))
    .addNumberOption(option =>
      option.setName('entry_cost')
        .setDescription('Cost in Sovereign Pounds to participate (default: 10)')
        .setRequired(false)
        .setMinValue(1))
    .addRoleOption(option =>
      option.setName('ping_role')
        .setDescription('Role to ping when giveaway is created (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('qotd-setup')
    .setDescription('Admin: Configure Question of the Day')
    .addChannelOption(option => option.setName('channel').setDescription('Channel to post QOTD').setRequired(true))
    .addRoleOption(option => option.setName('role').setDescription('Role to ping').setRequired(true)),

  new SlashCommandBuilder()
    .setName('qotd-add')
    .setDescription('Admin: Schedule a Question of the Day')
    .addStringOption(option => option.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
    .addStringOption(option => option.setName('question').setDescription('The question to ask').setRequired(true)),

  new SlashCommandBuilder()
    .setName('qotd-list')
    .setDescription('Admin: List scheduled questions'),

  new SlashCommandBuilder()
    .setName('qotd-remove')
    .setDescription('Admin: Remove a scheduled question')
    .addIntegerOption(option => option.setName('id').setDescription('ID of the question').setRequired(true)),

  new SlashCommandBuilder()
    .setName('reset-all')
    .setDescription('Admin: Reset all user balances, stats, and resources (IRREVERSIBLE)'),

  new SlashCommandBuilder()
    .setName('add-emoji')
    .setDescription('Admin: Upload an image as a server emoji')
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('The image file for the emoji')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name for the emoji')
        .setRequired(true)
    ),


].map(command => command.toJSON());

const ticketCommands = [
  new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Admin: Setup the ticket panel in a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel where the ticket panel will be sent')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('ticket-category')
    .setDescription('Admin: Manage ticket categories')
    .addSubcommand(subcommand =>
      subcommand
        .setName('edit')
        .setDescription('Edit an existing ticket category')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Current name of the category to edit')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(option =>
          option.setName('new_name')
            .setDescription('New name for the category')
            .setRequired(false))
        .addRoleOption(option =>
          option.setName('role')
            .setDescription('New staff role')
            .setRequired(false))
        .addStringOption(option =>
          option.setName('emoji')
            .setDescription('New emoji')
            .setRequired(false))
        .addBooleanOption(option =>
          option.setName('edit_questions')
            .setDescription('Launch a wizard to edit the questions?')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a ticket category')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Name of the category to remove')
            .setRequired(true)
            .setAutocomplete(true))),

  new SlashCommandBuilder()
    .setName('ticket-panel-edit')
    .setDescription('Admin: Edit the ticket panel message')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel where the panel is located')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message_id')
        .setDescription('ID of the panel message')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('title')
        .setDescription('New title for the embed')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('New description for the embed')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('image_url')
        .setDescription('New image URL (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('thumbnail_url')
        .setDescription('New thumbnail URL (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('ticket-wizard')
    .setDescription('Admin: Interactive setup for ticket categories (creates a config thread)'),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the current ticket'),

  new SlashCommandBuilder()
    .setName('add-user')
    .setDescription('Add a user to the current ticket')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to add')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('remove-user')
    .setDescription('Remove a user from the current ticket')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to remove')
        .setRequired(true)),
];

commands.push(...ticketCommands.map(command => command.toJSON()));

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();