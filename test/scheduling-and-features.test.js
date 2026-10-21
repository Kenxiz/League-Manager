import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/services/index.js';
import { silentLogger } from '../src/utils/logger.js';
import { MatchStatus, ReportStatus } from '../src/utils/constants.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/errors.js';

const G1 = '100000000000000001';
const U = (n) => `20000000000000000${n}`.slice(0, 18);
const [ALICE, BOB, CHARLIE] = [U(1), U(2), U(3)];

function setup(clock) {
  const config = loadConfig({}, { requireDiscord: false });
  return createServices({ config, logger: silentLogger, dbPath: ':memory:', clock });
}

test('schedule: create match, detect conflicts, reschedule, and cancel', () => {
  let now = 1_700_000_000;
  const s = setup(() => now);

  // Home and away must be different
  assert.throws(() => s.schedule.createMatch({ guildDiscordId: G1, homeTeam: 'Iowa', awayTeam: 'Iowa' }), ValidationError);

  // Create match
  const match1 = s.schedule.createMatch({
    guildDiscordId: G1,
    week: 1,
    homeTeam: 'Iowa',
    awayTeam: 'Oregon',
    scheduledAt: now + 3600,
    actorDiscordId: ALICE,
  });
  assert.equal(match1.homeTeam.key, 'Iowa');
  assert.equal(match1.awayTeam.key, 'Oregon');
  assert.equal(match1.status, MatchStatus.SCHEDULED);
  assert.equal(match1.week, 1);

  // Conflict detection: Iowa playing another game 30 mins later
  assert.throws(
    () =>
      s.schedule.createMatch({
        guildDiscordId: G1,
        week: 1,
        homeTeam: 'Iowa',
        awayTeam: 'Michigan',
        scheduledAt: now + 3600 + 1800, // 30 mins later (within 2h window)
      }),
    ConflictError,
  );

  // Can bypass conflict with ignoreConflicts
  const match2 = s.schedule.createMatch({
    guildDiscordId: G1,
    week: 1,
    homeTeam: 'Michigan',
    awayTeam: 'LSU',
    scheduledAt: now + 7200,
  });
  assert.equal(match2.status, MatchStatus.SCHEDULED);

  // Reschedule match1
  const updated = s.schedule.rescheduleMatch({
    guildDiscordId: G1,
    matchId: match1.id,
    scheduledAt: now + 14400,
    actorDiscordId: ALICE,
  });
  assert.equal(updated.scheduledAt, now + 14400);

  // Cancel match2
  const cancelled = s.schedule.cancelMatch({ guildDiscordId: G1, matchId: match2.id, reason: 'Weather' });
  assert.equal(cancelled.status, MatchStatus.CANCELLED);

  // List matches
  const all = s.schedule.listMatches({ guildDiscordId: G1 });
  assert.equal(all.length, 2);
});

test('schedule coordination: create thread, /schedule end {time} proposal, mutual tick confirmation', () => {
  let now = 1_700_000_000;
  const s = setup(() => now);
  const THREAD_ID = '300000000000000001';

  // 1. Match created and assigned a coordination thread for both team Athletic Directors
  const match = s.schedule.createMatch({
    guildDiscordId: G1,
    week: 2,
    homeTeam: 'Iowa',
    awayTeam: 'Oregon',
    coordinationThreadId: THREAD_ID,
  });
  assert.equal(match.coordinationThreadId, THREAD_ID);
  assert.equal(match.scheduledAt, null); // Time not locked in yet

  // Lookup match by thread ID
  const found = s.schedule.getByThreadId(THREAD_ID);
  assert.equal(found.id, match.id);

  // 2. Home Athletic Director runs /schedule end {time}
  const targetTime = now + 86400; // Tomorrow
  const proposed = s.schedule.proposeTime({
    guildDiscordId: G1,
    matchId: match.id,
    proposerDiscordId: ALICE, // Home AD
    scheduledAt: targetTime,
    side: 'home',
  });
  assert.equal(proposed.proposedTime, targetTime);
  assert.equal(proposed.scheduledAt, null); // Not locked in yet
  assert.ok(proposed.homeConfirmedAt > 0);
  assert.equal(proposed.awayConfirmedAt, null); // Away has not clicked tick yet

  // 3. Away Athletic Director clicks embed tick to confirm
  const res = s.schedule.confirmProposal({
    guildDiscordId: G1,
    matchId: match.id,
    confirmerDiscordId: BOB, // Away AD
    side: 'away',
  });
  assert.equal(res.fullyConfirmed, true);
  assert.equal(res.match.scheduledAt, targetTime); // Locked in!
  assert.ok(res.match.homeConfirmedAt > 0);
  assert.ok(res.match.awayConfirmedAt > 0);

  // Check Athletic Director role / captain helper
  const g = s.guilds.ensure(G1);
  const AD_ROLE = '400000000000000099';
  s.guilds.updateSettings(g, { athleticDirectorRoleIds: [AD_ROLE] });
  s.signings.sign({ guildDiscordId: G1, userDiscordId: ALICE, team: 'Iowa' });

  assert.ok(
    s.teamLinks.isTeamOwnerOrCaptain({
      guildDiscordId: G1,
      team: 'Iowa',
      userDiscordId: ALICE,
      memberRoleIds: [AD_ROLE],
    }),
  );
  assert.ok(
    !s.teamLinks.isTeamOwnerOrCaptain({
      guildDiscordId: G1,
      team: 'Iowa',
      userDiscordId: ALICE,
      memberRoleIds: ['other_role'],
    }),
  );
});

