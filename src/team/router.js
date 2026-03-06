const express = require('express');
const fs = require('fs');
const path = require('path');
const { saveDeveloper, loadDeveloper, listDevelopers, filterSessions, computeTotals, snapshotHealthHistory, loadHealthHistory } = require('./store');
const { getProductivityAnalytics, getWeekOverWeekDeltas, getInactivityStatus } = require('./analytics');

/* === Allowlist-based auth === */
const ALLOWLIST_PATH = path.join(process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team'), 'allowlist.json');

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return null; // no allowlist = open mode
  try { return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8')); } catch { return null; }
}

function resolveKey(key) {
  const allowlist = loadAllowlist();
  if (!allowlist) return null;
  return allowlist.find(u => u.key === key) || null;
}

function validateSync(devId, key) {
  const allowlist = loadAllowlist();
  if (!allowlist) return { ok: true }; // open mode — no allowlist file
  const entry = allowlist.find(u => u.devId === devId);
  if (!entry) return { ok: false, error: `Unknown developer "${devId}". Ask your admin for access.` };
  if (!key) return { ok: false, error: 'API key required. Use --key <your-key> when syncing.' };
  if (entry.key !== key) return { ok: false, error: 'Invalid API key for ' + devId };
  return { ok: true };
}

function createTeamRouter() {
  const router = express.Router();

  // GET /api/team/whoami?key=... - Resolve key to devId (for CLI)
  router.get('/whoami', (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'Missing key parameter' });
    const entry = resolveKey(key);
    if (!entry) return res.status(403).json({ error: 'Invalid API key' });
    res.json({ devId: entry.devId, name: entry.name });
  });

  // POST /api/team/sync - Developer pushes their data
  router.post('/sync', express.json({ limit: '50mb' }), (req, res) => {
    let { devId, data, key } = req.body;
    if (!data) {
      return res.status(400).json({ error: 'Missing data' });
    }
    // Resolve devId from key if not provided
    if (!devId && key) {
      const entry = resolveKey(key);
      if (!entry) return res.status(403).json({ error: 'Invalid API key' });
      devId = entry.devId;
    }
    if (!devId) {
      return res.status(400).json({ error: 'Missing devId or key' });
    }
    if (typeof devId !== 'string' || devId.length > 100) {
      return res.status(400).json({ error: 'Invalid devId' });
    }
    const auth = validateSync(devId, key);
    if (!auth.ok) {
      return res.status(403).json({ error: auth.error });
    }
    try {
      const merged = saveDeveloper(devId, data);

      /* === FEATURE 3: Snapshot health history on sync === */
      try {
        const analytics = getProductivityAnalytics();
        const devScores = {};
        let teamTotal = 0, teamCount = 0;
        for (const d of analytics.developers) {
          if (d.sessions > 0) {
            const score = computeHealthScore(d);
            devScores[d.devId] = score;
            teamTotal += score;
            teamCount++;
          }
        }
        const teamScore = teamCount > 0 ? Math.round((teamTotal / teamCount) * 10) / 10 : 0;
        snapshotHealthHistory(teamScore, devScores);
      } catch {}

      res.json({
        ok: true,
        devId,
        sessionCount: (merged.sessions || []).length,
        lastSync: merged.lastSync,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save: ' + err.message });
    }
  });

  // GET /api/team/leaderboard
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD for date range filtering
  router.get('/leaderboard', (req, res) => {
    try {
      const { from, to } = req.query;
      const devs = listDevelopers();

      const leaderboard = devs.map(d => {
        // If date filtering, reload full data and recompute
        if (from || to) {
          const full = loadDeveloper(d.devId);
          if (!full) return null;
          const filtered = filterSessions(full.sessions || [], from, to);
          const totals = computeTotals(filtered);
          return { devId: d.devId, lastSync: d.lastSync, ...totals };
        }
        const t = d.totals || {};
        return {
          devId: d.devId,
          lastSync: d.lastSync,
          totalTokens: t.totalTokens || 0,
          totalCost: t.totalCost || 0,
          totalSessions: t.totalSessions || d.sessionCount || 0,
          totalQueries: t.totalQueries || 0,
          totalInputTokens: t.totalInputTokens || 0,
          totalOutputTokens: t.totalOutputTokens || 0,
          totalCacheReadTokens: t.totalCacheReadTokens || 0,
        };
      }).filter(Boolean).sort((a, b) => b.totalTokens - a.totalTokens);

      const teamTotals = {
        totalDevs: leaderboard.length,
        totalTokens: leaderboard.reduce((s, d) => s + d.totalTokens, 0),
        totalCost: leaderboard.reduce((s, d) => s + d.totalCost, 0),
        totalSessions: leaderboard.reduce((s, d) => s + d.totalSessions, 0),
        totalQueries: leaderboard.reduce((s, d) => s + d.totalQueries, 0),
      };

      res.json({ leaderboard, teamTotals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/dev/:devId - Full data for one developer
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD for date range filtering
  // ?lite=1 to strip per-query data (smaller response)
  router.get('/dev/:devId', (req, res) => {
    try {
      const data = loadDeveloper(req.params.devId);
      if (!data) return res.status(404).json({ error: 'Developer not found' });
      const { from, to, lite } = req.query;
      let sessions = data.sessions || [];
      let dailyUsage = data.dailyUsage || [];

      if (from || to) {
        sessions = filterSessions(sessions, from, to);
        dailyUsage = dailyUsage.filter(d => {
          if (from && d.date < from) return false;
          if (to && d.date > to) return false;
          return true;
        });
      }

      if (lite) {
        // Sessions are already compacted (no queries[]), just pass through
        const totals = from || to ? computeTotals(sessions) : data.totals;
        return res.json({ ...data, sessions, totals, dailyUsage });
      }

      if (from || to) {
        return res.json({ ...data, sessions, totals: computeTotals(sessions), dailyUsage });
      }
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/productivity - Full productivity analytics
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD for date range filtering
  router.get('/productivity', (req, res) => {
    try {
      const { from, to } = req.query;
      res.json(getProductivityAnalytics(from, to));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/devs - List all developer IDs
  router.get('/devs', (req, res) => {
    try {
      res.json(listDevelopers());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* === FEATURE 1c: Health Check Endpoint === */
  router.get('/health', (req, res) => {
    try {
      const devs = listDevelopers();
      const allowlist = loadAllowlist();
      const lastSync = devs.reduce((latest, d) => {
        if (d.lastSync && (!latest || d.lastSync > latest)) return d.lastSync;
        return latest;
      }, null);
      res.json({
        status: 'ok',
        version: '1.0',
        devCount: devs.length,
        lastSync: lastSync || null,
        authEnabled: !!allowlist,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* === FEATURE 2: Week-over-Week Deltas Endpoint (augments leaderboard) === */
  router.get('/wow', (req, res) => {
    try {
      res.json(getWeekOverWeekDeltas());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* === FEATURE 3b: Health History Endpoint === */
  router.get('/health-history', (req, res) => {
    try {
      const days = Math.min(180, Math.max(1, parseInt(req.query.days) || 30));
      const history = loadHealthHistory(days);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* === FEATURE 4: Inactivity Status Endpoint (augments leaderboard) === */
  router.get('/inactivity', (req, res) => {
    try {
      res.json(getInactivityStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/* === FEATURE 3: Health score computation (mirrors client-side computeHealth) === */
function computeHealthScore(d) {
  const qDepth = Math.min(20, (d.avgQueriesPerSession / 10) * 20);
  const toolAct = Math.min(20, (d.toolActivationRate / 100) * 20);
  const toolDiv = Math.min(15, (d.uniqueTools / 10) * 15);
  const cache = Math.min(20, (d.cacheHitRate / 50) * 20);
  const modelCount = Object.keys(d.modelUsage || {}).length;
  const modelDisc = modelCount <= 2 ? 10 : modelCount <= 4 ? 7 : 4;
  const consist = Math.min(15, (d.activeDays / 30) * 15);
  return Math.round((qDepth + toolAct + toolDiv + cache + modelDisc + consist) * 10) / 10;
}

module.exports = { createTeamRouter };
