import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createServices } from '../src/services/index.js';

const config = loadConfig(process.env, { requireDiscord: false });
const logger = createLogger({ level: 'info', pretty: true });
const services = createServices({ config, logger, seedTeams: false });
console.log(`Schema is up to date (user_version=${services.db.pragma('user_version', { simple: true })}).`);
services.close();
