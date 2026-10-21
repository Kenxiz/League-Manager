import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/services/index.js';
import { silentLogger } from '../src/utils/logger.js';
import { createCodec } from '../src/utils/compression.js';
import { Permission, Tier, EndReason } from '../src/utils/constants.js';
import { ConflictError, PermissionError, ValidationError } from '../src/utils/errors.js';
import { redact, createLogger } from '../src/utils/logger.js';
import { RateLimiter, sanitizeText } from '../src/utils/helpers.js';

const G1 = '100000000000000001';
const G2 = '100000000000000002';
const U = (n) => `20000000000000000${n}`.slice(0, 18);
const [ALICE, BOB, CAROL] = [U(1), U(2), U(3)];

function setup(clock) {
  const config = loadConfig({}, { requireDiscord: false });
  return createServices({ config, logger: silentLogger, dbPath: ':memory:', clock });
}

test('codec: round-trips, stays raw when tiny, compresses when large', () => {
  const codec = createCodec();
  const small = { a: 1 };
  assert.equal(codec.pack(small)[0], 0);
  assert.deepEqual(codec.unpack(codec.pack(small)), small);
  const big = { list: Array.from({ length: 400 }, (_, i) => i % 7) };
  const blob = codec.pack(big);
  assert.equal(blob[0], 1);
  assert.ok(blob.length < JSON.stringify(big).length / 3);
  assert.deepEqual(codec.unpack(blob), big);
  assert.equal(codec.unpack(null), null);
});

test('team catalog: all 143 teams seeded (not just active), search + resolve work', () => {
  const s = setup();
  assert.equal(s.teams.count(), 143);
  assert.equal(s.teams.all().filter((t) => t.active).length, 8);
  assert.equal(s.teams.resolve('LSU').key, 'Louisiana State');
  assert.equal(s.teams.resolve('texas tech red raiders').key, 'Texas Tech');
  assert.equal(s.teams.resolve('Virginia Caveliers').key, 'Virginia'); // source-data alias
  assert.throws(() => s.teams.resolve('UNM'), ValidationError); // abbreviation shared by 2 teams
  assert.ok(s.teams.search('mich').some((t) => t.key === 'Michigan'));
  assert.ok(s.teams.conferences().includes('Big Ten'));
  // seeding is idempotent and ids are stable
  const id = s.teams.byKey('Iowa').id;
  s.teams.seed();
  assert.equal(s.teams.byKey('Iowa').id, id);
  assert.equal(s.teams.count(), 143);
});

test('settings: defaults cost nothing, only the diff is stored', () => {
  const s = setup();
  const g = s.guilds.ensure(G1);
  assert.equal(s.db.prepare('SELECT settings FROM guilds WHERE id=?').get(g).settings, null);
  s.guilds.updateSettings(g, { maxUsersPerTeam: 3 });
  assert.equal(s.guilds.getSettings(g).maxUsersPerTeam, 3);
  assert.equal(s.guilds.getSettings(g).signingsOpen, true);
  const stored = s.codec.unpack(s.db.prepare('SELECT settings FROM guilds WHERE id=?').get(g).settings);
  assert.deepEqual(stored, { maxUsersPerTeam: 3 });
  assert.throws(() => s.guilds.updateSettings(g, { maxUsersPerTeam: 999 }), ValidationError);
  assert.throws(() => s.guilds.updateSettings(g, { bogus: 1 }), ValidationError);
  s.guilds.updateSettings(g, { maxUsersPerTeam: 1 });
  assert.equal(s.db.prepare('SELECT settings FROM guilds WHERE id=?').get(g).settings, null);
});

test('signing: sign / limits / release / transfer, isolated per guild', () => {
  const s = setup();
  const base = { guildDiscordId: G1 };
  const a = s.signings.sign({ ...base, userDiscordId: ALICE, team: 'Iowa' });
  assert.equal(a.team.key, 'Iowa');

  assert.throws(() => s.signings.sign({ ...base, userDiscordId: BOB, team: 'Iowa' }), /full/);
  assert.throws(() => s.signings.sign({ ...base, userDiscordId: ALICE, team: 'Oregon' }), ConflictError);
  // another guild is completely independent
  s.signings.sign({ guildDiscordId: G2, userDiscordId: BOB, team: 'Iowa' });

  const t = s.signings.transfer({ ...base, userDiscordId: ALICE, to: 'Oregon' });
  assert.equal(t.to.team.key, 'Oregon');
  assert.equal(s.signings.forUser(G1, ALICE)[0].team.key, 'Oregon');
  assert.equal(s.signings.roster(G1, 'Iowa').length, 0);

  s.signings.release({ ...base, userDiscordId: ALICE, actorDiscordId: BOB });
  assert.equal(s.signings.forUser(G1, ALICE).length, 0);
  const h = s.signings.history(G1, ALICE);
  assert.deepEqual(h.map((x) => x.endReason), [EndReason.REMOVED, EndReason.TRANSFERRED]);

  // disabled team can't be signed; high school teams are off by default
  assert.throws(() => s.signings.sign({ ...base, userDiscordId: CAROL, team: 'Auburn High' }), /not available/);
  const g = s.guilds.ensure(G1);
  s.teams.setEnabled(g, s.teams.byKey('Auburn High').id, true);
  s.signings.sign({ ...base, userDiscordId: CAROL, team: 'Auburn High' });
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM guild_team_overrides').get().n, 1);
  assert.equal(s.audit.count(g), 4); // sign, transfer, release, sign (G2's signing isn't counted)
});

