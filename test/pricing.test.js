const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getPricing, queryCost } = require('../src/pricing');
const { extractSessionData } = require('../src/parser');

const perMTok = (p) => ({
  input: +(p.input * 1e6).toFixed(4),
  output: +(p.output * 1e6).toFixed(4),
  cacheRead: +(p.cacheRead * 1e6).toFixed(4),
});

test('getPricing matches current and legacy model IDs', () => {
  const cases = {
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
    'claude-opus-4-1-20250805': { input: 15, output: 75, cacheRead: 1.5 },
    'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5 },
    'claude-3-opus-20240229': { input: 15, output: 75, cacheRead: 1.5 },
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
    'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3 },
    'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1 },
    'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheRead: 0.08 },
  };
  for (const [model, expected] of Object.entries(cases)) {
    assert.deepEqual(perMTok(getPricing(model)), expected, model);
  }
});

test('queryCost prices 5-minute and 1-hour cache writes separately', () => {
  const base = { model: 'claude-opus-5', cacheCreationTokens: 1e6 };
  assert.equal(queryCost({ ...base, cacheCreation5mTokens: 1e6, cacheCreation1hTokens: 0 }), 6.25);
  assert.equal(queryCost({ ...base, cacheCreation5mTokens: 0, cacheCreation1hTokens: 1e6 }), 10);
  // No TTL split recorded: assume 1-hour, which is what Claude Code writes
  assert.equal(queryCost(base), 10);
});

test('queryCost doubles fast mode', () => {
  const q = { model: 'claude-opus-5', inputTokens: 1e6, outputTokens: 1e6 };
  assert.equal(queryCost(q), 30);
  assert.equal(queryCost({ ...q, speed: 'fast' }), 60);
});

test('extractSessionData records cache TTL split and prices with it', () => {
  const [q] = extractSessionData([
    { type: 'user', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      timestamp: '2026-09-01T00:00:01.000Z',
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 1e6,
          cache_read_input_tokens: 1e6,
          output_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 4e5, ephemeral_1h_input_tokens: 6e5 },
        },
        content: [],
      },
    },
  ]);
  assert.equal(q.cacheCreation5mTokens, 4e5);
  assert.equal(q.cacheCreation1hTokens, 6e5);
  // 0.4M * $5 + 0.6M * $8 + 1M * $0.20
  assert.ok(Math.abs(q.cost - 7) < 1e-9);
});

function loadStore(tempDir) {
  process.env.CLAUDE_SPEND_DATA = tempDir;
  delete process.env.S3_BUCKET;
  for (const mod of ['../src/team/store', '../src/team/s3']) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
  return require('../src/team/store');
}

const oldQuery = (day) => ({
  model: 'claude-opus-5',
  userTimestamp: `2026-09-${day}T00:00:00.000Z`,
  assistantTimestamp: `2026-09-${day}T00:00:01.000Z`,
  inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1e6, outputTokens: 0,
  totalTokens: 1e6,
  cost: 1.5, // old Opus 4.0 fallback rate
  isNewPrompt: true,
});

test('saveDeveloper prices incoming sessions on the server', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-pricing-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = loadStore(tempDir);

  const saved = await store.saveDeveloper('dev1', {
    sessions: [{ sessionId: 's1', date: '2026-09-01', queryCount: 1, cost: 1.5, queries: [oldQuery('01')] }],
  });
  assert.equal(saved.totals.totalCost, 0.5);
  assert.equal(saved.sessions[0]._models['claude-opus-5'].cost, 0.5);
});

