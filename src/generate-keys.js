#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env from project root
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const usersFile = process.argv[2] || path.join(__dirname, '..', 'users');
const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');
const outFile = path.join(DATA_DIR, 'allowlist.json');

const SALT = process.env.HMAC_SALT;
if (!SALT) {
  console.error('Error: HMAC_SALT not set. Add it to .env or set it as an environment variable.');
  console.error('See .env.example for reference.');
  process.exit(1);
}

if (!fs.existsSync(usersFile)) {
  console.error('Users file not found:', usersFile);
  process.exit(1);
}

const raw = fs.readFileSync(usersFile, 'utf-8').trim();
const entries = raw.split(',').map(e => e.trim()).filter(Boolean);

// Deterministic key: HMAC-MD5 of email with salt from .env
function deriveKey(email) {
  return crypto.createHmac('md5', SALT).update(email).digest('hex');
}

const allowlist = entries.map(entry => {
  const match = entry.match(/^(.+?)\s*<(.+?)>$/);
  if (!match) {
    console.warn('Skipping malformed entry:', entry);
    return null;
  }
  const name = match[1].trim();
  const email = match[2].trim().toLowerCase();
  const devId = name.split(/\s+/)[0];
  const key = deriveKey(email);
  return { devId, name, email, key };
}).filter(Boolean);

// Check for devId collisions
const idCounts = {};
for (const u of allowlist) idCounts[u.devId] = (idCounts[u.devId] || 0) + 1;
for (const u of allowlist) {
  if (idCounts[u.devId] > 1) {
    // Disambiguate with last name initial
    const parts = u.name.split(/\s+/);
    if (parts.length > 1) u.devId = parts[0] + parts[parts.length - 1][0].toUpperCase();
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(allowlist, null, 2));

console.log(`\nGenerated ${allowlist.length} API keys → ${outFile}\n`);
console.log('Share these with your team:\n');
console.log('Name'.padEnd(25) + 'Dev ID'.padEnd(18) + 'Sync Command');
console.log('-'.repeat(100));
for (const u of allowlist) {
  console.log(
    u.name.padEnd(25) +
    u.devId.padEnd(18) +
    `npx claude-spend --sync --key ${u.key} --server http://<server>:3457`
  );
}
console.log();
