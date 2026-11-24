const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('setup script does not execute shell metacharacters from key/server args', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-home-'));
  const marker = path.join(tmpHome, 'pwned.txt');
  const key = `abc'; touch ${marker}; #'`;
  const server = `http://localhost:9999'; touch ${marker}; #'`;

  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), 'src', 'setup.js'),
    '--key',
    key,
    '--server',
    server,
  ], {
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf-8',
    timeout: 120000,
  });

  assert.equal(run.status, 0);
  assert.equal(fs.existsSync(marker), false);

  const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  const command = settings.hooks.Stop[0].hooks[0].command;
  assert.match(command, /--key\s+'abc'\\''; touch /);
  assert.match(command, /--server\s+'http:\/\/localhost:9999'\\''; touch /);
});

test('setup ignores the temporary npx binary and keeps the npx command', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spend-home-'));
  const npxBin = path.join(tmpHome, '.npm', '_npx', 'abc123', 'node_modules', '.bin');
  fs.mkdirSync(npxBin, { recursive: true });
  fs.writeFileSync(path.join(npxBin, 'claude-spend'), '#!/bin/sh\n', { mode: 0o755 });

  const run = spawnSync(process.execPath, [
    path.join(process.cwd(), 'src', 'setup.js'), '--key', 'k', '--server', 'http://localhost:9999',
  ], {
    env: { ...process.env, HOME: tmpHome, PATH: npxBin + path.delimiter + '/usr/bin:/bin' },
    encoding: 'utf-8',
    timeout: 120000,
  });

  assert.equal(run.status, 0, run.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
  const hook = settings.hooks.Stop[0].hooks[0];
  assert.match(hook.command, /^npx --yes github:alessio-cmyk\/claude-spend --sync /);
  assert.equal(hook.async, true);
});
