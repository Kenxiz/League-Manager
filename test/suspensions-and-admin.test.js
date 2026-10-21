import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices } from '../src/services/index.js';
import { createApiServer } from '../src/api/server.js';
import { DEVELOPER_IDS, Permission } from '../src/utils/constants.js';
import { PermissionError, ValidationError, NotFoundError, ConflictError } from '../src/utils/errors.js';
import { buildSuspendModal } from '../src/discord/commands/suspend.js';
import banCommand from '../src/discord/commands/ban.js';
import unbanCommand from '../src/discord/commands/unban.js';
import {
  ensureSuspendedRole,
  runGuildSetup,
  selectInitialTeams,
  addGuildTeam,
} from '../src/discord/setup-helper.js';
import { createEvents } from '../src/discord/events.js';


function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'leaguebot-admin-test-'));
  const dbPath = join(dir, 'test.db');
  let now = 1_700_000_000;
  const clock = () => now;
  const config = {
    discord: { token: 'mock-token', clientId: 'mock-client-id', ownerIds: ['111111111111111111'] },
    database: { path: dbPath },
    compressionLevel: 0,
    api: { port: 0, key: 'test-secret-key' },
  };
  const services = createServices({ config, dbPath, clock, seedTeams: true });
  return {
    dir,
    services,
    config,
    advance: (sec) => { now += sec; },
    cleanup: () => {
      services.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const G1 = '123456789012345678';
const ALICE = '222222222222222222';
const BOB = '333333333333333333';
const CHARLIE = '444444444444444444';
const DEV1 = DEVELOPER_IDS[0]; // 341223005017604116
const DEV2 = DEVELOPER_IDS[1]; // 1301187757737246804
const ROLE_COMMISH = '555555555555555555';
const ROLE_DISCIPLINARY = '666666666666666666';

test('suspensions: suspend with Robux & Dollar bail, audit log, and unsuspend', () => {
  const env = makeEnv();
  try {
    const s = env.services;

    // Initially not suspended
    const gid = s.guilds.ensure(G1);
    const uid = s.users.ensure(BOB);
    assert.equal(s.suspensions.isSuspended(gid, uid), false);

    // Missing reason should fail
    assert.throws(
      () => s.suspensions.suspend({ guildDiscordId: G1, userDiscordId: BOB, reason: '' }),
      ValidationError,
    );

    // Negative bail should fail
    assert.throws(
      () => s.suspensions.suspend({ guildDiscordId: G1, userDiscordId: BOB, reason: 'Toxic', bailRobux: -10 }),
      ValidationError,
    );

    // Valid suspension with both Robux and Dollars bail
    const suspension = s.suspensions.suspend({
      guildDiscordId: G1,
      userDiscordId: BOB,
      reason: 'Unsportsmanlike conduct in match',
      bailRobux: 1500,
      bailDollars: 25.50,
      actorDiscordId: ALICE,
    });

    assert.equal(suspension.reason, 'Unsportsmanlike conduct in match');
    assert.equal(suspension.bailRobux, 1500);
    assert.equal(suspension.bailDollars, 25.5);
    assert.equal(suspension.active, true);

    // isSuspended should now be true
    assert.equal(s.suspensions.isSuspended(gid, uid), true);

    // Active suspension query
    const active = s.suspensions.getActiveSuspension(G1, BOB);
    assert.ok(active);
    assert.equal(active.bailRobux, 1500);
    assert.equal(active.bailDollars, 25.5);
    assert.equal(active.byDiscordId, ALICE);

    // Audit log was created
    const logs = s.audit.list(gid);
    assert.ok(logs.some((l) => l.action === 'user_suspend'));


    // Lift suspension (unsuspend)
    const un = s.suspensions.unsuspend({
      guildDiscordId: G1,
      userDiscordId: BOB,
      actorDiscordId: ALICE,
      reason: 'Bail paid in full via Robux',
    });
    assert.equal(un.unsuspended, true);
    assert.equal(s.suspensions.isSuspended(gid, uid), false);

    // Cannot unsuspend again
    assert.throws(
      () => s.suspensions.unsuspend({ guildDiscordId: G1, userDiscordId: BOB }),
      NotFoundError,
    );
  } finally {
    env.cleanup();
  }
});

test('suspensions block signing to teams until unsuspended', () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const gid = s.guilds.ensure(G1);
    const team = s.teams.resolve('Air Force');
    s.teams.setEnabled(gid, team.id, true);

    // Suspend CHARLIE
    s.suspensions.suspend({
      guildDiscordId: G1,
      userDiscordId: CHARLIE,
      reason: 'Pending disciplinary review',
      bailRobux: 500,
      bailDollars: 0,
      actorDiscordId: ALICE,
    });

    // Attempt to sign CHARLIE -> rejected
    assert.throws(
      () => s.signings.sign({ guildDiscordId: G1, userDiscordId: CHARLIE, team: team.id, actorDiscordId: CHARLIE }),
      (err) => err instanceof ConflictError && err.message.includes('suspended'),
    );

    // Unsuspend CHARLIE
    s.suspensions.unsuspend({
      guildDiscordId: G1,
      userDiscordId: CHARLIE,
      actorDiscordId: ALICE,
    });

    // Now signing succeeds
    const signing = s.signings.sign({
      guildDiscordId: G1,
      userDiscordId: CHARLIE,
      team: team.id,
      actorDiscordId: CHARLIE,
    });
    assert.equal(signing.team.name, team.name);
  } finally {
    env.cleanup();
  }
});

