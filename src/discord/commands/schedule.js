import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';
import { Permission } from '../../utils/constants.js';
import { parseTimeInput } from '../../utils/helpers.js';

export default {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Create match schedules, coordinate game times, and finalize agreements')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new scheduled match and spawn a coordination thread for Athletic Directors')
        .addStringOption((opt) =>
          opt
            .setName('home_team')
            .setDescription('The home team')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('away_team')
            .setDescription('The away team')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('week')
            .setDescription('Schedule week (default 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25),
        )
        .addStringOption((opt) =>
          opt
            .setName('stadium')
            .setDescription('Stadium name override (defaults to home team stadium)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('end')
        .setDescription('Propose/finalize game time for mutual confirmation by both team Athletic Directors')
        .addStringOption((opt) =>
          opt
            .setName('time')
            .setDescription('Game time (e.g. "today 8pm", "tomorrow 6pm", or unix timestamp)')
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('match_id')
            .setDescription('Match ID (optional if run inside the coordination thread)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('View upcoming scheduled matches')
        .addIntegerOption((opt) =>
          opt
            .setName('week')
            .setDescription('Filter by schedule week')
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName('team')
            .setDescription('Filter by team')
            .setRequired(false)
            .setAutocomplete(true),
        ),
    ),

  async autocomplete(interaction, app) {
    const focused = interaction.options.getFocused(true);
    const guildId = app.services.guilds.ensure(interaction.guildId);
    const available = app.services.teams.listForGuild(guildId);
    const query = String(focused.value).toLowerCase().trim();

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

    if (sub === 'create') {
      app.services.permissions.assert(ctx.actor, ctx.settings, Permission.MANAGE_SCHEDULE);

      const homeQuery = interaction.options.getString('home_team', true);
      const awayQuery = interaction.options.getString('away_team', true);
      const week = interaction.options.getInteger('week') ?? 1;

      const homeTeam = app.services.teams.resolve(homeQuery);
      const awayTeam = app.services.teams.resolve(awayQuery);
      const stadium = interaction.options.getString('stadium') ?? homeTeam.stadium?.name;

      // 1. Create match in database
      const match = app.services.schedule.createMatch({
        guildDiscordId: interaction.guildId,
        homeTeam: homeTeam.id,
        awayTeam: awayTeam.id,
        week,
        stadiumName: stadium,
        actorDiscordId: interaction.user.id,
      });

      // 2. Create coordination thread in schedule channel
      let thread = null;
      let scheduleChannel = null;

      if (ctx.settings.scheduleChannelId && interaction.guild) {
        scheduleChannel = interaction.guild.channels.cache.get(ctx.settings.scheduleChannelId);
      }
      if (!scheduleChannel) {
        scheduleChannel = interaction.channel;
      }

      if (scheduleChannel && typeof scheduleChannel.threads?.create === 'function') {
        try {
          thread = await scheduleChannel.threads.create({
            name: `W${week}: ${homeTeam.name} vs ${awayTeam.name} (Match #${match.id})`,
            autoArchiveDuration: 1440,
            reason: `Game coordination thread for Match #${match.id}`,
            type: ChannelType.PublicThread,
          });

          // Save thread ID to match
          app.services.schedule.db
            .prepare('UPDATE matches SET coordination_thread_id = ? WHERE id = ?')
            .run(thread.id, match.id);

          const adMentions = ctx.settings.athleticDirectorRoleIds.length > 0
            ? ctx.settings.athleticDirectorRoleIds.map((id) => `<@&${id}>`).join(' ')
            : 'Athletic Directors / Team Captains';

          const introEmbed = new EmbedBuilder()
            .setColor(homeTeam.colors?.primary ?? 0x5865f2)
            .setTitle(`🏈 Game Coordination: ${homeTeam.name} vs ${awayTeam.name}`)
            .setDescription(
              `Welcome ${adMentions}!\n\n` +
              `Use this thread to coordinate the match date & time.\n` +
              `Once you agree on a time, run:\n` +
              `\`/schedule end time:<game_time>\`\n\n` +
              `Both sides will then click the confirmation tick button on the embed to lock in the schedule.`,
            )
            .addFields(
              { name: 'Match ID', value: `\`#${match.id}\``, inline: true },
              { name: 'Week', value: `Week ${week}`, inline: true },
              { name: 'Stadium', value: stadium || 'TBD', inline: true },
            )
            .setFooter({ text: 'College Football League • Match Coordination' })
            .setTimestamp();

          await thread.send({ embeds: [introEmbed] });
        } catch (err) {
          app.logger?.warn({ err }, 'failed to create match coordination thread');
        }
      }

      const replyEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Match Scheduled')
        .setDescription(`Match **#${match.id}** created: **${homeTeam.name}** vs **${awayTeam.name}** (Week ${week})`)
        .addFields(
          { name: 'Home Team', value: `**${homeTeam.name}**`, inline: true },
          { name: 'Away Team', value: `**${awayTeam.name}**`, inline: true },
          { name: 'Stadium', value: stadium || 'Home Field', inline: true },
          {
            name: 'Coordination Thread',
            value: thread ? `<#${thread.id}>` : '⚠️ Could not create thread (check permissions)',
            inline: false,
          },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [replyEmbed] });
      return;
    }

    if (sub === 'end') {
      const timeInput = interaction.options.getString('time', true);
      const parsedTimestamp = parseTimeInput(timeInput);

      if (!parsedTimestamp) {
        await interaction.reply({
          content: '❌ Invalid time format. Please provide a relative time (e.g. "today 8pm", "tomorrow 6pm") or a unix timestamp.',
          ephemeral: true,
        });
        return;
      }

      // Find match ID: from option or from current thread
      let matchId = interaction.options.getInteger('match_id');
      if (!matchId && interaction.channel.isThread()) {
        const row = app.services.schedule.db
          .prepare('SELECT id FROM matches WHERE coordination_thread_id = ?')
          .get(interaction.channelId);
        if (row) matchId = row.id;
      }

      if (!matchId) {
        await interaction.reply({
          content: '❌ Could not determine match. Run this inside the match coordination thread or specify `match_id`.',
          ephemeral: true,
        });
        return;
      }

      const match = app.services.schedule.getMatch(matchId);

      // Determine caller's side
      let side = 'home';
      const isHomeAD = app.services.teamLinks.canManageTeam({
        guildDiscordId: interaction.guildId,
        team: match.homeTeam.id,
        userDiscordId: interaction.user.id,
        memberRoleIds: ctx.actor.roleIds,
        settings: ctx.settings,
      });
      const isAwayAD = app.services.teamLinks.canManageTeam({
        guildDiscordId: interaction.guildId,
        team: match.awayTeam.id,
        userDiscordId: interaction.user.id,
        memberRoleIds: ctx.actor.roleIds,
        settings: ctx.settings,
      });

      if (isAwayAD && !isHomeAD) side = 'away';

      // Record proposal
      app.services.schedule.proposeMatchTime({
        guildDiscordId: interaction.guildId,
        matchId,
        scheduledAt: parsedTimestamp,
        proposerDiscordId: interaction.user.id,
        side,
      });

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⏱️ Proposed Game Time: Match #${match.id}`)
        .setDescription(
          `**${match.homeTeam.name}** vs **${match.awayTeam.name}**\n\n` +
          `A game time has been proposed for <t:${parsedTimestamp}:F> (<t:${parsedTimestamp}:R>).\n\n` +
          `**Both team owners / Athletic Directors must click their tick below to confirm!**`,
        )
        .addFields(
          {
            name: `Home: ${match.homeTeam.name}`,
            value: side === 'home' ? `✅ Proposed & Confirmed by <@${interaction.user.id}>` : '⏳ Waiting for confirmation...',
            inline: true,
          },
          {
            name: `Away: ${match.awayTeam.name}`,
            value: side === 'away' ? `✅ Proposed & Confirmed by <@${interaction.user.id}>` : '⏳ Waiting for confirmation...',
            inline: true,
          },
        )
        .setFooter({ text: 'Once both ticks are confirmed, the match will automatically be locked in.' })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`match_confirm:${match.id}:home`)
          .setLabel(`Confirm (${match.homeTeam.abbr})`)
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`match_confirm:${match.id}:away`)
          .setLabel(`Confirm (${match.awayTeam.abbr})`)
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
      );

      await interaction.reply({ embeds: [embed], components: [buttons] });
      return;
    }

    if (sub === 'list') {
      const week = interaction.options.getInteger('week');
      const teamQuery = interaction.options.getString('team');
      const team = teamQuery ? app.services.teams.resolve(teamQuery) : null;

      const matches = app.services.schedule.listMatches({
        guildDiscordId: interaction.guildId,
        week,
        team: team ? team.id : null,
        limit: 20,
      });

      if (matches.length === 0) {
        await interaction.reply({ content: 'ℹ️ No matches found on the schedule.', ephemeral: true });
        return;
      }

      const lines = matches.map((m) => {
        const timeStr = m.scheduledAt ? `<t:${m.scheduledAt}:f>` : '*TBD*';
        const scoreStr = m.status === 3 ? ` (${m.homeScore} - ${m.awayScore})` : '';
        return `• **#${m.id}** [W${m.week}] **${m.homeTeam.name}** vs **${m.awayTeam.name}**${scoreStr} — ${timeStr}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📅 League Match Schedule')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use /report to submit scores, or /schedule create to add games' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },
};
