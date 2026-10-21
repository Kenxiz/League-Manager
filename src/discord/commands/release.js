import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('release')
    .setDescription('Release yourself or another player from a team')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to release (leave empty to release yourself)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('team')
        .setDescription('Specify which team to release from (required if player is on multiple teams)')
        .setRequired(false)
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
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = targetUser.id === interaction.user.id;

    const teamQuery = interaction.options.getString('team');
    const team = teamQuery ? app.services.teams.resolve(teamQuery) : null;

    if (isSelf) {
      app.services.permissions.assertCanRelease(ctx.actor, ctx.settings, targetUser.id);
    } else {
      let isAD = false;
      if (team) {
        isAD = app.services.teamLinks.canManageTeam({
          guildDiscordId: interaction.guildId,
          team: team.id,
          userDiscordId: interaction.user.id,
          memberRoleIds: ctx.actor.roleIds,
          settings: ctx.settings,
        });
      }
      if (!isAD) {
        app.services.permissions.assertCanRelease(ctx.actor, ctx.settings, targetUser.id);
      }
    }

    const released = app.services.signings.release({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      team: team ? team.id : null,
      actorDiscordId: interaction.user.id,
    });

    const releasedTeams = released.map((s) => s.team);

    // Discord Role updates: remove team roles, add Free Agent role
    let freeAgentAdded = false;
    if (interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member) {
          for (const t of releasedTeams) {
            const teamRoleId = app.services.teamLinks.getRole(interaction.guildId, t.id);
            if (teamRoleId && member.roles.cache.has(teamRoleId)) {
              await member.roles.remove(teamRoleId, `Released from ${t.name}`);
            }
          }

          // Add Free Agent role back
          if (ctx.settings.freeAgentRoleId) {
            await member.roles.add(ctx.settings.freeAgentRoleId, 'Player released to Free Agency');
            freeAgentAdded = true;
          }
        }
      } catch (err) {
        app.logger?.warn({ err, userId: targetUser.id }, 'failed to update member roles on release');
      }
    }

    const teamNames = releasedTeams.map((t) => `**${t.name}**`).join(', ');
    const embed = new EmbedBuilder()
      .setColor(0xe67e22) // Orange
      .setTitle('📋 Official Release')
      .setDescription(`<@${targetUser.id}> has been released from ${teamNames}.`)
      .addFields(
        { name: 'Player', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'Released From', value: teamNames, inline: true },
        {
          name: 'Status',
          value: freeAgentAdded ? '✅ Returned to `@Free Agent`' : 'Free Agent',
          inline: true,
        },
      )
      .setFooter({ text: 'College Football League • Transactions' })
      .setTimestamp();

    if (ctx.settings.transactionsChannelId && interaction.guild) {
      try {
        const transChannel = interaction.guild.channels.cache.get(ctx.settings.transactionsChannelId);
        if (transChannel && transChannel.id !== interaction.channelId) {
          await transChannel.send({ embeds: [embed] });
        }
      } catch (err) {}
    }

    await interaction.reply({ embeds: [embed] });
  },
};
