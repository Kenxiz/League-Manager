import { ExternalServiceError } from '../utils/errors.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hardened JSON HTTP client for external APIs: HTTPS-only, host allowlist, hard timeout,
 * exponential backoff with jitter (honours Retry-After), and a response size cap.
 * Failures surface as ExternalServiceError (safe to show) with the real cause attached for logs.
 */
export class HttpClient {
  /**
   * @param {{ allowedHosts: string[], timeoutMs?: number, maxRetries?: number, logger?: any, fetchImpl?: typeof fetch, userAgent?: string }} opts
   */
  constructor({ allowedHosts, timeoutMs = 10_000, maxRetries = 3, logger, fetchImpl = fetch, userAgent = 'leaguemanager/0.1' }) {
    this.allowedHosts = new Set(allowedHosts);
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.userAgent = userAgent;
  }

  /** @returns {Promise<any>} parsed JSON body */
  async getJson(url, { headers = {} } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new ExternalServiceError('Refusing non-HTTPS request.', { code: 'EXTERNAL_BLOCKED' });
    if (!this.allowedHosts.has(u.hostname)) {
      throw new ExternalServiceError('Refusing request to a host that is not allow-listed.', { code: 'EXTERNAL_BLOCKED' });
    }

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetch(u, {
          headers: { accept: 'application/json', 'user-agent': this.userAgent, ...headers },
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
        if (res.ok) return await this.#readJson(res);
        lastErr = new Error(`HTTP ${res.status} from ${u.hostname}`);
        if (!RETRYABLE.has(res.status)) break;
        if (attempt < this.maxRetries) await sleep(this.#backoff(attempt, res.headers.get('retry-after')));
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) await sleep(this.#backoff(attempt));
      }
    }
    this.logger?.warn({ err: lastErr, host: u.hostname }, 'external request failed');
    throw new ExternalServiceError(undefined, { cause: lastErr });
  }

  /** @returns {Promise<any>} parsed JSON body for POST request */
  async postJson(url, body, { headers = {} } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new ExternalServiceError('Refusing non-HTTPS request.', { code: 'EXTERNAL_BLOCKED' });
    if (!this.allowedHosts.has(u.hostname)) {
      throw new ExternalServiceError('Refusing request to a host that is not allow-listed.', { code: 'EXTERNAL_BLOCKED' });
    }

    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetch(u, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': this.userAgent,
            ...headers,
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
        if (res.ok) return await this.#readJson(res);
        lastErr = new Error(`HTTP ${res.status} from ${u.hostname}`);
        if (!RETRYABLE.has(res.status)) break;
        if (attempt < this.maxRetries) await sleep(this.#backoff(attempt, res.headers.get('retry-after')));
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) await sleep(this.#backoff(attempt));
      }
    }
    this.logger?.warn({ err: lastErr, host: u.hostname }, 'external POST request failed');
    throw new ExternalServiceError(undefined, { cause: lastErr });
  }

  async #readJson(res) {
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) throw new Error('response too large');
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
    return JSON.parse(text);
  }

  #backoff(attempt, retryAfter) {
    const header = Number(retryAfter);
    if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 15_000);
    return Math.min(250 * 2 ** attempt, 8_000) * (0.5 + Math.random() / 2);
  }
}
