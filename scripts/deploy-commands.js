import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/index.js';
import { loadCommands } from '../src/discord/command-loader.js';

/**
 * Registers slash commands. With DEV_GUILD_ID set they go to that guild only (instant);
 * otherwise globally (can take up to an hour to propagate).
 */
const config = loadConfig();
const commands = await loadCommands();
const body = [...commands.values()].map((c) => c.data.toJSON());

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const { clientId, devGuildId } = config.discord;
const route = devGuildId ? Routes.applicationGuildCommands(clientId, devGuildId) : Routes.applicationCommands(clientId);

await rest.put(route, { body });
console.log(`Deployed ${body.length} command(s) ${devGuildId ? `to guild ${devGuildId}` : 'globally'}.`);
