import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('standings')
    .setDescription('View the official league standings and team records')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName('conference')
        .setDescription('Filter by conference (e.g. SEC, Big Ten)')
        .setRequired(false),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const confFilter = interaction.options.getString('conference')?.toLowerCase();

    let standings = app.services.matchReports.getStandings({
      guildDiscordId: interaction.guildId,
    });

    if (confFilter) {
      standings = standings.filter((s) => (s.team.conference || '').toLowerCase() === confFilter);
    }

    if (standings.length === 0) {
      await interaction.reply({
        content: 'ℹ️ No completed matches recorded for this season yet.',
        ephemeral: true,
      });
      return;
    }

    // Format fixed-width style leaderboard table
    const header = '` #  Team               W-L     PCT   DIFF `\n';
    const rows = standings.slice(0, 20).map((s, idx) => {
      const rank = String(idx + 1).padStart(2, ' ');
      const name = (s.team.name.length > 17 ? s.team.name.slice(0, 16) + '…' : s.team.name).padEnd(17, ' ');
      const record = `${s.won}-${s.lost}`.padEnd(7, ' ');
      const pct = (s.pct * 100).toFixed(0).padStart(3, ' ') + '%';
      const diffSign = s.diff > 0 ? `+${s.diff}` : `${s.diff}`;
      const diff = diffSign.padStart(6, ' ');
      return `\`${rank}  ${name}  ${record} ${pct} ${diff} \``;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🏆 Official League Standings')
      .setDescription(
        `${confFilter ? `Conference: **${confFilter.toUpperCase()}**\n\n` : ''}` +
        header +
        rows.join('\n'),
      )
      .setFooter({ text: 'College Football League • Real-time Standings' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
