#!/usr/bin/env node

// Setup script: adds a Claude Code Stop hook to auto-sync after each conversation.
// Usage: npx --yes github:alessio-cmyk/claude-spend setup --key <your-key>
//    or: node src/setup.js --key <your-key> --server <server-url>

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2).filter(a => a !== 'setup');
const keyIdx = args.indexOf('--key');
const serverIdx = args.indexOf('--server');
const removeFlag = args.includes('--remove');

const DEFAULT_SERVER = 'https://ks5kkwv9ja.us-east-1.awsapprunner.com';
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

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

const syncCommand = `npx --yes github:alessio-cmyk/claude-spend --sync --key ${apiKey} --server ${serverUrl}`;

// Check if already installed
const existingIdx = settings.hooks.Stop.findIndex(h =>
  h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-spend --sync'))
);

if (existingIdx !== -1) {
  // Update existing hook
  for (const hh of settings.hooks.Stop[existingIdx].hooks) {
    if (hh.command && hh.command.includes('claude-spend --sync')) {
      hh.command = syncCommand;
    }
  }
  console.log('\n  Updated existing claude-spend sync hook.');
} else {
  settings.hooks.Stop.push({
    matcher: '.*',
    hooks: [{
      type: 'command',
      command: syncCommand,
    }],
  });
  console.log('\n  Added claude-spend sync hook.');
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(`  Settings: ${settingsPath}`);
console.log(`  Server:   ${serverUrl}`);
console.log(`\n  Your Claude Code sessions will now auto-sync when conversations end.\n`);
