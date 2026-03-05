#!/usr/bin/env node

const { createServer } = require('./server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - See where your Claude Code tokens go

Usage:
  claude-spend [options]

Options:
  --port <port>         Port to run dashboard on (default: 3456)
  --no-open             Don't auto-open browser
  --sync                Sync your data to a team server
  --server <url>        Team server URL (default: http://localhost:3457)
  --name <devId>        Your developer name for the team leaderboard
  --help, -h            Show this help message

Examples:
  npx claude-spend                              Open personal dashboard
  claude-spend --port 8080                      Use custom port
  claude-spend --sync --name alice              Sync to local team server
  claude-spend --sync --name alice --server https://team.example.com
`);
  process.exit(0);
}

// --- Sync mode ---
if (args.includes('--sync')) {
  const nameIdx = args.indexOf('--name');
  const devId = nameIdx !== -1 ? args[nameIdx + 1] : null;
  if (!devId) {
    console.error('Error: --sync requires --name <your-name>');
    process.exit(1);
  }

  const serverIdx = args.indexOf('--server');
  const serverUrl = serverIdx !== -1 ? args[serverIdx + 1] : 'http://localhost:3457';

  (async () => {
    try {
      console.log(`\n  Parsing your Claude Code sessions...`);
      const { parseAllSessions } = require('./parser');
      const data = await parseAllSessions();
      console.log(`  Found ${data.sessions.length} sessions, ${data.totals.totalQueries} queries`);

      console.log(`  Syncing to ${serverUrl} as "${devId}"...`);
      const { syncToTeam } = require('./sync');
      const result = await syncToTeam(serverUrl, devId, data);
      console.log(`  Synced! Server now has ${result.sessionCount} sessions for ${devId}`);
      console.log(`  View leaderboard: ${serverUrl}\n`);
    } catch (err) {
      console.error(`\n  Sync failed: ${err.message}\n`);
      process.exit(1);
    }
  })();
  return;
}

// --- Dashboard mode ---
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3456;
const noOpen = args.includes('--no-open');

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}

const app = createServer();

const server = app.listen(port, async () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  claude-spend dashboard running at ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close();
  process.exit(0);
});
