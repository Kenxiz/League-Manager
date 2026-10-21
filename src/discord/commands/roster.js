import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('roster')
    .setDescription('View the official team roster, captains, and stadium info')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName('team')
        .setDescription('The team to view')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction, app) {
    const focused = interaction.options.getFocused();
    const guildId = app.services.guilds.ensure(interaction.guildId);
    const available = app.services.teams.listForGuild(guildId);
    const query = focused.toLowerCase().trim();

    const matches = available
      .filter((t) => t.name.toLowerCase().includes(query) || t.abbr.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(
      matches.map((t) => ({
        name: `${t.name} (${t.abbr})`,
        value: t.key,
      })),
    );
  },

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const teamQuery = interaction.options.getString('team', true);
    const team = app.services.teams.resolve(teamQuery);

    const players = app.services.signings.roster(interaction.guildId, team.id);
    const captains = app.services.teamLinks.getCaptains(interaction.guildId, team.id);

    const playerLines = players.map((p, idx) => {
      const pos = app.services.teamLinks.getPosition(p.id);
      const posTag = pos?.position ? `\`${pos.position}\`` : '`ATH`';
      const numTag = pos?.jerseyNumber !== null && pos?.jerseyNumber !== undefined ? `#${pos.jerseyNumber}` : '';
      return `${idx + 1}. <@${p.userDiscordId}> ${posTag} ${numTag}`;
    });

    const captainLines = captains.map((c) => `• <@${c.userDiscordId}> (${c.role.toUpperCase()})`);

    const openSpots = Math.max(0, ctx.settings.maxUsersPerTeam - players.length);

    const embed = new EmbedBuilder()
      .setColor(team.colors?.primary ?? 0x5865f2)
      .setTitle(`🏈 ${team.fullName || team.name} Roster`)
      .setDescription(
        `**Conference**: ${team.conference || 'Independent'}\n` +
        `**Stadium**: ${team.stadium?.name || 'Home Field'} (${(team.stadium?.capacity || 0).toLocaleString()} cap)\n` +
        `**Roster Size**: ${players.length} / ${ctx.settings.maxUsersPerTeam} (${openSpots} open spots)`,
      )
      .addFields(
        {
          name: 'Team Staff & Captains',
          value: captainLines.length > 0 ? captainLines.join('\n') : '*No captains assigned yet.*',
          inline: false,
        },
        {
          name: `Active Players (${players.length})`,
          value: playerLines.length > 0 ? playerLines.join('\n') : '*No players signed to this team yet.*',
          inline: false,
        },
      )
      .setFooter({ text: 'College Football League • /sign to join this team' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