test('permissions: dashboard allowed roles control access to suspension panel', () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const gid = s.guilds.ensure(G1);

    // Configure commissioner role and specific suspension allowed role in dashboard
    s.guilds.updateSettings(gid, {
      commissionerRoleIds: [ROLE_COMMISH],
      suspensionAllowedRoleIds: [ROLE_DISCIPLINARY],
    });
    const settings = s.guilds.getSettings(gid);

    const randomUser = { userId: BOB, roleIds: [] };
    const disciplinaryOfficer = { userId: CHARLIE, roleIds: [ROLE_DISCIPLINARY] };
    const serverOwner = { userId: ALICE, roleIds: [], isGuildOwner: true };

    // Random user cannot suspend
    assert.equal(s.permissions.canSuspend(randomUser, settings), false);
    assert.throws(() => s.permissions.assertCanSuspend(randomUser, settings), PermissionError);

    // Disciplinary officer has allowed role -> authorized
    assert.equal(s.permissions.canSuspend(disciplinaryOfficer, settings), true);
    assert.doesNotThrow(() => s.permissions.assertCanSuspend(disciplinaryOfficer, settings));

    // Server owner is always authorized
    assert.equal(s.permissions.canSuspend(serverOwner, settings), true);
    assert.doesNotThrow(() => s.permissions.assertCanSuspend(serverOwner, settings));

    // If suspensionAllowedRoleIds is empty, commissioners can suspend by default
    s.guilds.updateSettings(gid, { suspensionAllowedRoleIds: [] });
    const commishSettings = s.guilds.getSettings(gid);
    const commishUser = { userId: BOB, roleIds: [ROLE_COMMISH] };
    assert.equal(s.permissions.canSuspend(commishUser, commishSettings), true);
  } finally {
    env.cleanup();
  }
});

