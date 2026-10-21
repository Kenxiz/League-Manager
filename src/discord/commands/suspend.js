import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export function buildSuspendModal(targetUserId = '') {
  const modal = new ModalBuilder()
    .setCustomId(`suspend_modal:${targetUserId || 'new'}`)
    .setTitle('League Suspension Form');

  const userInput = new TextInputBuilder()
    .setCustomId('user_input')
    .setLabel('User (ID, @mention, or Username)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(64)
    .setPlaceholder('e.g. 123456789012345678 or @Player');

  if (targetUserId) {
    userInput.setValue(targetUserId);
  }

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason_input')
    .setLabel('Reason for Suspension')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500)
    .setPlaceholder('Enter the official reason for suspending this user...');

  const bailRobuxInput = new TextInputBuilder()
    .setCustomId('bail_robux_input')
    .setLabel('Bail in Robux (R$)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(12)
    .setPlaceholder('e.g. 500 (or leave 0 / empty)');

  const bailDollarsInput = new TextInputBuilder()
    .setCustomId('bail_dollars_input')
    .setLabel('Bail in Dollars ($ USD)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(12)
    .setPlaceholder('e.g. 15.00 (or leave 0 / empty)');

  modal.addComponents(
    new ActionRowBuilder().addComponents(userInput),
    new ActionRowBuilder().addComponents(reasonInput),
    new ActionRowBuilder().addComponents(bailRobuxInput),
    new ActionRowBuilder().addComponents(bailDollarsInput),
  );

  return modal;
}

export default {
  data: new SlashCommandBuilder()
    .setName('suspend')
    .setDescription('Suspend a player with bail in Robux and/or Dollars and assign @Suspended role')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to suspend')
        .setRequired(false),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);

    const targetUser = interaction.options.getUser('user');
    const modal = buildSuspendModal(targetUser ? targetUser.id : '');
    await interaction.showModal(modal);
  },
};
