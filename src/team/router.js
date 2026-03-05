const express = require('express');
const { saveDeveloper, loadDeveloper, listDevelopers, filterSessions, computeTotals } = require('./store');
const { getProductivityAnalytics } = require('./analytics');

function createTeamRouter() {
  const router = express.Router();

  // POST /api/team/sync - Developer pushes their data
  router.post('/sync', express.json({ limit: '50mb' }), (req, res) => {
    const { devId, data } = req.body;
    if (!devId || !data) {
      return res.status(400).json({ error: 'Missing devId or data' });
    }
    if (typeof devId !== 'string' || devId.length > 100) {
      return res.status(400).json({ error: 'Invalid devId' });
    }
    try {
      const merged = saveDeveloper(devId, data);
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
        const liteSessions = sessions.map(s => {
          const queries = s.queries || [];
          const tools = {};
          const models = {};
          let hasToolCall = false;
          for (const q of queries) {
            const m = q.model || 'unknown';
            if (m !== '<synthetic>' && m !== 'unknown') {
              if (!models[m]) models[m] = { queries: 0, tokens: 0, cost: 0 };
              models[m].queries += 1;
              models[m].tokens += q.totalTokens || 0;
              models[m].cost += q.cost || 0;
            }
            for (const t of (q.tools || [])) {
              tools[t] = (tools[t] || 0) + 1;
              hasToolCall = true;
            }
          }
          const { queries: _, ...rest } = s;
          return { ...rest, _tools: tools, _models: models, _hasToolCall: hasToolCall };
        });
        const totals = from || to ? computeTotals(sessions) : data.totals;
        return res.json({ ...data, sessions: liteSessions, totals, dailyUsage });
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

  return router;
}

module.exports = { createTeamRouter };
