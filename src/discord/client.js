import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

/**
 * Discord client with the smallest privilege/footprint that works:
 *  - Only the Guilds intent (slash commands need nothing else; no privileged intents).
 *  - Mentions are disabled by default so user-supplied text can never ping @everyone/roles.
 *  - Caches that we never read (members, messages, presences...) are zeroed to keep RAM flat
 *    across many guilds.
 */
export function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      GuildMemberManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildMessageManager: 0,
      ThreadManager: 0,
      VoiceStateManager: 0,
      GuildScheduledEventManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
      StageInstanceManager: 0,
      GuildBanManager: 0,
      GuildInviteManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      users: { interval: 3600, filter: () => (user) => user.id !== user.client.user?.id },
    },
  });
}