test('repriceDeveloper recomputes stored costs from the archive and from totals', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-pricing-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = loadStore(tempDir);

  // A dev file written under the old pricing: s1 has archived queries, s2 does not
  fs.mkdirSync(path.join(tempDir, 'archive'), { recursive: true });
  const archived = { sessionId: 's1', date: '2026-09-01', queryCount: 2, queries: [oldQuery('01'), oldQuery('02')] };
  fs.writeFileSync(path.join(tempDir, 'archive', 'dev1.jsonl'), JSON.stringify(archived) + '\n');
  const s1 = {
    sessionId: 's1', date: '2026-09-01', queryCount: 2, promptCount: 2, cost: 3, totalTokens: 2e6,
    cacheReadTokens: 2e6,
    _models: { 'claude-opus-5': { queries: 2, tokens: 2e6, cost: 3 } },
    _dailyBreakdown: {
      '2026-09-01': { tokens: 1e6, cost: 1.5, queries: 1, prompts: 1 },
      '2026-09-02': { tokens: 1e6, cost: 1.5, queries: 1, prompts: 1 },
    },
  };
  const s2 = {
    sessionId: 's2', date: '2026-09-03', queryCount: 1, promptCount: 1, cost: 16.5, totalTokens: 2e6,
    inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 1e6, outputTokens: 1e6 * 0.2,
    _models: {
      'claude-opus-5': { queries: 1, tokens: 1.1e6, cost: 16.5 },
    },
    _dailyBreakdown: { '2026-09-03': { tokens: 2e6, cost: 16.5, queries: 1, prompts: 1 } },
  };
  fs.writeFileSync(path.join(tempDir, 'dev1.json'), JSON.stringify({ devId: 'dev1', sessions: [s1, s2] }));

  const result = await store.repriceDeveloper('dev1');
  assert.equal(result.fromQueries, 1);
  assert.equal(result.estimated, 1);

  const dev = JSON.parse(fs.readFileSync(path.join(tempDir, 'dev1.json'), 'utf-8'));
  const [r1, r2] = dev.sessions;
  assert.equal(r1.cost, 1);
  assert.equal(r1._models['claude-opus-5'].cost, 1);
  assert.equal(r1._dailyBreakdown['2026-09-02'].cost, 0.5);
  // 1M cache reads * $0.50 + 0.2M output * $25
  assert.ok(Math.abs(r2.cost - 5.5) < 1e-9);
  assert.ok(Math.abs(r2._dailyBreakdown['2026-09-03'].cost - 5.5) < 1e-9);
  assert.ok(Math.abs(dev.totals.totalCost - 6.5) < 1e-9);
});

test('queryCost prices cache writes missing from a partial split as 1-hour', () => {
  const base = { model: 'claude-opus-5', cacheCreationTokens: 1e6 };
  // Empty cache_creation object: parser records both counters as 0
  assert.equal(queryCost({ ...base, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }), 10);
  // Only the 5-minute counter present
  assert.equal(queryCost({ ...base, cacheCreation5mTokens: 4e5 }), 0.4 * 6.25 + 0.6 * 10);
});

test('repriceDeveloper spreads cost over days by tokens when the old cost was zero', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-pricing-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const store = loadStore(tempDir);

  const s = {
    sessionId: 's1', date: '2026-09-01', queryCount: 2, promptCount: 2, cost: 0, totalTokens: 2e6,
    inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 2e6, outputTokens: 0,
    _models: { 'claude-opus-5': { queries: 2, tokens: 2e6, cost: 0 } },
    _dailyBreakdown: {
      '2026-09-01': { tokens: 1.5e6, cost: 0, queries: 1, prompts: 1 },
      '2026-09-02': { tokens: 0.5e6, cost: 0, queries: 1, prompts: 1 },
    },
  };
  fs.writeFileSync(path.join(tempDir, 'dev1.json'), JSON.stringify({ devId: 'dev1', sessions: [s] }));

  await store.repriceDeveloper('dev1');
  const [r] = JSON.parse(fs.readFileSync(path.join(tempDir, 'dev1.json'), 'utf-8')).sessions;
  assert.equal(r.cost, 1);
  assert.equal(r._dailyBreakdown['2026-09-01'].cost, 0.75);
  assert.equal(r._dailyBreakdown['2026-09-02'].cost, 0.25);
});

test('parseAllSessions counts fast-mode rates in cache savings', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const projectDir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      timestamp: '2026-09-01T00:00:01.000Z',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 0, cache_read_input_tokens: 1e6, output_tokens: 0, speed: 'fast' },
        content: [],
      },
    },
  ];
  fs.writeFileSync(path.join(projectDir, 'fast-session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const { parseAllSessions } = require('../src/parser');
  const data = await parseAllSessions();
  // 1M cache reads at fast Opus 5 rates: $1 paid vs $10 at full input price
  assert.ok(Math.abs(data.totals.totalCost - 1) < 1e-9);
  assert.ok(Math.abs(data.totals.totalSaved - 9) < 1e-9);
  const insight = data.insights.find(i => i.id === 'cache-savings');
  assert.match(insight.description, /\$10\.00 instead of \$1\.00/);
});
