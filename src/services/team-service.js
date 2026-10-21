import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { hexToInt, intToHex, normalizeForSearch } from '../utils/helpers.js';

export const CATALOG_PATH = fileURLToPath(new URL('../../data/teams.json', import.meta.url));

/** The source data spells conferences inconsistently; map every spelling to one canonical name. */
const CONFERENCE_CANON = new Map(
  Object.entries({
    'big 12': 'Big 12',
    b10: 'Big Ten',
    'pac-12': 'Pac-12',
    'sun belt': 'Sun Belt',
    'high school': 'High School',
    'high schools': 'High School',
  }),
);
export const canonicalConference = (raw) => {
  const name = String(raw ?? '').trim();
  return CONFERENCE_CANON.get(name.toLowerCase()) ?? name;
};

/** Conferences whose teams are hidden from guilds unless explicitly enabled. */
const DEFAULT_DISABLED_CONFERENCES = new Set(['High School']);

/**
 * @typedef {object} Team
 * @property {number} id
 * @property {string} key
 * @property {string} name
 * @property {string} fullName
 * @property {string} abbr
 * @property {string} mascot
 * @property {string|null} conference
 * @property {{ primary: number, secondary: number, primaryName: string|null, secondaryName: string|null }} colors  24-bit ints (embed-ready)
 * @property {{ groupId: number, logo1: number, logo2: number, scoreboardText: number|null }} roblox
 * @property {string|null} emoji
 * @property {{ name: string|null, location: string|null, capacity: number|null, indoor: boolean }} stadium
 * @property {boolean} active
 * @property {boolean} defaultEnabled
 */

const TEAM_SELECT = `
  SELECT t.*, c.name AS conference
  FROM teams t LEFT JOIN conferences c ON c.id = t.conference_id`;

function rowToTeam(r) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    fullName: r.full_name,
    abbr: r.abbr,
    mascot: r.mascot,
    conference: r.conference,
    colors: { primary: r.color1, secondary: r.color2, primaryName: r.color1_name, secondaryName: r.color2_name },
    roblox: { groupId: r.group_id, logo1: r.logo1, logo2: r.logo2, scoreboardText: r.scoreboard_text },
    emoji: r.emoji,
    stadium: {
      name: r.stadium_name,
      location: r.stadium_location,
      capacity: r.stadium_capacity,
      indoor: !!r.stadium_indoor,
    },
    active: !!r.active,
    defaultEnabled: !!r.default_enabled,
  };
}

export class TeamService {
  constructor({ db }) {
    this.db = db;
    /** @type {Team[]|null} lazy in-memory copy of the (small, global) catalog for fast fuzzy search */
    this.catalog = null;
    /** @type {Map<string, Set<number>>|null} normalised term -> team ids (exact terms) */
    this.exactIndex = null;

    this.q = {
      all: db.prepare(`${TEAM_SELECT} ORDER BY t.name`),
      byId: db.prepare(`${TEAM_SELECT} WHERE t.id = ?`),
      byKey: db.prepare(`${TEAM_SELECT} WHERE t.key = ?`),
      conf: db.prepare('SELECT id FROM conferences WHERE name = ?'),
      insConf: db.prepare('INSERT INTO conferences (name) VALUES (?)'),
      aliases: db.prepare('SELECT alias, team_id FROM team_aliases'),
      delAliases: db.prepare('DELETE FROM team_aliases WHERE team_id = ?'),
      insAlias: db.prepare('INSERT OR IGNORE INTO team_aliases (alias, team_id) VALUES (?, ?)'),
      upsert: db.prepare(`
        INSERT INTO teams (key, name, full_name, abbr, mascot, conference_id, color1, color2, color1_name, color2_name,
          group_id, logo1, logo2, scoreboard_text, emoji, stadium_name, stadium_location, stadium_capacity,
          stadium_indoor, stadium_icon, stadium_thumb, stadium_asset, active, default_enabled)
        VALUES (@key, @name, @full_name, @abbr, @mascot, @conference_id, @color1, @color2, @color1_name, @color2_name,
          @group_id, @logo1, @logo2, @scoreboard_text, @emoji, @stadium_name, @stadium_location, @stadium_capacity,
          @stadium_indoor, @stadium_icon, @stadium_thumb, @stadium_asset, @active, @default_enabled)
        ON CONFLICT(key) DO UPDATE SET
          name=excluded.name, full_name=excluded.full_name, abbr=excluded.abbr, mascot=excluded.mascot,
          conference_id=excluded.conference_id, color1=excluded.color1, color2=excluded.color2,
          color1_name=excluded.color1_name, color2_name=excluded.color2_name, group_id=excluded.group_id,
          logo1=excluded.logo1, logo2=excluded.logo2, scoreboard_text=excluded.scoreboard_text, emoji=excluded.emoji,
          stadium_name=excluded.stadium_name, stadium_location=excluded.stadium_location,
          stadium_capacity=excluded.stadium_capacity, stadium_indoor=excluded.stadium_indoor,
          stadium_icon=excluded.stadium_icon, stadium_thumb=excluded.stadium_thumb,
          stadium_asset=excluded.stadium_asset, active=excluded.active, default_enabled=excluded.default_enabled
        RETURNING id`),
      enabled: db.prepare(`
        SELECT COALESCE(o.enabled, t.default_enabled) AS enabled
        FROM teams t LEFT JOIN guild_team_overrides o ON o.team_id = t.id AND o.guild_id = ?
        WHERE t.id = ?`),
      setOverride: db.prepare(`
        INSERT INTO guild_team_overrides (guild_id, team_id, enabled) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, team_id) DO UPDATE SET enabled = excluded.enabled`),
      delOverride: db.prepare('DELETE FROM guild_team_overrides WHERE guild_id = ? AND team_id = ?'),
      overrides: db.prepare('SELECT team_id, enabled FROM guild_team_overrides WHERE guild_id = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM teams'),
    };
  }

