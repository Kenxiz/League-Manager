import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';
import { Permission } from '../../utils/constants.js';

export default {
  data: new SlashCommandBuilder()
    .setName('transfer')
    .setDescription('Transfer a player directly from one team to another')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to transfer')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('to_team')
        .setDescription('The destination team')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('from_team')
        .setDescription('Current team (required only if player is on multiple teams)')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('position')
        .setDescription('New position (e.g. QB, WR, CB, LB)')
        .setRequired(false)
        .setMaxLength(10),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('jersey')
        .setDescription('New jersey number (0-99)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(99),
    ),

  async autocomplete(interaction, app) {
    const focused = interaction.options.getFocused(true);
    const guildId = app.services.guilds.ensure(interaction.guildId);
    const available = app.services.teams.listForGuild(guildId);
    const query = (focused.value || '').toLowerCase().trim();

    const matches = available
      .filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.key.toLowerCase().includes(query) ||
          t.abbr.toLowerCase().includes(query),
      )
      .slice(0, 25);

    await interaction.respond(
      matches.map((t) => ({
        name: `${t.name} (${t.abbr}) - ${t.conference || 'Independent'}`,
        value: t.key,
      })),
    );
  },

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const targetUser = interaction.options.getUser('user', true);
    const toTeamQuery = interaction.options.getString('to_team', true);
    const fromTeamQuery = interaction.options.getString('from_team');
    const position = interaction.options.getString('position');
    const jersey = interaction.options.getInteger('jersey');

    const toTeam = app.services.teams.resolve(toTeamQuery);
    const fromTeam = fromTeamQuery ? app.services.teams.resolve(fromTeamQuery) : null;

    // Check authority: must have SIGN_OTHERS or be commissioner/AD of the new team or league admin
    const isAD = app.services.teamLinks.canManageTeam({
      guildDiscordId: interaction.guildId,
      team: toTeam.id,
      userDiscordId: interaction.user.id,
      memberRoleIds: ctx.actor.roleIds,
      settings: ctx.settings,
    });

    if (!isAD) {
      app.services.permissions.assert(ctx.actor, ctx.settings, Permission.SIGN_OTHERS);
    }

    // Perform transfer in service
    const result = app.services.signings.transfer({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      from: fromTeam ? fromTeam.id : undefined,
      to: toTeam.id,
      actorDiscordId: interaction.user.id,
    });

    // Set position & jersey on the new signing if provided
    if (position || jersey !== null) {
      try {
        app.services.teamLinks.setPosition({
          signingId: result.to.id,
          position: position || 'ATH',
          jerseyNumber: jersey,
        });
      } catch (err) {
        app.logger?.warn({ err }, 'could not set position/jersey on transfer');
      }
    }

    // Discord role management: remove old team role, add new team role, ensure no free agent role
    let oldRoleRemoved = false;
    let newRoleAdded = false;

    if (interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member) {
          // Remove old team role
          const oldRoleId = app.services.teamLinks.getRole(interaction.guildId, result.from.team.id);
          if (oldRoleId && member.roles.cache.has(oldRoleId)) {
            await member.roles.remove(oldRoleId, `Transferred to ${toTeam.name}`);
            oldRoleRemoved = true;
          }

          // Add new team role
          const newRoleId = app.services.teamLinks.getRole(interaction.guildId, toTeam.id);
          if (newRoleId) {
            await member.roles.add(newRoleId, `Transferred from ${result.from.team.name}`);
            newRoleAdded = true;
          }

          // Ensure Free Agent role is not present
          if (ctx.settings.freeAgentRoleId && member.roles.cache.has(ctx.settings.freeAgentRoleId)) {
            await member.roles.remove(ctx.settings.freeAgentRoleId, 'Transferred to team');
          }
        }
      } catch (err) {
        app.logger?.warn({ err, userId: targetUser.id }, 'failed to update roles on transfer');
      }
    }

    const embed = new EmbedBuilder()
      .setColor(toTeam.colors?.primary ?? 0x3498db)
      .setTitle('🔄 Official Transfer Portal')
      .setDescription(
        `<@${targetUser.id}> has transferred from **${result.from.team.name}** to the **${toTeam.name}**!`,
      )
      .addFields(
        { name: 'Player', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'From', value: `**${result.from.team.name}** (${result.from.team.abbr})`, inline: true },
        { name: 'To', value: `**${toTeam.name}** (${toTeam.abbr})`, inline: true },
        {
          name: 'New Position & Jersey',
          value: position || jersey !== null
            ? `${position ? `**${position.toUpperCase()}**` : 'ATH'} ${jersey !== null ? `#${jersey}` : ''}`
            : 'Unchanged',
          inline: true,
        },
        { name: 'Authorized By', value: `<@${interaction.user.id}>`, inline: true },
        {
          name: 'Role Updates',
          value: `${oldRoleRemoved ? '✅ Old team role removed' : 'ℹ️ Old role N/A'} · ${newRoleAdded ? '✅ New team role assigned' : 'ℹ️ No team role'}`,
          inline: false,
        },
      )
      .setFooter({ text: `College Football League • ${toTeam.stadium?.name || 'Home Stadium'}` })
      .setTimestamp();

    // Post to transactions channel if configured
    if (ctx.settings.transactionsChannelId && interaction.guild) {
      try {
        const transChannel = interaction.guild.channels.cache.get(ctx.settings.transactionsChannelId);
        if (transChannel && transChannel.id !== interaction.channelId) {
          await transChannel.send({ embeds: [embed] });
        }
      } catch (err) {
        app.logger?.warn({ err }, 'failed to post transfer to transactions channel');
      }
    }

    await interaction.reply({ embeds: [embed] });
  },
};
