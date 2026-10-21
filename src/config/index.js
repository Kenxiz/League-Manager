import { z } from 'zod';
import { resolve } from 'node:path';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake ID');

const emptyToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optional = (schema) => z.preprocess(emptyToUndefined, schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN looks invalid'),
  DISCORD_CLIENT_ID: snowflake,
  DEV_GUILD_ID: optional(snowflake),
  BOT_OWNER_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(snowflake)),
  DATABASE_PATH: z.string().min(1).default('./data/leaguebot.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  COMPRESSION_LEVEL: z.coerce.number().int().min(0).max(11).default(5),
  ROBLOX_THUMBNAILS_BASE: z.string().url().default('https://thumbnails.roblox.com/v1'),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  API_KEY: optional(z.string().min(8)),
});

/**
 * Validates environment variables once and returns a frozen, typed config object.
 * Throws a readable error listing every problem (never the offending secret values).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ requireDiscord?: boolean }} [opts] set requireDiscord=false for scripts/tests that never talk to Discord
 */
export function loadConfig(env = process.env, { requireDiscord = true } = {}) {
  const effective = requireDiscord
    ? env
    : {
        ...env,
        DISCORD_TOKEN: env.DISCORD_TOKEN || 'x'.repeat(60),
        DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID || '0'.repeat(18),
      };

  const parsed = schema.safeParse(effective);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return Object.freeze({
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    discord: Object.freeze({
      token: e.DISCORD_TOKEN,
      clientId: e.DISCORD_CLIENT_ID,
      devGuildId: e.DEV_GUILD_ID,
      ownerIds: Object.freeze(e.BOT_OWNER_IDS),
    }),
    database: Object.freeze({ path: resolve(e.DATABASE_PATH) }),
    logLevel: e.LOG_LEVEL,
    auditRetentionDays: e.AUDIT_RETENTION_DAYS,
    compressionLevel: e.COMPRESSION_LEVEL,
    http: Object.freeze({
      timeoutMs: e.HTTP_TIMEOUT_MS,
      maxRetries: e.HTTP_MAX_RETRIES,
      robloxThumbnailsBase: e.ROBLOX_THUMBNAILS_BASE.replace(/\/+$/, ''),
    }),
    api: Object.freeze({
      port: e.API_PORT,
      apiKey: e.API_KEY,
    }),
  });
}

export { snowflake as snowflakeSchema };
