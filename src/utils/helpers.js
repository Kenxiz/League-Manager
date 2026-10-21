import { ValidationError, RateLimitError } from './errors.js';

/** Unix time in whole seconds (all timestamps are stored this way: 4-5 bytes vs 8+ for ms/ISO text). */
export const nowSec = () => Math.floor(Date.now() / 1000);

const SNOWFLAKE = /^\d{17,20}$/;

export function assertSnowflake(value, label = 'ID') {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw new ValidationError(`Invalid ${label}.`);
  return value;
}

export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/**
 * Cleans user-supplied free text: strips control/zero-width/bidi characters, collapses
 * whitespace, defuses @everyone/@here, and enforces a length cap.
 */
export function sanitizeText(input, { max = 100, label = 'Text', allowEmpty = false } = {}) {
  if (typeof input !== 'string') throw new ValidationError(`${label} must be text.`);
  let s = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/@(everyone|here)/gi, '@\u200b$1');
  if (!allowEmpty && s.length === 0) throw new ValidationError(`${label} cannot be empty.`);
  if (s.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return s;
}

/** Normalises text for case/diacritic-insensitive matching (team search). */
export function normalizeForSearch(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "#aabbcc" <-> 0xaabbcc (24-bit ints are what Discord embeds want, and take 3 bytes in SQLite). */
export const hexToInt = (hex) => parseInt(String(hex).replace('#', ''), 16);
export const intToHex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

/**
 * In-memory fixed-window limiter keyed by string (e.g. `${userId}:${command}`).
 * Memory is bounded: expired keys are swept periodically.
 */
export class RateLimiter {
  /** @param {{ limit: number, windowMs: number, maxKeys?: number }} opts */
  constructor({ limit, windowMs, maxKeys = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.hits = new Map();
  }

  /** Throws RateLimitError when the key is over its limit. */
  consume(key, now = Date.now()) {
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    if (e.count >= this.limit) throw new RateLimitError(e.resetAt - now);
    e.count++;
  }

  sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Hard cap in the pathological case where nothing has expired.
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

/** Small bounded LRU used for hot lookups (guild settings, id maps). */
export class LruCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

/**
 * Parses natural or numeric time input into unix seconds.
 * Supports: unix timestamps, "today 8pm", "tomorrow 6:30pm", "in 2 hours", ISO date strings.
 */
export function parseTimeInput(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();

  // 1. Raw Unix seconds or ms
  if (/^\d{10}$/.test(s)) return Number(s);
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);

  // 2. Relative offset: "in X hours", "in Y minutes"
  const inMatch = s.match(/^in\s+(\d+)\s*(h|hr|hours?|m|min|minutes?)$/);
  if (inMatch) {
    const val = Number(inMatch[1]);
    const unit = inMatch[2].startsWith('h') ? 3600 : 60;
    return nowSec() + val * unit;
  }

  // 3. "today 8pm" / "tomorrow 6:30pm"
  const now = new Date();
  const baseDate = new Date(now);

  const isToday = s.startsWith('today');
  const isTomorrow = s.startsWith('tomorrow');

  if (isTomorrow) {
    baseDate.setDate(baseDate.getDate() + 1);
  }

  const timeMatch = s.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if ((isToday || isTomorrow) && timeMatch) {
    let hours = Number(timeMatch[1]);
    const mins = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const meridian = timeMatch[3];

    if (meridian === 'pm' && hours < 12) hours += 12;
    if (meridian === 'am' && hours === 12) hours = 0;

    baseDate.setHours(hours, mins, 0, 0);
    return Math.floor(baseDate.getTime() / 1000);
  }

  // 4. Standard Date parsing fallback
  const parsed = Date.parse(input);
  if (!isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  return null;
}

