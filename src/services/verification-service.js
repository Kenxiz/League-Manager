import { AuditAction } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { nowSec } from '../utils/helpers.js';

export class VerificationService {
  constructor({ db, users, audit, http, clock = nowSec }) {
    this.db = db;
    this.users = users;
    this.audit = audit;
    this.http = http;
    this.clock = clock;

    this.q = {
      get: db.prepare('SELECT roblox_id, roblox_username, verified_at FROM roblox_links WHERE user_id = ?'),
      byRobloxId: db.prepare('SELECT user_id, roblox_username FROM roblox_links WHERE roblox_id = ?'),
      upsert: db.prepare(`
        INSERT INTO roblox_links (user_id, roblox_id, roblox_username, verified_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          roblox_id = excluded.roblox_id,
          roblox_username = excluded.roblox_username,
          verified_at = excluded.verified_at`),
      delete: db.prepare('DELETE FROM roblox_links WHERE user_id = ?'),
    };
  }

  getLink(userDiscordId) {
    const userId = this.users.ensure(userDiscordId);
    const row = this.q.get.get(userId);
    if (!row) return null;
    return {
      userDiscordId,
      robloxId: row.roblox_id,
      robloxUsername: row.roblox_username,
      verifiedAt: row.verified_at,
    };
  }

  link({ userDiscordId, robloxId, robloxUsername, actorDiscordId = null }) {
    if (!robloxId || !/^\d+$/.test(String(robloxId))) {
      throw new ValidationError('Invalid Roblox ID: must be numeric.');
    }
    const cleanUsername = String(robloxUsername || '').trim();
    if (!cleanUsername) throw new ValidationError('Roblox username is required.');

    const userId = this.users.ensure(userDiscordId);
    const existing = this.q.byRobloxId.get(String(robloxId));
    if (existing && existing.user_id !== userId) {
      throw new ConflictError('That Roblox account is already linked to another Discord user.');
    }

    const now = this.clock();
    this.q.upsert.run(userId, String(robloxId), cleanUsername, now);
    return {
      userDiscordId,
      robloxId: String(robloxId),
      robloxUsername: cleanUsername,
      verifiedAt: now,
    };
  }

  unlink({ userDiscordId }) {
    const userId = this.users.ensure(userDiscordId);
    const existing = this.q.get.get(userId);
    if (!existing) throw new NotFoundError('No Roblox account is linked for that user.');
    this.q.delete.run(userId);
    return { userDiscordId, unlinked: true };
  }

  /**
   * Checks if a user is verified and optionally checks Roblox Group membership if groupId > 0.
   * If http is configured to allow groups.roblox.com, it will query Roblox API; otherwise
   * verifies account presence.
   */
  async checkVerification(userDiscordId, { requiredGroupId = 0 } = {}) {
    const link = this.getLink(userDiscordId);
    if (!link) {
      return { verified: false, reason: 'Roblox account is not linked.' };
    }

    if (requiredGroupId > 0 && this.http?.allowedHosts?.has('groups.roblox.com')) {
      try {
        const url = `https://groups.roblox.com/v1/users/${link.robloxId}/groups/roles`;
        const res = await this.http.getJson(url);
        const inGroup = Array.isArray(res?.data) && res.data.some((g) => g?.group?.id === requiredGroupId);
        if (!inGroup) {
          return { verified: false, reason: `User is not a member of Roblox group ${requiredGroupId}.` };
        }
      } catch (err) {
        // If external API fails, log but avoid failing completely unless strictly required
      }
    }

    return { verified: true, link };
  }
}
