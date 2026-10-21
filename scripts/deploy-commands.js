import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config/index.js';
import { loadCommands } from '../src/discord/command-loader.js';

/**
 * Registers slash commands with Discord.
 * Clears existing commands first to ensure no stale/duplicate commands remain,
 * then redeploys the fresh command definitions.
 *
 * If DEV_GUILD_ID is set:
 *   - Clears existing guild commands AND global commands (prevents duplicate command ghosting).
 *   - Instantly redeploys to DEV_GUILD_ID.
 * Otherwise:
 *   - Clears and redeploys globally.
 *
 * Usage:
 *   npm run deploy          (clears and redeploys)
 *   node scripts/deploy-commands.js --clear-only  (clears all commands)
 */
const config = loadConfig();
const commands = await loadCommands();
const body = [...commands.values()].map((c) => c.data.toJSON());

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const { clientId, devGuildId } = config.discord;
const clearOnly = process.argv.includes('--clear') || process.argv.includes('--clear-only');

console.log(`Connecting to Discord API as Client ID ${clientId}...`);

if (devGuildId) {
  console.log(`Clearing commands in dev guild ${devGuildId} and global scope...`);
  await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body: [] });
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log('Successfully cleared all guild and global commands.');

  if (!clearOnly) {
    console.log(`Deploying ${body.length} command(s) to dev guild ${devGuildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    console.log(`Successfully redeployed ${body.length} command(s) to guild ${devGuildId} (instant).`);
  }
} else {
  console.log('Clearing all global commands...');
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log('Successfully cleared all global commands.');

  if (!clearOnly) {
    console.log(`Deploying ${body.length} command(s) globally...`);
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`Successfully redeployed ${body.length} command(s) globally.`);
  }
}
