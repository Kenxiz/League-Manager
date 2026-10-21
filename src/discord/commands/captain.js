import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';
import { Permission } from '../../utils/constants.js';

export default {
  data: new SlashCommandBuilder()
    .setName('captain')
    .setDescription('Manage team captains, co-captains, and team staff')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('assign')
        .setDescription('Assign a team captain, co-captain, or coach')
        .addStringOption((opt) =>
          opt
            .setName('team')
            .setDescription('The team')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('The user to assign')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('role')
            .setDescription('Role title')
            .setRequired(false)
            .addChoices(
              { name: 'Captain', value: 'captain' },
              { name: 'Co-Captain', value: 'co-captain' },
              { name: 'Head Coach', value: 'head coach' },
              { name: 'Offensive Coordinator', value: 'oc' },
              { name: 'Defensive Coordinator', value: 'dc' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a captain or coach from a team')
        .addStringOption((opt) =>
          opt
            .setName('team')
            .setDescription('The team')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('The user to remove')
            .setRequired(true),
        ),
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
    const sub = interaction.options.getSubcommand();
    const teamQuery = interaction.options.getString('team', true);
    const team = app.services.teams.resolve(teamQuery);
    const targetUser = interaction.options.getUser('user', true);

    // Permission check: MANAGE_CAPTAINS or Athletic Director / Team Manager
    const isAD = app.services.teamLinks.canManageTeam({
      guildDiscordId: interaction.guildId,
      team: team.id,
      userDiscordId: interaction.user.id,
      memberRoleIds: ctx.actor.roleIds,
      settings: ctx.settings,
    });

    if (!isAD) {
      app.services.permissions.assert(ctx.actor, ctx.settings, Permission.MANAGE_CAPTAINS);
    }

    if (sub === 'assign') {
      const role = interaction.options.getString('role') ?? 'captain';
      app.services.teamLinks.assignCaptain({
        guildDiscordId: interaction.guildId,
        team: team.id,
        userDiscordId: targetUser.id,
        role,
        actorDiscordId: interaction.user.id,
      });

      const embed = new EmbedBuilder()
        .setColor(team.colors?.primary ?? 0x5865f2)
        .setTitle('⭐ Captain Assigned')
        .setDescription(`<@${targetUser.id}> has been appointed **${role.toUpperCase()}** for the **${team.name}**!`)
        .addFields(
          { name: 'Team', value: `**${team.name}** (${team.abbr})`, inline: true },
          { name: 'Role Title', value: role.toUpperCase(), inline: true },
          { name: 'Assigned By', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'remove') {
      app.services.teamLinks.removeCaptain({
        guildDiscordId: interaction.guildId,
        team: team.id,
        userDiscordId: targetUser.id,
        actorDiscordId: interaction.user.id,
      });

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('⭐ Captain Status Removed')
        .setDescription(`<@${targetUser.id}> is no longer a captain for the **${team.name}**.`)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },
};