  // ---- catalog seeding ---------------------------------------------------------------

  /**
   * Idempotently loads the team catalog (default: data/teams.json). Safe to run on every boot:
   * rows are upserted by `key`, so team ids (and therefore guild data) stay stable.
   * @returns {{ total: number }}
   */
  seed(entries = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))) {
    const run = this.db.transaction(() => {
      for (const e of entries) {
        const conference = canonicalConference(e.conference);
        let confId = null;
        if (conference) {
          confId = this.q.conf.get(conference)?.id ?? Number(this.q.insConf.run(conference).lastInsertRowid);
        }
        const id = this.q.upsert.get({
          key: e.key,
          name: e.name,
          full_name: e.fullName,
          abbr: e.abbr,
          mascot: e.mascot ?? '',
          conference_id: confId,
          color1: hexToInt(e.color1),
          color2: hexToInt(e.color2),
          color1_name: e.color1Name ?? null,
          color2_name: e.color2Name ?? null,
          group_id: e.groupId ?? 0,
          logo1: e.logo1 ?? 0,
          logo2: e.logo2 ?? 0,
          scoreboard_text: e.scoreboardText ?? null,
          emoji: e.emoji ?? null,
          stadium_name: e.stadium?.name || null,
          stadium_location: e.stadium?.location || null,
          stadium_capacity: e.stadium?.capacity || null,
          stadium_indoor: e.stadium?.indoor ? 1 : 0,
          stadium_icon: e.stadium?.icon || null,
          stadium_thumb: e.stadium?.thumbnail || null,
          stadium_asset: e.stadium?.assetId || null,
          active: e.active ? 1 : 0,
          default_enabled: DEFAULT_DISABLED_CONFERENCES.has(conference) ? 0 : 1,
        }).id;

        this.q.delAliases.run(id);
        for (const a of new Set([e.key, e.name, e.fullName, ...(e.aliases ?? [])])) this.q.insAlias.run(a, id);
      }
    });
    run();
    this.catalog = null; // invalidate
    return { total: entries.length };
  }

  count() {
    return this.q.count.get().n;
  }

  // ---- lookup -----------------------------------------------------------------------

  /** @returns {Team[]} */
  all() {
    this.#load();
    return this.catalog;
  }

  /** @returns {Team|undefined} */
  byId(id) {
    this.#load();
    return this.catalog.find((t) => t.id === id);
  }

  /** @returns {Team|undefined} */
  byKey(key) {
    this.#load();
    return this.catalog.find((t) => t.key === key);
  }

  /** Teams with matching name/alias/abbr/prefix, best matches first. */
  search(query, { limit = 25 } = {}) {
    this.#load();
    const q = normalizeForSearch(query);
    if (!q) return this.catalog.slice(0, limit);

    const scored = [];
    for (const t of this.catalog) {
      const terms = this.terms.get(t.id);
      let score = 0;
      if (terms.exact.has(q)) score = 100;
      else if (terms.abbr === q) score = 90;
      else if (terms.names.some((n) => n.startsWith(q))) score = 60;
      else if (terms.names.some((n) => n.split(' ').some((w) => w.startsWith(q)))) score = 40;
      else if (terms.names.some((n) => n.includes(q))) score = 20;
      if (score) scored.push([score, t]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    return scored.slice(0, limit).map(([, t]) => t);
  }

  /**
   * Resolves user input (autocomplete value = team key, or free text) to exactly one team.
   * @returns {Team}
   */
  resolve(query) {
    const direct = this.byKey(String(query));
    if (direct) return direct;
    const q = normalizeForSearch(query);
    if (!q) throw new ValidationError('Please provide a team.');
    this.#load();
    const exact = this.catalog.filter((t) => this.terms.get(t.id).exact.has(q) || this.terms.get(t.id).abbr === q);
    // Prefer an unambiguous exact match; otherwise fall back to a single prefix match.
    const pool = exact.length ? exact : this.search(query, { limit: 5 });
    if (pool.length === 0) throw new NotFoundError(`No team found matching "${String(query).slice(0, 50)}".`);
    if (pool.length > 1) {
      const names = pool.slice(0, 5).map((t) => t.name).join(', ');
      throw new ValidationError(`"${String(query).slice(0, 50)}" matches several teams (${names}). Be more specific.`);
    }
    return pool[0];
  }

  // ---- per-guild availability -------------------------------------------------------

  isEnabled(guildId, teamId) {
    const row = this.q.enabled.get(guildId, teamId);
    if (!row) throw new NotFoundError('Unknown team.');
    return !!row.enabled;
  }

  /** Enables/disables a team for one guild. Stores a row only when it differs from the catalog default. */
  setEnabled(guildId, teamId, enabled) {
    const team = this.byId(teamId);
    if (!team) throw new NotFoundError('Unknown team.');
    if (enabled === team.defaultEnabled) this.q.delOverride.run(guildId, teamId);
    else this.q.setOverride.run(guildId, teamId, enabled ? 1 : 0);
  }

  /** @returns {Team[]} teams available to a guild (optionally filtered by conference name) */
  listForGuild(guildId, { conference } = {}) {
    this.#load();
    const overrides = new Map(this.q.overrides.all(guildId).map((o) => [o.team_id, !!o.enabled]));
    const conf = conference ? canonicalConference(conference).toLowerCase() : null;
    return this.catalog.filter(
      (t) =>
        (overrides.get(t.id) ?? t.defaultEnabled) && (!conf || (t.conference ?? '').toLowerCase() === conf),
    );
  }

  conferences() {
    this.#load();
    return [...new Set(this.catalog.map((t) => t.conference).filter(Boolean))].sort();
  }

  /** Embed-friendly colour helper. */
  static hex(n) {
    return intToHex(n);
  }

  #load() {
    if (this.catalog) return;
    this.catalog = this.q.all.all().map(rowToTeam);
    const aliasesByTeam = new Map();
    for (const a of this.q.aliases.all()) {
      if (!aliasesByTeam.has(a.team_id)) aliasesByTeam.set(a.team_id, []);
      aliasesByTeam.get(a.team_id).push(a.alias);
    }
    /** @type {Map<number, { exact: Set<string>, names: string[], abbr: string }>} */
    this.terms = new Map();
    for (const t of this.catalog) {
      const names = [t.key, t.name, t.fullName, t.mascot, ...(aliasesByTeam.get(t.id) ?? [])]
        .filter(Boolean)
        .map(normalizeForSearch);
      // Mascot alone is a search term but not an "exact identity" (many teams share mascots).
      const exact = new Set([t.key, t.name, t.fullName, ...(aliasesByTeam.get(t.id) ?? [])].map(normalizeForSearch));
      this.terms.set(t.id, { exact, names: [...new Set(names)], abbr: normalizeForSearch(t.abbr) });
    }
  }
}
