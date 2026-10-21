import { ExternalServiceError } from '../utils/errors.js';

/**
 * Client for official Roblox Web APIs:
 * - Users API (users.roblox.com): username to ID resolution, profile details, and description.
 * - Thumbnails API (thumbnails.roblox.com): player avatar headshots.
 * - Groups API (groups.roblox.com): group membership and ranks.
 */
export class RobloxApi {
  /**
   * @param {{ http: import('./http-client.js').HttpClient, logger?: any }} opts
   */
  constructor({ http, logger }) {
    this.http = http;
    this.logger = logger;
  }

  /**
   * Resolves a Roblox username to user profile data.
   * @param {string} username
   * @returns {Promise<{ id: number, name: string, displayName: string } | null>}
   */
  async getUserByUsername(username) {
    if (!username || typeof username !== 'string') return null;
    const clean = username.trim();
    if (!clean) return null;

    try {
      const res = await this.http.postJson('https://users.roblox.com/v1/usernames/users', {
        usernames: [clean],
        excludeBannedUsers: false,
      });

      if (res?.data && res.data.length > 0) {
        const u = res.data[0];
        return {
          id: Number(u.id),
          name: u.name,
          displayName: u.displayName || u.name,
        };
      }
      return null;
    } catch (err) {
      this.logger?.warn({ err, username: clean }, 'roblox getUserByUsername failed');
      throw err;
    }
  }

  /**
   * Fetches full Roblox user profile details including description (About Me).
   * @param {number|string} userId
   * @returns {Promise<{ id: number, name: string, displayName: string, description: string, created: string, isBanned: boolean } | null>}
   */
  async getUserById(userId) {
    if (!userId) return null;
    const cleanId = String(userId).trim();
    if (!/^\d+$/.test(cleanId)) return null;

    try {
      const res = await this.http.getJson(`https://users.roblox.com/v1/users/${cleanId}`);
      if (res && res.id) {
        return {
          id: Number(res.id),
          name: res.name,
          displayName: res.displayName || res.name,
          description: res.description || '',
          created: res.created || null,
          isBanned: Boolean(res.isBanned),
        };
      }
      return null;
    } catch (err) {
      if (err instanceof ExternalServiceError && err.cause?.message?.includes('404')) {
        return null;
      }
      this.logger?.warn({ err, userId: cleanId }, 'roblox getUserById failed');
      throw err;
    }
  }

  /**
   * Fetches the avatar headshot image URL for a user.
   * @param {number|string} userId
   * @param {string} size e.g. '150x150', '420x420'
   * @returns {Promise<string | null>}
   */
  async getUserHeadshot(userId, size = '150x150') {
    if (!userId) return null;
    const cleanId = String(userId).trim();
    if (!/^\d+$/.test(cleanId)) return null;

    try {
      const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${cleanId}&size=${size}&format=Png&isCircular=false`;
      const res = await this.http.getJson(url);
      if (res?.data && res.data.length > 0 && res.data[0].state === 'Completed') {
        return res.data[0].imageUrl || null;
      }
      return null;
    } catch (err) {
      this.logger?.warn({ err, userId: cleanId }, 'roblox getUserHeadshot failed');
      return null;
    }
  }

  /**
   * Fetches group memberships and roles for a user.
   * @param {number|string} userId
   * @returns {Promise<Array<{ group: { id: number, name: string }, role: { id: number, name: string, rank: number } }>>}
   */
  async getUserGroups(userId) {
    if (!userId) return [];
    const cleanId = String(userId).trim();
    if (!/^\d+$/.test(cleanId)) return [];

    try {
      const url = `https://groups.roblox.com/v1/users/${cleanId}/groups/roles`;
      const res = await this.http.getJson(url);
      return Array.isArray(res?.data) ? res.data : [];
    } catch (err) {
      this.logger?.warn({ err, userId: cleanId }, 'roblox getUserGroups failed');
      return [];
    }
  }
}
