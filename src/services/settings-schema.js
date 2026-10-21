import { z } from 'zod';
import { snowflakeSchema as snowflake } from '../config/index.js';
import { ALL_PERMISSIONS } from '../utils/constants.js';

const roleList = z.array(snowflake).max(25).default([]);
const mask = z.number().int().min(0).max(ALL_PERMISSIONS);

/**
 * Per-guild settings. Every field MUST have a default: the defaults are what we do NOT
 * persist (see GuildService - only the diff vs. these defaults is stored, compressed).
 *
 * Add new settings freely; guilds that never touched them automatically get the default.
 * Removing/renaming a setting: old stored keys are dropped on read (`stripUnknown`).
 */
export const settingsSchema = z.strictObject({
  // Role -> tier mapping (see PermissionService)
  adminRoleIds: roleList,
  commissionerRoleIds: roleList,
  /** Role designated for team owners / Athletic Directors to coordinate and confirm match times. */
  athleticDirectorRoleIds: roleList,
  /** Empty = every member counts as a coach (open league). */
  coachRoleIds: roleList,

  /** Per-tier permission mask overrides. Missing tier = built-in default. */
  permissionOverrides: z
    .strictObject({
      member: mask.optional(),
      coach: mask.optional(),
      commissioner: mask.optional(),
      admin: mask.optional(),
    })
    .default({}),

  // League rules
  signingsOpen: z.boolean().default(true),
  maxTeamsPerUser: z.number().int().min(1).max(10).default(1),
  maxUsersPerTeam: z.number().int().min(1).max(25).default(1),
  /** Hours a user must wait after being released before signing again (0 = none). */
  signingCooldownHours: z.number().int().min(0).max(24 * 60).default(0),

  // Channels (optional; features that post messages read these)
  logChannelId: snowflake.nullable().default(null),
  transactionsChannelId: snowflake.nullable().default(null),
  scheduleChannelId: snowflake.nullable().default(null),

  // Verification & integrations
  requireRobloxVerification: z.boolean().default(false),
  requireGroupJoin: z.boolean().default(false),

  // Administration & Suspensions
  /** Roles allowed to use the suspension panel/command (configured in dashboard or settings). */
  suspensionAllowedRoleIds: roleList,
  /** Discord snowflake ID of the @Suspended role (auto-created during setup if missing). */
  suspendedRoleId: snowflake.nullable().default(null),
  /** Discord snowflake ID of the @Free Agent role (given to all members on join or during setup). */
  freeAgentRoleId: snowflake.nullable().default(null),
});



/** @typedef {z.infer<typeof settingsSchema>} GuildSettings */

export const DEFAULT_SETTINGS = Object.freeze(settingsSchema.parse({}));

/** Returns only the keys of `settings` that differ from the defaults. */
export function diffFromDefaults(settings) {
  const diff = {};
  for (const [k, v] of Object.entries(settings)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_SETTINGS[k])) diff[k] = v;
  }
  return diff;
}

/**
 * Re-hydrates a stored diff. Unknown (legacy) keys are dropped and invalid values fall
 * back to defaults key-by-key, so a bad/obsolete stored value can never brick a guild.
 */
export function hydrateSettings(diff) {
  const merged = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(diff ?? {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const candidate = settingsSchema.safeParse({ ...merged, [k]: v });
    if (candidate.success) merged[k] = candidate.data[k];
  }
  return Object.freeze(merged);
}
