import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/services/index.js';
import { silentLogger } from '../src/utils/logger.js';
import { createApiServer } from '../src/api/server.js';

const G1 = '100000000000000001';
const U = (n) => `20000000000000000${n}`.slice(0, 18);
const [ALICE, BOB] = [U(1), U(2)];

async function request(baseUrl, path, { method = 'GET', body = null, headers = {} } = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}

test('api: health, teams catalog, settings, signings, and scheduling workflow', async () => {
  const config = loadConfig({ API_PORT: '0' }, { requireDiscord: false });
  const services = createServices({ config, logger: silentLogger, dbPath: ':memory:' });
  const api = createApiServer({ services, config, logger: silentLogger });

  await api.listen(0);
  const port = api.server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Health check
    const health = await request(baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.data.status, 'ok');

    // 2. Teams catalog search
    const teams = await request(baseUrl, '/api/teams?q=iowa');
    assert.equal(teams.status, 200);
    assert.ok(teams.data.data.length > 0);
    assert.equal(teams.data.data[0].key, 'Iowa');

    // 3. Guild settings patch
    const patch = await request(baseUrl, `/api/guilds/${G1}/settings`, {
      method: 'PATCH',
      body: { maxUsersPerTeam: 4 },
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.data.data.maxUsersPerTeam, 4);

    // 4. Sign player via API
    const sign = await request(baseUrl, `/api/guilds/${G1}/signings`, {
      method: 'POST',
      body: { userDiscordId: ALICE, team: 'Iowa' },
    });
    assert.equal(sign.status, 201);
    assert.equal(sign.data.data.team.key, 'Iowa');

    // 5. Open teams query
    const open = await request(baseUrl, `/api/guilds/${G1}/open-teams`);
    assert.equal(open.status, 200);
    assert.ok(Array.isArray(open.data.data));

    // 6. Schedule match
    const match = await request(baseUrl, `/api/guilds/${G1}/matches`, {
      method: 'POST',
      body: { week: 1, homeTeam: 'Iowa', awayTeam: 'Oregon' },
    });
    assert.equal(match.status, 201);
    const matchId = match.data.data.id;

    // 7. Propose time via /schedule end API
    const targetTime = Math.floor(Date.now() / 1000) + 7200;
    const proposed = await request(baseUrl, `/api/guilds/${G1}/matches/${matchId}/propose`, {
      method: 'POST',
      body: { scheduledAt: targetTime, proposerDiscordId: ALICE, side: 'home' },
    });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.data.data.proposedTime, targetTime);
    assert.equal(proposed.data.data.scheduledAt, null);

    // 8. Confirm proposal by Away side
    const confirmed = await request(baseUrl, `/api/guilds/${G1}/matches/${matchId}/confirm`, {
      method: 'POST',
      body: { confirmerDiscordId: BOB, side: 'away' },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.data.fullyConfirmed, true);
    assert.equal(confirmed.data.data.match.scheduledAt, targetTime);

    // 9. Report match scores
    const report = await request(baseUrl, `/api/guilds/${G1}/matches/${matchId}/report`, {
      method: 'POST',
      body: { reporterDiscordId: ALICE, homeScore: 21, awayScore: 14, autoApprove: true },
    });
    assert.equal(report.status, 201);

    // 10. Standings query
    const standings = await request(baseUrl, `/api/guilds/${G1}/standings`);
    assert.equal(standings.status, 200);
    assert.equal(standings.data.data[0].team.key, 'Iowa');
    assert.equal(standings.data.data[0].won, 1);

    // 11. Ban user via API
    const ban = await request(baseUrl, `/api/guilds/${G1}/bans`, {
      method: 'POST',
      body: { userDiscordId: BOB, reason: 'Toxic' },
    });
    assert.equal(ban.status, 201);

    // Banned user trying to sign fails with 409 Conflict
    const badSign = await request(baseUrl, `/api/guilds/${G1}/signings`, {
      method: 'POST',
      body: { userDiscordId: BOB, team: 'Oregon' },
    });
    assert.equal(badSign.status, 409);
    assert.equal(badSign.data.success, false);
    assert.match(badSign.data.error.message, /banned/);
  } finally {
    await api.close();
    services.close();
  }
});
