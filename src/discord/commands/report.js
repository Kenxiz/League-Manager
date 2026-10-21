import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';
import { Permission } from '../../utils/constants.js';

export default {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Submit an official match score report for verification')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName('match_id')
        .setDescription('The match ID')
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('home_score')
        .setDescription('Home team final score')
        .setRequired(true)
        .setMinValue(0),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('away_score')
        .setDescription('Away team final score')
        .setRequired(true)
        .setMinValue(0),
    )
    .addStringOption((opt) =>
      opt
        .setName('proof_url')
        .setDescription('Link to scoreboard screenshot or stream vod')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('notes')
        .setDescription('Game notes or overtime detail')
        .setRequired(false)
        .setMaxLength(250),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    app.services.permissions.assert(ctx.actor, ctx.settings, Permission.REPORT_SCORES);

    const matchId = interaction.options.getInteger('match_id', true);
    const homeScore = interaction.options.getInteger('home_score', true);
    const awayScore = interaction.options.getInteger('away_score', true);
    const proofUrl = interaction.options.getString('proof_url');
    const notes = interaction.options.getString('notes');

    const match = app.services.schedule.getMatch(matchId);

    // If caller has APPROVE_SCORES (Commissioner/Admin), auto-approve directly
    const autoApprove = ctx.access.has(Permission.APPROVE_SCORES);

    const report = app.services.matchReports.submitReport({
      guildDiscordId: interaction.guildId,
      matchId,
      reporterDiscordId: interaction.user.id,
      homeScore,
      awayScore,
      proofUrl,
      notes,
      autoApprove,
    });

    const embed = new EmbedBuilder()
      .setColor(autoApprove ? 0x57f287 : 0xfee75c)
      .setTitle(`📊 Score Report: Match #${match.id}`)
      .setDescription(
        `**${match.homeTeam.name}** vs **${match.awayTeam.name}**\n\n` +
        `Final Score: **${match.homeTeam.abbr} ${homeScore}** - **${awayScore} ${match.awayTeam.abbr}**\n` +
        `Status: ${autoApprove ? '✅ **Verified & Approved**' : '⏳ **Pending Staff Verification**'}`,
      )
      .addFields(
        { name: 'Reporter', value: `<@${interaction.user.id}>`, inline: true },
        {
          name: 'Winner',
          value: homeScore > awayScore
            ? `🏆 **${match.homeTeam.name}**`
            : awayScore > homeScore
              ? `🏆 **${match.awayTeam.name}**`
              : '🤝 Tie',
          inline: true,
        },
        { name: 'Proof', value: proofUrl ? `[View Proof](${proofUrl})` : '*No proof attached*', inline: true },
      )
      .setFooter({ text: autoApprove ? 'Standings have been updated' : 'Reviewable by Commissioners' })
      .setTimestamp();

    if (notes) {
      embed.addFields({ name: 'Notes', value: notes });
    }

    // If not auto-approved and logChannelId configured, send verification embed with approve button
    if (!autoApprove && ctx.settings.logChannelId && interaction.guild) {
      try {
        const logChannel = interaction.guild.channels.cache.get(ctx.settings.logChannelId);
        if (logChannel) {
          const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`report_approve:${report.id}`)
              .setLabel('Approve Score')
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`report_reject:${report.id}`)
              .setLabel('Reject')
              .setEmoji('❌')
              .setStyle(ButtonStyle.Danger),
          );
          await logChannel.send({ embeds: [embed], components: [actionRow] });
        }
      } catch (err) {
        app.logger?.warn({ err }, 'failed to send report to log channel');
      }
    }

    await interaction.reply({ embeds: [embed] });
  },
};
