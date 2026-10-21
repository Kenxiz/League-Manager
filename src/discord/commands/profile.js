import {
  EmbedBuilder,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { buildContext } from '../context.js';

export default {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a player profile, signed teams, positions, and Roblox account')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('The player to view (leave empty to view your own profile)')
        .setRequired(false),
    ),

  async execute(interaction, app) {
    const ctx = buildContext(interaction, app);
    const targetUser = interaction.options.getUser('user') ?? interaction.user;

    const signings = app.services.signings.forUser(interaction.guildId, targetUser.id);
    const robloxLink = app.services.verification?.getLink?.(targetUser.id);
    const suspension = app.services.suspensions.getActiveSuspension(interaction.guildId, targetUser.id);

    let statusText = '🟢 Active Player';
    if (suspension) {
      statusText = `🔴 **Suspended** (${suspension.bailRobux ? `${suspension.bailRobux} R$` : ''} ${suspension.bailDollars ? `$${suspension.bailDollars.toFixed(2)}` : ''})`;
    } else if (signings.length === 0) {
      statusText = '⚪ **Free Agent**';
    }

    const teamLines = signings.map((s) => {
      const pos = app.services.teamLinks.getPosition(s.id);
      const posTag = pos?.position ? `\`${pos.position}\`` : '`ATH`';
      const numTag = pos?.jerseyNumber !== null && pos?.jerseyNumber !== undefined ? `#${pos.jerseyNumber}` : '';
      return `• **${s.team.name}** (${s.team.abbr}) — ${posTag} ${numTag}`;
    });

    const embed = new EmbedBuilder()
      .setColor(signings.length > 0 ? (signings[0].team.colors?.primary ?? 0x5865f2) : 0x3498db)
      .setTitle(`🏈 Player Profile: ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: 'Discord User', value: `<@${targetUser.id}> (\`${targetUser.id}\`)`, inline: true },
        { name: 'League Status', value: statusText, inline: true },
        {
          name: 'Roblox Account',
          value: robloxLink
            ? `**[${robloxLink.robloxUsername}](https://www.roblox.com/users/${robloxLink.robloxId}/profile)** (\`${robloxLink.robloxId}\`)`
            : '*Not verified with Roblox*',
          inline: true,
        },
        {
          name: `Current Teams (${signings.length})`,
          value: teamLines.length > 0 ? teamLines.join('\n') : '*Currently a Free Agent*',
          inline: false,
        },
      )
      .setFooter({ text: 'College Football League' })
      .setTimestamp();

    if (suspension) {
      embed.addFields({
        name: 'Suspension Detail',
        value: `**Reason**: ${suspension.reason}\n**Suspended By**: <@${suspension.byDiscordId}>`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
