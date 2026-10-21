import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('freeagents')
    .setDescription('List all free agent players in the server available for signing')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const roleId = ctx.settings.freeAgentRoleId;

    let freeAgents = [];
    if (interaction.guild) {
      if (roleId) {
        const role = interaction.guild.roles.cache.get(roleId);
        if (role) {
          freeAgents = role.members.filter((m) => !m.user.bot).map((m) => m.id);
        }
      }

      // If role not found or empty, fetch members without active signings
      if (freeAgents.length === 0) {
        const allLive = app.services.signings.q.liveAll.all(ctx.guildId);
        const signedUserIds = new Set(allLive.map((s) => s.discord_id));
        freeAgents = interaction.guild.members.cache
          .filter((m) => !m.user.bot && !signedUserIds.has(m.id))
          .map((m) => m.id);
      }
    }

    if (freeAgents.length === 0) {
      await interaction.reply({
        content: 'ℹ️ There are currently no Free Agent players in the server.',
        ephemeral: true,
      });
      return;
    }

    const lines = freeAgents.slice(0, 30).map((id, idx) => `${idx + 1}. <@${id}> (\`${id}\`)`);

    const embed = new EmbedBuilder()
      .setColor(0x3498db) // Blue
      .setTitle(`📋 League Free Agents (${freeAgents.length})`)
      .setDescription(
        'The following players are currently unassigned and eligible to be signed to a team:\n\n' +
        lines.join('\n') +
        (freeAgents.length > 30 ? `\n\n*...and ${freeAgents.length - 30} more players.*` : ''),
      )
      .setFooter({ text: 'Team coaches and ADs can sign players using /sign <team> <user>' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
