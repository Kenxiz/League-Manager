import { Events } from 'discord.js';

/**
 * Gateway event handlers. Each: { name, once?, execute(app, ...args) }.
 * Keep them thin; real work belongs in services.
 */
export function createEvents({ app, handleInteraction }) {
  const { logger, services } = app;
  return [
    {
      name: Events.ClientReady,
      once: true,
      execute(client) {
        // Register every guild we're in (covers invites received while offline).
        for (const guild of client.guilds.cache.values()) services.guilds.ensure(guild.id);
        logger.info({ user: client.user.tag, guilds: client.guilds.cache.size }, 'bot ready');
      },
    },
    {
      name: Events.GuildCreate,
      execute(guild) {
        services.guilds.ensure(guild.id);
        logger.info({ guild: guild.id, members: guild.memberCount }, 'joined guild');
      },
    },
    {
      name: Events.GuildDelete,
      execute(guild) {
        if (guild.available === false) return; // outage, not a kick
        services.guilds.markLeft(guild.id);
        logger.info({ guild: guild.id }, 'left guild (data kept for grace period)');
      },
    },
    {
      name: Events.GuildMemberAdd,
      async execute(member) {
        if (!member?.guild || member.user?.bot) return;
        try {
          const guildId = services.guilds.ensure(member.guild.id);
          const settings = services.guilds.getSettings(guildId);
          const roleId = settings.freeAgentRoleId;
          if (roleId) {
            await member.roles.add(roleId, 'Automatic setup: assign Free Agent role on join');
            logger.debug({ user: member.id, guild: member.guild.id }, 'assigned Free Agent role on join');
          }
        } catch (err) {
          logger.warn({ err, userId: member.id, guild: member.guild.id }, 'could not assign Free Agent role on join');
        }
      },
    },
    { name: Events.InteractionCreate, execute: handleInteraction },

    { name: Events.Error, execute: (err) => logger.error({ err }, 'discord client error') },
    { name: Events.Warn, execute: (msg) => logger.warn(msg) },
  ];
}
