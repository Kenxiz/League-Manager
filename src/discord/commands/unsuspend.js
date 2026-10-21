import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unsuspend')
    .setDescription('Lift a player suspension, remove bail, and remove the @Suspended role')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to unsuspend')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason for lifting the suspension (e.g. Bail paid)')
        .setRequired(false)
        .setMaxLength(250),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') ?? 'Bail paid / Suspension lifted';

    const result = app.services.suspensions.unsuspend({
      guildDiscordId: interaction.guildId,
      userDiscordId: targetUser.id,
      actorDiscordId: interaction.user.id,
      reason,
    });

    // Remove @Suspended role if member is currently in the guild
    let roleRemoved = false;
    if (ctx.settings.suspendedRoleId) {
      try {
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member && member.roles.cache.has(ctx.settings.suspendedRoleId)) {
          await member.roles.remove(ctx.settings.suspendedRoleId, `Unsuspended by ${interaction.user.tag}: ${reason}`);
          roleRemoved = true;
        }
      } catch (err) {
        app.logger?.warn({ err, userId: targetUser.id }, 'failed to remove @Suspended role from member');
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Discord Green
      .setTitle('Player Unsuspended')
      .setDescription(`Suspension for <@${targetUser.id}> has been successfully lifted.`)
      .addFields(
        { name: 'Target User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Role Status', value: roleRemoved ? '✅ `@Suspended` role removed' : 'ℹ️ Role was not assigned', inline: true },
        { name: 'Reason / Resolution', value: reason },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
