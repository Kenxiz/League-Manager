import { AuditAction } from '../utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { assertSnowflake, nowSec, sanitizeText } from '../utils/helpers.js';

export class TeamLinkService {
  constructor({ db, guilds, users, teams, audit, clock = nowSec }) {
    this.db = db;
    this.guilds = guilds;
    this.users = users;
    this.teams = teams;
    this.audit = audit;
    this.clock = clock;

    this.q = {
      assignCaptain: db.prepare(`
        INSERT INTO team_captains (guild_id, team_id, user_id, role, assigned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, team_id, user_id) DO UPDATE SET role = excluded.role`),
      removeCaptain: db.prepare('DELETE FROM team_captains WHERE guild_id = ? AND team_id = ? AND user_id = ?'),
      getCaptains: db.prepare(`
        SELECT tc.team_id, tc.role, tc.assigned_at, u.discord_id AS user_discord_id
        FROM team_captains tc
        JOIN users u ON u.id = tc.user_id
        WHERE tc.guild_id = ? AND (? IS NULL OR tc.team_id = ?)
        ORDER BY tc.role, tc.assigned_at`),
      isCaptain: db.prepare('SELECT 1 FROM team_captains WHERE guild_id = ? AND team_id = ? AND user_id = ?'),

      upsertLink: db.prepare(`
        INSERT INTO team_links (guild_id, team_id, external_server_id, invite_url, webhook_url, role_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, team_id) DO UPDATE SET
          external_server_id = COALESCE(excluded.external_server_id, team_links.external_server_id),
          invite_url = COALESCE(excluded.invite_url, team_links.invite_url),
          webhook_url = COALESCE(excluded.webhook_url, team_links.webhook_url),
          role_id = COALESCE(excluded.role_id, team_links.role_id)`),
      getLink: db.prepare('SELECT external_server_id, invite_url, webhook_url, role_id FROM team_links WHERE guild_id = ? AND team_id = ?'),
      allLinks: db.prepare('SELECT team_id, external_server_id, invite_url, webhook_url, role_id FROM team_links WHERE guild_id = ?'),


      upsertPosition: db.prepare(`
        INSERT INTO player_positions (signing_id, position, jersey_number)
        VALUES (?, ?, ?)
        ON CONFLICT(signing_id) DO UPDATE SET
          position = excluded.position,
          jersey_number = excluded.jersey_number`),
      getPosition: db.prepare('SELECT position, jersey_number FROM player_positions WHERE signing_id = ?'),
    };
  }

  // --- Captains ---

  assignCaptain({ guildDiscordId, team, userDiscordId, role = 'captain', actorDiscordId = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const t = this.#team(team);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;
    const cleanRole = sanitizeText(role, { max: 30, label: 'Captain role' });

    const now = this.clock();
    this.q.assignCaptain.run(guildId, t.id, userId, cleanRole, now);

    this.audit.record({
      guildId,
      action: AuditAction.CAPTAIN_ASSIGN,
      actorId,
      targetId: userId,
      teamId: t.id,
      data: { role: cleanRole },
    });

    return {
      team: t,
      userDiscordId,
      role: cleanRole,
      assignedAt: now,
    };
  }

  removeCaptain({ guildDiscordId, team, userDiscordId, actorDiscordId = null }) {
    const guildId = this.guilds.require(guildDiscordId);
    const t = this.#team(team);
    const userId = this.users.ensure(userDiscordId);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;

    const res = this.q.removeCaptain.run(guildId, t.id, userId);
    if (res.changes === 0) throw new NotFoundError('That user is not assigned as a captain for this team.');

    this.audit.record({
      guildId,
      action: AuditAction.CAPTAIN_REMOVE,
      actorId,
      targetId: userId,
      teamId: t.id,
    });

    return { team: t, userDiscordId, removed: true };
  }

  listCaptains(guildDiscordId, team = null) {
    const guildId = this.guilds.require(guildDiscordId);
    const teamId = team ? this.#team(team).id : null;
    const rows = this.q.getCaptains.all(guildId, teamId, teamId);
    return rows.map((r) => ({
      team: this.teams.byId(r.team_id),
      userDiscordId: r.user_discord_id,
      role: r.role,
      assignedAt: r.assigned_at,
    }));
  }

  isCaptain(guildDiscordId, team, userDiscordId) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const t = this.#team(team);
    const userId = this.users.ensure(userDiscordId);
    return !!this.q.isCaptain.get(guildId, t.id, userId);
  }

