import { MessageFlags } from 'discord.js';
import { RateLimiter } from '../utils/helpers.js';
import { AppError, toUserMessage } from '../utils/errors.js';

/**
 * Central interaction pipeline: lookup -> guild-only check -> rate limit -> execute -> error handling.
 * Commands never need their own try/catch: throw an AppError and the user sees its message;
 * anything else is logged and replaced by a generic message.
 */
export function createInteractionHandler({ app, commands }) {
  const { logger } = app;
  // Global per-user burst limit + per-command limit.
  const globalLimiter = new RateLimiter({ limit: 15, windowMs: 10_000 });
  const commandLimiters = new Map();

  const limiterFor = (command) => {
    let l = commandLimiters.get(command.data.name);
    if (!l) {
      const { limit = 5, windowMs = 10_000 } = command.rateLimit ?? {};
      l = new RateLimiter({ limit, windowMs });
      commandLimiters.set(command.data.name, l);
    }
    return l;
  };

  async function reportError(interaction, err, command) {
    if (!(err instanceof AppError) || !err.expose || err.code === 'INTERNAL') {
      logger.error(
        { err, command: command?.data.name, guild: interaction.guildId, user: interaction.user?.id },
        'command failed',
      );
    } else {
      logger.debug({ code: err.code, command: command?.data.name }, 'command rejected');
    }
    const payload = { content: `❌ ${toUserMessage(err)}`, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: payload.content });
      else if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (replyErr) {
      logger.warn({ err: replyErr }, 'could not deliver error message');
    }
  }

  return async function handle(interaction) {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (!command?.autocomplete || (command.guildOnly !== false && !interaction.inGuild())) return;
      try {
        await command.autocomplete(interaction, app);
      } catch (err) {
        logger.warn({ err, command: interaction.commandName }, 'autocomplete failed');
        if (!interaction.responded) await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      if (command.guildOnly !== false && !interaction.inGuild()) {
        await interaction.reply({ content: '❌ This command only works in a server.', flags: MessageFlags.Ephemeral });
        return;
      }
      globalLimiter.consume(interaction.user.id);
      limiterFor(command).consume(interaction.user.id);
      await command.execute(interaction, app);
    } catch (err) {
      await reportError(interaction, err, command);
    }
  };
}
