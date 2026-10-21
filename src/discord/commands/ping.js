import { MessageFlags, SlashCommandBuilder, InteractionContextType } from 'discord.js';
import { buildContext } from '../context.js';

/** Health-check / smoke command. Also demonstrates the command contract and permission context. */
export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that the bot is alive.')
    .setContexts(InteractionContextType.Guild),
  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    await interaction.reply({
      content: `🏓 Pong! Gateway ${Math.round(interaction.client.ws.ping)}ms · access tier: **${ctx.access.tier}**`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
