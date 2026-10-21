import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ValidationError } from '../utils/errors.js';

const CONFIG_DIR = fileURLToPath(new URL('../../data/guild-configs/', import.meta.url));

/**
 * Saves a guild's configuration snapshot to data/guild-configs/<guildId>.json automatically.
 */
export function saveGuildConfigFile(guildDiscordId, data) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const filePath = join(CONFIG_DIR, `${guildDiscordId}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  } catch (err) {
    // Non-fatal if filesystem is read-only in some environments
    return null;
  }
}

export function findInCache(cache, predicate) {
  if (!cache) return null;
  if (typeof cache.find === 'function') return cache.find(predicate);
  if (typeof cache.values === 'function') {
    for (const item of cache.values()) {
      if (predicate(item)) return item;
    }
  }
  return null;
}

/**
 * Ensures a role exists by name (case-insensitive) or creates it.
 */
async function ensureRole(guild, roleName, color, reason, permissions = []) {
  if (!guild?.roles) return null;
  const existing = findInCache(guild.roles.cache, (r) => r.name.toLowerCase() === roleName.toLowerCase());
  if (existing) return existing;

  try {
    return await guild.roles.create({
      name: roleName,
      color,
      reason,
      permissions,
    });
  } catch (err) {
    return null;
  }
}


/**
 * Ensures the @Suspended role exists, updates guild settings, and returns the role object.
 */
export async function ensureSuspendedRole(guild, services) {
  if (!guild) return null;
  const guildId = services.guilds.ensure(guild.id);
  const settings = services.guilds.getSettings(guildId);

  // 1. If configured in settings, check if it still exists in the Discord guild
  if (settings.suspendedRoleId) {
    let role = guild.roles.cache?.get?.(settings.suspendedRoleId);
    if (!role && typeof guild.roles.fetch === 'function') {
      try {
        role = await guild.roles.fetch(settings.suspendedRoleId);
      } catch {
        role = null;
      }
    }
    if (role) return role;
  }

  // 2. Search for existing role or create
  const role = await ensureRole(
    guild,
    'Suspended',
    0x80848e,
    'Automatic setup: LeagueBot Suspended role',
    [],
  );

  if (role) {
    services.guilds.updateSettings(guildId, { suspendedRoleId: role.id });
  }
  return role;
}

/**
 * Runs the full automatic setup for a guild:
 * Creates necessary core roles, category, and channels to run the bot.
 * Persists all IDs automatically to guild settings and data/guild-configs/<guildId>.json.
 * NOTE: DOES NOT create the 143 team roles; teams are selected via the dashboard (up to 20 initial).
 */
export async function runGuildSetup(guild, services) {
  if (!guild) return null;
  const guildId = services.guilds.ensure(guild.id);
  const currentSettings = services.guilds.getSettings(guildId);

  // --- 1. Roles ---
  const suspendedRole = await ensureSuspendedRole(guild, services);

  const commissionerRole = await ensureRole(
    guild,
    'Commissioner',
    0xed4245,
    'Automatic setup: LeagueBot Commissioner role',
  );

  const athleticDirectorRole = await ensureRole(
    guild,
    'Athletic Director',
    0xfee75c,
    'Automatic setup: LeagueBot Athletic Director role (team coordination & schedule confirmation)',
  );

  const coachRole = await ensureRole(
    guild,
    'Coach',
    0x5865f2,
    'Automatic setup: LeagueBot Coach role',
  );

  const freeAgentRole = await ensureRole(
    guild,
    'Free Agent',
    0x3498db,
    'Automatic setup: LeagueBot Free Agent role (assigned to all players)',
  );

  // --- Assign Free Agent role to all existing server members ---
  let membersAssignedCount = 0;
  if (freeAgentRole && guild.members) {
    try {
      let members = guild.members.cache;
      if (typeof guild.members.fetch === 'function' && guild.memberCount > (members?.size ?? 0)) {
        try {
          members = await guild.members.fetch();
        } catch {}
      }
      if (members) {
        const memberList = typeof members.values === 'function' ? [...members.values()] : [];
        for (const member of memberList) {
          if (member.user?.bot) continue;
          const hasRole = member.roles?.cache
            ? (typeof member.roles.cache.has === 'function' ? member.roles.cache.has(freeAgentRole.id) : false)
            : false;
          if (!hasRole && typeof member.roles?.add === 'function') {
            try {
              await member.roles.add(freeAgentRole.id, 'Automatic setup: assign Free Agent role');
              membersAssignedCount++;
            } catch {}
          }
        }
      }
    } catch {}
  }

  // --- 2. Category & Channels ---
  let category = null;
  let scheduleChannel = null;
  let transactionsChannel = null;
  let logChannel = null;

  if (guild.channels) {
    // Category: "🏈 LEAGUE BOT"
    category = findInCache(
      guild.channels.cache,
      (c) => c.type === ChannelType.GuildCategory && c.name?.toLowerCase().includes('league bot'),
    );
    if (!category && typeof guild.channels.create === 'function') {
      try {
        category = await guild.channels.create({
          name: '🏈 LEAGUE BOT',
          type: ChannelType.GuildCategory,
          reason: 'Automatic setup: LeagueBot Category',
        });
      } catch {}
    }

    const parentId = category?.id ?? null;

    // Channel 1: #league-schedule
    scheduleChannel =
      (currentSettings.scheduleChannelId ? guild.channels.cache?.get?.(currentSettings.scheduleChannelId) : null) ||
      findInCache(guild.channels.cache, (c) => c.name === 'league-schedule' || c.name === 'schedule');
    if (!scheduleChannel && typeof guild.channels.create === 'function') {
      try {
        scheduleChannel = await guild.channels.create({
          name: 'league-schedule',
          type: ChannelType.GuildText,
          parent: parentId,
          topic: 'Official match schedules, game announcements, and team coordination.',
          reason: 'Automatic setup: LeagueBot Schedule channel',
        });
      } catch {}
    }

    // Channel 2: #transactions
    transactionsChannel =
      (currentSettings.transactionsChannelId ? guild.channels.cache?.get?.(currentSettings.transactionsChannelId) : null) ||
      findInCache(guild.channels.cache, (c) => c.name === 'transactions' || c.name === 'signings');
    if (!transactionsChannel && typeof guild.channels.create === 'function') {
      try {
        transactionsChannel = await guild.channels.create({
          name: 'transactions',
          type: ChannelType.GuildText,
          parent: parentId,
          topic: 'Official player signings, releases, and transfers.',
          reason: 'Automatic setup: LeagueBot Transactions channel',
        });
      } catch {}
    }

    // Channel 3: #league-logs (Private to staff/commissioners)
    logChannel =
      (currentSettings.logChannelId ? guild.channels.cache?.get?.(currentSettings.logChannelId) : null) ||
      findInCache(guild.channels.cache, (c) => c.name === 'league-logs' || c.name === 'mod-logs');

    if (!logChannel && typeof guild.channels.create === 'function') {
      try {
        const permissionOverwrites = [];
        if (guild.roles?.everyone) {
          permissionOverwrites.push({
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          });
        }
        if (commissionerRole) {
          permissionOverwrites.push({
            id: commissionerRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          });
        }
        logChannel = await guild.channels.create({
          name: 'league-logs',
          type: ChannelType.GuildText,
          parent: parentId,
          topic: 'League moderation, suspensions, and audit logs.',
          reason: 'Automatic setup: LeagueBot Log channel',
          permissionOverwrites,
        });
      } catch {}
    }
  }

  // --- 3. Build Settings Patch ---
  const commissionerRoleIds = [
    ...new Set([...currentSettings.commissionerRoleIds, ...(commissionerRole ? [commissionerRole.id] : [])]),
  ];
  const athleticDirectorRoleIds = [
    ...new Set([...currentSettings.athleticDirectorRoleIds, ...(athleticDirectorRole ? [athleticDirectorRole.id] : [])]),
  ];
  const coachRoleIds = [
    ...new Set([...currentSettings.coachRoleIds, ...(coachRole ? [coachRole.id] : [])]),
  ];
  const suspensionAllowedRoleIds = [
    ...new Set([...currentSettings.suspensionAllowedRoleIds, ...commissionerRoleIds]),
  ];

  const patch = {
    suspendedRoleId: suspendedRole?.id ?? currentSettings.suspendedRoleId,
    commissionerRoleIds,
    athleticDirectorRoleIds,
    coachRoleIds,
    suspensionAllowedRoleIds,
    freeAgentRoleId: freeAgentRole?.id ?? currentSettings.freeAgentRoleId,
    scheduleChannelId: scheduleChannel?.id ?? currentSettings.scheduleChannelId,
    transactionsChannelId: transactionsChannel?.id ?? currentSettings.transactionsChannelId,
    logChannelId: logChannel?.id ?? currentSettings.logChannelId,
  };

  const { after: settings } = services.guilds.updateSettings(guildId, patch);

  // --- 4. Automatically Save Configuration File ---
  const fileData = {
    guildId: guild.id,
    guildName: guild.name,
    updatedAt: Math.floor(Date.now() / 1000),
    channels: {
      categoryId: category?.id ?? null,
      scheduleChannelId: settings.scheduleChannelId,
      transactionsChannelId: settings.transactionsChannelId,
      logChannelId: settings.logChannelId,
    },
    roles: {
      suspendedRoleId: settings.suspendedRoleId,
      commissionerRoleIds: settings.commissionerRoleIds,
      athleticDirectorRoleIds: settings.athleticDirectorRoleIds,
      coachRoleIds: settings.coachRoleIds,
      freeAgentRoleId: settings.freeAgentRoleId,
      suspensionAllowedRoleIds: settings.suspensionAllowedRoleIds,
    },
    settings,
  };

  saveGuildConfigFile(guild.id, fileData);

  return {
    guildId: guild.id,
    guildName: guild.name,
    category,
    channels: {
      schedule: scheduleChannel,
      transactions: transactionsChannel,
      logs: logChannel,
    },
    roles: {
      suspended: suspendedRole,
      commissioner: commissionerRole,
      athleticDirector: athleticDirectorRole,
      coach: coachRole,
      freeAgent: freeAgentRole,
    },
    membersAssignedCount,
    settings,
    fileSaved: true,
  };

}

/**
 * Initial Team Selection from the Dashboard:
 * Allows user to choose up to 20 initial teams.
 * Enables chosen teams (disables the rest), optionally creates Discord team roles with matching catalog colors.
 */
export async function selectInitialTeams({
  guildDiscordId,
  teamKeysOrIds,
  createRoles = true,
  guild = null,
  services,
}) {
  if (!Array.isArray(teamKeysOrIds)) {
    throw new ValidationError('teamKeysOrIds must be an array of team keys or IDs.');
  }

  if (teamKeysOrIds.length > 20) {
    throw new ValidationError('Initial team selection is limited to a maximum of 20 teams.');
  }

  const guildId = services.guilds.ensure(guildDiscordId);
  const catalog = services.teams.listForGuild ? services.teams.listForGuild(guildId) : [];

  // 1. Resolve selected teams
  const selectedTeams = teamKeysOrIds.map((item) => services.teams.resolve(item));
  const selectedIds = new Set(selectedTeams.map((t) => t.id));

  // 2. Disable all catalog teams first, then enable only selected ones
  const allTeams = services.teams.search('', { limit: 200 });
  for (const t of allTeams) {
    const shouldEnable = selectedIds.has(t.id);
    services.teams.setEnabled(guildId, t.id, shouldEnable);
  }

  // 3. Create Discord roles for the selected teams if requested and guild available
  const teamRoles = [];
  for (const team of selectedTeams) {
    let roleId = services.teamLinks.getRole(guildDiscordId, team.id);

    if (!roleId && createRoles && guild?.roles) {
      // Check if role with this name already exists in guild
      let role = findInCache(guild.roles.cache, (r) => r.name.toLowerCase() === team.name.toLowerCase());
      if (!role && typeof guild.roles.create === 'function') {
        try {
          role = await guild.roles.create({
            name: team.name,
            color: team.colors?.primary ?? 0x5865f2,
            reason: `Dashboard initial team setup: ${team.fullName || team.name}`,
          });
        } catch {}
      }
      if (role) {
        roleId = role.id;
        services.teamLinks.setRole({ guildDiscordId, team: team.id, roleId: role.id });
      }
    }

    teamRoles.push({
      team,
      roleId: roleId ?? null,
    });
  }

  // 4. Update the saved file snapshot
  const settings = services.guilds.getSettings(guildId);
  const fileData = {
    guildId: guildDiscordId,
    guildName: guild?.name ?? 'CFB League',
    updatedAt: Math.floor(Date.now() / 1000),
    teams: teamRoles.map((tr) => ({
      id: tr.team.id,
      name: tr.team.name,
      key: tr.team.key,
      roleId: tr.roleId,
    })),
    settings,
  };
  saveGuildConfigFile(guildDiscordId, fileData);

  return {
    guildDiscordId,
    selectedCount: selectedTeams.length,
    teams: teamRoles,
  };
}

/**
 * Adds an additional team from the dashboard after initial setup.
 */
export async function addGuildTeam({
  guildDiscordId,
  teamKeyOrId,
  createRole = true,
  guild = null,
  services,
}) {
  const guildId = services.guilds.ensure(guildDiscordId);
  const team = services.teams.resolve(teamKeyOrId);

  services.teams.setEnabled(guildId, team.id, true);

  let roleId = services.teamLinks.getRole(guildDiscordId, team.id);
  if (!roleId && createRole && guild?.roles) {
    let role = findInCache(guild.roles.cache, (r) => r.name.toLowerCase() === team.name.toLowerCase());
    if (!role && typeof guild.roles.create === 'function') {
      try {
        role = await guild.roles.create({
          name: team.name,
          color: team.colors?.primary ?? 0x5865f2,
          reason: `Dashboard added team: ${team.fullName || team.name}`,
        });
      } catch {}
    }
    if (role) {
      roleId = role.id;
      services.teamLinks.setRole({ guildDiscordId, team: team.id, roleId: role.id });
    }
  }

  return {
    team,
    roleId: roleId ?? null,
    enabled: true,
  };
}

