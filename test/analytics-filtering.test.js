const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Helper: set up a temp data dir with dev JSON, then require analytics fresh
function setupAnalytics(devDataArray) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-analytics-'));

  for (const dev of devDataArray) {
    fs.writeFileSync(path.join(tempDir, `${dev.devId}.json`), JSON.stringify(dev));
  }
  // Empty allowlist so open mode works
  fs.writeFileSync(path.join(tempDir, 'allowlist.json'), '[]');

  // Clear module caches so store/analytics pick up new data dir
  for (const mod of ['../src/team/store', '../src/team/analytics', '../src/team/s3']) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
  process.env.CLAUDE_SPEND_DATA = tempDir;

  return require('../src/team/analytics');
}

// A multi-day session spanning March 6-8 with per-day breakdown
function makeMultiDaySession() {
  return {
    sessionId: 'multi-day-1',
    date: '2026-03-06',
    lastDate: '2026-03-08',
    timestamp: '2026-03-06T10:00:00.000Z',
    project: 'my-project',
    totalTokens: 300000,   // full session total
    inputTokens: 100000,
    outputTokens: 50000,
    cacheReadTokens: 140000,
    cacheCreationTokens: 10000,
    cost: 30.00,
    queryCount: 300,
    _models: { 'claude-sonnet-4-6': { queries: 300, tokens: 300000, cost: 30.00 } },
    _tools: { Read: 50, Edit: 30, Bash: 20 },
    _hasToolCall: true,
    _dailyBreakdown: {
      '2026-03-06': { tokens: 100000, cost: 10.00, queries: 100 },
      '2026-03-07': { tokens: 120000, cost: 12.00, queries: 120 },
      '2026-03-08': { tokens: 80000,  cost: 8.00,  queries: 80 },
    },
  };
}

// A single-day session on March 8
function makeSingleDaySession() {
  return {
    sessionId: 'single-day-1',
    date: '2026-03-08',
    lastDate: '2026-03-08',
    timestamp: '2026-03-08T14:00:00.000Z',
    project: 'my-project',
    totalTokens: 50000,
    inputTokens: 20000,
    outputTokens: 10000,
    cacheReadTokens: 18000,
    cacheCreationTokens: 2000,
    cost: 5.00,
    queryCount: 50,
    _models: { 'claude-sonnet-4-6': { queries: 50, tokens: 50000, cost: 5.00 } },
    _tools: { Read: 10 },
    _hasToolCall: true,
    _dailyBreakdown: {
      '2026-03-08': { tokens: 50000, cost: 5.00, queries: 50 },
    },
  };
}

function makeDev() {
  return {
    devId: 'TestDev',
    lastSync: '2026-03-08T15:00:00.000Z',
    sessions: [makeMultiDaySession(), makeSingleDaySession()],
    totals: {
      totalTokens: 350000, totalInputTokens: 120000, totalOutputTokens: 60000,
      totalCacheReadTokens: 158000, totalCacheCreationTokens: 12000,
      totalCost: 35.00, totalQueries: 350, totalSessions: 2,
    },
    dailyUsage: [
      { date: '2026-03-06', tokens: 100000, cost: 10.00, sessions: 1, queries: 100 },
      { date: '2026-03-07', tokens: 120000, cost: 12.00, sessions: 1, queries: 120 },
      { date: '2026-03-08', tokens: 130000, cost: 13.00, sessions: 2, queries: 130 },
    ],
  };
}

// ===== UNFILTERED (All Time) =====

test('unfiltered: returns full session totals', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics();
  const dev = result.developers[0];

  assert.equal(dev.totalTokens, 350000);
  assert.equal(dev.cost, 35.00);
  assert.equal(dev.queries, 350);
  assert.equal(dev.sessions, 2);
});

test('unfiltered: dailyBreakdown includes all 3 days', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics();
  const dev = result.developers[0];

  assert.equal(dev.dailyBreakdown.length, 3);
  const dates = dev.dailyBreakdown.map(d => d.date);
  assert.deepEqual(dates, ['2026-03-06', '2026-03-07', '2026-03-08']);
});

test('unfiltered: avgSessionDepth and avgQueriesPerSession use full data', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics();
  const dev = result.developers[0];

  // 350 queries / 2 sessions = 175
  assert.equal(dev.avgQueriesPerSession, 175);
  assert.equal(dev.avgSessionDepth, 175);
});

// ===== FILTERED TO SINGLE DAY (March 8 only) =====

test('filtered to March 8: tokens/cost/queries only from that day', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // March 8: multi-day contributes 80k tokens/$8/80q + single-day 50k/$5/50q
  assert.equal(dev.totalTokens, 130000);
  assert.equal(dev.cost, 13.00);
  assert.equal(dev.queries, 130);
});