test('match reports: submit scores, approval, forfeit, and standings', () => {
  let now = 1_700_000_000;
  const s = setup(() => now);

  const m1 = s.schedule.createMatch({ guildDiscordId: G1, week: 1, homeTeam: 'Iowa', awayTeam: 'Oregon' });
  const m2 = s.schedule.createMatch({ guildDiscordId: G1, week: 1, homeTeam: 'Michigan', awayTeam: 'LSU' });

  // Coach submits score
  const report1 = s.matchReports.submitReport({
    guildDiscordId: G1,
    matchId: m1.id,
    reporterDiscordId: BOB,
    homeScore: 24,
    awayScore: 17,
    notes: 'Good game',
  });
  assert.equal(report1.status, ReportStatus.PENDING);
  assert.equal(s.schedule.getMatch(m1.id).status, MatchStatus.SCHEDULED);

  // Commissioner approves score
  const approved = s.matchReports.approveReport({
    guildDiscordId: G1,
    reportId: report1.id,
    actorDiscordId: ALICE,
  });
  assert.equal(approved.status, ReportStatus.APPROVED);

  const m1Updated = s.schedule.getMatch(m1.id);
  assert.equal(m1Updated.status, MatchStatus.COMPLETED);
  assert.equal(m1Updated.homeScore, 24);
  assert.equal(m1Updated.awayScore, 17);
  assert.equal(m1Updated.winnerTeam.key, 'Iowa');

  // Auto-approve test on match 2
  s.matchReports.submitReport({
    guildDiscordId: G1,
    matchId: m2.id,
    reporterDiscordId: ALICE,
    homeScore: 10,
    awayScore: 35,
    autoApprove: true,
  });
  const m2Updated = s.schedule.getMatch(m2.id);
  assert.equal(m2Updated.status, MatchStatus.COMPLETED);
  assert.equal(m2Updated.winnerTeam.key, 'Louisiana State');

  // Check Standings
  const standings = s.matchReports.getStandings({ guildDiscordId: G1 });
  assert.equal(standings.length, 4);
  // LSU and Iowa won, LSU has bigger diff (35-10 = +25 vs 24-17 = +7)
  assert.equal(standings[0].team.key, 'Louisiana State');
  assert.equal(standings[0].won, 1);
  assert.equal(standings[0].diff, 25);
  assert.equal(standings[1].team.key, 'Iowa');
  assert.equal(standings[1].won, 1);
  assert.equal(standings[1].diff, 7);
});

test('team links & captains: assign captain, link server, positions', () => {
  const s = setup();

  // Captains
  const cap = s.teamLinks.assignCaptain({
    guildDiscordId: G1,
    team: 'Iowa',
    userDiscordId: ALICE,
    role: 'Head Coach',
  });
  assert.equal(cap.team.key, 'Iowa');
  assert.equal(cap.role, 'Head Coach');
  assert.ok(s.teamLinks.isCaptain(G1, 'Iowa', ALICE));
  assert.ok(!s.teamLinks.isCaptain(G1, 'Iowa', BOB));

  const list = s.teamLinks.listCaptains(G1, 'Iowa');
  assert.equal(list.length, 1);
  assert.equal(list[0].userDiscordId, ALICE);

  // External server link
  const link = s.teamLinks.setLink({
    guildDiscordId: G1,
    team: 'Iowa',
    externalServerId: '100000000000000099',
    inviteUrl: 'https://discord.gg/hawkeyes',
  });
  assert.equal(link.inviteUrl, 'https://discord.gg/hawkeyes');
  assert.equal(s.teamLinks.getLink(G1, 'Iowa').externalServerId, '100000000000000099');

  // Player positions
  const sign = s.signings.sign({ guildDiscordId: G1, userDiscordId: BOB, team: 'Iowa' });
  const pos = s.teamLinks.setPosition({ signingId: sign.id, position: 'QB', jerseyNumber: 12 });
  assert.equal(pos.position, 'QB');
  assert.equal(pos.jerseyNumber, 12);
  assert.deepEqual(s.teamLinks.getPosition(sign.id), { position: 'QB', jerseyNumber: 12 });
});

test('bans & moderation: league ban blocks signing', () => {
  const s = setup();

  s.bans.ban({
    guildDiscordId: G1,
    userDiscordId: CHARLIE,
    reason: 'Rule violation',
    durationHours: 24,
    actorDiscordId: ALICE,
  });

  const bans = s.bans.listBans(G1);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].userDiscordId, CHARLIE);
  assert.equal(bans[0].reason, 'Rule violation');

  // Attempting to sign while banned throws ConflictError
  assert.throws(
    () => s.signings.sign({ guildDiscordId: G1, userDiscordId: CHARLIE, team: 'Iowa' }),
    /banned from signing/,
  );

  // Unban allows signing
  s.bans.unban({ guildDiscordId: G1, userDiscordId: CHARLIE, actorDiscordId: ALICE });
  const sign = s.signings.sign({ guildDiscordId: G1, userDiscordId: CHARLIE, team: 'Iowa' });
  assert.equal(sign.team.key, 'Iowa');
});

test('verification: roblox link and enforcement', () => {
  const s = setup();
  const g = s.guilds.ensure(G1);

  // Link roblox account
  s.verification.link({ userDiscordId: BOB, robloxId: '12345678', robloxUsername: 'HawkeyePlayer' });
  const link = s.verification.getLink(BOB);
  assert.equal(link.robloxUsername, 'HawkeyePlayer');

  // Enforce verification in guild settings
  s.guilds.updateSettings(g, { requireRobloxVerification: true });

  // Unverified user fails to sign
  assert.throws(
    () => s.signings.sign({ guildDiscordId: G1, userDiscordId: CHARLIE, team: 'Iowa' }),
    /must link your Roblox account/,
  );

  // Verified user can sign
  const sign = s.signings.sign({ guildDiscordId: G1, userDiscordId: BOB, team: 'Iowa' });
  assert.equal(sign.team.key, 'Iowa');
});
