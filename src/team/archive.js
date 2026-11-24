// Per-developer query archive (full per-query prompts that don't survive compaction).
//
// Layout under DATA_DIR:
//   archive/<dev>.jsonl                      legacy single-file archive (read-only now)
//   archive/<dev>/<YYYY-MM>_<bootId>_<n>.jsonl  append-only shards, per month per process, rotated at 4 MB
//   archive-index/<dev>.json                 { sessionIds: [...] } — small, loaded at boot
//
// Why: the legacy files grew to 100s of MB each. Every sync used to read the whole file
// to find archived session IDs and then re-upload the whole file to S3, which OOM-killed
// the 4 GB App Runner instance once several syncs overlapped. Now a sync touches only the
// small index and a small shard. Shards are named per process (bootId) so an instance that
// appends before background hydration finishes can never overwrite another instance's file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uploadFile, isEnabled: s3Enabled } = require('./s3');

const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const INDEX_DIR = path.join(DATA_DIR, 'archive-index');
const BOOT_ID = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// With S3 on, archives arrive via background hydration after the server starts listening.
// Until then the local archive is incomplete, so we must not build (and persist) an index from it.
let archivesReady = !s3Enabled();
const indexCache = new Map(); // safeId -> Set<sessionId>

function safeId(devId) {
  return String(devId).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function archiveFiles(devId) {
  const safe = safeId(devId);
  const files = [];
  const legacy = path.join(ARCHIVE_DIR, safe + '.jsonl');
  if (fs.existsSync(legacy)) files.push(legacy);
  const dir = path.join(ARCHIVE_DIR, safe);
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
      files.push(path.join(dir, f));
    }
  } catch {}
  return files;
}

// Read a file line by line with bounded memory (1 MB chunks), synchronously.
function forEachLineInFile(file, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let pending = null;
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const chunk = buf.subarray(0, n);
      let start = 0, nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        let lineBuf = chunk.subarray(start, nl);
        if (pending) { lineBuf = Buffer.concat([pending, lineBuf]); pending = null; }
        if (lineBuf.length) fn(lineBuf.toString('utf8'));
        start = nl + 1;
      }
      if (start < n) {
        const tail = Buffer.from(chunk.subarray(start)); // copy: buf is reused
        pending = pending ? Buffer.concat([pending, tail]) : tail;
      }
    }
    if (pending && pending.length) fn(pending.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

// Call fn(entry) for every parseable archive entry of a dev, across legacy file + shards.
// Unreadable files / unparseable lines are skipped; pass `errors` to count them.
function forEachArchiveEntry(devId, fn, errors) {
  for (const file of archiveFiles(devId)) {
    try {
      forEachLineInFile(file, line => {
        let entry;
        try { entry = JSON.parse(line); } catch { if (errors) errors.parseErrors++; return; }
        fn(entry);
      });
    } catch {
      if (errors) errors.readErrors++;
    }
  }
}

function indexPath(safe) {
  return path.join(INDEX_DIR, safe + '.json');
}

function writeIndex(safe, ids) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const fp = indexPath(safe);
  const tmp = fp + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ sessionIds: [...ids] }));
  fs.renameSync(tmp, fp);
  uploadFile(fp);
}

// Returns the Set of archived session IDs, or null if it can't be known yet
// (no index on disk and archives not hydrated).
function loadIndex(devId) {
  const safe = safeId(devId);
  if (indexCache.has(safe)) return indexCache.get(safe);
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(safe), 'utf-8'));
    const ids = new Set(parsed.sessionIds || []);
    indexCache.set(safe, ids);
    return ids;
  } catch {}
  if (!archivesReady) return null;
  const ids = new Set();
  // Exclude shards whose S3 upload hasn't succeeded yet (see appendToArchive).
  const unconfirmed = pendingShards.get(safe) || new Map();
  for (const file of archiveFiles(devId)) {
    if (unconfirmed.has(file)) continue;
    try {
      forEachLineInFile(file, line => {
        try { const e = JSON.parse(line); if (e && e.sessionId) ids.add(e.sessionId); } catch {}
      });
    } catch {}
  }
  indexCache.set(safe, ids);
  if (ids.size > 0) writeIndex(safe, ids);
  return ids;
}

