const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

function getDataDir() { return process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team'); }
function getBucket() { return process.env.S3_BUCKET; }
function getPrefix() { return process.env.S3_PREFIX || 'team/'; }

let client = null;

function isEnabled() {
  return !!getBucket();
}

function getClient() {
  if (!client) {
    const opts = {};
    if (process.env.AWS_REGION) opts.region = process.env.AWS_REGION;
    client = new S3Client(opts);
  }
  return client;
}

// Convert local file path to S3 key
function toKey(filePath) {
  const rel = path.relative(getDataDir(), filePath);
  return getPrefix() + rel.replace(/\\/g, '/');
}

// Upload a single file to S3. Callers may fire-and-forget; the returned promise
// resolves true on success (or when S3 is disabled) and false on failure — never rejects.
function uploadFile(filePath) {
  if (!isEnabled()) return Promise.resolve(true);
  const key = toKey(filePath);
  let body;
  try { body = fs.readFileSync(filePath); }
  catch (err) {
    console.error(`[S3] Upload failed for ${key}:`, err.message);
    return Promise.resolve(false);
  }
  return getClient().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  })).then(() => true, err => {
    console.error(`[S3] Upload failed for ${key}:`, err.message);
    return false;
  });
}

// A relative key (key minus prefix) is an "archive" file if it lives under archive/.
// Archives are large (100s of MB) and only needed for backfill / conversation history,
// not for serving the leaderboard or productivity API.
function isArchiveRel(rel) {
  return rel.startsWith('archive/');
}

// Download files from S3 to the local data dir, restricted by a relative-key filter.
async function downloadFiltered(filterRel, label, { skipNewerLocal = false } = {}) {
  if (!isEnabled()) return 0;
  const bucket = getBucket();
  const prefix = getPrefix();
  const dataDir = getDataDir();
  console.log(`[S3] Downloading ${label} from s3://${bucket}/${prefix} ...`);

  const s3 = getClient();
  let continuationToken;
  let count = 0;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = (res.Contents || []).filter(obj => {
      const rel = obj.Key.slice(prefix.length);
      return rel && filterRel(rel);
    });
    await Promise.all(objects.map(async (obj) => {
      const rel = obj.Key.slice(prefix.length);
      const localPath = path.join(dataDir, rel);
      if (skipNewerLocal) {
        // This process may already have appended to the file (e.g. a sync landed before
        // hydration finished); never clobber a local copy with an older remote one.
        try { if (fs.statSync(localPath).size >= (obj.Size || 0)) return; } catch {}
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      const getRes = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: obj.Key,
      }));
      // Stream to disk: archives are 100s of MB and buffering them all at once
      // (Promise.all over every file) can exhaust instance memory.
      const tmpPath = localPath + '.download.' + process.pid;
      await pipeline(getRes.Body, fs.createWriteStream(tmpPath));
      fs.renameSync(tmpPath, localPath);
      count++;
    }));

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`[S3] Downloaded ${count} ${label} file(s)`);
  return count;
}

// Download all files (core + archives). Kept for seeding / one-shot tools.
async function downloadAll() {
  return downloadFiltered(() => true, 'all data');
}

// Download only the small per-dev summary JSONs needed to serve the dashboard.
async function downloadCore() {
  return downloadFiltered(rel => !isArchiveRel(rel), 'core data');
}

// Download only the large archive JSONLs (backfill / conversation history).
async function downloadArchives() {
  return downloadFiltered(isArchiveRel, 'archives', { skipNewerLocal: true });
}

// Upload all local files to S3 (for initial seeding)
async function uploadAll() {
  if (!isEnabled()) return;
  const bucket = getBucket();
  const prefix = getPrefix();
  const dataDir = getDataDir();
  console.log(`[S3] Uploading data to s3://${bucket}/${prefix} ...`);

  const s3 = getClient();
  let count = 0;

  function walk(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else files.push(full);
    }
    return files;
  }

  if (!fs.existsSync(dataDir)) return;
  const files = walk(dataDir);

  for (const filePath of files) {
    const key = toKey(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(filePath),
      ContentType: filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    }));
    count++;
  }

  console.log(`[S3] Uploaded ${count} files`);
}

module.exports = { isEnabled, uploadFile, downloadAll, downloadCore, downloadArchives, uploadAll };
