import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('teams')
    .setDescription('List all available league teams and their roster availability')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName('conference')
        .setDescription('Filter by conference (e.g. SEC, Big Ten, Big 12)')
        .setRequired(false),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const confFilter = interaction.options.getString('conference');
    const teams = app.services.teams.listForGuild(ctx.guildId, { conference: confFilter });

    if (teams.length === 0) {
      await interaction.reply({
        content: confFilter
          ? `ℹ️ No enabled teams found in conference **${confFilter}**.`
          : 'ℹ️ No teams have been enabled in this server yet. Admins can select up to 20 teams from the dashboard.',
        ephemeral: true,
      });
      return;
    }

    const lines = teams.slice(0, 25).map((t) => {
      const live = app.services.signings.roster(interaction.guildId, t.id);
      const open = Math.max(0, ctx.settings.maxUsersPerTeam - live.length);
      const statusIcon = open > 0 ? '🟢' : '🔴';
      return `${statusIcon} **${t.name}** (\`${t.abbr}\`) — ${live.length}/${ctx.settings.maxUsersPerTeam} players · ${open} open`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🏈 Active League Teams (${teams.length})`)
      .setDescription(
        `Showing active teams in this server.${confFilter ? ` Filtered by **${confFilter}**.` : ''}\n\n` +
        lines.join('\n'),
      )
      .setFooter({ text: 'Use /roster <team> to see players, or /sign <team> to sign' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
