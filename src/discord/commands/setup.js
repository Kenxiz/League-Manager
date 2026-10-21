import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';
import { Permission } from '../../utils/constants.js';
import { runGuildSetup } from '../setup-helper.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Run automatic setup for LeagueBot (creates @Suspended role & checks guild configuration)')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    app.services.permissions.assert(ctx.actor, ctx.settings, Permission.MANAGE_SETTINGS);

    const setupResult = await runGuildSetup(interaction.guild, app.services);
    const { roles, channels, settings } = setupResult;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2) // Blurple
      .setTitle('🏈 LeagueBot Automatic Setup Complete')
      .setDescription(
        'Server channels and core roles have been created and configured automatically.\n' +
        'All IDs and settings have been saved to the database and `data/guild-configs/`.\n\n' +
        'ℹ️ **Team Roles Note**: 143 team roles were **not** created. You can select up to 20 initial teams from the web dashboard (and add more anytime).',
      )
      .addFields(
        {
          name: 'Core Roles Created',
          value: [
            roles.suspended ? `• Suspended: <@&${roles.suspended.id}>` : null,
            roles.commissioner ? `• Commissioner: <@&${roles.commissioner.id}>` : null,
            roles.athleticDirector ? `• Athletic Director: <@&${roles.athleticDirector.id}>` : null,
            roles.coach ? `• Coach: <@&${roles.coach.id}>` : null,
            roles.freeAgent ? `• Free Agent: <@&${roles.freeAgent.id}> (${setupResult.membersAssignedCount ?? 0} members assigned)` : null,
          ].filter(Boolean).join('\n') || 'None',

          inline: false,
        },
        {
          name: 'League Channels Created',
          value: [
            channels.schedule ? `• Schedule: <#${channels.schedule.id}>` : null,
            channels.transactions ? `• Transactions: <#${channels.transactions.id}>` : null,
            channels.logs ? `• League Logs: <#${channels.logs.id}>` : null,
          ].filter(Boolean).join('\n') || 'None',
          inline: false,
        },
        {
          name: 'Signings Status',
          value: settings.signingsOpen ? '🟢 Open' : '🔴 Closed',
          inline: true,
        },
        {
          name: 'Dashboard Initial Teams',
          value: 'Select up to 20 teams in Dashboard',
          inline: true,
        },
      )
      .setFooter({ text: 'All IDs and configurations are stored in data/guild-configs/' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

  },
};