test('filtered to March 8: dailyBreakdown only has March 8', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  assert.equal(dev.dailyBreakdown.length, 1);
  assert.equal(dev.dailyBreakdown[0].date, '2026-03-08');
  assert.equal(dev.dailyBreakdown[0].tokens, 130000);
});

test('filtered to March 8: sessions count from dailyMap', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // Both sessions have activity on March 8 → 2 sessions in dailyMap
  assert.equal(dev.sessions, 2);
});

test('filtered to March 8: avgSessionDepth uses filtered queries/sessions', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // 130 queries / 2 sessions = 65
  assert.equal(dev.avgSessionDepth, 65);
  assert.equal(dev.avgQueriesPerSession, 65);
});

test('filtered to March 8: avgTokensPerQuery uses filtered data', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // 130000 / 130 = 1000
  assert.equal(dev.avgTokensPerQuery, 1000);
});

test('filtered to March 8: activeDays is 1', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  assert.equal(dev.activeDays, 1);
});

test('filtered to March 8: streak is 1', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  assert.equal(dev.streak, 1);
});

test('filtered to March 8: project usage uses in-range portion', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  const proj = dev.projectUsage['my-project'];
  assert.ok(proj, 'project should exist');
  assert.equal(proj.tokens, 130000);
  assert.equal(proj.cost, 13.00);
  assert.equal(proj.queries, 130);
});

// ===== FILTERED TO RANGE (March 7-8) =====

test('filtered to March 7-8: includes only those days', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-07', '2026-03-08');
  const dev = result.developers[0];

  // March 7: 120k/12/120 + March 8: 130k/13/130
  assert.equal(dev.totalTokens, 250000);
  assert.equal(dev.cost, 25.00);
  assert.equal(dev.queries, 250);
  assert.equal(dev.dailyBreakdown.length, 2);
  assert.equal(dev.activeDays, 2);
});

// ===== FILTERED TO DAY WITH NO ACTIVITY =====

test('filtered to March 5: dev has zero metrics', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-05', '2026-03-05');
  const dev = result.developers[0];

  assert.equal(dev.sessions, 0);
  assert.equal(dev.totalTokens, 0);
  assert.equal(dev.queries, 0);
  assert.equal(dev.cost, 0);
  assert.equal(dev.dailyBreakdown.length, 0);
});

// ===== TEAM AGGREGATIONS =====

test('filtered: team totals match filtered dev totals', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  assert.equal(result.team.totalTokens, 130000);
  assert.equal(result.team.totalCost, 13.00);
  assert.equal(result.team.totalQueries, 130);
});

test('filtered: team dailyTrend only has in-range days', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  assert.equal(result.dailyTrend.length, 1);
  assert.equal(result.dailyTrend[0].date, '2026-03-08');
  assert.equal(result.dailyTrend[0].tokens, 130000);
});

test('filtered: team project breakdown uses filtered data', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  const proj = result.projectBreakdown.find(p => p.project === 'my-project');
  assert.ok(proj);
  assert.equal(proj.tokens, 130000);
  assert.equal(proj.cost, 13.00);
});

// ===== TOOL ACTIVATION RATE =====

test('filtered: toolActivationRate uses filtered session count', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // Both sessions have tools, 2 sessions in range → 100%
  assert.equal(dev.toolActivationRate, 100);
});

// ===== MULTI-DEV =====

// ===== MODEL USAGE =====

test('filtered to March 8: model usage is proportionally scaled', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  const model = dev.modelUsage['claude-sonnet-4-6'];
  assert.ok(model, 'model should exist');
  // Multi-day session: 80k/300k ratio = 0.267, scaled from 300q → ~80q
  // Single-day session: ratio 1.0, 50q stays 50q
  // Total model queries should be ~130 (proportioned)
  assert.ok(model.queries <= 135 && model.queries >= 125,
    `model queries ${model.queries} should be ~130`);
  assert.ok(model.tokens <= 135000 && model.tokens >= 125000,
    `model tokens ${model.tokens} should be ~130000`);
});

test('filtered: team model breakdown is proportionally scaled', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  const model = result.modelBreakdown.find(m => m.model === 'claude-sonnet-4-6');
  assert.ok(model);
  assert.ok(model.tokens <= 135000 && model.tokens >= 125000,
    `team model tokens ${model.tokens} should be ~130000`);
});

// ===== TOOL COUNTS =====

test('filtered to March 8: tool counts are proportionally scaled', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // Multi-day session has Read:50, Edit:30, Bash:20, ratio ~0.267 → Read:~13, Edit:~8, Bash:~5
  // Single-day session has Read:10, ratio 1.0 → Read:10
  // Total Read should be ~23
  const readTool = dev.topTools.find(t => t.tool === 'Read');
  assert.ok(readTool, 'Read tool should exist');
  assert.ok(readTool.count <= 26 && readTool.count >= 20,
    `Read count ${readTool.count} should be ~23`);
});

