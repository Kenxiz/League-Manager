import { PermissionError } from '../utils/errors.js';
import { ALL_PERMISSIONS, DEFAULT_TIER_PERMISSIONS, Permission, TIER_ORDER, Tier } from '../utils/constants.js';

const PERMISSION_NAMES = Object.entries(Permission);

/**
 * Role-based access control.
 *
 * A caller is described by a plain `Actor` (extracted from a Discord interaction by the
 * Discord layer - see discord/context.js), so this logic is independent of discord.js and
 * trivially testable.
 *
 * Tier resolution (highest match wins):
 *   admin         bot owner, server owner, Discord "Administrator", or a role in adminRoleIds
 *   commissioner  a role in commissionerRoleIds
 *   coach         a role in coachRoleIds (or ANY member when coachRoleIds is empty)
 *   member        everyone else
 *
 * Permissions are cumulative (a tier includes every lower tier's permissions), tier masks can
 * be overridden per guild, and the admin tier can never be reduced (no lock-outs).
 *
 * @typedef {object} Actor
 * @property {string} userId
 * @property {string[]} roleIds
 * @property {boolean} [isGuildOwner]
 * @property {boolean} [isDiscordAdmin]  member has the Discord Administrator permission
 * @property {boolean} [isBotOwner]      listed in BOT_OWNER_IDS
 */
export class PermissionService {
  /**
   * @param {Actor} actor
   * @param {import('./settings-schema.js').GuildSettings} settings
   * @returns {{ tier: string, permissions: number, has: (p: number) => boolean }}
   */
  resolve(actor, settings) {
    const roles = new Set(actor.roleIds ?? []);
    const hasAny = (list) => list.some((id) => roles.has(id));

    let tier = Tier.MEMBER;
    if (settings.coachRoleIds.length === 0 || hasAny(settings.coachRoleIds)) tier = Tier.COACH;
    if (hasAny(settings.commissionerRoleIds)) tier = Tier.COMMISSIONER;
    if (actor.isBotOwner || actor.isGuildOwner || actor.isDiscordAdmin || hasAny(settings.adminRoleIds)) {
      tier = Tier.ADMIN;
    }

    let permissions = 0;
    for (const t of TIER_ORDER) {
      permissions |= t === Tier.ADMIN ? ALL_PERMISSIONS : settings.permissionOverrides[t] ?? DEFAULT_TIER_PERMISSIONS[t];
      if (t === tier) break;
    }
    return { tier, permissions, has: (p) => (permissions & p) === p };
  }

  /** Throws PermissionError unless the actor holds every flag in `required`. */
  assert(actor, settings, required, message) {
    const r = this.resolve(actor, settings);
    if (!r.has(required)) throw new PermissionError(message ?? `You need the ${describe(required)} permission for that.`);
    return r;
  }

  /** Signing yourself needs SIGN_SELF; signing someone else needs SIGN_OTHERS. */
  assertCanSign(actor, settings, targetUserId) {
    return this.assert(actor, settings, actor.userId === targetUserId ? Permission.SIGN_SELF : Permission.SIGN_OTHERS);
  }

  assertCanRelease(actor, settings, targetUserId) {
    return this.assert(
      actor,
      settings,
      actor.userId === targetUserId ? Permission.RELEASE_SELF : Permission.RELEASE_OTHERS,
    );
  }

  /** Checks whether the actor is authorized to use the suspension panel/command. */
  canSuspend(actor, settings) {
    if (actor.isBotOwner || actor.isGuildOwner || actor.isDiscordAdmin) return true;
    const roles = new Set(actor.roleIds ?? []);
    if (settings.adminRoleIds?.some((id) => roles.has(id))) return true;
    if (settings.suspensionAllowedRoleIds && settings.suspensionAllowedRoleIds.length > 0) {
      return settings.suspensionAllowedRoleIds.some((id) => roles.has(id));
    }
    return this.resolve(actor, settings).has(Permission.SUSPEND_USERS);
  }

  assertCanSuspend(actor, settings, message) {
    if (!this.canSuspend(actor, settings)) {
      throw new PermissionError(message ?? 'You do not have permission to use the suspensions panel.');
    }
    return true;
  }

  /**
   * Which permission a settings patch requires. Anything touching who-has-power (roles, tier
   * masks) needs MANAGE_PERMISSIONS; the rest needs MANAGE_SETTINGS.
   */
  requiredForSettingsPatch(patch) {
    const powerKeys = [
      'adminRoleIds',
      'commissionerRoleIds',
      'coachRoleIds',
      'permissionOverrides',
      'suspensionAllowedRoleIds',
    ];
    return Object.keys(patch).some((k) => powerKeys.includes(k))
      ? Permission.MANAGE_PERMISSIONS
      : Permission.MANAGE_SETTINGS;
  }
}


export function describe(mask) {
  return PERMISSION_NAMES.filter(([, bit]) => (mask & bit) === bit && bit !== 0)
    .map(([name]) => name.toLowerCase().replace(/_/g, ' '))
    .join(' + ');
}