test('developer-only bans: ban and unban commands reject non-developers and allow developers', async () => {
  const env = makeEnv();
  try {
    const s = env.services;
    s.guilds.ensure(G1);

    // Mock non-developer interaction
    const nonDevInteraction = {
      user: { id: ALICE, tag: 'Alice#0001' },
      guildId: G1,
      options: {
        getUser: () => ({ id: BOB }),
        getString: () => 'Rule violation',
        getNumber: () => null,
      },
    };

    // Should reject non-developer
    await assert.rejects(
      async () => await banCommand.execute(nonDevInteraction, { services: s, config: env.config }),
      (err) => err instanceof PermissionError && err.message.includes('strictly reserved for League Manager developers'),
    );

    await assert.rejects(
      async () => await unbanCommand.execute(nonDevInteraction, { services: s, config: env.config }),
      (err) => err instanceof PermissionError && err.message.includes('strictly reserved for League Manager developers'),
    );

    // Mock developer interaction
    let replyPayload = null;
    const devInteraction = {
      user: { id: DEV1, tag: 'Developer#0001' },
      guildId: G1,
      options: {
        getUser: () => ({ id: BOB }),
        getString: () => 'Severe exploit abuse',
        getNumber: () => null,
      },
      reply: async (payload) => { replyPayload = payload; },
    };

    // Dev can ban
    await banCommand.execute(devInteraction, { services: s, config: env.config });
    assert.ok(replyPayload);
    const gid = s.guilds.ensure(G1);
    const uid = s.users.ensure(BOB);
    assert.equal(s.bans.isBanned(gid, uid), true);

    // Dev 2 can unban
    const dev2Interaction = {
      user: { id: DEV2, tag: 'Developer2#0001' },
      guildId: G1,
      options: { getUser: () => ({ id: BOB }) },
      reply: async (payload) => { replyPayload = payload; },
    };
    await unbanCommand.execute(dev2Interaction, { services: s, config: env.config });
    assert.equal(s.bans.isBanned(gid, uid), false);
  } finally {
    env.cleanup();
  }
});

test('discord form: buildSuspendModal includes User, Reason, Bail Robux, Bail Dollars', () => {
  const modal = buildSuspendModal(BOB);
  const json = modal.toJSON();

  assert.equal(json.title, 'League Suspension Form');
  assert.equal(json.custom_id, `suspend_modal:${BOB}`);
  assert.equal(json.components.length, 4);

  const [row1, row2, row3, row4] = json.components;
  assert.equal(row1.components[0].custom_id, 'user_input');
  assert.equal(row1.components[0].value, BOB);

  assert.equal(row2.components[0].custom_id, 'reason_input');
  assert.equal(row2.components[0].required, true);

  assert.equal(row3.components[0].custom_id, 'bail_robux_input');
  assert.equal(row3.components[0].required, false);

  assert.equal(row4.components[0].custom_id, 'bail_dollars_input');
  assert.equal(row4.components[0].required, false);
});

test('automatic setup: creates channels, category, core roles and saves config file automatically (no team roles)', async () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const gid = s.guilds.ensure(G1);

    const createdRoles = new Map();
    const createdChannels = new Map();
    let idCounter = 1000;

    const mockGuild = {
      id: G1,
      name: 'CFB Championship League',
      roles: {
        cache: createdRoles,
        everyone: { id: '000000000000000000' },
        create: async (data) => {
          const id = `99900000000000${++idCounter}`;
          const r = { id, name: data.name, color: data.color };
          createdRoles.set(id, r);
          return r;
        },
        fetch: async (id) => createdRoles.get(id) || null,
      },
      channels: {
        cache: createdChannels,
        create: async (data) => {
          const id = `88800000000000${++idCounter}`;
          const c = { id, name: data.name, type: data.type, parentId: data.parent };
          createdChannels.set(id, c);
          return c;
        },
      },

    };

    const result = await runGuildSetup(mockGuild, s);

    // Verify core roles created
    assert.ok(result.roles.suspended);
    assert.equal(result.roles.suspended.name, 'Suspended');
    assert.ok(result.roles.commissioner);
    assert.equal(result.roles.commissioner.name, 'Commissioner');
    assert.ok(result.roles.athleticDirector);
    assert.equal(result.roles.athleticDirector.name, 'Athletic Director');
    assert.ok(result.roles.coach);
    assert.ok(result.roles.freeAgent);
    assert.equal(result.roles.freeAgent.name, 'Free Agent');

    // Verify channels created
    assert.ok(result.category);
    assert.ok(result.channels.schedule);
    assert.ok(result.channels.transactions);
    assert.ok(result.channels.logs);

    // Verify settings updated
    const settings = s.guilds.getSettings(gid);
    assert.equal(settings.suspendedRoleId, result.roles.suspended.id);
    assert.ok(settings.commissionerRoleIds.includes(result.roles.commissioner.id));
    assert.ok(settings.athleticDirectorRoleIds.includes(result.roles.athleticDirector.id));
    assert.ok(settings.coachRoleIds.includes(result.roles.coach.id));
    assert.equal(settings.freeAgentRoleId, result.roles.freeAgent.id);
    assert.equal(settings.scheduleChannelId, result.channels.schedule.id);
    assert.equal(settings.transactionsChannelId, result.channels.transactions.id);
    assert.equal(settings.logChannelId, result.channels.logs.id);

    // CRITICAL: Team roles MUST NOT be automatically created during setup
    // None of the created roles should be a team name
    assert.equal(createdRoles.size, 5); // Only 5 core roles

    // Verify configuration file saved automatically
    const configPath = join(process.cwd(), 'data', 'guild-configs', `${G1}.json`);
    assert.ok(existsSync(configPath), 'guild config file should exist');
    const savedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.guildId, G1);
    assert.equal(savedConfig.roles.suspendedRoleId, result.roles.suspended.id);
    assert.equal(savedConfig.roles.freeAgentRoleId, result.roles.freeAgent.id);

  } finally {
    env.cleanup();
  }
});