test('signing: cooldown and closed signings (force bypasses)', () => {
  let now = 1_000_000;
  const s = setup(() => now);
  const g = s.guilds.ensure(G1);
  s.guilds.updateSettings(g, { signingCooldownHours: 2 });
  s.signings.sign({ guildDiscordId: G1, userDiscordId: ALICE, team: 'Iowa' });
  s.signings.release({ guildDiscordId: G1, userDiscordId: ALICE });
  assert.throws(() => s.signings.sign({ guildDiscordId: G1, userDiscordId: ALICE, team: 'Oregon' }), /sign again/);
  now += 2 * 3600 + 1;
  s.signings.sign({ guildDiscordId: G1, userDiscordId: ALICE, team: 'Oregon' });
  s.guilds.updateSettings(g, { signingsOpen: false });
  assert.throws(() => s.signings.sign({ guildDiscordId: G1, userDiscordId: BOB, team: 'LSU' }), /closed/);
  s.signings.sign({ guildDiscordId: G1, userDiscordId: BOB, team: 'LSU', force: true });
});

test('seasons: end without carry-over, archive round-trip shrinks live table', () => {
  let now = 1_700_000_000;
  const s = setup(() => now);
  const g = s.guilds.ensure(G1);
  s.guilds.updateSettings(g, { maxUsersPerTeam: 25, maxTeamsPerUser: 5 });
  const teams = ['Iowa', 'Oregon', 'Michigan', 'LSU'];
  for (let i = 0; i < 40; i++) {
    now += 3600;
    s.signings.sign({ guildDiscordId: G1, userDiscordId: `3000000000000000${String(10 + i)}`, team: teams[i % 4] });
  }
  const { season, released } = s.seasons.end(g, { carryOver: false });
  assert.equal(released, 40);
  const before = s.db.prepare('SELECT * FROM signings WHERE season_id=?').all(season.id);
  assert.equal(s.seasons.archive(season.id), 40);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM signings WHERE season_id=?').get(season.id).n, 0);
  const restored = s.seasons.readArchive(season.id);
  assert.equal(restored.length, 40);
  assert.deepEqual(
    restored.map((r) => [r.userId, r.teamId, r.signedAt, r.endedAt]),
    before.map((r) => [r.user_id, r.team_id, r.signed_at, r.ended_at]),
  );
  assert.equal(s.seasons.start(g).number, 2);
});

test('permissions: tiers, cumulative masks, no admin lock-out', () => {
  const s = setup();
  const g = s.guilds.ensure(G1);
  s.guilds.updateSettings(g, { commissionerRoleIds: ['400000000000000001'], adminRoleIds: ['400000000000000002'] });
  const st = s.guilds.getSettings(g);
  const P = s.permissions;
  const member = { userId: ALICE, roleIds: [] };
  assert.equal(P.resolve(member, st).tier, Tier.COACH); // coachRoleIds empty => everyone is a coach
  assert.ok(P.resolve(member, st).has(Permission.SIGN_SELF));
  assert.ok(!P.resolve(member, st).has(Permission.SIGN_OTHERS));
  assert.throws(() => P.assertCanSign(member, st, BOB), PermissionError);
  P.assertCanSign(member, st, ALICE);

  const comm = { userId: BOB, roleIds: ['400000000000000001'] };
  assert.equal(P.resolve(comm, st).tier, Tier.COMMISSIONER);
  P.assertCanSign(comm, st, ALICE);
  assert.throws(() => P.assert(comm, st, Permission.MANAGE_SETTINGS), PermissionError);

  assert.equal(P.resolve({ userId: CAROL, roleIds: [], isDiscordAdmin: true }, st).tier, Tier.ADMIN);
  assert.equal(P.resolve({ userId: CAROL, roleIds: ['400000000000000002'] }, st).tier, Tier.ADMIN);

  s.guilds.updateSettings(g, { permissionOverrides: { admin: 0, coach: Permission.VIEW } });
  const st2 = s.guilds.getSettings(g);
  assert.ok(P.resolve({ userId: CAROL, roleIds: ['400000000000000002'] }, st2).has(Permission.MANAGE_PERMISSIONS));
  assert.ok(!P.resolve(member, st2).has(Permission.SIGN_SELF));

  assert.equal(P.requiredForSettingsPatch({ signingsOpen: false }), Permission.MANAGE_SETTINGS);
  assert.equal(P.requiredForSettingsPatch({ adminRoleIds: [] }), Permission.MANAGE_PERMISSIONS);
});

test('security: logger redacts tokens, sanitizer neutralises mentions, limiter limits', () => {
  const fake = 'fake-discord-token-for-testing';
  assert.ok(!JSON.stringify(redact({ msg: `token is ${fake}`, token: 'x', nested: { authorization: 'y' } })).includes(fake));
  let out = '';
  createLogger({ level: 'info', stream: { write: (s) => (out += s) } }).info({ DISCORD_TOKEN: fake }, `boom ${fake}`);
  assert.ok(!out.includes(fake));

  assert.equal(sanitizeText('hi @everyone\u202e  there'), 'hi @\u200beveryone there');
  assert.throws(() => sanitizeText('x'.repeat(200)), ValidationError);

  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  rl.consume('k', 0);
  rl.consume('k', 1);
  assert.throws(() => rl.consume('k', 2), /Slow down/);
  rl.consume('k', 1001);
});
