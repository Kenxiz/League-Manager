import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createServices } from '../src/services/index.js';

/** Usage: npm run maintenance [-- --backup] */
const config = loadConfig(process.env, { requireDiscord: false });
const logger = createLogger({ level: 'info', pretty: true });
const services = createServices({ config, logger });

console.log('before:', services.maintenance.stats());
console.log('result:', services.maintenance.run());
if (process.argv.includes('--backup')) console.log('backup:', await services.maintenance.backup());
console.log('after: ', services.maintenance.stats());
services.close();