  /** Checks if a user is an Athletic Director or assigned captain for a team in a guild. */
  isTeamOwnerOrCaptain({ guildDiscordId, team, userDiscordId, memberRoleIds = [], settings = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const t = this.#team(team);
    const userId = this.users.ensure(userDiscordId);

    // 1. Direct captain assignment
    if (this.q.isCaptain.get(guildId, t.id, userId)) return true;

    // 2. Member has the guild's Athletic Director role AND is signed to this team
    const effectiveSettings = settings ?? this.guilds.getSettings(guildId);
    const adRoleIds = new Set(effectiveSettings.athleticDirectorRoleIds ?? []);
    if (adRoleIds.size > 0 && memberRoleIds.some((r) => adRoleIds.has(r))) {
      const isSigned = this.db
        .prepare(
          'SELECT 1 FROM signings WHERE guild_id = ? AND team_id = ? AND user_id = ? AND ended_at IS NULL',
        )
        .get(guildId, t.id, userId);
      if (isSigned) return true;
    }

    return false;
  }

  // --- External Server Linking ---

  setLink({ guildDiscordId, team, externalServerId = null, inviteUrl = null, webhookUrl = null, actorDiscordId = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const t = this.#team(team);
    const actorId = actorDiscordId ? this.users.ensure(actorDiscordId) : null;

    if (externalServerId) assertSnowflake(externalServerId, 'external server ID');
    if (inviteUrl && !/^https?:\/\/(discord\.(gg|com\/invite)|[a-z0-9-.]+)/i.test(inviteUrl)) {
      throw new ValidationError('Invalid invite URL.');
    }
    if (webhookUrl && !/^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\//i.test(webhookUrl)) {
      throw new ValidationError('Invalid Discord webhook URL.');
    }

    this.q.upsertLink.run(guildId, t.id, externalServerId, inviteUrl, webhookUrl, null);

    this.audit.record({
      guildId,
      action: AuditAction.TEAM_LINK_UPDATE,
      actorId,
      teamId: t.id,
      data: { externalServerId, inviteUrl: !!inviteUrl, webhookUrl: !!webhookUrl },
    });

    const current = this.q.getLink.get(guildId, t.id);
    return {
      team: t,
      externalServerId,
      inviteUrl,
      webhookUrl,
      roleId: current?.role_id ?? null,
    };
  }

  setRole({ guildDiscordId, team, roleId = null, actorDiscordId = null }) {
    const guildId = this.guilds.ensure(guildDiscordId);
    const t = this.#team(team);
    if (roleId) assertSnowflake(roleId, 'team role ID');

    this.q.upsertLink.run(guildId, t.id, null, null, null, roleId);
    return { team: t, roleId };
  }

  getRole(guildDiscordId, team) {
    const guildId = this.guilds.require(guildDiscordId);
    const t = this.#team(team);
    const row = this.q.getLink.get(guildId, t.id);
    return row?.role_id ?? null;
  }

  getLink(guildDiscordId, team) {
    const guildId = this.guilds.require(guildDiscordId);
    const t = this.#team(team);
    const row = this.q.getLink.get(guildId, t.id);
    return row
      ? {
          team: t,
          externalServerId: row.external_server_id,
          inviteUrl: row.invite_url,
          webhookUrl: row.webhook_url,
          roleId: row.role_id ?? null,
        }
      : null;
  }

  listLinks(guildDiscordId) {
    const guildId = this.guilds.require(guildDiscordId);
    return this.q.allLinks.all(guildId).map((r) => ({
      team: this.teams.byId(r.team_id),
      externalServerId: r.external_server_id,
      inviteUrl: r.invite_url,
      webhookUrl: r.webhook_url,
      roleId: r.role_id ?? null,
    }));
  }


  // --- Player Positions & Jersey Numbers ---

  setPosition({ signingId, position, jerseyNumber = null }) {
    const cleanPos = sanitizeText(position, { max: 10, label: 'Position' }).toUpperCase();
    let num = null;
    if (jerseyNumber !== null && jerseyNumber !== undefined) {
      num = Number(jerseyNumber);
      if (!Number.isInteger(num) || num < 0 || num > 99) {
        throw new ValidationError('Jersey number must be between 0 and 99.');
      }
    }
    this.q.upsertPosition.run(signingId, cleanPos, num);
    return { signingId, position: cleanPos, jerseyNumber: num };
  }

  getPosition(signingId) {
    const row = this.q.getPosition.get(signingId);
    return row ? { position: row.position, jerseyNumber: row.jersey_number } : null;
  }

  #team(team) {
    if (typeof team === 'number') {
      const t = this.teams.byId(team);
      if (!t) throw new NotFoundError('Unknown team.');
      return t;
    }
    return this.teams.resolve(team);
  }
}
