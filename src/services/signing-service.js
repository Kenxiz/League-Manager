import { AuditAction, EndReason } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { nowSec } from '../utils/helpers.js';

/**
 * @typedef {object} Signing
 * @property {number} id
 * @property {string} userDiscordId
 * @property {import('./team-service.js').Team} team
 * @property {number} seasonId
 * @property {number} signedAt
 * @property {number|null} endedAt
 */

/**
 * Core business logic: signing, releasing and transferring users on teams.
 *
 * Public methods take Discord IDs (strings) and do all internal-id resolution. Every
 * mutating method runs in a single synchronous SQLite transaction, so limit checks and
 * inserts are atomic (no double-signing a full team under concurrent commands).
 *
 * This layer does NOT check Discord permissions - callers use PermissionService first.
 * `force: true` skips *league rules* (signings open, limits, cooldown), not validation.
 */
export class SigningService {
  constructor({ db, guilds, users, teams, seasons, audit, clock = nowSec }) {
    Object.assign(this, { db, guilds, users, teams, seasons, audit, clock });
    this.q = {
      liveByUser: db.prepare(
        'SELECT id, team_id, season_id, signed_at FROM signings WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL',
      ),
      liveCountTeam: db.prepare(
        'SELECT COUNT(*) AS n FROM signings WHERE guild_id = ? AND team_id = ? AND ended_at IS NULL',
      ),
      liveByTeam: db.prepare(`
        SELECT s.id, s.season_id, s.signed_at, u.discord_id
        FROM signings s JOIN users u ON u.id = s.user_id
        WHERE s.guild_id = ? AND s.team_id = ? AND s.ended_at IS NULL ORDER BY s.signed_at`),
      liveAll: db.prepare(`
        SELECT s.id, s.team_id, s.season_id, s.signed_at, u.discord_id
        FROM signings s JOIN users u ON u.id = s.user_id
        WHERE s.guild_id = ? AND s.ended_at IS NULL ORDER BY s.team_id, s.signed_at`),
      lastEnded: db.prepare(`
        SELECT ended_at FROM signings
        WHERE guild_id = ? AND user_id = ? AND ended_at IS NOT NULL AND end_reason = ?
        ORDER BY ended_at DESC LIMIT 1`),
      history: db.prepare(`
        SELECT id, team_id, season_id, signed_at, ended_at, end_reason
        FROM signings WHERE guild_id = ? AND user_id = ? ORDER BY signed_at DESC, id DESC LIMIT ?`),
      insert: db.prepare(`
        INSERT INTO signings (guild_id, season_id, user_id, team_id, signed_at, by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)`),
      end: db.prepare('UPDATE signings SET ended_at = ?, end_reason = ? WHERE id = ?'),
    };
  }