test('dashboard team selection: limits to 20 initial teams and allows adding more', async () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const gid = s.guilds.ensure(G1);

    const mockGuildRoles = new Map();
    let idCounter = 5000;
    const mockGuild = {
      id: G1,
      roles: {
        cache: mockGuildRoles,
        create: async (data) => {
          const id = `99900000000000${++idCounter}`;
          const r = { id, name: data.name, color: data.color };
          mockGuildRoles.set(id, r);
          return r;
        },

      },
    };

    // Selecting > 20 teams should fail
    const tooMany = Array.from({ length: 21 }, (_, i) => `team-${i}`);
    await assert.rejects(
      async () => await selectInitialTeams({ guildDiscordId: G1, teamKeysOrIds: tooMany, services: s }),
      ValidationError,
    );

    // Select 3 initial teams (e.g. Air Force, Akron, Alabama)
    const initialSelection = await selectInitialTeams({
      guildDiscordId: G1,
      teamKeysOrIds: ['Air Force', 'Akron', 'Alabama'],
      createRoles: true,
      guild: mockGuild,
      services: s,
    });

    assert.equal(initialSelection.selectedCount, 3);
    assert.equal(initialSelection.teams.length, 3);
    assert.ok(initialSelection.teams[0].roleId);
    assert.equal(mockGuildRoles.size, 3);

    // Verify they are enabled in the guild and others are disabled
    const enabled = s.teams.listForGuild(gid);
    assert.equal(enabled.length, 3);

    // Add an additional team from the dashboard later
    const added = await addGuildTeam({
      guildDiscordId: G1,
      teamKeyOrId: 'Appalachian State',
      createRole: true,
      guild: mockGuild,
      services: s,
    });

    assert.equal(added.team.name, 'Appalachian State');
    assert.ok(added.roleId);

    assert.equal(mockGuildRoles.size, 4);

    const updatedList = s.teams.listForGuild(gid);
    assert.equal(updatedList.length, 4);
  } finally {
    env.cleanup();
  }
});

