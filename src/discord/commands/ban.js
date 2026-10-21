import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { DEVELOPER_IDS } from '../../utils/constants.js';
import { PermissionError } from '../../utils/errors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Permanently ban a user from the league (Developer only)')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The user to ban from the league')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(false)
        .setMaxLength(250),
    )
    .addNumberOption((opt) =>
      opt
        .setName('duration_hours')
        .setDescription('Optional temporary duration in hours (leave blank for permanent)')
        .setRequired(false)
        .setMinValue(1),
    ),

  async execute(interaction, app) {
    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
      throw new PermissionError(
        `Banning is strictly reserved for League Manager developers (${DEVELOPER_IDS.join(', ')}). League staff and commissioners must use /suspend instead.`,
      );
    }

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') ?? 'Banned by developer';
    const durationHours = interaction.options.getNumber('duration_hours') ?? null;

    const ban = app.services.bans.ban({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      actorDiscordId: interaction.user.id,
      reason,
      durationHours,
    });

    const embed = new EmbedBuilder()
      .setColor(0xed4245) // Discord Red
      .setTitle('League Ban Issued (Developer Action)')
      .setDescription(`<@${targetUser.id}> has been banned from the league.`)
      .addFields(
        { name: 'Target User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true },
        {
          name: 'Duration',
          value: ban.expiresAt ? `<t:${ban.expiresAt}:R>` : 'Permanent',
          inline: true,
        },
        { name: 'Reason', value: reason },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
