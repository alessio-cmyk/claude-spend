const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S3_PATH = require.resolve('../src/team/s3');

// Load store/archive fresh against a temp data dir. With s3Bucket set, the s3 module is
// replaced by a recording stub so nothing touches AWS.
function loadFresh(tempDir, { s3Bucket } = {}) {
  process.env.CLAUDE_SPEND_DATA = tempDir;
  for (const mod of ['../src/team/store', '../src/team/archive', '../src/team/s3']) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
  const uploads = [];
  if (s3Bucket) {
    require.cache[S3_PATH] = {
      id: S3_PATH, filename: S3_PATH, loaded: true,
      exports: { isEnabled: () => true, uploadFile: fp => uploads.push(fp) },
    };
  }
  const store = require('../src/team/store');
  const archive = require('../src/team/archive');
  return { store, archive, uploads };
}

function q(i, prompt) {
  return {
    userPrompt: prompt || `prompt ${i}`,
    userTimestamp: `2026-11-24T10:${String(i).padStart(2, '0')}:00Z`,
    assistantTimestamp: `2026-11-24T10:${String(i).padStart(2, '0')}:30Z`,
    model: 'claude-sonnet-4-6', totalTokens: 100, cost: 0.01, isNewPrompt: true,
  };
}

function session(id, queries) {
  return { sessionId: id, date: '2026-11-24', project: 'p', queryCount: queries.length, queries };
}

function payload(sessions) {
  return { sessions, totals: {}, dailyUsage: [] };
}

function shardFiles(tempDir, devId) {
  const dir = path.join(tempDir, 'archive', devId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) : [];
}

function readShardEntries(tempDir, devId) {
  return shardFiles(tempDir, devId).flatMap(f =>
    fs.readFileSync(path.join(tempDir, 'archive', devId, f), 'utf-8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

test('forEachLineInFile handles multibyte text split across 1 MB chunk boundaries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-archive-'));
  const { archive } = loadFresh(tempDir);
  const fp = path.join(tempDir, 'big.jsonl');
  const lines = [];
  // ~2.5 MB of Cyrillic (2-byte UTF-8) so boundaries land mid-character and mid-line.
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ i, t: 'Привіт світ '.repeat(300) }));
  fs.writeFileSync(fp, lines.join('\n')); // no trailing newline: last line must still be emitted
  const seen = [];
  archive.forEachLineInFile(fp, l => seen.push(JSON.parse(l)));
  assert.equal(seen.length, 400);
  assert.deepEqual(seen.map(s => s.i), [...Array(400).keys()]);
  assert.ok(seen.every(s => s.t.startsWith('Привіт')));
});

test('sync uses the index, appends only new queries to a shard, and never rewrites the legacy archive', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-archive-'));
  const { store } = loadFresh(tempDir);

  // First sync: one session with 2 queries.
  await store.saveDeveloper('dev1', payload([session('s1', [q(1), q(2)])]));

  // Simulate a pre-existing legacy archive for another session.
  fs.writeFileSync(path.join(tempDir, 'archive', 'dev1.jsonl'),
    JSON.stringify(session('legacy', [q(5, 'old prompt')])) + '\n');
  const legacyBefore = fs.readFileSync(path.join(tempDir, 'archive', 'dev1.jsonl'), 'utf-8');

  // Second sync: s1 grew to 3 queries.
  await store.saveDeveloper('dev1', payload([session('s1', [q(1), q(2), q(3)])]));

  const entries = readShardEntries(tempDir, 'dev1');
  assert.equal(entries.length, 2, 'initial entry + delta entry');
  assert.equal(entries[0].queries.length, 2);
  assert.deepEqual(entries[1].queries.map(x => x.userPrompt), ['prompt 3'], 'only the new query is appended');
  assert.equal(fs.readFileSync(path.join(tempDir, 'archive', 'dev1.jsonl'), 'utf-8'), legacyBefore);

  const index = JSON.parse(fs.readFileSync(path.join(tempDir, 'archive-index', 'dev1.json'), 'utf-8'));
  assert.ok(index.sessionIds.includes('s1'));
});

test('index is built from legacy + shards when missing; readers span both', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-archive-'));
  fs.mkdirSync(path.join(tempDir, 'archive', 'dev2'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'archive', 'dev2.jsonl'),
    JSON.stringify(session('a', [q(1, 'legacy prompt')])) + '\n');
  fs.writeFileSync(path.join(tempDir, 'archive', 'dev2', '2026-11_x.jsonl'),
    JSON.stringify(session('b', [q(2, 'shard prompt')])) + '\n');
  const { store } = loadFresh(tempDir);

  assert.deepEqual([...store.getArchivedSessionIds('dev2')].sort(), ['a', 'b']);
  assert.ok(fs.existsSync(path.join(tempDir, 'archive-index', 'dev2.json')));

  const prompts = store.loadArchivePrompts('dev2');
  assert.deepEqual(prompts.get('a'), ['legacy prompt']);
  assert.deepEqual(prompts.get('b'), ['shard prompt']);
});

test('before hydration (S3 on, no index), sync skips gap backfill and does not persist an index', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-archive-'));
  const { store, archive, uploads } = loadFresh(tempDir, { s3Bucket: 'b' });
  try {
    await store.saveDeveloper('dev3', payload([session('s1', [q(1)])]));
    assert.equal(readShardEntries(tempDir, 'dev3').length, 1, 'new session still archived');
    assert.equal(fs.existsSync(path.join(tempDir, 'archive-index', 'dev3.json')), false);
    assert.ok(uploads.some(u => u.includes(path.join('archive', 'dev3'))), 'shard uploaded');
    assert.ok(uploads.every(u => !u.endsWith('dev3.jsonl')), 'no legacy-file upload');

    // Once hydrated, the index is built from local files (including the pre-hydration shard).
    archive.markArchivesReady([]);
    assert.deepEqual([...store.getArchivedSessionIds('dev3')], ['s1']);
  } finally {
    delete require.cache[S3_PATH];
  }
});
