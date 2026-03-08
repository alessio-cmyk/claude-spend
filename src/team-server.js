#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load .env from project root
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const express = require('express');
const http = require('http');
const https = require('https');
const { createTeamRouter } = require('./team/router');
const { isEnabled: s3Enabled, downloadAll } = require('./team/s3');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : parseInt(process.env.PORT, 10) || 3457;
const pullIndex = args.indexOf('--pull');
const pullUrl = pullIndex !== -1 ? args[pullIndex + 1] : null;

/* === Pull all dev data from a remote team server === */
function fetchJSON(url) {
  const transport = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    transport.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

async function pullFromRemote(remoteUrl) {
  const { saveDeveloper } = require('./team/store');

  console.log(`[Pull] Fetching dev list from ${remoteUrl}...`);
  const base = remoteUrl.replace(/\/$/, '');
  const devs = await fetchJSON(base + '/api/team/devs');
  console.log(`[Pull] Found ${devs.length} developers`);

  let pulled = 0;
  for (const dev of devs) {
    const devId = dev.devId;
    try {
      const data = await fetchJSON(base + '/api/team/dev/' + encodeURIComponent(devId));
      // Use saveDeveloper to merge (dedup by sessionId) instead of overwriting
      const merged = await saveDeveloper(devId, data);
      pulled++;
      console.log(`[Pull] ${devId}: ${(merged.sessions || []).length} sessions (merged)`);
    } catch (err) {
      console.error(`[Pull] Failed to pull ${devId}: ${err.message}`);
    }
  }
  console.log(`[Pull] Done — pulled ${pulled}/${devs.length} developers\n`);
}

async function start() {
  // Download data from S3 before starting (App Runner has ephemeral storage)
  console.log(`[Boot] S3_BUCKET=${process.env.S3_BUCKET || '(not set)'}, S3 enabled=${s3Enabled()}`);
  console.log(`[Boot] CLAUDE_SPEND_DATA=${process.env.CLAUDE_SPEND_DATA || '(not set)'}, cwd=${process.cwd()}`);
  if (s3Enabled()) {
    try { await downloadAll(); }
    catch (err) { console.error('[S3] Initial download failed:', err.message); }
  }

  // Pull from remote server if --pull <url> specified
  if (pullUrl) {
    try { await pullFromRemote(pullUrl); }
    catch (err) { console.error('[Pull] Failed:', err.message); }
  }
  // Log allowlist status
  const alPath = path.join(process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team'), 'allowlist.json');
  console.log(`[Boot] Allowlist path: ${alPath}, exists: ${fs.existsSync(alPath)}`);

  const app = express();

  // Team API
  app.use('/api/team', createTeamRouter());

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Serve dashboard frontend
  app.use(express.static(path.join(__dirname, 'public-team')));

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public-team', 'index.html'));
  });

  const server = app.listen(port, () => {
    console.log(`\n  claude-spend team server running at http://localhost:${port}`);
    console.log(`  Leaderboard:  http://localhost:${port}`);
    console.log(`  API:          http://localhost:${port}/api/team/leaderboard`);
    if (s3Enabled()) console.log(`  S3:           s3://${process.env.S3_BUCKET}/${process.env.S3_PREFIX || 'team/'}`);
    console.log();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try --port <other-port> or set PORT env var`);
      process.exit(1);
    }
    throw err;
  });

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    server.close();
    process.exit(0);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
