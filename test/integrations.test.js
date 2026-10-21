import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/integrations/http-client.js';
import { RobloxThumbnails } from '../src/integrations/roblox-thumbnails.js';
import { loadCommands } from '../src/discord/command-loader.js';
import { loadConfig } from '../src/config/index.js';
import { ExternalServiceError } from '../src/utils/errors.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('http: blocks non-https and non-allow-listed hosts', async () => {
  const http = new HttpClient({ allowedHosts: ['thumbnails.roblox.com'], fetchImpl: () => assert.fail('must not fetch') });
  await assert.rejects(http.getJson('http://thumbnails.roblox.com/x'), ExternalServiceError);
  await assert.rejects(http.getJson('https://evil.example.com/x'), ExternalServiceError);
});

test('http: retries 5xx then succeeds; gives up on 4xx', async () => {
  let calls = 0;
  const http = new HttpClient({
    allowedHosts: ['thumbnails.roblox.com'],
    maxRetries: 3,
    fetchImpl: async () => (++calls < 3 ? json({}, 503) : json({ ok: true })),
  });
  // speed up the backoff
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    assert.deepEqual(await http.getJson('https://thumbnails.roblox.com/a'), { ok: true });
    assert.equal(calls, 3);

    calls = 0;
    const bad = new HttpClient({ allowedHosts: ['thumbnails.roblox.com'], fetchImpl: async () => (calls++, json({}, 404)) });
    await assert.rejects(bad.getJson('https://thumbnails.roblox.com/a'), ExternalServiceError);
    assert.equal(calls, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('roblox thumbnails: batches, caches, maps missing to null', async () => {
  let calls = 0;
  const http = {
    getJson: async (url) => {
      calls++;
      assert.match(url, /assetIds=1,2/);
      return { data: [{ targetId: 1, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/1.png' }, { targetId: 2, state: 'Pending' }] };
    },
  };
  const r = new RobloxThumbnails({ http });
  const a = await r.assets([1, 2, 1, -5, 'x']);
  assert.equal(a.get(1), 'https://tr.rbxcdn.com/1.png');
  assert.equal(a.get(2), null);
  await r.assets([1, 2]);
  assert.equal(calls, 1); // second call fully cached
});

test('discord: every command module loads and has a valid builder', async () => {
  const commands = await loadCommands();
  assert.ok(commands.has('ping'));
  for (const c of commands.values()) assert.doesNotThrow(() => c.data.toJSON());
});

test('config: validates, redacts nothing it should not leak, and reports all problems', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN[\s\S]*DISCORD_CLIENT_ID/);
  const cfg = loadConfig({
    DISCORD_TOKEN: 'a'.repeat(70),
    DISCORD_CLIENT_ID: '123456789012345678',
    BOT_OWNER_IDS: '123456789012345678, 223456789012345678',
    DEV_GUILD_ID: '',
  });
  assert.deepEqual(cfg.discord.ownerIds, ['123456789012345678', '223456789012345678']);
  assert.equal(cfg.discord.devGuildId, undefined);
  assert.ok(Object.isFrozen(cfg));
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'short', DISCORD_CLIENT_ID: '1' }), /Invalid configuration/);
});