  /**
   * Signs a user to a team.
   * @param {{ guildDiscordId: string, userDiscordId: string, team: string|number, actorDiscordId?: string, force?: boolean }} p
   *   `team` is a team key / free-text query (string) or internal team id (number).
   * @returns {Signing}
   */
  sign({ guildDiscordId, userDiscordId, team, actorDiscordId, force = false }) {
    // Ids are resolved BEFORE the transaction: registering a guild/user is idempotent and must
    // survive even if the signing itself is rejected (and its transaction rolls back).
    const ctx = this.#context(guildDiscordId, userDiscordId, actorDiscordId);
    const t = this.#team(team);
    return this.db.transaction(() => this.#sign(ctx, t, { force, audit: true }))();
  }

  /**
   * Releases a user. With `team` omitted the user's single live signing is released; if they have
   * several you must say which.
   * @returns {Signing[]} the signings that were ended
   */
  release({ guildDiscordId, userDiscordId, team, actorDiscordId, reason }) {
    const ctx = this.#context(guildDiscordId, userDiscordId, actorDiscordId);
    return this.db.transaction(() => {
      const live = this.q.liveByUser.all(ctx.guildId, ctx.userId);
      if (live.length === 0) throw new NotFoundError('That user is not signed to any team.');

      let targets = live;
      if (team !== undefined && team !== null) {
        const t = this.#team(team);
        targets = live.filter((s) => s.team_id === t.id);
        if (targets.length === 0) throw new NotFoundError(`That user is not signed to ${t.name}.`);
      } else if (live.length > 1) {
        throw new ValidationError('That user is on several teams - specify which team to release them from.');
      }

      const endReason = reason ?? (ctx.actorId && ctx.actorId !== ctx.userId ? EndReason.REMOVED : EndReason.RELEASED);
      return targets.map((s) => {
        this.#end(s.id, endReason);
        this.audit.record({
          guildId: ctx.guildId,
          action: AuditAction.RELEASE,
          actorId: ctx.actorId,
          targetId: ctx.userId,
          teamId: s.team_id,
        });
        return this.#toSigning(s, userDiscordId, this.clock());
      });
    })();
  }

  /**
   * Atomically moves a user from one team to another (no cooldown; the old signing ends as TRANSFERRED).
   * If the user is on several teams, `from` is required.
   * @returns {{ from: Signing, to: Signing }}
   */
  transfer({ guildDiscordId, userDiscordId, from, to, actorDiscordId, force = false }) {
    const ctx = this.#context(guildDiscordId, userDiscordId, actorDiscordId);
    return this.db.transaction(() => {
      const dest = this.#team(to);
      const live = this.q.liveByUser.all(ctx.guildId, ctx.userId);
      if (live.length === 0) throw new NotFoundError('That user is not signed to any team.');

      let current = live;
      if (from !== undefined && from !== null) {
        const f = this.#team(from);
        current = live.filter((s) => s.team_id === f.id);
        if (current.length === 0) throw new NotFoundError(`That user is not signed to ${f.name}.`);
      } else if (live.length > 1) {
        throw new ValidationError('That user is on several teams - specify which one to transfer from.');
      }
      const old = current[0];
      if (old.team_id === dest.id) throw new ConflictError(`That user is already signed to ${dest.name}.`);

      this.#end(old.id, EndReason.TRANSFERRED);
      // Free slot on the old team doesn't matter; the new team's capacity is still enforced.
      const created = this.#sign(ctx, dest, { force, audit: false, skipCooldown: true, skipUserLimit: true });
      this.audit.record({
        guildId: ctx.guildId,
        action: AuditAction.TRANSFER,
        actorId: ctx.actorId,
        targetId: ctx.userId,
        teamId: dest.id,
        data: { from: old.team_id },
      });
      return { from: this.#toSigning(old, userDiscordId, this.clock()), to: created };
    })();
  }

  // ---- queries ----------------------------------------------------------------------

  /** @returns {Signing[]} the user's live signings in this guild */
  forUser(guildDiscordId, userDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    const row = this.users.ensure(userDiscordId);
    return this.q.liveByUser.all(guildId, row).map((s) => this.#toSigning(s, userDiscordId, null));
  }

  /** @returns {Signing[]} live roster of one team */
  roster(guildDiscordId, team) {
    const guildId = this.guilds.require(guildDiscordId);
    const t = this.#team(team);
    return this.q.liveByTeam.all(guildId, t.id).map((s) => this.#toSigning({ ...s, team_id: t.id }, s.discord_id, null));
  }

  /** @returns {Signing[]} every live signing in the guild, grouped by team id order */
  allLive(guildDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    return this.q.liveAll.all(guildId).map((s) => this.#toSigning(s, s.discord_id, null));
  }

  /** Recent signing history for a user (live table only; archived seasons: SeasonService.readArchive). */
  history(guildDiscordId, userDiscordId, { limit = 25 } = {}) {
    const guildId = this.guilds.require(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    return this.q.history
      .all(guildId, userId, Math.min(Math.max(limit, 1), 100))
      .map((s) => ({ ...this.#toSigning(s, userDiscordId, s.ended_at), endReason: s.end_reason }));
  }

  /** Free slots per team id for the guild (only counts enabled teams). */
  openTeams(guildDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    const max = this.guilds.getSettings(guildId).maxUsersPerTeam;
    const counts = new Map();
    for (const s of this.q.liveAll.all(guildId)) counts.set(s.team_id, (counts.get(s.team_id) ?? 0) + 1);
    return this.teams
      .listForGuild(guildId)
      .map((team) => ({ team, filled: counts.get(team.id) ?? 0, max }))
      .filter((x) => x.filled < x.max);
  }

  // ---- internals --------------------------------------------------------------------

  #context(guildDiscordId, userDiscordId, actorDiscordId) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : userId;
    return { guildId, userId, actorId, settings: this.guilds.getSettings(guildId) };
  }

  #team(team) {
    if (typeof team === 'number') {
      const t = this.teams.byId(team);
      if (!t) throw new NotFoundError('Unknown team.');
      return t;
    }
    return this.teams.resolve(team);
  }

  #sign(ctx, team, { force, audit, skipCooldown = false, skipUserLimit = false }) {
    const { guildId, userId, actorId, settings } = ctx;

    if (!this.teams.isEnabled(guildId, team.id)) throw new ConflictError(`${team.name} is not available in this server.`);

    if (!force) {
      if (!settings.signingsOpen) throw new ConflictError('Signings are currently closed.');

      const live = this.q.liveByUser.all(guildId, userId);
      if (live.some((s) => s.team_id === team.id)) throw new ConflictError(`Already signed to ${team.name}.`);
      if (!skipUserLimit && live.length >= settings.maxTeamsPerUser) {
        throw new ConflictError(
          settings.maxTeamsPerUser === 1
            ? 'That user is already signed to a team. Release or transfer them first.'
            : `That user is already on the maximum of ${settings.maxTeamsPerUser} teams.`,
        );
      }
      if (this.q.liveCountTeam.get(guildId, team.id).n >= settings.maxUsersPerTeam) {
        throw new ConflictError(`${team.name} is full.`);
      }
      if (!skipCooldown && settings.signingCooldownHours > 0) {
        const last = this.q.lastEnded.get(guildId, userId, EndReason.RELEASED);
        const readyAt = last ? last.ended_at + settings.signingCooldownHours * 3600 : 0;
        if (readyAt > this.clock()) {
          throw new ConflictError(`That user can sign again <t:${readyAt}:R>.`);
        }
      }
    }

    const season = this.seasons.ensureCurrent(guildId);
    const now = this.clock();
    const id = Number(this.q.insert.run(guildId, season.id, userId, team.id, now, actorId === userId ? null : actorId).lastInsertRowid);
    if (audit) {
      this.audit.record({ guildId, action: AuditAction.SIGN, actorId, targetId: userId, teamId: team.id });
    }
    return { id, userDiscordId: this.users.discordId(userId), team, seasonId: season.id, signedAt: now, endedAt: null };
  }

  #end(signingId, reason) {
    this.q.end.run(this.clock(), reason, signingId);
  }

  #toSigning(row, userDiscordId, endedAt) {
    const team = this.teams.byId(row.team_id);
    return {
      id: row.id,
      userDiscordId,
      team,
      seasonId: row.season_id,
      signedAt: row.signed_at,
      endedAt: row.ended_at ?? endedAt ?? null,
    };
  }
}
