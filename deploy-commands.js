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
    .setName('buy')
    .setDescription('Buy a resource from the shop')
    .addStringOption(option =>
      option.setName('resource')
        .setDescription('The resource to buy')
        .setRequired(true)
        .addChoices(
          { name: 'Gold', value: 'gold' },
          { name: 'Wood', value: 'wood' },
          { name: 'Food', value: 'food' },
          { name: 'Stone', value: 'stone' }
        )
    )
  ,
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
].map(command => command.toJSON());

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