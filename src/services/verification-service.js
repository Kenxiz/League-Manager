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
    this.challenges = new Map(); // userDiscordId -> { code, robloxUsername, robloxId, expiresAt }

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
    this.challenges.delete(userDiscordId);

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
    this.challenges.delete(userDiscordId);
    return { userDiscordId, unlinked: true };
  }

  // --- Verification Challenge Workflow ---

  createChallenge({ userDiscordId, robloxUsername, robloxId }) {
    const now = this.clock();
    const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
    const code = `LEAGUEBOT-${randomStr}`;
    const expiresAt = now + 900; // 15 minutes

    const challenge = {
      code,
      robloxUsername,
      robloxId: String(robloxId),
      createdAt: now,
      expiresAt,
    };

    this.challenges.set(userDiscordId, challenge);
    return challenge;
  }

  getChallenge(userDiscordId) {
    const challenge = this.challenges.get(userDiscordId);
    if (!challenge) return null;
    if (this.clock() > challenge.expiresAt) {
      this.challenges.delete(userDiscordId);
      return null;
    }
    return challenge;
  }

  async verifyChallenge({ userDiscordId, robloxApi }) {
    const challenge = this.getChallenge(userDiscordId);
    if (!challenge) {
      throw new ValidationError('No active verification challenge found. Please run /verify first to get a code.');
    }

    if (!robloxApi) {
      throw new ValidationError('Roblox API client is not configured.');
    }

    const profile = await robloxApi.getUserById(challenge.robloxId);
    if (!profile) {
      throw new NotFoundError('Could not fetch Roblox profile details.');
    }

    const description = (profile.description || '').toLowerCase();
    const targetCode = challenge.code.toLowerCase();

    if (!description.includes(targetCode)) {
      throw new ValidationError(
        `Verification code not found in Roblox profile. Please paste "${challenge.code}" into your Roblox 'About' section, save your profile, and try again.`,
      );
    }

    // Code matched! Link account permanently
    const link = this.link({
      userDiscordId,
      robloxId: challenge.robloxId,
      robloxUsername: profile.name,
    });

    return {
      link,
      robloxUser: profile,
    };
  }

  /**
   * Checks if a user is verified and optionally checks Roblox Group membership if groupId > 0.
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
