/**
 * Numeric enums persisted in the database. Small ints keep rows tiny; NEVER renumber
 * an existing value, only append.
 */

/** Why a signing ended. */
export const EndReason = Object.freeze({
  RELEASED: 1,
  TRANSFERRED: 2,
  SEASON_END: 3,
  REMOVED: 4, // admin/commissioner removal
});

/** Audit log action codes. */
export const AuditAction = Object.freeze({
  SIGN: 1,
  RELEASE: 2,
  TRANSFER: 3,
  SEASON_START: 4,
  SEASON_END: 5,
  SETTINGS_UPDATE: 6,
  TEAM_TOGGLE: 7,
  GUILD_RESET: 8,
  MATCH_CREATE: 9,
  MATCH_UPDATE: 10,
  MATCH_REPORT: 11,
  MATCH_APPROVE: 12,
  CAPTAIN_ASSIGN: 13,
  CAPTAIN_REMOVE: 14,
  TEAM_LINK_UPDATE: 15,
  ROBLOX_LINK: 16,
  ROBLOX_UNLINK: 17,
  USER_BAN: 18,
  USER_UNBAN: 19,
  USER_SUSPEND: 20,
  USER_UNSUSPEND: 21,
});

/** Bot developers with reserved authority for permanent bans. */
export const DEVELOPER_IDS = Object.freeze(['341223005017604116', '1301187757737246804']);

export const AuditActionName = Object.freeze(
  Object.fromEntries(Object.entries(AuditAction).map(([k, v]) => [v, k.toLowerCase()])),
);

/** Match lifecycle statuses. */
export const MatchStatus = Object.freeze({
  SCHEDULED: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  CANCELLED: 4,
  FORFEITED: 5,
});

export const MatchStatusName = Object.freeze(
  Object.fromEntries(Object.entries(MatchStatus).map(([k, v]) => [v, k.toLowerCase()])),
);

/** Score report workflow statuses. */
export const ReportStatus = Object.freeze({
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
});

/**
 * Permission bit flags. A user's effective permissions are the OR of the flags granted
 * to their tier (see services/permissions.js). Max 31 flags so masks fit a JS int32.
 */
export const Permission = Object.freeze({
  VIEW: 1 << 0, // read-only commands (rosters, teams, history)
  SIGN_SELF: 1 << 1,
  RELEASE_SELF: 1 << 2,
  SIGN_OTHERS: 1 << 3,
  RELEASE_OTHERS: 1 << 4,
  MANAGE_TEAMS: 1 << 5, // enable/disable teams for the guild
  MANAGE_SEASONS: 1 << 6,
  MANAGE_SETTINGS: 1 << 7,
  VIEW_AUDIT: 1 << 8,
  MANAGE_PERMISSIONS: 1 << 9, // change role->tier mapping & tier masks
  MANAGE_SCHEDULE: 1 << 10, // create/edit match schedules
  REPORT_SCORES: 1 << 11, // report match scores
  APPROVE_SCORES: 1 << 12, // verify and confirm match reports
  MANAGE_CAPTAINS: 1 << 13, // assign/remove team captains
  MODERATE_USERS: 1 << 14, // ban/unban players from league
  SUSPEND_USERS: 1 << 15, // suspend/unsuspend players with bail
});

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0);

/** Permission tiers, lowest to highest. */
export const Tier = Object.freeze({
  MEMBER: 'member',
  COACH: 'coach',
  COMMISSIONER: 'commissioner',
  ADMIN: 'admin',
});
export const TIER_ORDER = Object.freeze([Tier.MEMBER, Tier.COACH, Tier.COMMISSIONER, Tier.ADMIN]);

/** Default permission mask for each tier (guilds can override per tier via settings). */
export const DEFAULT_TIER_PERMISSIONS = Object.freeze({
  [Tier.MEMBER]: Permission.VIEW,
  [Tier.COACH]:
    Permission.VIEW |
    Permission.SIGN_SELF |
    Permission.RELEASE_SELF |
    Permission.REPORT_SCORES,
  [Tier.COMMISSIONER]:
    Permission.VIEW |
    Permission.SIGN_SELF |
    Permission.RELEASE_SELF |
    Permission.SIGN_OTHERS |
    Permission.RELEASE_OTHERS |
    Permission.MANAGE_TEAMS |
    Permission.MANAGE_SEASONS |
    Permission.VIEW_AUDIT |
    Permission.MANAGE_SCHEDULE |
    Permission.REPORT_SCORES |
    Permission.APPROVE_SCORES |
    Permission.MANAGE_CAPTAINS |
    Permission.MODERATE_USERS |
    Permission.SUSPEND_USERS,
  [Tier.ADMIN]: ALL_PERMISSIONS,
});

