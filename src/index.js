import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { createServices } from './services/index.js';
import { createIntegrations } from './integrations/index.js';
import { createClient } from './discord/client.js';
import { loadCommands } from './discord/command-loader.js';
import { createInteractionHandler } from './discord/interaction-handler.js';
import { createEvents } from './discord/events.js';
import { createApiServer } from './api/server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProd });
  logger.info({ env: config.env }, 'starting leaguebot');

  const services = createServices({ config, logger });
  const integrations = createIntegrations({ config, logger });
  const commands = await loadCommands();
  const client = createClient();
  const api = createApiServer({ services, config, logger });

  /** Shared application context handed to every command/event. */
  const app = { config, logger, services, integrations, client, commands, api };

  const handleInteraction = createInteractionHandler({ app, commands });
  for (const ev of createEvents({ app, handleInteraction })) {
    client[ev.once ? 'once' : 'on'](ev.name, (...args) => {
      try {
        const r = ev.execute(...args);
        if (r?.catch) r.catch((err) => logger.error({ err, event: ev.name }, 'event handler failed'));
      } catch (err) {
        logger.error({ err, event: ev.name }, 'event handler failed');
      }
    });
  }

  // Housekeeping: once at boot (after a short delay) and then daily.
  const runMaintenance = () => {
    try {
      services.maintenance.run();
    } catch (err) {
      logger.error({ err }, 'maintenance failed');
    }
  };
  const boot = setTimeout(runMaintenance, 30_000);
  const daily = setInterval(runMaintenance, DAY_MS);
  boot.unref();
  daily.unref();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(daily);
    clearTimeout(boot);
    try {
      await api.close();
      await client.destroy();
      services.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });

  await api.listen(config.api.port);
  await client.login(config.discord.token);
}

main().catch((err) => {
  // Config errors list problems without echoing secret values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
