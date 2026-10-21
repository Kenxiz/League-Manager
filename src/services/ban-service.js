import { AuditAction } from '../utils/constants.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { nowSec, sanitizeText } from '../utils/helpers.js';

export class BanService {
  constructor({ db, guilds, users, audit, clock = nowSec }) {
    this.db = db;
    this.guilds = guilds;
    this.users = users;
    this.audit = audit;
    this.clock = clock;

    this.q = {
      insert: db.prepare(`
        INSERT INTO league_bans (guild_id, user_id, reason, banned_at, expires_at, by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          reason = excluded.reason,
          banned_at = excluded.banned_at,
          expires_at = excluded.expires_at,
          by_user_id = excluded.by_user_id`),
      delete: db.prepare('DELETE FROM league_bans WHERE guild_id = ? AND user_id = ?'),
      get: db.prepare('SELECT id, reason, banned_at, expires_at, by_user_id FROM league_bans WHERE guild_id = ? AND user_id = ?'),
      list: db.prepare(`
        SELECT b.id, b.reason, b.banned_at, b.expires_at,
               u.discord_id AS user_discord_id,
               bu.discord_id AS by_discord_id
        FROM league_bans b
        JOIN users u ON u.id = b.user_id
        LEFT JOIN users bu ON bu.id = b.by_user_id
        WHERE b.guild_id = ? AND (b.expires_at IS NULL OR b.expires_at > ?)
        ORDER BY b.banned_at DESC`),
      deleteExpired: db.prepare('DELETE FROM league_bans WHERE expires_at IS NOT NULL AND expires_at <= ?'),
    };
  }

  isBanned(guildId, userId) {
    const row = this.q.get.get(guildId, userId);
    if (!row) return false;
    const now = this.clock();
    if (row.expires_at !== null && row.expires_at <= now) {
      this.q.delete.run(guildId, userId);
      return false;
    }
    return true;
  }

  ban({ guildDiscordId, userDiscordId, reason = null, durationHours = null, actorDiscordId = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const now = this.clock();
    const cleanReason = reason ? sanitizeText(reason, { max: 250, label: 'Ban reason' }) : null;
    const expiresAt = durationHours && durationHours > 0 ? now + Math.round(durationHours * 3600) : null;

    this.db.transaction(() => {
      this.q.insert.run(guildId, userId, cleanReason, now, expiresAt, actorId);
      this.audit.record({
        guildId,
        action: AuditAction.USER_BAN,
        actorId,
        targetId: userId,
        data: { reason: cleanReason, expiresAt },
      });
    })();

    return {
      userDiscordId,
      reason: cleanReason,
      bannedAt: now,
      expiresAt,
    };
  }

  unban({ guildDiscordId, userDiscordId, actorDiscordId = null }) {
    const guildId = this.guilds.require(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;

    const row = this.q.get.get(guildId, userId);
    if (!row) throw new NotFoundError('That user is not currently banned.');

    this.db.transaction(() => {
      this.q.delete.run(guildId, userId);
      this.audit.record({
        guildId,
        action: AuditAction.USER_UNBAN,
        actorId,
        targetId: userId,
      });
    })();

    return { userDiscordId, unbanned: true };
  }

  listBans(guildDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    const now = this.clock();
    return this.q.list.all(guildId, now).map((r) => ({
      id: r.id,
      userDiscordId: r.user_discord_id,
      byDiscordId: r.by_discord_id,
      reason: r.reason,
      bannedAt: r.banned_at,
      expiresAt: r.expires_at,
    }));
  }

  pruneExpired() {
    return this.q.deleteExpired.run(this.clock()).changes;
  }
}
