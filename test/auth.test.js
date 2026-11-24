const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DASH_PASS = 'dash-test-pass';
const ADMIN_PASS = 'admin-test-pass';
const ALICE_KEY = 'alice-key-123';

function fresh() {
  for (const mod of ['../src/team/router', '../src/team/store', '../src/team/analytics', '../src/team/auth']) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
}

async function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auth-'));
  process.env.CLAUDE_SPEND_DATA = tempDir;
  process.env.DASHBOARD_PASSWORD = DASH_PASS;
  process.env.ADMIN_PASSWORD = ADMIN_PASS;
  process.env.HMAC_SALT = 'test-salt';
  delete process.env.S3_BUCKET;
  fs.writeFileSync(path.join(tempDir, 'allowlist.json'), JSON.stringify([
    { devId: 'alice', name: 'Alice', key: ALICE_KEY },
    { devId: 'bob', name: 'Bob', key: 'bob-key-456' },
  ]));
  for (const devId of ['alice', 'bob']) {
    fs.writeFileSync(path.join(tempDir, devId + '.json'), JSON.stringify({
      devId, lastSync: '2026-11-24T00:00:00Z',
      sessions: [{ sessionId: devId + '-s1', date: '2026-11-24', firstPrompt: 'SECRET prompt of ' + devId, queryCount: 1, _models: {}, _tools: {}, _dailyBreakdown: {} }],
      totals: { totalQueries: 1 }, dailyUsage: [{ date: '2026-11-24', tokens: 1, cost: 0, sessions: 1, queries: 1 }],
    }));
  }
  fresh();
  const express = require('express');
  const { createTeamRouter } = require('../src/team/router');
  const router = createTeamRouter();
  const app = express();
  app.use('/api/team', router);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/team`;
  return { server, base, router };
}

// Every route registered on the router, with params filled in.
function listRoutes(router) {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) out.push({ method: method.toUpperCase(), path: p.replace(/:devId/g, 'alice').replace(/:[a-zA-Z]+/g, 'x') });
    }
  }
  return out;
}

async function call(base, method, p, { headers = {}, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function login(base) {
  const r = await call(base, 'POST', '/login', { body: { password: DASH_PASS } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

const PUBLIC = new Set(['POST /sync', 'GET /whoami', 'POST /login', 'POST /logout', 'GET /session']);

test('every non-public route rejects unauthenticated requests and leaks nothing', async () => {
  const { server, base, router } = await startServer();
  try {
    const routes = listRoutes(router);
    assert.ok(routes.length > 15, 'route enumeration found the router');
    for (const r of routes) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      for (const headers of [{}, { Cookie: 'cs_session=v1.9999999999999.forged' }, { Authorization: 'Bearer wrong' }, { 'X-Api-Key': 'not-a-key' }]) {
        const res = await call(base, r.method, r.path, { headers, body: r.method === 'GET' ? undefined : {} });
        assert.equal(res.status, 401, `${r.method} ${r.path} with ${JSON.stringify(headers)} returned ${res.status}`);
        assert.ok(!res.text.includes('SECRET'), `${r.method} ${r.path} leaked data`);
      }
    }
    // Query-string variants of the sync-diff path are covered by the same check.
    assert.equal((await call(base, 'GET', '/dev/alice?archived=1')).status, 401);
    assert.equal((await call(base, 'GET', '/dev/alice?lite=1')).status, 401);
  } finally { server.close(); }
});

test('public routes expose no dashboard data', async () => {
  const { server, base } = await startServer();
  try {
    const session = await call(base, 'GET', '/session');
    assert.deepEqual(JSON.parse(session.text), { authenticated: false });
    const who = await call(base, 'GET', '/whoami');
    assert.equal(who.status, 400);
    const badWho = await call(base, 'GET', '/whoami?key=nope');
    assert.equal(badWho.status, 403);
    const sync = await call(base, 'POST', '/sync', { body: { devId: 'alice', data: { sessions: [] } } });
    assert.equal(sync.status, 403, 'sync without key is rejected when allowlist exists');
  } finally { server.close(); }
});

test('dashboard session grants read access but not admin', async () => {
  const { server, base } = await startServer();
  try {
    const cookie = await login(base);
    const lb = await call(base, 'GET', '/leaderboard', { headers: { Cookie: cookie } });
    assert.equal(lb.status, 200);
    const dev = await call(base, 'GET', '/dev/bob', { headers: { Cookie: cookie } });
    assert.equal(dev.status, 200);
    const keys = await call(base, 'GET', '/admin/keys', { headers: { Cookie: cookie } });
    assert.equal(keys.status, 401, 'viewer session cannot reach admin APIs');
    const admin = await call(base, 'GET', '/admin/keys', { headers: { Authorization: 'Bearer ' + ADMIN_PASS } });
    assert.equal(admin.status, 200);
  } finally { server.close(); }
});

test('session cookie is HttpOnly, SameSite=Strict, and revoked by password rotation', async () => {
  const { server, base } = await startServer();
  try {
    const r = await call(base, 'POST', '/login', { body: { password: DASH_PASS }, headers: { 'X-Forwarded-Proto': 'https' } });
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';')[0];
    process.env.DASHBOARD_PASSWORD = 'rotated';
    assert.equal((await call(base, 'GET', '/leaderboard', { headers: { Cookie: cookie } })).status, 401);
  } finally { process.env.DASHBOARD_PASSWORD = DASH_PASS; server.close(); }
});

test('login fails closed without DASHBOARD_PASSWORD and rate-limits guessing', async () => {
  const { server, base } = await startServer();
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await call(base, 'POST', '/login', { body: { password: 'guess' + i } })).status, 401);
    }
    assert.equal((await call(base, 'POST', '/login', { body: { password: DASH_PASS } })).status, 429, 'blocked even with the right password');

    delete process.env.DASHBOARD_PASSWORD;
    assert.equal((await call(base, 'POST', '/login', { body: { password: '' } })).status, 503);
    assert.equal((await call(base, 'GET', '/leaderboard', { headers: { Cookie: 'cs_session=' } })).status, 401);
  } finally { process.env.DASHBOARD_PASSWORD = DASH_PASS; server.close(); }
});

test('a developer API key reads only that developer\'s own /dev/:id', async () => {
  const { server, base } = await startServer();
  try {
    const own = await call(base, 'GET', '/dev/alice?archived=1', { headers: { 'X-Api-Key': ALICE_KEY } });
    assert.equal(own.status, 200);
    assert.ok(Array.isArray(JSON.parse(own.text)._archivedSessionIds));
    for (const p of ['/dev/bob', '/dev/alice/work-summary', '/leaderboard', '/devs', '/productivity']) {
      assert.equal((await call(base, 'GET', p, { headers: { 'X-Api-Key': ALICE_KEY } })).status, 401, p);
    }
    assert.equal((await call(base, 'GET', '/dev/alice?key=' + ALICE_KEY)).status, 401, 'key in query string not accepted');
  } finally { server.close(); }
});
