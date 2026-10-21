/**
 * One-off importer: converts the game's `teams.luau` module into `data/teams.json`.
 *
 * Usage: node scripts/import-teams.js [path/to/teams.luau]
 *
 * It is a purpose-built line parser (not a general Luau parser) that understands the
 * exact shape of the file: a `teams` table, a `Names` list, a `ByFullName` alias map and
 * an `Active` list. It fails loudly if anything unexpected shows up.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(process.argv[2] ?? resolve(root, 'teams.luau'));
const output = resolve(root, 'data/teams.json');

const lines = readFileSync(input, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);

const hex = (r, g, b) =>
  '#' + [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('');

function parseValue(raw) {
  const v = raw.trim().replace(/,$/, '');
  let m;
  if ((m = v.match(/^"(.*)"$/))) return m[1];
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((m = v.match(/^Color3\.fromRGB\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/))) return hex(m[1], m[2], m[3]);
  if ((m = v.match(/^BrickColor\.new\("(.*)"\)$/))) return m[1];
  throw new Error(`Unrecognised value: ${raw}`);
}

/** Returns the [start, end) line indexes of a top-level block opened by a line matching `open`. */
function sectionRange(open, indent) {
  const start = lines.findIndex((l) => open.test(l));
  if (start < 0) throw new Error(`Section not found: ${open}`);
  const close = new RegExp(`^${indent}\\}`);
  for (let i = start + 1; i < lines.length; i++) if (close.test(lines[i])) return [start + 1, i];
  throw new Error(`Unterminated section: ${open}`);
}

// --- Teams table ---------------------------------------------------------------------
const teams = {};
{
  const [s, e] = sectionRange(/^local teams: /, '');
  let current = null;
  let stadium = null;
  for (let i = s; i < e; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\t\["(.+)"\] = \{$/))) {
      current = { key: m[1] };
      teams[m[1]] = current;
    } else if (/^\t\},?$/.test(line)) {
      current = null;
    } else if ((m = line.match(/^\t\tStadium = \{$/))) {
      stadium = {};
      current.Stadium = stadium;
    } else if (/^\t\t\},?$/.test(line)) {
      stadium = null;
    } else if ((m = line.match(/^\t\t\t(\w+) = (.+)$/)) && stadium) {
      stadium[m[1]] = parseValue(m[2]);
    } else if ((m = line.match(/^\t\t(\w+) = (.+)$/)) && current) {
      current[m[1]] = parseValue(m[2]);
    } else if (line.trim() !== '') {
      throw new Error(`Line ${i + 1}: unexpected content: ${line}`);
    }
  }
}

// --- Aliases + active list -----------------------------------------------------------
const aliases = {};
{
  const [s, e] = sectionRange(/^\tByFullName = \{/, '\\t');
  for (let i = s; i < e; i++) {
    const m = lines[i].match(/^\t\t\["(.+)"\] = "(.+)",$/);
    if (!m) throw new Error(`Line ${i + 1}: bad alias line`);
    aliases[m[1]] = m[2];
  }
}
const active = [];
{
  const [s, e] = sectionRange(/^\tActive = \{/, '\\t');
  for (let i = s; i < e; i++) {
    const m = lines[i].match(/^\t\t"(.+)",$/);
    if (!m) throw new Error(`Line ${i + 1}: bad active line`);
    active.push(m[1]);
  }
}

// --- Normalise -----------------------------------------------------------------------
const aliasMap = {};
for (const [alias, key] of Object.entries(aliases)) (aliasMap[key] ??= []).push(alias);

// The Active list is hand-maintained and may use a short name or abbreviation (e.g. "LSU"
// for the team keyed "Louisiana State"), so resolve each entry to a canonical team key.
const allTeams = Object.values(teams);
const activeKeys = new Set();
for (const a of active) {
  const hit = teams[a] ?? allTeams.find((t) => t.ShortName === a) ?? allTeams.find((t) => t.AbbreviatedName === a);
  if (!hit) throw new Error(`Active team missing: ${a}`);
  if (hit.key !== a) console.warn(`note: Active entry "${a}" resolved to team key "${hit.key}"`);
  activeKeys.add(hit.key);
}

const out = Object.values(teams).map((t) => {
  const st = t.Stadium ?? {};
  const row = {
    key: t.key,
    name: t.ShortName,
    fullName: t.FullName,
    abbr: t.AbbreviatedName,
    mascot: t.Mascot,
    conference: t.Conference,
    color1: t.Color1,
    color2: t.Color2,
    color1Name: t.Color1Name,
    color2Name: t.Color2Name,
    groupId: t.GroupId,
    logo1: t.Logo1,
    logo2: t.Logo2,
    scoreboardText: t.ScoreboardText ?? null,
    emoji: t.Emoji || null,
    stadium: {
      name: st.Name ?? '',
      location: st.Location ?? '',
      capacity: st.Capacity ?? 0,
      indoor: !!st.Indoor,
      icon: st.Icon ?? 0,
      thumbnail: st.Thumbnail ?? 0,
      assetId: st.AssetId ?? 0,
    },
    active: activeKeys.has(t.key),
  };
  // Aliases other than the canonical full name (e.g. historic misspellings).
  const extra = (aliasMap[t.key] ?? []).filter((a) => a !== t.FullName);
  if (extra.length) row.aliases = extra;
  return row;
});

// Sanity checks.
for (const [alias, key] of Object.entries(aliases))
  if (!teams[key]) throw new Error(`Alias "${alias}" -> unknown team "${key}"`);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${out.length} teams (${activeKeys.size} active) -> ${output}`);
