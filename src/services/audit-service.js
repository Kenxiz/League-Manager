import { AuditActionName } from '../utils/constants.js';
import { nowSec } from '../utils/helpers.js';

/** Append-only action log per guild. Extra detail is stored as a compressed blob only when provided. */
export class AuditService {
  constructor({ db, codec, clock = nowSec }) {
    this.codec = codec;
    this.clock = clock;
    this.q = {
      insert: db.prepare(`
        INSERT INTO audit_log (guild_id, ts, action, actor_user_id, target_user_id, team_id, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      list: db.prepare(`
        SELECT a.id, a.ts, a.action, a.team_id, a.data,
               au.discord_id AS actor, tu.discord_id AS target
        FROM audit_log a
        LEFT JOIN users au ON au.id = a.actor_user_id
        LEFT JOIN users tu ON tu.id = a.target_user_id
        WHERE a.guild_id = ? AND (? IS NULL OR a.id < ?)
        ORDER BY a.id DESC LIMIT ?`),
      prune: db.prepare('DELETE FROM audit_log WHERE ts < ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE guild_id = ?'),
    };
  }

  /** All ids are INTERNAL ids. `data` is any JSON-serialisable detail. */
  record({ guildId, action, actorId = null, targetId = null, teamId = null, data = null }) {
    this.q.insert.run(
      guildId,
      this.clock(),
      action,
      actorId,
      targetId,
      teamId,
      data == null ? null : this.codec.pack(data),
    );
  }

  /** Newest first. Pass the last seen `id` as `before` to page. */
  list(guildId, { limit = 25, before = null } = {}) {
    const rows = this.q.list.all(guildId, before, before, Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({
      id: r.id,
      at: r.ts,
      action: AuditActionName[r.action] ?? `unknown_${r.action}`,
      actorDiscordId: r.actor,
      targetDiscordId: r.target,
      teamId: r.team_id,
      data: this.codec.unpack(r.data),
    }));
  }

  count(guildId) {
    return this.q.count.get(guildId).n;
  }

  /** Deletes entries older than `days`. 0 = keep forever. @returns {number} rows deleted */
  prune(days) {
    if (!days) return 0;
    return this.q.prune.run(this.clock() - days * 86400).changes;
  }
}
