const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function clearFeatureCaches() {
  for (const mod of [
    '../src/team/router',
    '../src/team/store',
    '../src/team/analytics',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
}

function createRouterForTempDir(tempDir) {
  process.env.CLAUDE_SPEND_DATA = tempDir;
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.HMAC_SALT = 'test-salt';
  clearFeatureCaches();
  const { createTeamRouter } = require('../src/team/router');
  return createTeamRouter();
}

async function invokeRoute(router, method, pathPattern, reqInit = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === pathPattern && l.route.methods[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${pathPattern}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(reqInit.headers || {})) {
    normalizedHeaders[String(k).toLowerCase()] = v;
  }

  const req = {
    body: reqInit.body || {},
    query: reqInit.query || {},
    params: reqInit.params || {},
    headers: normalizedHeaders,
  };

  const res = await new Promise((resolve, reject) => {
    const out = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve(this); return this; },
    };
    try {
      const maybe = handler(req, out, () => resolve(out));
      if (maybe && typeof maybe.then === 'function') {
        maybe.catch(reject);
      }
    } catch (err) {
      reject(err);
    }
  });
  return res;
}

test('admin remove requires Authorization header and succeeds with bearer token', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-team-'));
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'allowlist.json'), '[]');
  const router = createRouterForTempDir(tempDir);

  const addRes = await invokeRoute(router, 'post', '/admin/add', {
    headers: {
        Authorization: 'Bearer admin-test-pass',
        'Content-Type': 'application/json',
    },
    body: { name: 'Dev One', email: 'dev1@example.com' },
  });
  assert.equal(addRes.statusCode, 200);
  assert.equal(addRes.body.ok, true);

  const badRemove = await invokeRoute(router, 'post', '/admin/remove', {
    headers: {
        'x-admin-key': 'admin-test-pass',
        'Content-Type': 'application/json',
    },
    body: { devId: addRes.body.devId },
  });
  assert.equal(badRemove.statusCode, 401);

  const goodRemove = await invokeRoute(router, 'post', '/admin/remove', {
    headers: {
        Authorization: 'Bearer admin-test-pass',
        'Content-Type': 'application/json',
    },
    body: { devId: addRes.body.devId },
  });
  assert.equal(goodRemove.statusCode, 200);
  assert.equal(goodRemove.body.ok, true);
});

test('leaderboard and dev endpoints behave for seeded feature data', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-team-'));
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'allowlist.json'), '[]');
  fs.writeFileSync(path.join(tempDir, 'Alice.json'), JSON.stringify({
    devId: 'Alice',
    lastSync: '2026-03-08T12:00:00.000Z',
    sessions: [{
      sessionId: 's1', date: '2026-03-08', lastDate: '2026-03-08',
      totalTokens: 100, inputTokens: 60, outputTokens: 40,
      cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.01, queryCount: 1,
      _models: { 'claude-sonnet-4-6': { queries: 1, tokens: 100, cost: 0.01 } },
      _tools: { Read: 1 }, _hasToolCall: true,
      _dailyBreakdown: { '2026-03-08': { tokens: 100, cost: 0.01, queries: 1 } }
    }],
    totals: {
      totalTokens: 100, totalInputTokens: 60, totalOutputTokens: 40,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
      totalCost: 0.01, totalQueries: 1, totalSessions: 1,
    },
    dailyUsage: [{ date: '2026-03-08', tokens: 100, cost: 0.01, sessions: 1, queries: 1 }],
  }));
  const router = createRouterForTempDir(tempDir);

  const lbRes = await invokeRoute(router, 'get', '/leaderboard');
  assert.equal(lbRes.statusCode, 200);
  assert.equal(Array.isArray(lbRes.body.leaderboard), true);
  assert.equal(lbRes.body.leaderboard[0].devId, 'Alice');

  const devRes = await invokeRoute(router, 'get', '/dev/:devId', {
    params: { devId: 'Alice' },
    query: { lite: '1' },
  });
  assert.equal(devRes.statusCode, 200);
  assert.equal(devRes.body.devId, 'Alice');

  const missingRes = await invokeRoute(router, 'get', '/dev/:devId', {
    params: { devId: 'DoesNotExist' },
  });
  assert.equal(missingRes.statusCode, 404);
});
