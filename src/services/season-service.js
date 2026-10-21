import { AuditAction, EndReason } from '../utils/constants.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { nowSec } from '../utils/helpers.js';

const ARCHIVE_VERSION = 1;

/**
 * Seasons and cold storage of finished seasons.
 *
 * Live signings sit in the `signings` table (indexed, fast). Once a season is over, its
 * *ended* signings can be archived: they are rewritten as columnar, delta-encoded arrays,
 * brotli-compressed into a single blob and deleted from `signings`. Typical result is
 * ~10-20x smaller than the row form, and no per-row index overhead.
 */
export class SeasonService {
  constructor({ db, codec, audit, clock = nowSec }) {
    this.db = db;
    this.codec = codec;
    this.audit = audit;
    this.clock = clock;
    this.q = {
      open: db.prepare('SELECT id, number, started_at, ended_at FROM seasons WHERE guild_id = ? AND ended_at IS NULL'),
      byId: db.prepare('SELECT id, guild_id, number, started_at, ended_at FROM seasons WHERE id = ?'),
      maxNumber: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM seasons WHERE guild_id = ?'),
      insert: db.prepare('INSERT INTO seasons (guild_id, number, started_at) VALUES (?, ?, ?)'),
      close: db.prepare('UPDATE seasons SET ended_at = ? WHERE id = ?'),
      list: db.prepare('SELECT id, number, started_at, ended_at FROM seasons WHERE guild_id = ? ORDER BY number DESC'),
      endAllLive: db.prepare(
        'UPDATE signings SET ended_at = ?, end_reason = ? WHERE guild_id = ? AND ended_at IS NULL',
      ),
      endedRows: db.prepare(`
        SELECT id, user_id, team_id, signed_at, ended_at, end_reason, by_user_id
        FROM signings WHERE season_id = ? AND ended_at IS NOT NULL ORDER BY signed_at, id`),
      delRows: db.prepare('DELETE FROM signings WHERE season_id = ? AND ended_at IS NOT NULL'),
      getArchive: db.prepare('SELECT signing_count, data FROM season_archives WHERE season_id = ?'),
      putArchive: db.prepare(`
        INSERT INTO season_archives (season_id, guild_id, signing_count, archived_at, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(season_id) DO UPDATE SET signing_count = excluded.signing_count,
          archived_at = excluded.archived_at, data = excluded.data`),
      archivable: db.prepare(`
        SELECT s.id FROM seasons s
        WHERE s.ended_at IS NOT NULL AND s.ended_at < ?
          AND EXISTS (SELECT 1 FROM signings g WHERE g.season_id = s.id AND g.ended_at IS NOT NULL)`),
    };
  }

  /** @returns {{ id: number, number: number, started_at: number, ended_at: null }|null} */
  current(guildId) {
    return this.q.open.get(guildId) ?? null;
  }

  /** Current open season, creating one if the guild has none yet. */
  ensureCurrent(guildId) {
    return this.current(guildId) ?? this.#create(guildId);
  }

  list(guildId) {
    return this.q.list.all(guildId);
  }

  start(guildId, { actorId = null } = {}) {
    if (this.current(guildId)) throw new ConflictError('A season is already in progress. End it first.');
    return this.db.transaction(() => {
      const season = this.#create(guildId);
      this.audit.record({ guildId, action: AuditAction.SEASON_START, actorId, data: { season: season.number } });
      return season;
    })();
  }

  /**
   * Ends the open season.
   * @param {{ carryOver?: boolean, actorId?: number|null }} [opts]
   *   carryOver=true (default): live signings stay active into the next season.
   *   carryOver=false: every live signing is ended with reason SEASON_END.
   */
  end(guildId, { carryOver = true, actorId = null } = {}) {
    const season = this.current(guildId);
    if (!season) throw new NotFoundError('There is no season in progress.');
    return this.db.transaction(() => {
      const now = this.clock();
      let released = 0;
      if (!carryOver) released = this.q.endAllLive.run(now, EndReason.SEASON_END, guildId).changes;
      this.q.close.run(now, season.id);
      this.audit.record({
        guildId,
        action: AuditAction.SEASON_END,
        actorId,
        data: { season: season.number, carryOver, released },
      });
      return { season: { ...season, ended_at: now }, released };
    })();
  }

  // ---- cold storage -----------------------------------------------------------------

  /**
   * Moves a season's ended signings into its compressed archive (merging with any existing archive).
   * @returns {number} how many signings were archived
   */
  archive(seasonId) {
    const season = this.q.byId.get(seasonId);
    if (!season) throw new NotFoundError('Unknown season.');
    if (season.ended_at === null) throw new ConflictError('Only finished seasons can be archived.');

    return this.db.transaction(() => {
      const fresh = this.q.endedRows.all(seasonId);
      if (fresh.length === 0) return 0;
      const existing = this.q.getArchive.get(seasonId);
      const rows = existing ? [...decodeRows(this.codec.unpack(existing.data)), ...fresh.map(toRow)] : fresh.map(toRow);
      rows.sort((a, b) => a.signedAt - b.signedAt);
      this.q.putArchive.run(seasonId, season.guild_id, rows.length, this.clock(), this.codec.pack(encodeRows(rows)));
      this.q.delRows.run(seasonId);
      return fresh.length;
    })();
  }

  /** Archives every finished season older than `olderThanSec`. @returns {number} signings archived */
  archiveOld(olderThanSec) {
    let n = 0;
    for (const { id } of this.q.archivable.all(this.clock() - olderThanSec)) n += this.archive(id);
    return n;
  }

  /**
   * Reads an archived season back as plain rows (internal user/team ids).
   * @returns {{ userId: number, teamId: number, signedAt: number, endedAt: number, endReason: number, byUserId: number|null }[]}
   */
  readArchive(seasonId) {
    const row = this.q.getArchive.get(seasonId);
    return row ? decodeRows(this.codec.unpack(row.data)) : [];
  }

  #create(guildId) {
    const number = this.q.maxNumber.get(guildId).n + 1;
    const startedAt = this.clock();
    const id = Number(this.q.insert.run(guildId, number, startedAt).lastInsertRowid);
    return { id, number, started_at: startedAt, ended_at: null };
  }
}

const toRow = (r) => ({
  userId: r.user_id,
  teamId: r.team_id,
  signedAt: r.signed_at,
  endedAt: r.ended_at,
  endReason: r.end_reason ?? 0,
  byUserId: r.by_user_id,
});

/** Columnar + delta encoding: similar values sit together so brotli squeezes them much harder. */
function encodeRows(rows) {
  let prev = 0;
  const signedDelta = rows.map((r) => {
    const d = r.signedAt - prev;
    prev = r.signedAt;
    return d;
  });
  return {
    v: ARCHIVE_VERSION,
    u: rows.map((r) => r.userId),
    t: rows.map((r) => r.teamId),
    s: signedDelta,
    d: rows.map((r) => r.endedAt - r.signedAt), // duration
    r: rows.map((r) => r.endReason),
    b: rows.map((r) => r.byUserId ?? 0),
  };
}

function decodeRows(c) {
  if (c?.v !== ARCHIVE_VERSION) throw new Error(`Unsupported archive version: ${c?.v}`);
  let t = 0;
  return c.u.map((userId, i) => {
    t += c.s[i];
    return {
      userId,
      teamId: c.t[i],
      signedAt: t,
      endedAt: t + c.d[i],
      endReason: c.r[i],
      byUserId: c.b[i] || null,
    };
  });
}
