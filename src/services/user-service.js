import { LruCache, assertSnowflake } from '../utils/helpers.js';

/** Maps Discord user IDs to compact internal integer IDs (created on first sight). */
export class UserService {
  constructor({ db }) {
    this.db = db;
    this.cache = new LruCache(5000);
    this.q = {
      byDiscord: db.prepare('SELECT id FROM users WHERE discord_id = ?'),
      insert: db.prepare('INSERT INTO users (discord_id) VALUES (?)'),
      byId: db.prepare('SELECT discord_id FROM users WHERE id = ?'),
    };
  }

  /** @returns {number} internal user id */
  ensure(discordId) {
    assertSnowflake(discordId, 'user ID');
    const cached = this.cache.get(discordId);
    if (cached) return cached;
    const row = this.q.byDiscord.get(discordId);
    const id = row ? row.id : Number(this.q.insert.run(discordId).lastInsertRowid);
    // Never cache inside an open transaction: if it rolls back, the cached id would dangle.
    if (!this.db.inTransaction) this.cache.set(discordId, id);
    return id;
  }

  /** @returns {string|null} Discord id for an internal id */
  discordId(id) {
    return id == null ? null : this.q.byId.get(id)?.discord_id ?? null;
  }
}
