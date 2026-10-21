import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('sign')
    .setDescription('Sign yourself or another player to a college football team')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName('team')
        .setDescription('The team to sign to')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to sign (leave empty to sign yourself)')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('position')
        .setDescription('Player position (e.g. QB, RB, WR, OT, DT, LB, CB, S, K)')
        .setRequired(false)
        .setMaxLength(10),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('jersey')
        .setDescription('Jersey number (0-99)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(99),
    ),

  async autocomplete(interaction, app) {
    const focused = interaction.options.getFocused();
    const guildId = app.services.guilds.ensure(interaction.guildId);
    const available = app.services.teams.listForGuild(guildId);
    const query = focused.toLowerCase().trim();

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
    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = targetUser.id === interaction.user.id;

    if (isSelf) {
      app.services.permissions.assertCanSign(ctx.actor, ctx.settings, targetUser.id);
    } else {
      // Signing someone else: check if coach/AD of that team or commissioner/admin
      const teamQuery = interaction.options.getString('team', true);
      const team = app.services.teams.resolve(teamQuery);
      const isAD = app.services.teamLinks.canManageTeam({
        guildDiscordId: interaction.guildId,
        team: team.id,
        userDiscordId: interaction.user.id,
        memberRoleIds: ctx.actor.roleIds,
        settings: ctx.settings,
      });

      if (!isAD) {
        app.services.permissions.assertCanSign(ctx.actor, ctx.settings, targetUser.id);
      }
    }

    const teamQuery = interaction.options.getString('team', true);
    const team = app.services.teams.resolve(teamQuery);

    const position = interaction.options.getString('position');
    const jersey = interaction.options.getInteger('jersey');

    // 1. Core signing
    const signing = app.services.signings.sign({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      team: team.id,
      actorDiscordId: interaction.user.id,
    });

    // 2. Set position and jersey number if provided
    if (position || jersey !== null) {
      try {
        app.services.teamLinks.setPosition({
          signingId: signing.id,
          position: position || 'ATH',
          jerseyNumber: jersey,
        });
      } catch (err) {
        app.logger?.warn({ err }, 'could not set position/jersey');
      }
    }

    // 3. Discord Role Management: Remove Free Agent role & Add Team role
    let freeAgentRoleRemoved = false;
    let teamRoleAdded = false;

    if (interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member) {
          // Remove Free Agent role
          if (ctx.settings.freeAgentRoleId && member.roles.cache.has(ctx.settings.freeAgentRoleId)) {
            await member.roles.remove(ctx.settings.freeAgentRoleId, `Signed to ${team.name}`);
            freeAgentRoleRemoved = true;
          }

          // Add Team role
          const teamRoleId = app.services.teamLinks.getRole(interaction.guildId, team.id);
          if (teamRoleId) {
            await member.roles.add(teamRoleId, `Signed to ${team.name}`);
            teamRoleAdded = true;
          }
        }
      } catch (err) {
        app.logger?.warn({ err, userId: targetUser.id }, 'failed to update member roles on sign');
      }
    }

    // 4. Build Announcement Embed
    const embed = new EmbedBuilder()
      .setColor(team.colors?.primary ?? 0x5865f2)
      .setTitle(`✍️ Official Signing: ${team.fullName || team.name}`)
      .setDescription(`<@${targetUser.id}> has officially signed with the **${team.name}**!`)
      .addFields(
        { name: 'Player', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'Team', value: `**${team.name}** (${team.abbr})`, inline: true },
        { name: 'Conference', value: team.conference || 'Independent', inline: true },
        {
          name: 'Position & Jersey',
          value: position || jersey !== null
            ? `${position ? `**${position.toUpperCase()}**` : 'ATH'} ${jersey !== null ? `#${jersey}` : ''}`
            : 'Unassigned',
          inline: true,
        },
        {
          name: 'Authorized By',
          value: isSelf ? 'Self-Signed' : `<@${interaction.user.id}>`,
          inline: true,
        },
        {
          name: 'Role Updates',
          value: `${freeAgentRoleRemoved ? '✅ `@Free Agent` removed' : 'ℹ️ Free Agent N/A'} · ${teamRoleAdded ? '✅ Team role assigned' : 'ℹ️ No team role'}`,
          inline: false,
        },
      )
      .setFooter({ text: `College Football League • ${team.stadium?.name || 'Home Stadium'}` })
      .setTimestamp();

    // 5. Post to transactions channel if configured
    if (ctx.settings.transactionsChannelId && interaction.guild) {
      try {
        const transChannel = interaction.guild.channels.cache.get(ctx.settings.transactionsChannelId);
        if (transChannel && transChannel.id !== interaction.channelId) {
          await transChannel.send({ embeds: [embed] });
        }
      } catch (err) {
        app.logger?.warn({ err }, 'failed to post signing to transactions channel');
      }
    }

    await interaction.reply({ embeds: [embed] });
  },
};
