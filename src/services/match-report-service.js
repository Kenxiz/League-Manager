import { AuditAction, MatchStatus, ReportStatus } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { nowSec, sanitizeText } from '../utils/helpers.js';

export class MatchReportService {
  constructor({ db, guilds, teams, seasons, users, audit, clock = nowSec }) {
    this.db = db;
    this.guilds = guilds;
    this.teams = teams;
    this.seasons = seasons;
    this.users = users;
    this.audit = audit;
    this.clock = clock;

    this.q = {
      matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
      reportById: db.prepare('SELECT * FROM match_reports WHERE id = ?'),
      insertReport: db.prepare(`
        INSERT INTO match_reports (
          match_id, reported_by_user_id, home_score, away_score, proof_url, notes, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      setReportStatus: db.prepare(`
        UPDATE match_reports
        SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?
        WHERE id = ?`),
      completeMatch: db.prepare(`
        UPDATE matches
        SET status = ?, home_score = ?, away_score = ?, winner_team_id = ?, updated_at = ?
        WHERE id = ?`),
      reportsForMatch: db.prepare(`
        SELECT mr.*, u.discord_id AS reporter_discord_id, ru.discord_id AS reviewer_discord_id
        FROM match_reports mr
        JOIN users u ON u.id = mr.reported_by_user_id
        LEFT JOIN users ru ON ru.id = mr.reviewed_by_user_id
        WHERE mr.match_id = ?
        ORDER BY mr.created_at DESC`),
      pendingReports: db.prepare(`
        SELECT mr.*, m.guild_id, u.discord_id AS reporter_discord_id
        FROM match_reports mr
        JOIN matches m ON m.id = mr.match_id
        JOIN users u ON u.id = mr.reported_by_user_id
        WHERE m.guild_id = ? AND mr.status = 1
        ORDER BY mr.created_at ASC`),
      completedMatchesInSeason: db.prepare(`
        SELECT home_team_id, away_team_id, home_score, away_score, winner_team_id, status
        FROM matches
        WHERE guild_id = ? AND season_id = ? AND status IN (3, 5)`),
    };
  }

  submitReport({
    guildDiscordId,
    matchId,
    reporterDiscordId,
    homeScore,
    awayScore,
    proofUrl = null,
    notes = null,
    autoApprove = false,
  }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const reporterId = this.users.ensure(reporterDiscordId);
    const match = this.q.matchById.get(matchId);
    if (!match || match.guild_id !== guildId) throw new NotFoundError('Match not found.');

    if (match.status === MatchStatus.COMPLETED) {
      throw new ConflictError('This match has already been marked completed.');
    }
    if (match.status === MatchStatus.CANCELLED) {
      throw new ConflictError('Cannot submit scores for a cancelled match.');
    }

    const hScore = Number(homeScore);
    const aScore = Number(awayScore);
    if (!Number.isInteger(hScore) || hScore < 0 || !Number.isInteger(aScore) || aScore < 0) {
      throw new ValidationError('Scores must be non-negative integers.');
    }

    const cleanProof = proofUrl ? sanitizeText(proofUrl, { max: 300, label: 'Proof URL' }) : null;
    const cleanNotes = notes ? sanitizeText(notes, { max: 500, label: 'Notes' }) : null;
    const now = this.clock();

    const reportId = this.db.transaction(() => {
      const initialStatus = autoApprove ? ReportStatus.APPROVED : ReportStatus.PENDING;
      const res = this.q.insertReport.run(
        matchId,
        reporterId,
        hScore,
        aScore,
        cleanProof,
        cleanNotes,
        initialStatus,
        now,
      );
      const rId = Number(res.lastInsertRowid);

      this.audit.record({
        guildId,
        action: AuditAction.MATCH_REPORT,
        actorId: reporterId,
        data: { matchId, reportId: rId, homeScore: hScore, awayScore: aScore, autoApprove },
      });

      if (autoApprove) {
        this.#applyScoresToMatch(match, hScore, aScore, reporterId, now);
      }
      return rId;
    })();

    return this.getReport(reportId);
  }

  approveReport({ guildDiscordId, reportId, actorDiscordId }) {
    const guildId = this.guilds.require(guildDiscordId);
    const actorId = this.users.ensure(actorDiscordId);
    const report = this.q.reportById.get(reportId);
    if (!report) throw new NotFoundError('Match report not found.');

    const match = this.q.matchById.get(report.match_id);
    if (!match || match.guild_id !== guildId) throw new NotFoundError('Match not found.');

    if (report.status !== ReportStatus.PENDING) {
      throw new ConflictError('This report is not pending.');
    }

    const now = this.clock();
    this.db.transaction(() => {
      this.q.setReportStatus.run(ReportStatus.APPROVED, actorId, now, reportId);
      this.#applyScoresToMatch(match, report.home_score, report.away_score, actorId, now);

      this.audit.record({
        guildId,
        action: AuditAction.MATCH_APPROVE,
        actorId,
        data: { matchId: match.id, reportId, homeScore: report.home_score, awayScore: report.away_score },
      });
    })();

    return this.getReport(reportId);
  }

  rejectReport({ guildDiscordId, reportId, actorDiscordId, reason = null }) {
    const guildId = this.guilds.require(guildDiscordId);
    const actorId = this.users.ensure(actorDiscordId);
    const report = this.q.reportById.get(reportId);
    if (!report) throw new NotFoundError('Match report not found.');

    const match = this.q.matchById.get(report.match_id);
    if (!match || match.guild_id !== guildId) throw new NotFoundError('Match not found.');

    const now = this.clock();
    this.q.setReportStatus.run(ReportStatus.REJECTED, actorId, now, reportId);

    this.audit.record({
      guildId,
      action: AuditAction.MATCH_UPDATE,
      actorId,
      data: { matchId: match.id, reportId, status: 'rejected', reason },
    });

    return this.getReport(reportId);
  }

  forfeitMatch({ guildDiscordId, matchId, forfeitingTeam, actorDiscordId }) {
    const guildId = this.guilds.require(guildDiscordId);
    const actorId = this.users.ensure(actorDiscordId);
    const match = this.q.matchById.get(matchId);
    if (!match || match.guild_id !== guildId) throw new NotFoundError('Match not found.');

    const forfeitTeamId = typeof forfeitingTeam === 'number' ? forfeitingTeam : this.teams.resolve(forfeitingTeam).id;
    if (forfeitTeamId !== match.home_team_id && forfeitTeamId !== match.away_team_id) {
      throw new ValidationError('The forfeiting team is not in this match.');
    }

    const winnerId = forfeitTeamId === match.home_team_id ? match.away_team_id : match.home_team_id;
    const homeScore = forfeitTeamId === match.home_team_id ? 0 : 2;
    const awayScore = forfeitTeamId === match.away_team_id ? 0 : 2;
    const now = this.clock();

    this.db.transaction(() => {
      this.q.completeMatch.run(MatchStatus.FORFEITED, homeScore, awayScore, winnerId, now, matchId);
      this.audit.record({
        guildId,
        action: AuditAction.MATCH_UPDATE,
        actorId,
        teamId: winnerId,
        data: { matchId, forfeitedByTeamId: forfeitTeamId },
      });
    })();

    return {
      matchId,
      status: MatchStatus.FORFEITED,
      winnerTeam: this.teams.byId(winnerId),
      forfeitedByTeam: this.teams.byId(forfeitTeamId),
    };
  }

  getReport(reportId) {
    const r = this.q.reportById.get(reportId);
    if (!r) throw new NotFoundError('Report not found.');
    return {
      id: r.id,
      matchId: r.match_id,
      reportedByUserId: r.reported_by_user_id,
      homeScore: r.home_score,
      awayScore: r.away_score,
      proofUrl: r.proof_url,
      notes: r.notes,
      status: r.status,
      reviewedByUserId: r.reviewed_by_user_id,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
    };
  }

  listReportsForMatch(matchId) {
    return this.q.reportsForMatch.all(matchId);
  }

  listPendingReports(guildDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    return this.q.pendingReports.all(guildId);
  }

  // --- Standings Engine ---

  getStandings({ guildDiscordId, seasonId = null }) {
    const guildId = this.guilds.require(guildDiscordId);
    const currentSeason = seasonId ? { id: seasonId } : this.seasons.current(guildId);
    if (!currentSeason) return [];

    const games = this.q.completedMatchesInSeason.all(guildId, currentSeason.id);
    const table = new Map();

    const getRow = (teamId) => {
      let r = table.get(teamId);
      if (!r) {
        const team = this.teams.byId(teamId);
        r = {
          team,
          played: 0,
          won: 0,
          lost: 0,
          tied: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          diff: 0,
          pct: 0,
          streak: '',
        };
        table.set(teamId, r);
      }
      return r;
    };

    for (const g of games) {
      const home = getRow(g.home_team_id);
      const away = getRow(g.away_team_id);

      home.played++;
      away.played++;
      home.pointsFor += g.home_score;
      home.pointsAgainst += g.away_score;
      away.pointsFor += g.away_score;
      away.pointsAgainst += g.home_score;

      if (g.home_score > g.away_score) {
        home.won++;
        away.lost++;
      } else if (g.away_score > g.home_score) {
        away.won++;
        home.lost++;
      } else {
        home.tied++;
        away.tied++;
      }
    }

    const rows = [...table.values()].map((r) => {
      r.diff = r.pointsFor - r.pointsAgainst;
      r.pct = r.played > 0 ? (r.won + 0.5 * r.tied) / r.played : 0;
      return r;
    });

    // Standings sort order: win percentage -> total wins -> point differential -> points for
    rows.sort((a, b) => b.pct - a.pct || b.won - a.won || b.diff - a.diff || b.pointsFor - a.pointsFor);
    return rows;
  }

  #applyScoresToMatch(match, homeScore, awayScore, reviewerId, now) {
    let winnerId = null;
    if (homeScore > awayScore) winnerId = match.home_team_id;
    else if (awayScore > homeScore) winnerId = match.away_team_id;

    this.q.completeMatch.run(MatchStatus.COMPLETED, homeScore, awayScore, winnerId, now, match.id);
  }
}
