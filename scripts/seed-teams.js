import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createServices } from '../src/services/index.js';

// createServices already seeds data/teams.json (idempotent); this script just does it on demand.
const config = loadConfig(process.env, { requireDiscord: false });
const logger = createLogger({ level: 'info', pretty: true });
const services = createServices({ config, logger, seedTeams: true });
console.log(`Team catalog: ${services.teams.count()} teams, ${services.teams.conferences().length} conferences.`);
services.close();
