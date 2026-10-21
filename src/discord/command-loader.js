import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const COMMANDS_DIR = fileURLToPath(new URL('./commands/', import.meta.url));

/**
 * Loads every `src/discord/commands/*.js`. A command module exports:
 *   data        SlashCommandBuilder
 *   execute     async (interaction, app) => void
 *   autocomplete?  async (interaction, app) => void
 *   guildOnly?  default true
 *   rateLimit?  { limit, windowMs }
 *
 * @returns {Promise<Map<string, any>>}
 */
export async function loadCommands() {
  const commands = new Map();
  for (const file of readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.js'))) {
    const mod = await import(pathToFileURL(join(COMMANDS_DIR, file)).href);
    const cmd = mod.default ?? mod;
    if (!cmd?.data || typeof cmd.execute !== 'function') {
      throw new Error(`Command file ${file} must export { data, execute }`);
    }
    if (commands.has(cmd.data.name)) throw new Error(`Duplicate command name: ${cmd.data.name}`);
    commands.set(cmd.data.name, cmd);
  }
  return commands;
}
