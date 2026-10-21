import { AuditAction, MatchStatus } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { assertSnowflake, nowSec, sanitizeText } from '../utils/helpers.js';

export class ScheduleService {
  constructor({ db, guilds, teams, seasons, users, audit, clock = nowSec }) {
    this.db = db;
    this.guilds = guilds;
    this.teams = teams;
    this.seasons = seasons;
    this.users = users;
    this.audit = audit;
    this.clock = clock;

    this.q = {
      insert: db.prepare(`
        INSERT INTO matches (
          guild_id, season_id, week, home_team_id, away_team_id,
          scheduled_at, status, stadium_name, notes, coordination_thread_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      byId: db.prepare('SELECT * FROM matches WHERE id = ?'),
      byThread: db.prepare('SELECT * FROM matches WHERE coordination_thread_id = ?'),
      setThread: db.prepare('UPDATE matches SET coordination_thread_id = ?, updated_at = ? WHERE id = ?'),
      list: db.prepare(`
        SELECT m.*
        FROM matches m
        WHERE m.guild_id = ?
          AND (? IS NULL OR m.season_id = ?)
          AND (? IS NULL OR m.week = ?)
          AND (? IS NULL OR m.home_team_id = ? OR m.away_team_id = ?)
          AND (? IS NULL OR m.status = ?)
          AND (? IS NULL OR m.scheduled_at >= ?)
        ORDER BY m.week ASC, m.scheduled_at ASC, m.id ASC
        LIMIT ?`),
      conflicts: db.prepare(`
        SELECT id, week, home_team_id, away_team_id, scheduled_at
        FROM matches
        WHERE guild_id = ?
          AND (? IS NULL OR id != ?)
          AND status IN (1, 2)
          AND scheduled_at IS NOT NULL
          AND scheduled_at BETWEEN ? AND ?
          AND (home_team_id IN (?, ?) OR away_team_id IN (?, ?))`),
      update: db.prepare(`
        UPDATE matches
        SET scheduled_at = COALESCE(?, scheduled_at),
            stadium_name = COALESCE(?, stadium_name),
            status = COALESCE(?, status),
            notes = COALESCE(?, notes),
            updated_at = ?
        WHERE id = ?`),
      setStatus: db.prepare('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?'),
      setProposal: db.prepare(`
        UPDATE matches
        SET proposed_time = ?,
            proposed_by_user_id = ?,
            home_confirmed_at = ?,
            home_confirmed_by_user_id = ?,
            away_confirmed_at = ?,
            away_confirmed_by_user_id = ?,
            updated_at = ?
        WHERE id = ?`),
      confirmHome: db.prepare(`
        UPDATE matches
        SET home_confirmed_at = ?,
            home_confirmed_by_user_id = ?,
            updated_at = ?
        WHERE id = ?`),
      confirmAway: db.prepare(`
        UPDATE matches
        SET away_confirmed_at = ?,
            away_confirmed_by_user_id = ?,
            updated_at = ?
        WHERE id = ?`),
      lockInScheduledTime: db.prepare(`
        UPDATE matches
        SET scheduled_at = ?,
            updated_at = ?
        WHERE id = ?`),
    };
  }

  createMatch({
    guildDiscordId,
    seasonId = null,
    week = 1,
    homeTeam,
    awayTeam,
    scheduledAt = null,
    stadiumName = null,
    notes = null,
    coordinationThreadId = null,
    actorDiscordId = null,
    ignoreConflicts = false,
  }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const season = seasonId ? { id: seasonId } : this.seasons.ensureCurrent(guildId);

    const home = this.#team(homeTeam);
    const away = this.#team(awayTeam);
    if (home.id === away.id) throw new ValidationError('Home and away teams must be different.');

    if (!this.teams.isEnabled(guildId, home.id)) {
      throw new ConflictError(`${home.name} is not enabled in this server.`);
    }
    if (!this.teams.isEnabled(guildId, away.id)) {
      throw new ConflictError(`${away.name} is not enabled in this server.`);
    }

    const cleanWeek = Math.max(1, Number(week) || 1);
    const cleanNotes = notes ? sanitizeText(notes, { max: 500, label: 'Notes' }) : null;
    const stadium = stadiumName ? sanitizeText(stadiumName, { max: 100, label: 'Stadium' }) : (home.stadium?.name || null);

    let schedTime = null;
    if (scheduledAt !== null && scheduledAt !== undefined) {
      schedTime = Number(scheduledAt);
      if (!Number.isFinite(schedTime) || schedTime <= 0) throw new ValidationError('Invalid scheduled timestamp.');

      if (!ignoreConflicts) {
        const conflicts = this.detectConflicts({
          guildDiscordId,
          teamIds: [home.id, away.id],
          scheduledAt: schedTime,
        });
        if (conflicts.length > 0) {
          throw new ConflictError(
            `Schedule conflict: A team is already playing in match #${conflicts[0].id} around that time.`,
          );
        }
      }
    }

    const now = this.clock();
    const id = Number(
      this.q.insert.run(
        guildId,
        season.id,
        cleanWeek,
        home.id,
        away.id,
        schedTime,
        MatchStatus.SCHEDULED,
        stadium,
        cleanNotes,
        coordinationThreadId,
        now,
        now,
      ).lastInsertRowid,
    );

    this.audit.record({
      guildId,
      action: AuditAction.MATCH_CREATE,
      actorId,
      teamId: home.id,
      data: { matchId: id, awayTeamId: away.id, week: cleanWeek, scheduledAt: schedTime },
    });

    return this.getMatch(id);
  }

  getMatch(matchId) {
    const r = this.q.byId.get(matchId);
    if (!r) throw new NotFoundError('Match not found.');
    return this.#formatMatch(r);
  }

  getByThreadId(threadId) {
    const r = this.q.byThread.get(threadId);
    return r ? this.#formatMatch(r) : null;
  }

  setCoordinationThread({ matchId, threadId }) {
    assertSnowflake(threadId, 'thread ID');
    const now = this.clock();
    this.q.setThread.run(threadId, now, matchId);
    return this.getMatch(matchId);
  }

  // --- Proposal & Confirmation Workflow (/schedule end {time}) ---

  proposeTime({
    guildDiscordId,
    matchId,
    proposerDiscordId,
    scheduledAt,
    side = 'home', // 'home' | 'away' | 'commissioner'
  }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const proposerId = this.users.ensure(proposerDiscordId);
    const match = this.getMatch(matchId);
    if (match.guildId !== guildId) throw new NotFoundError('Match not found in this guild.');

    if (match.status === MatchStatus.COMPLETED || match.status === MatchStatus.CANCELLED) {
      throw new ConflictError('Cannot schedule a match that is already completed or cancelled.');
    }

    const targetTime = Number(scheduledAt);
    if (!Number.isFinite(targetTime) || targetTime <= 0) {
      throw new ValidationError('Invalid target match time.');
    }

    const now = this.clock();
    const isHome = side === 'home';
    const isAway = side === 'away';

    const homeConfirmedAt = isHome ? now : null;
    const homeConfirmedBy = isHome ? proposerId : null;
    const awayConfirmedAt = isAway ? now : null;
    const awayConfirmedBy = isAway ? proposerId : null;

    this.q.setProposal.run(
      targetTime,
      proposerId,
      homeConfirmedAt,
      homeConfirmedBy,
      awayConfirmedAt,
      awayConfirmedBy,
      now,
      matchId,
    );

    this.audit.record({
      guildId,
      action: AuditAction.MATCH_UPDATE,
      actorId: proposerId,
      data: { matchId, proposedTime: targetTime, side },
    });

    return this.getMatch(matchId);
  }

  confirmProposal({
    guildDiscordId,
    matchId,
    confirmerDiscordId,
    userDiscordId,
    side, // 'home' | 'away'
    ignoreConflicts = false,
  }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const confirmerId = this.users.ensure(confirmerDiscordId ?? userDiscordId);
    const match = this.getMatch(matchId);
    if (match.guildId !== guildId) throw new NotFoundError('Match not found in this guild.');

    if (!match.proposedTime) {
      throw new ConflictError('No match time has been proposed yet. Use /schedule end {time} first.');
    }

    const now = this.clock();
    if (side === 'home') {
      this.q.confirmHome.run(now, confirmerId, now, matchId);
    } else if (side === 'away') {
      this.q.confirmAway.run(now, confirmerId, now, matchId);
    } else {
      throw new ValidationError("Invalid side: must be 'home' or 'away'.");
    }

    const updated = this.getMatch(matchId);
    const fullyConfirmed = updated.homeConfirmedAt !== null && updated.awayConfirmedAt !== null;

    if (fullyConfirmed) {
      // Check for conflicts before locking in
      if (!ignoreConflicts) {
        const conflicts = this.detectConflicts({
          guildDiscordId,
          teamIds: [updated.homeTeam.id, updated.awayTeam.id],
          scheduledAt: updated.proposedTime,
          excludeMatchId: matchId,
        });
        if (conflicts.length > 0) {
          throw new ConflictError(`Schedule conflict: Match #${conflicts[0].id} is already playing at that time.`);
        }
      }

      this.q.lockInScheduledTime.run(updated.proposedTime, now, matchId);
      this.audit.record({
        guildId,
        action: AuditAction.MATCH_UPDATE,
        actorId: confirmerId,
        data: { matchId, scheduledAt: updated.proposedTime, fullyConfirmed: true },
      });
    }

    return {
      match: this.getMatch(matchId),
      fullyConfirmed,
      confirmedSide: side,
    };
  }

  // --- Queries & Standard Modifications ---

  listMatches({
    guildDiscordId,
    seasonId = null,
    week = null,
    team = null,
    status = null,
    upcomingOnly = false,
    limit = 50,
  }) {
    const guildId = this.guilds.require(guildDiscordId);
    const teamId = team ? this.#team(team).id : null;
    const fromTime = upcomingOnly ? this.clock() : null;

    const rows = this.q.list.all(
      guildId,
      seasonId,
      seasonId,
      week,
      week,
      teamId,
      teamId,
      teamId,
      status,
      status,
      fromTime,
      fromTime,
      Math.min(Math.max(1, limit), 200),
    );

    return rows.map((r) => this.#formatMatch(r));
  }

  detectConflicts({ guildDiscordId, teamIds, scheduledAt, windowHours = 2, excludeMatchId = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const halfWindow = Math.round((windowHours * 3600) / 2);
    const start = scheduledAt - halfWindow;
    const end = scheduledAt + halfWindow;
    const [t1, t2] = teamIds.length >= 2 ? [teamIds[0], teamIds[1]] : [teamIds[0], teamIds[0]];

    return this.q.conflicts.all(guildId, excludeMatchId, excludeMatchId, start, end, t1, t2, t1, t2);
  }

  rescheduleMatch({ guildDiscordId, matchId, scheduledAt, actorDiscordId = null, ignoreConflicts = false }) {
    const match = this.getMatch(matchId);
    const guildId = this.guilds.ensure(guildDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const newTime = Number(scheduledAt);
    if (!Number.isFinite(newTime) || newTime <= 0) throw new ValidationError('Invalid scheduled timestamp.');

    if (!ignoreConflicts) {
      const conflicts = this.detectConflicts({
        guildDiscordId,
        teamIds: [match.homeTeam.id, match.awayTeam.id],
        scheduledAt: newTime,
        excludeMatchId: matchId,
      });
      if (conflicts.length > 0) {
        throw new ConflictError(`Schedule conflict: A team is already playing in match #${conflicts[0].id} around that time.`);
      }
    }

    const now = this.clock();
    this.q.update.run(newTime, null, null, null, now, matchId);

    this.audit.record({
      guildId,
      action: AuditAction.MATCH_UPDATE,
      actorId,
      teamId: match.homeTeam.id,
      data: { matchId, oldScheduledAt: match.scheduledAt, newScheduledAt: newTime },
    });

    return this.getMatch(matchId);
  }

  cancelMatch({ guildDiscordId, matchId, reason = null, actorDiscordId = null }) {
    const match = this.getMatch(matchId);
    const guildId = this.guilds.ensure(guildDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const now = this.clock();

    this.q.setStatus.run(MatchStatus.CANCELLED, now, matchId);

    this.audit.record({
      guildId,
      action: AuditAction.MATCH_UPDATE,
      actorId,
      teamId: match.homeTeam.id,
      data: { matchId, status: MatchStatus.CANCELLED, reason },
    });

    return this.getMatch(matchId);
  }

  #team(team) {
    if (typeof team === 'number') {
      const t = this.teams.byId(team);
      if (!t) throw new NotFoundError('Unknown team.');
      return t;
    }
    return this.teams.resolve(team);
  }

  #formatMatch(r) {
    return {
      id: r.id,
      guildId: r.guild_id,
      seasonId: r.season_id,
      week: r.week,
      homeTeam: this.teams.byId(r.home_team_id),
      awayTeam: this.teams.byId(r.away_team_id),
      scheduledAt: r.scheduled_at,
      status: r.status,
      stadiumName: r.stadium_name,
      homeScore: r.home_score,
      awayScore: r.away_score,
      winnerTeam: r.winner_team_id ? this.teams.byId(r.winner_team_id) : null,
      notes: r.notes,
      coordinationThreadId: r.coordination_thread_id,
      proposedTime: r.proposed_time,
      proposedByUserId: r.proposed_by_user_id,
      homeConfirmedAt: r.home_confirmed_at,
      homeConfirmedByUserId: r.home_confirmed_by_user_id,
      awayConfirmedAt: r.away_confirmed_at,
      awayConfirmedByUserId: r.away_confirmed_by_user_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
