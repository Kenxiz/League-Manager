import { ValidationError, NotFoundError } from '../utils/errors.js';
import { LruCache, assertSnowflake, nowSec } from '../utils/helpers.js';
import { settingsSchema, diffFromDefaults, hydrateSettings, DEFAULT_SETTINGS } from './settings-schema.js';

/**
 * Guild registry + per-guild settings.
 * Every other service resolves Discord guild IDs to internal integer IDs through here.
 */
export class GuildService {
  constructor({ db, codec, clock = nowSec }) {
    this.db = db;
    this.codec = codec;
    this.clock = clock;
    this.idCache = new LruCache(2000); // discord_id -> internal id
    this.settingsCache = new LruCache(500); // internal id -> frozen settings

    this.q = {
      byDiscord: db.prepare('SELECT id, discord_id, left_at FROM guilds WHERE discord_id = ?'),
      insert: db.prepare('INSERT INTO guilds (discord_id, joined_at) VALUES (?, ?)'),
      rejoin: db.prepare('UPDATE guilds SET left_at = NULL WHERE id = ?'),
      left: db.prepare('UPDATE guilds SET left_at = ? WHERE id = ?'),
      getSettings: db.prepare('SELECT settings FROM guilds WHERE id = ?'),
      setSettings: db.prepare('UPDATE guilds SET settings = ? WHERE id = ?'),
      purge: db.prepare('DELETE FROM guilds WHERE id = ?'),
      purgeable: db.prepare('SELECT id, discord_id FROM guilds WHERE left_at IS NOT NULL AND left_at < ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM guilds WHERE left_at IS NULL'),
    };
  }

  /**
   * Returns the internal id for a guild, registering it on first sight (and reactivating it
   * if the bot rejoined). Cheap: hot path is a cache hit.
   * @returns {number}
   */
  ensure(discordId) {
    assertSnowflake(discordId, 'guild ID');
    const cached = this.idCache.get(discordId);
    if (cached) return cached;

    let row = this.q.byDiscord.get(discordId);
    if (!row) {
      const info = this.q.insert.run(discordId, this.clock());
      row = { id: Number(info.lastInsertRowid), left_at: null };
    } else if (row.left_at !== null) {
      this.q.rejoin.run(row.id);
    }
    // Never cache inside an open transaction: if it rolls back, the cached id would dangle.
    if (!this.db.inTransaction) this.idCache.set(discordId, row.id);
    return row.id;
  }

  /** Internal id or NotFoundError; never creates. */
  require(discordId) {
    assertSnowflake(discordId, 'guild ID');
    const cached = this.idCache.get(discordId);
    if (cached) return cached;
    const row = this.q.byDiscord.get(discordId);
    if (!row) throw new NotFoundError('This server is not registered with the bot yet.');
    if (!this.db.inTransaction) this.idCache.set(discordId, row.id);
    return row.id;
  }

  /** Call from the guildDelete event. Data is kept for a grace period (see MaintenanceService). */
  markLeft(discordId) {
    const row = this.q.byDiscord.get(discordId);
    if (!row) return;
    this.q.left.run(this.clock(), row.id);
    this.idCache.delete(discordId);
    this.settingsCache.delete(row.id);
  }

  /** Permanently deletes guilds that left more than `olderThanSec` ago (cascades to all their data). */
  purgeLeft(olderThanSec) {
    const rows = this.q.purgeable.all(this.clock() - olderThanSec);
    for (const r of rows) {
      this.q.purge.run(r.id);
      this.idCache.delete(r.discord_id);
      this.settingsCache.delete(r.id);
    }
    return rows.length;
  }

  activeCount() {
    return this.q.count.get().n;
  }

  /** @returns {import('./settings-schema.js').GuildSettings} frozen, fully-populated settings */
  getSettings(guildId) {
    const hit = this.settingsCache.get(guildId);
    if (hit) return hit;
    const row = this.q.getSettings.get(guildId);
    const settings = hydrateSettings(row?.settings ? this.codec.unpack(row.settings) : null);
    this.settingsCache.set(guildId, settings);
    return settings;
  }

  /**
   * Validates and applies a partial settings update. Only the diff vs defaults is persisted.
   * @returns {{ before: object, after: object }}
   */
  updateSettings(guildId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('Invalid settings.');
    const before = this.getSettings(guildId);
    const parsed = settingsSchema.safeParse({ ...before, ...patch });
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ');
      throw new ValidationError(`Invalid settings — ${msg}`);
    }
    const after = Object.freeze(parsed.data);
    this.#store(guildId, after);
    return { before, after };
  }

  resetSettings(guildId) {
    this.q.setSettings.run(null, guildId);
    this.settingsCache.delete(guildId);
    return DEFAULT_SETTINGS;
  }

  #store(guildId, settings) {
    const diff = diffFromDefaults(settings);
    const blob = Object.keys(diff).length ? this.codec.pack(diff) : null;
    this.q.setSettings.run(blob, guildId);
    this.settingsCache.set(guildId, settings);
  }
}
