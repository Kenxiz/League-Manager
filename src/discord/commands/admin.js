import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Open the League Administration & Suspensions panel')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);

    const activeSuspensions = app.services.suspensions.listSuspensions(interaction.guildId, { activeOnly: true });

    const embed = new EmbedBuilder()
      .setColor(0x2f3136)
      .setTitle('🛡️ League Administration & Suspensions Panel')
      .setDescription(
        'Use this panel to manage league disciplinary actions, configure bail, and manage suspensions.\n' +
        'Suspending a player applies the `@Suspended` role, sets their bail in Robux/Dollars, and releases them from active signings.',
      )
      .addFields(
        {
          name: 'Active Suspensions',
          value: `**${activeSuspensions.length}** player(s) suspended`,
          inline: true,
        },
        {
          name: 'Allowed Suspension Roles',
          value: ctx.settings.suspensionAllowedRoleIds.length > 0
            ? ctx.settings.suspensionAllowedRoleIds.map((id) => `<@&${id}>`).join(', ')
            : 'Default (Commissioners & Admins)',
          inline: true,
        },
        {
          name: 'Suspended Role',
          value: ctx.settings.suspendedRoleId ? `<@&${ctx.settings.suspendedRoleId}>` : '⚠️ Not yet created (click Auto-Setup)',
          inline: true,
        },
      )
      .setFooter({ text: 'Authorized staff only · Permanent bans are reserved for Bot Developers' })
      .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('admin:open_suspend_modal')
        .setLabel('Suspend Player')
        .setEmoji('⚖️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('admin:view_suspensions')
        .setLabel('View Active Suspensions')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('admin:run_setup')
        .setLabel('Auto-Setup @Suspended Role')
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.reply({ embeds: [embed], components: [buttons] });
  },
};
