// Per-developer query archive (full per-query prompts that don't survive compaction).
//
// Layout under DATA_DIR:
//   archive/<dev>.jsonl                      legacy single-file archive (read-only now)
//   archive/<dev>/<YYYY-MM>_<bootId>.jsonl   append-only shards, one per month per process
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
function forEachArchiveEntry(devId, fn) {
  for (const file of archiveFiles(devId)) {
    try {
      forEachLineInFile(file, line => {
        let entry;
        try { entry = JSON.parse(line); } catch { return; }
        fn(entry);
      });
    } catch {}
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
  forEachArchiveEntry(devId, e => { if (e && e.sessionId) ids.add(e.sessionId); });
  indexCache.set(safe, ids);
  if (ids.size > 0) writeIndex(safe, ids);
  return ids;
}

function getArchivedSessionIds(devId) {
  return loadIndex(devId) || new Set();
}

// Append session entries (each { sessionId, ..., queries: [...] }) to the current shard.
function appendToArchive(devId, entries) {
  if (!entries || entries.length === 0) return;
  const safe = safeId(devId);
  const dir = path.join(ARCHIVE_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const file = path.join(dir, `${month}_${BOOT_ID}.jsonl`);
  fs.appendFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  uploadFile(file);

  const ids = loadIndex(devId);
  if (ids) {
    let changed = false;
    for (const e of entries) {
      if (e.sessionId && !ids.has(e.sessionId)) { ids.add(e.sessionId); changed = true; }
    }
    if (changed) writeIndex(safe, ids);
  }
}

// Entry/query counts for the admin archive-health report.
function archiveStats(devId) {
  const files = archiveFiles(devId);
  let entries = 0, queries = 0;
  forEachArchiveEntry(devId, e => { entries++; queries += (e.queries || []).length; });
  return { exists: files.length > 0, files: files.length, entries, queries };
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
  archivesReady = !s3Enabled();
}

module.exports = {
  ARCHIVE_DIR, INDEX_DIR,
  safeId, archiveFiles, forEachArchiveEntry, forEachLineInFile,
  getArchivedSessionIds, loadIndex, appendToArchive, archiveStats, markArchivesReady,
  _resetForTests,
};
