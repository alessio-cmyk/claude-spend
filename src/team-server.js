#!/usr/bin/env node

const express = require('express');
const path = require('path');
const { createTeamRouter } = require('./team/router');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : parseInt(process.env.PORT, 10) || 3457;

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
  console.log(`  API:          http://localhost:${port}/api/team/leaderboard\n`);
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