function getArchivedSessionIds(devId) {
  return loadIndex(devId) || new Set();
}

// Shards rotate at this size so each S3 upload (which re-sends the whole shard) stays small
// no matter how long the process runs.
const SHARD_MAX_BYTES = 4 * 1024 * 1024;
const shardSeq = new Map();      // safeId -> current shard sequence number
const pendingShards = new Map(); // safeId -> Map<shardPath, Set<sessionId>> not yet confirmed in S3

function currentShard(safe) {
  const dir = path.join(ARCHIVE_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  let seq = shardSeq.get(safe) || 0;
  let file = path.join(dir, `${month}_${BOOT_ID}_${String(seq).padStart(6, '0')}.jsonl`);
  try {
    if (fs.statSync(file).size >= SHARD_MAX_BYTES) {
      seq++;
      file = path.join(dir, `${month}_${BOOT_ID}_${String(seq).padStart(6, '0')}.jsonl`);
    }
  } catch {}
  shardSeq.set(safe, seq);
  return file;
}

// Append session entries (each { sessionId, ..., queries: [...] }) to the current shard.
// Session IDs enter the index only after their shard is confirmed in S3: otherwise a
// restart could restore an index claiming queries are archived when they never persisted,
// and the client would stop resending them. Shards whose upload failed are retried on the
// next append for that dev. Callers serialize per dev (saveDeveloper's lock), which also
// bounds concurrent shard uploads to one per dev.
// Returns true only if every shard for this dev is confirmed in S3 (always true without S3).
async function appendToArchive(devId, entries) {
  const safe = safeId(devId);
  if (!pendingShards.has(safe)) pendingShards.set(safe, new Map());
  const pending = pendingShards.get(safe);

  if (entries && entries.length > 0) {
    const file = currentShard(safe);
    fs.appendFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    if (!pending.has(file)) pending.set(file, new Set());
    for (const e of entries) if (e.sessionId) pending.get(file).add(e.sessionId);
  }
  if (pending.size === 0) return true;

  const confirmed = [];
  for (const [file, sids] of [...pending]) {
    if (await uploadFile(file)) {
      pending.delete(file);
      confirmed.push(...sids);
    }
  }

  const ids = loadIndex(devId);
  if (ids && confirmed.length > 0) {
    let changed = false;
    for (const sid of confirmed) {
      if (!ids.has(sid)) { ids.add(sid); changed = true; }
    }
    if (changed) writeIndex(safe, ids);
  }
  return pending.size === 0;
}

// Entry/query/error counts for the admin archive-health report.
function archiveStats(devId) {
  const files = archiveFiles(devId);
  const stats = { exists: files.length > 0, files: files.length, entries: 0, queries: 0, readErrors: 0, parseErrors: 0 };
  forEachArchiveEntry(devId, e => { stats.entries++; stats.queries += (e.queries || []).length; }, stats);
  return stats;
}

// Called once background hydration finishes: from now on local archives are authoritative.
// Builds missing indexes one dev at a time, yielding between devs so requests keep flowing.
function markArchivesReady(devIds = []) {
  archivesReady = true;
  const queue = devIds.slice();
  const next = () => {
    const devId = queue.shift();
    if (devId === undefined) return;
    try { loadIndex(devId); } catch (err) { console.error(`[archive] Index build failed for ${devId}:`, err.message); }
    setImmediate(next);
  };
  setImmediate(next);
}

function _resetForTests() {
  indexCache.clear();
  shardSeq.clear();
  pendingShards.clear();
  archivesReady = !s3Enabled();
}

module.exports = {
  ARCHIVE_DIR, INDEX_DIR,
  safeId, archiveFiles, forEachArchiveEntry, forEachLineInFile,
  getArchivedSessionIds, loadIndex, appendToArchive, archiveStats, markArchivesReady,
  _resetForTests,
};