test('api: suspensions and dashboard team selection endpoints', async () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const api = createApiServer({ config: env.config, services: s });
    const server = await api.listen(0);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    async function req(path, opts = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.config.api.key}`,
          ...opts.headers,
        },
        ...opts,
      });
      return { status: res.status, body: await res.json() };
    }

    try {
      // POST /api/guilds/:guildId/suspensions
      const postRes = await req(`/api/guilds/${G1}/suspensions`, {
        method: 'POST',
        body: JSON.stringify({
          userDiscordId: BOB,
          reason: 'Illegal recruit contact',
          bailRobux: 2000,
          bailDollars: 50.0,
          actorDiscordId: ALICE,
        }),
      });
      assert.equal(postRes.status, 201);
      assert.equal(postRes.body.data.bailRobux, 2000);
      assert.equal(postRes.body.data.bailDollars, 50.0);

      // GET /api/guilds/:guildId/suspensions
      const listRes = await req(`/api/guilds/${G1}/suspensions`);
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.data.length, 1);
      assert.equal(listRes.body.data[0].userDiscordId, BOB);

      // GET /api/guilds/:guildId/suspensions/:userId
      const getRes = await req(`/api/guilds/${G1}/suspensions/${BOB}`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.data.bailRobux, 2000);

      // DELETE /api/guilds/:guildId/suspensions/:userId
      const delRes = await req(`/api/guilds/${G1}/suspensions/${BOB}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.data.unsuspended, true);

      // POST /api/guilds/:guildId/teams/initial (Dashboard team selection)
      const initTeamsRes = await req(`/api/guilds/${G1}/teams/initial`, {
        method: 'POST',
        body: JSON.stringify({
          teamKeysOrIds: ['Air Force', 'Akron'],
          createRoles: false,
        }),
      });
      assert.equal(initTeamsRes.status, 200);
      assert.equal(initTeamsRes.body.data.selectedCount, 2);

      // POST /api/guilds/:guildId/teams (Add a team later)
      const addTeamRes = await req(`/api/guilds/${G1}/teams`, {
        method: 'POST',
        body: JSON.stringify({
          teamKeyOrId: 'Alabama',
          createRole: false,
        }),
      });
      assert.equal(addTeamRes.status, 201);
      assert.equal(addTeamRes.body.data.team.name, 'Alabama');
    } finally {
      await api.close();
    }
  } finally {
    env.cleanup();
  }
});

test('free agent role: assigns to existing members during setup and to new members on join', async () => {
  const env = makeEnv();
  try {
    const s = env.services;
    const gid = s.guilds.ensure(G1);

    const existingMemberRoles = new Set();
    const existingMember = {
      id: BOB,
      user: { id: BOB, bot: false },
      roles: {
        cache: { has: (id) => existingMemberRoles.has(id) },
        add: async (id) => { existingMemberRoles.add(id); },
      },
    };

    const mockGuildRoles = new Map();
    let idCounter = 1000;
    const mockGuild = {
      id: G1,
      name: 'CFB League',
      memberCount: 1,
      roles: {
        cache: mockGuildRoles,
        create: async (data) => {
          const id = `99900000000000${++idCounter}`;
          const r = { id, name: data.name, color: data.color };
          mockGuildRoles.set(id, r);
          return r;
        },
      },
      members: {
        cache: new Map([[BOB, existingMember]]),
        fetch: async () => new Map([[BOB, existingMember]]),
      },
    };

    // Run setup -> assigns Free Agent to existing members
    const setupResult = await runGuildSetup(mockGuild, s);
    const freeAgentRoleId = setupResult.roles.freeAgent.id;
    assert.equal(existingMemberRoles.has(freeAgentRoleId), true);
    assert.equal(setupResult.membersAssignedCount, 1);

    // Test GuildMemberAdd event for joining member
    const newMemberRoles = new Set();
    const newMember = {
      id: CHARLIE,
      user: { id: CHARLIE, bot: false },
      guild: { id: G1 },
      roles: {
        add: async (id) => { newMemberRoles.add(id); },
      },
    };

    const events = createEvents({
      app: { services: s, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
      handleInteraction: () => {},
    });
    const memberAddEvent = events.find((e) => e.name === 'guildMemberAdd');
    assert.ok(memberAddEvent);

    await memberAddEvent.execute(newMember);
    assert.equal(newMemberRoles.has(freeAgentRoleId), true);
  } finally {
    env.cleanup();
  }
});


