import { AuditAction, EndReason } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { nowSec, sanitizeText } from '../utils/helpers.js';

export class SuspensionService {
  constructor({ db, guilds, users, audit, signings = null, clock = nowSec }) {
    this.db = db;
    this.guilds = guilds;
    this.users = users;
    this.audit = audit;
    this.signings = signings;
    this.clock = clock;

    this.q = {
      insert: db.prepare(`
        INSERT INTO suspensions (
          guild_id, user_id, reason, bail_robux, bail_dollars, suspended_at, by_user_id, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `),
      deactivateActive: db.prepare(`
        UPDATE suspensions
        SET active = 0, unsuspended_at = ?, unby_user_id = ?
        WHERE guild_id = ? AND user_id = ? AND active = 1
      `),
      getActive: db.prepare(`
        SELECT s.id, s.reason, s.bail_robux, s.bail_dollars, s.suspended_at, s.active,
               u.discord_id AS user_discord_id,
               bu.discord_id AS by_discord_id
        FROM suspensions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN users bu ON bu.id = s.by_user_id
        WHERE s.guild_id = ? AND s.user_id = ? AND s.active = 1
        ORDER BY s.id DESC LIMIT 1
      `),
      isSuspended: db.prepare(`
        SELECT 1 FROM suspensions WHERE guild_id = ? AND user_id = ? AND active = 1 LIMIT 1
      `),
      list: db.prepare(`
        SELECT s.id, s.reason, s.bail_robux, s.bail_dollars, s.suspended_at, s.unsuspended_at, s.active,
               u.discord_id AS user_discord_id,
               bu.discord_id AS by_discord_id,
               ubu.discord_id AS unby_discord_id
        FROM suspensions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN users bu ON bu.id = s.by_user_id
        LEFT JOIN users ubu ON ubu.id = s.unby_user_id
        WHERE s.guild_id = ? AND (? = 0 OR s.active = 1)
        ORDER BY s.suspended_at DESC
      `),
    };
  }

  isSuspended(guildId, userId) {
    return Boolean(this.q.isSuspended.get(guildId, userId));
  }

  getActiveSuspension(guildDiscordId, userDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const row = this.q.getActive.get(guildId, userId);
    if (!row) return null;
    return {
      id: row.id,
      userDiscordId: row.user_discord_id,
      byDiscordId: row.by_discord_id,
      reason: row.reason,
      bailRobux: row.bail_robux,
      bailDollars: row.bail_dollars,
      suspendedAt: row.suspended_at,
      active: Boolean(row.active),
    };
  }

  suspend({
    guildDiscordId,
    userDiscordId,
    reason,
    bailRobux = 0,
    bailDollars = 0,
    actorDiscordId = null,
  }) {
    const cleanReason = reason ? sanitizeText(reason, { max: 500, label: 'Suspension reason' }) : '';
    if (!cleanReason || cleanReason.trim().length === 0) {
      throw new ValidationError('A reason for the suspension is required.');
    }

    const robux = Number(bailRobux ?? 0);
    if (isNaN(robux) || robux < 0 || !Number.isInteger(robux)) {
      throw new ValidationError('Bail in Robux must be a non-negative whole integer.');
    }

    const dollars = Number(bailDollars ?? 0);
    if (isNaN(dollars) || dollars < 0) {
      throw new ValidationError('Bail in Dollars must be a non-negative number.');
    }
    const cleanDollars = Math.round(dollars * 100) / 100;

    const guildId = this.guilds.ensure(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const now = this.clock();

    let suspensionId;
    this.db.transaction(() => {
      // Deactivate any currently active suspension for this user in this guild
      this.q.deactivateActive.run(now, actorId, guildId, userId);

      const info = this.q.insert.run(
        guildId,
        userId,
        cleanReason,
        robux,
        cleanDollars,
        now,
        actorId,
      );
      suspensionId = Number(info.lastInsertRowid);

      // Audit log the suspension
      this.audit.record({
        guildId,
        action: AuditAction.USER_SUSPEND,
        actorId,
        targetId: userId,
        data: {
          suspensionId,
          reason: cleanReason,
          bailRobux: robux,
          bailDollars: cleanDollars,
        },
      });
    })();

    return {
      id: suspensionId,
      guildDiscordId,
      userDiscordId,
      actorDiscordId,
      reason: cleanReason,
      bailRobux: robux,
      bailDollars: cleanDollars,
      suspendedAt: now,
      active: true,
    };
  }

  unsuspend({ guildDiscordId, userDiscordId, actorDiscordId = null, reason = null }) {
    const guildId = this.guilds.require(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const now = this.clock();

    const active = this.q.getActive.get(guildId, userId);
    if (!active) {
      throw new NotFoundError('That user does not have an active suspension in this server.');
    }

    const cleanReason = reason ? sanitizeText(reason, { max: 250, label: 'Unsuspend reason' }) : null;

    this.db.transaction(() => {
      this.q.deactivateActive.run(now, actorId, guildId, userId);

      this.audit.record({
        guildId,
        action: AuditAction.USER_UNSUSPEND,
        actorId,
        targetId: userId,
        data: {
          suspensionId: active.id,
          reason: cleanReason,
        },
      });
    })();

    return {
      userDiscordId,
      unsuspended: true,
      unsuspendedAt: now,
      actorDiscordId,
    };
  }

  listSuspensions(guildDiscordId, { activeOnly = true } = {}) {
    const guildId = this.guilds.require(guildDiscordId);
    const rows = this.q.list.all(guildId, activeOnly ? 1 : 0);
    return rows.map((r) => ({
      id: r.id,
      userDiscordId: r.user_discord_id,
      byDiscordId: r.by_discord_id,
      unbyDiscordId: r.unby_discord_id,
      reason: r.reason,
      bailRobux: r.bail_robux,
      bailDollars: r.bail_dollars,
      suspendedAt: r.suspended_at,
      unsuspendedAt: r.unsuspended_at,
      active: Boolean(r.active),
    }));
  }
}
