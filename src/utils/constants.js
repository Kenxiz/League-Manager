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
});

export const AuditActionName = Object.freeze(
  Object.fromEntries(Object.entries(AuditAction).map(([k, v]) => [v, k.toLowerCase()])),
);

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
  [Tier.COACH]: Permission.VIEW | Permission.SIGN_SELF | Permission.RELEASE_SELF,
  [Tier.COMMISSIONER]:
    Permission.VIEW |
    Permission.SIGN_SELF |
    Permission.RELEASE_SELF |
    Permission.SIGN_OTHERS |
    Permission.RELEASE_OTHERS |
    Permission.MANAGE_TEAMS |
    Permission.MANAGE_SEASONS |
    Permission.VIEW_AUDIT,
  [Tier.ADMIN]: ALL_PERMISSIONS,
});
