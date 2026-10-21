import { LruCache } from '../utils/helpers.js';

const TTL_MS = 60 * 60 * 1000;
const NEG_TTL_MS = 5 * 60 * 1000; // retry failed/pending thumbnails sooner
const BATCH = 100;
const SIZES = new Set(['30x30', '42x42', '50x50', '60x62', '75x75', '110x110', '150x150', '160x100', '160x600', '250x250', '256x144', '300x250', '304x166', '384x216', '396x216', '420x420', '480x270', '512x512', '576x324', '700x700', '728x90', '768x432']);

/**
 * Turns Roblox asset ids (the team logos in the catalog) into image URLs Discord embeds can show.
 * Results are cached in memory (bounded LRU + TTL); concurrent lookups are batched per call.
 */
export class RobloxThumbnails {
  constructor({ http, baseUrl = 'https://thumbnails.roblox.com/v1', logger }) {
    this.http = http;
    this.baseUrl = baseUrl;
    this.logger = logger;
    this.cache = new LruCache(2000);
  }

  /**
   * @param {number[]} assetIds
   * @param {{ size?: string }} [opts]
   * @returns {Promise<Map<number, string|null>>} id -> image URL (null if unavailable)
   */
  async assets(assetIds, { size = '150x150' } = {}) {
    if (!SIZES.has(size)) throw new RangeError(`Unsupported thumbnail size: ${size}`);
    const ids = [...new Set(assetIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
    const out = new Map();
    const missing = [];
    const now = Date.now();
    for (const id of ids) {
      const hit = this.cache.get(`${size}:${id}`);
      if (hit && hit.expires > now) out.set(id, hit.url);
      else missing.push(id);
    }

    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const url = `${this.baseUrl}/assets?assetIds=${chunk.join(',')}&size=${size}&format=Png&returnPolicy=PlaceHolder`;
      const body = await this.http.getJson(url);
      const byId = new Map((body?.data ?? []).map((d) => [d.targetId, d]));
      for (const id of chunk) {
        const d = byId.get(id);
        const ok = d?.state === 'Completed' && typeof d.imageUrl === 'string';
        const imageUrl = ok ? d.imageUrl : null;
        this.cache.set(`${size}:${id}`, { url: imageUrl, expires: Date.now() + (ok ? TTL_MS : NEG_TTL_MS) });
        out.set(id, imageUrl);
      }
    }
    return out;
  }

  /** Primary logo URL for a catalog team (or null). */
  async teamLogo(team, opts) {
    const id = team.roblox.logo1 || team.roblox.logo2;
    if (!id) return null;
    return (await this.assets([id], opts)).get(id) ?? null;
  }
}
