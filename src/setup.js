#!/usr/bin/env node

/* === FEATURE 1: New Dev Onboarding Wizard === */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const CONFIG_PATH = path.join(os.homedir(), '.claude-spend-config.json');

function ask(rl, question, defaultVal) {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`  ${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function checkHealth(serverUrl) {
  const url = new URL('/api/team/health', serverUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200 && json.status === 'ok') resolve({ ok: true, data: json });
          else resolve({ ok: false, error: 'Server returned status ' + res.statusCode });
        } catch { resolve({ ok: false, error: 'Invalid JSON response' }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
  });
}

function getShellProfile() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return '~/.zshrc';
  if (shell.includes('bash')) {
    // macOS uses .bash_profile, Linux uses .bashrc
    if (process.platform === 'darwin') return '~/.bash_profile';
    return '~/.bashrc';
  }
  return '~/.profile';
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  ===================================');
  console.log('   Claude Spend - Team Setup Wizard');
  console.log('  ===================================\n');

  const existing = loadConfig();
  if (existing) {
    console.log(`  Existing config found: devId="${existing.devId}", server="${existing.serverUrl}"`);
    const update = await ask(rl, 'Update existing config? (y/N)', 'N');
    if (update.toLowerCase() !== 'y') {
      console.log('  Keeping existing config. Exiting.\n');
      rl.close();
      return;
    }
    console.log('');
  }

  // Step 1: Name
  const defaultName = existing ? existing.devId : '';
  const devId = await ask(rl, 'Step 1: What\'s your name? (this will be your devId on the team server)', defaultName);
  if (!devId) {
    console.log('  Error: Name is required.\n');
    rl.close();
    return;
  }

  // Step 2: Server URL
  const defaultUrl = existing ? existing.serverUrl : 'http://localhost:3457';
  const serverUrl = await ask(rl, 'Step 2: What\'s the team server URL?', defaultUrl);

  // Step 3: Verify connection
  console.log('\n  Step 3: Verifying connection...');
  const health = await checkHealth(serverUrl);
  if (health.ok) {
    const h = health.data;
    console.log(`  Connected! Server v${h.version || '1.0'} - ${h.devCount || 0} developers, last sync: ${h.lastSync || 'never'}`);
  } else {
    console.log(`  Connection failed: ${health.error}`);
    console.log('  Make sure the team server is running: node src/team-server.js');
    console.log('  You can still save this config and try syncing later.\n');
  }

  // Save config
  const config = { devId, serverUrl };
  saveConfig(config);
  console.log(`\n  Config saved to ${CONFIG_PATH}`);

  // Step 4: First sync
  console.log('\n  Step 4: Running first sync...');
  let sessionCount = 0;
  try {
    const { parseAllSessions } = require('./parser');
    const data = await parseAllSessions();
    console.log(`  Found ${data.sessions.length} sessions, ${data.totals.totalQueries} queries`);

    const { syncToTeam } = require('./sync');
    const result = await syncToTeam(serverUrl, devId, data);
    sessionCount = result.sessionCount || 0;
    console.log(`  Synced! Server now has ${sessionCount} sessions for ${devId}`);
  } catch (err) {
    console.log(`  Sync failed: ${err.message}`);
    console.log('  You can retry later with: node src/index.js --sync --name ' + devId);
  }

  // Step 5: Summary
  const profileFile = getShellProfile();
  const scriptPath = path.resolve(__dirname, 'index.js');
  const alias = `alias claude-sync='node ${scriptPath} --sync --name ${devId}'`;

  console.log('\n  ===================================');
  console.log('   Setup Complete!');
  console.log('  ===================================');
  console.log(`  devId:          ${devId}`);
  console.log(`  Server:         ${serverUrl}`);
  console.log(`  Sessions:       ${sessionCount}`);
  console.log(`  Dashboard:      ${serverUrl}`);
  console.log('');
  console.log('  Step 5: Add this to your shell profile to sync daily:');
  console.log(`  File: ${profileFile}\n`);
  console.log(`  ${alias}`);
  console.log('');
  console.log('  Then run `claude-sync` anytime to push your latest data.\n');

  rl.close();
}

main().catch(err => {
  console.error('Setup error:', err.message);
  process.exit(1);
});
