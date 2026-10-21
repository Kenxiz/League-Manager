import { PermissionFlagsBits } from 'discord.js';

/**
 * Builds the request context every command needs: internal guild id, effective settings and the
 * caller's resolved access. Registers the guild lazily, so the bot works even if a guildCreate
 * event was missed while offline.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ config: any, services: ReturnType<typeof import('../services/index.js').createServices> }} app
 */
export function buildContext(interaction, app) {
  const { services, config } = app;
  const guildId = services.guilds.ensure(interaction.guildId);
  const settings = services.guilds.getSettings(guildId);
  const actor = actorFromInteraction(interaction, config);
  const access = services.permissions.resolve(actor, settings);
  return { guildId, guildDiscordId: interaction.guildId, settings, actor, access };
}

/** Extracts the permission-relevant facts about the caller from an interaction. */
export function actorFromInteraction(interaction, config) {
  const roles = interaction.member?.roles;
  // Cached members expose a RoleManager; uncached (API) members expose a plain id array.
  const roleIds = Array.isArray(roles) ? roles : roles?.cache ? [...roles.cache.keys()] : [];
  return {
    userId: interaction.user.id,
    roleIds,
    isGuildOwner: interaction.guild?.ownerId === interaction.user.id,
    isDiscordAdmin: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
    isBotOwner: config.discord.ownerIds.includes(interaction.user.id),
  };
}