test('filtered: team tool breakdown is proportionally scaled', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  const readTool = result.toolBreakdown.find(t => t.tool === 'Read');
  assert.ok(readTool);
  assert.ok(readTool.count <= 26 && readTool.count >= 20,
    `team Read count ${readTool.count} should be ~23`);
});

// ===== CACHE TOKENS =====

test('filtered to March 8: cache tokens are proportionally scaled', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // Multi-day: cacheRead=140000, ratio=80k/300k=0.267 → ~37333
  // Single-day: cacheRead=18000, ratio=1.0 → 18000
  // Total ~55333
  assert.ok(dev.cacheReadTokens > 50000 && dev.cacheReadTokens < 60000,
    `cacheReadTokens ${dev.cacheReadTokens} should be ~55000`);
});

test('filtered to March 8: cacheHitRate computed from filtered tokens', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  // cacheHitRate should be > 0 and reasonable
  assert.ok(dev.cacheHitRate > 0, 'cacheHitRate should be > 0');
  assert.ok(dev.cacheHitRate < 100, 'cacheHitRate should be < 100');
});

// ===== OUTPUT RATIO =====

test('filtered to March 8: outputRatio computed from filtered tokens', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  assert.ok(dev.outputRatio > 0, 'outputRatio should be > 0');
  assert.ok(dev.outputRatio < 100, 'outputRatio should be < 100');
});

// ===== SESSION DEPTH DISTRIBUTION =====

test('filtered: session depth reflects filtered query counts', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);

  // Unfiltered: 350 queries / 2 sessions = 175 depth
  const all = getProductivityAnalytics();
  const devAll = all.developers[0];
  assert.equal(devAll.avgSessionDepth, 175);

  // Filtered March 8: 130 queries / 2 sessions = 65 depth
  const filtered = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const devFiltered = filtered.developers[0];
  assert.equal(devFiltered.avgSessionDepth, 65);

  // Filtered depth must be less than unfiltered for multi-day sessions
  assert.ok(devFiltered.avgSessionDepth < devAll.avgSessionDepth);
});

// ===== CONTRIBUTION HEATMAP (dailyBreakdown correctness) =====

test('filtered: dailyBreakdown token sums match totalTokens', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');
  const dev = result.developers[0];

  const dbTotal = dev.dailyBreakdown.reduce((s, d) => s + d.tokens, 0);
  assert.equal(dbTotal, dev.totalTokens,
    'dailyBreakdown token sum should equal totalTokens');
});

test('unfiltered: dailyBreakdown token sums match totalTokens', () => {
  const { getProductivityAnalytics } = setupAnalytics([makeDev()]);
  const result = getProductivityAnalytics();
  const dev = result.developers[0];

  const dbTotal = dev.dailyBreakdown.reduce((s, d) => s + d.tokens, 0);
  assert.equal(dbTotal, dev.totalTokens,
    'dailyBreakdown token sum should equal totalTokens');
});

// ===== MULTI-DEV =====

test('filtered: multiple devs each get correct filtered totals', () => {
  const dev1 = makeDev();
  const dev2 = {
    devId: 'OtherDev',
    lastSync: '2026-03-08T12:00:00.000Z',
    sessions: [{
      sessionId: 'other-1', date: '2026-03-07', lastDate: '2026-03-08',
      timestamp: '2026-03-07T09:00:00.000Z', project: 'other-proj',
      totalTokens: 200000, inputTokens: 80000, outputTokens: 40000,
      cacheReadTokens: 70000, cacheCreationTokens: 10000,
      cost: 20.00, queryCount: 200,
      _models: { 'claude-sonnet-4-6': { queries: 200, tokens: 200000, cost: 20 } },
      _tools: { Read: 30 }, _hasToolCall: true,
      _dailyBreakdown: {
        '2026-03-07': { tokens: 150000, cost: 15.00, queries: 150 },
        '2026-03-08': { tokens: 50000,  cost: 5.00,  queries: 50 },
      },
    }],
    totals: { totalTokens: 200000, totalCost: 20, totalQueries: 200, totalSessions: 1 },
    dailyUsage: [
      { date: '2026-03-07', tokens: 150000, cost: 15, sessions: 1, queries: 150 },
      { date: '2026-03-08', tokens: 50000, cost: 5, sessions: 1, queries: 50 },
    ],
  };

  const { getProductivityAnalytics } = setupAnalytics([dev1, dev2]);
  const result = getProductivityAnalytics('2026-03-08', '2026-03-08');

  const d1 = result.developers.find(d => d.devId === 'TestDev');
  const d2 = result.developers.find(d => d.devId === 'OtherDev');

  assert.equal(d1.totalTokens, 130000);
  assert.equal(d2.totalTokens, 50000);

  // Team total = 130k + 50k
  assert.equal(result.team.totalTokens, 180000);
});
