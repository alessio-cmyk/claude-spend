#!/usr/bin/env node

// Setup script: adds a Claude Code Stop hook to auto-sync after each conversation.
// Usage: npx --yes github:alessio-cmyk/claude-spend setup --key <your-key>
//    or: node src/setup.js --key <your-key> --server <server-url>

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2).filter(a => a !== 'setup');
const keyIdx = args.indexOf('--key');
const serverIdx = args.indexOf('--server');
const removeFlag = args.includes('--remove');

const DEFAULT_SERVER = 'https://ks5kkwv9ja.us-east-1.awsapprunner.com';
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

function shellEscapeArg(value) {
  const s = String(value);
  if (s.length === 0) return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

if (removeFlag) {
  // Remove the sync hook
  if (!fs.existsSync(settingsPath)) {
    console.log('\n  No Claude settings found. Nothing to remove.\n');
    process.exit(0);
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = settings.hooks.Stop.filter(h =>
      !(h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-spend --sync')))
    );
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('\n  Removed claude-spend sync hook.\n');
  } else {
    console.log('\n  No sync hook found.\n');
  }
  process.exit(0);
}

if (keyIdx === -1) {
  console.log(`
  Claude Spend - Auto-Sync Setup

  Usage:
    node setup.js --key <your-api-key> [--server <url>]
    node setup.js --remove

  This adds a Claude Code hook that auto-syncs your usage
  data when each conversation ends. Zero effort after setup.

  Get your key from your team admin.
`);
  process.exit(1);
}

const apiKey = args[keyIdx + 1];
const serverUrl = serverIdx !== -1 ? args[serverIdx + 1] : DEFAULT_SERVER;

// Load or create settings
let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
}

if (!settings.hooks) settings.hooks = {};
if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

// Prefer a globally installed binary: `npx --yes github:...` re-fetches the package on
// every run (~18 s), which a Stop hook pays after every single reply.
// `npx ... setup` puts a temporary copy (~/.npm/_npx/...) on PATH; that one disappears,
// so only a binary outside npx's cache counts as a real global install.
function findGlobalBinary() {
  const r = spawnSync('sh', ['-c', 'command -v claude-spend'], { encoding: 'utf-8' });
  const bin = r.status === 0 ? r.stdout.trim() : '';
  if (!bin) return null;
  let real = bin;
  try { real = fs.realpathSync(bin); } catch {}
  return /[\\/]_npx[\\/]/.test(bin) || /[\\/]_npx[\\/]/.test(real) ? null : bin;
}
const hasGlobalBinary = !!findGlobalBinary();
if (!hasGlobalBinary) {
  console.log('\n  Note: claude-spend is not installed globally, so the hook will use npx (slow, ~18 s per run).');
  console.log('  Recommended: npm i -g github:alessio-cmyk/claude-spend   then re-run this setup.');
}

const syncCommand = [
  ...(hasGlobalBinary ? ['claude-spend'] : ['npx', '--yes', 'github:alessio-cmyk/claude-spend']),
  '--sync',
  '--key',
  shellEscapeArg(apiKey),
  '--server',
  shellEscapeArg(serverUrl),
].join(' ');

// Check if already installed
const existingIdx = settings.hooks.Stop.findIndex(h =>
  h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-spend --sync'))
);

if (existingIdx !== -1) {
  // Update existing hook
  for (const hh of settings.hooks.Stop[existingIdx].hooks) {
    if (hh.command && hh.command.includes('claude-spend --sync')) {
      hh.command = syncCommand;
      hh.async = true;
    }
  }
  console.log('\n  Updated existing claude-spend sync hook.');
} else {
  settings.hooks.Stop.push({
    matcher: '.*',
    hooks: [{
      type: 'command',
      command: syncCommand,
      // Run in the background so syncing never holds up the next prompt.
      async: true,
    }],
  });
  console.log('\n  Added claude-spend sync hook.');
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(`  Settings: ${settingsPath}`);
console.log(`  Server:   ${serverUrl}`);
console.log(`\n  Your Claude Code sessions will now auto-sync when conversations end.`);

// Run first sync immediately
console.log('\n  Running first sync...\n');
try {
  const run = spawnSync(process.execPath, [
    path.join(__dirname, 'index.js'),
    '--sync',
    '--key',
    apiKey,
    '--server',
    serverUrl,
  ], { encoding: 'utf-8', timeout: 120000 });

  if (run.stdout) process.stdout.write(run.stdout);
  if (run.status !== 0) {
    const msg = (run.stderr || run.stdout || `exit code ${run.status}`).trim();
    throw new Error(msg);
  }
} catch (err) {
  const msg = err.message;
  console.log(`  First sync failed: ${msg.trim()}\n  You can retry manually or it will sync after your next Claude conversation.\n`);
}
