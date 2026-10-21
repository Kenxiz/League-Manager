import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { DEVELOPER_IDS } from '../../utils/constants.js';
import { PermissionError } from '../../utils/errors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from the league (Developer only)')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The user to unban')
        .setRequired(true),
    ),

  async execute(interaction, app) {
    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
      throw new PermissionError(
        `Unbanning is strictly reserved for League Manager developers (${DEVELOPER_IDS.join(', ')}). League staff and commissioners must use /unsuspend instead.`,
      );
    }

    const targetUser = interaction.options.getUser('user', true);

    app.services.bans.unban({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      actorDiscordId: interaction.user.id,
    });

    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Discord Green
      .setTitle('League Ban Lifted (Developer Action)')
      .setDescription(`<@${targetUser.id}> has been unbanned from the league.`)
      .addFields(
        { name: 'Target User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'Developer', value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
