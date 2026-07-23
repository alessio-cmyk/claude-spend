const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { saveDeveloper, loadDeveloper, listDevelopers, filterSessions, computeTotalsFromDaily, snapshotHealthHistory, loadHealthHistory, recompactFromArchive, getArchivedSessionIds, loadArchivePrompts } = require('./store');
const { getProductivityAnalytics, getWeekOverWeekDeltas, getInactivityStatus } = require('./analytics');
const { uploadFile } = require('./s3');

/* === Allowlist-based auth === */
const ALLOWLIST_PATH = path.join(process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team'), 'allowlist.json');

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { exists: false, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8'));
    if (!Array.isArray(data)) return { exists: true, data: null, corrupt: true };
    return { exists: true, data };
  } catch {
    return { exists: true, data: null, corrupt: true };
  }
}

function resolveKey(key) {
  const { data: allowlist } = loadAllowlist();
  if (!allowlist) return null;
  return allowlist.find(u => u.key === key) || null;
}

function normalizeDevIdBase(name) {
  const raw = String(name || '').trim();
  const first = raw.split(/\s+/)[0] || '';
  return first.replace(/[^a-zA-Z0-9_-]/g, '');
}

function generateUniqueDevId(name, allowlist) {
  const base = normalizeDevIdBase(name);
  if (!base) return null;
  const taken = new Set((allowlist || []).map(u => String(u.devId || '').toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i <= 9999; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

function sanitizeProjectTagsInput(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
  const safe = {};
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  for (const [k, v] of Object.entries(tags)) {
    if (forbidden.has(k)) continue;
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.trim();
    const value = v.trim();
    if (!key || !value) continue;
    if (key.length > 200 || value.length > 100) continue;
    safe[key] = value;
  }
  return safe;
}

function validateSync(devId, key) {
  const { exists, data: allowlist, corrupt } = loadAllowlist();
  if (!exists) return { ok: true }; // open mode — no allowlist file
  if (corrupt || !allowlist) return { ok: false, error: 'Server auth config is corrupted. Contact your admin.' };
  const entry = allowlist.find(u => u.devId === devId);
  if (!entry) return { ok: false, error: `Unknown developer "${devId}". Ask your admin for access.` };
  if (!key) return { ok: false, error: 'API key required. Use --key <your-key> when syncing.' };
  if (entry.key !== key) return { ok: false, error: 'Invalid API key for ' + devId };
  return { ok: true };
}

function buildTeamBaseline(allDevs, excludeDevId) {
  const others = allDevs.filter(d => d.devId !== excludeDevId && d.sessions > 0);
  if (others.length === 0) return null;
  const avg = (arr, fn) => arr.reduce((s, d) => s + fn(d), 0) / arr.length;
  const min = (arr, fn) => Math.min(...arr.map(fn));
  const max = (arr, fn) => Math.max(...arr.map(fn));
  const stat = (fn) => ({ avg: +avg(others, fn).toFixed(1), min: +min(others, fn).toFixed(1), max: +max(others, fn).toFixed(1) });
  return {
    teamSize: allDevs.length,
    otherDevs: others.length,
    queriesPerSession: stat(d => d.avgQueriesPerSession || 0),
    costPerQuery: stat(d => d.queries ? d.cost / d.queries : 0),
    cacheHitRate: stat(d => d.cacheHitRate || 0),
    toolActivationRate: stat(d => d.toolActivationRate || 0),
    outputRatio: stat(d => d.outputRatio || 0),
    uniqueTools: stat(d => d.uniqueTools || 0),
    sessions: stat(d => d.sessions || 0),
    activeDays: stat(d => d.activeDays || 0),
    healthScore: stat(d => d.healthScore || 0),
  };
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
  router.post('/sync', express.json({ limit: '50mb' }), async (req, res) => {
    let { devId, data, key, timezone } = req.body;
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
      const merged = await saveDeveloper(devId, data, timezone);

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
          const filteredDaily = (full.dailyUsage || []).filter(dy => {
            if (from && dy.date < from) return false;
            if (to && dy.date > to) return false;
            return true;
          });
          const totals = computeTotalsFromDaily(filteredDaily, filtered);
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
          totalPrompts: t.totalPrompts || 0,
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
        totalPrompts: leaderboard.reduce((s, d) => s + (d.totalPrompts || 0), 0),
      };

      res.json({ leaderboard, teamTotals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/dev/:devId/work-summary?from=&to= - AI summary of what a dev worked on (review prep)
  router.get('/dev/:devId/work-summary', async (req, res) => {
    const { isConfigured, getWorkSummary } = require('./ai-review');
    if (!isConfigured()) return res.status(503).json({ error: 'AI not configured. Set GOOGLE_CREDENTIALS_BASE64 env var.' });
    try {
      const devId = req.params.devId;
      const data = loadDeveloper(devId);
      if (!data) return res.status(404).json({ error: 'Developer not found' });
      const { from, to } = req.query;
      const sessions = filterSessions(data.sessions || [], from, to);
      if (sessions.length === 0) return res.status(400).json({ error: 'No sessions in selected period' });
      const promptsBySession = loadArchivePrompts(devId);
      const summary = await getWorkSummary(devId, sessions, promptsBySession, from, to);
      res.json({ ok: true, devId, from: from || null, to: to || null, sessionCount: sessions.length, summary });
    } catch (err) {
      if (/429|RESOURCE_EXHAUSTED/i.test(err.message || '')) {
        return res.status(429).json({ error: 'AI quota temporarily exhausted — wait a minute and try again.' });
      }
      res.status(500).json({ error: 'Work summary failed: ' + err.message });
    }
  });

  // GET /api/team/dev/:devId - Full data for one developer
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD for date range filtering
  router.get('/dev/:devId', (req, res) => {
    try {
      const data = loadDeveloper(req.params.devId);
      if (!data) return res.status(404).json({ error: 'Developer not found' });
      const { from, to } = req.query;
      let sessions = data.sessions || [];
      let dailyUsage = data.dailyUsage || [];

      let totals = data.totals;
      if (from || to) {
        sessions = filterSessions(sessions, from, to);
        dailyUsage = dailyUsage.filter(d => {
          if (from && d.date < from) return false;
          if (to && d.date > to) return false;
          return true;
        });
        totals = computeTotalsFromDaily(dailyUsage, sessions);
      }

      const result = { ...data, sessions, totals, dailyUsage };
      // Include archived session IDs for sync client to detect archive gaps
      if (req.query.archived === '1') {
        result._archivedSessionIds = [...getArchivedSessionIds(req.params.devId)];
      }
      res.json(result);
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
      const { exists } = loadAllowlist();
      const lastSync = devs.reduce((latest, d) => {
        if (d.lastSync && (!latest || d.lastSync > latest)) return d.lastSync;
        return latest;
      }, null);
      res.json({
        status: 'ok',
        version: '1.0',
        devCount: devs.length,
        lastSync: lastSync || null,
        authEnabled: exists,
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

  /* === Admin API (password-protected) === */
  const ADMIN_PASS = process.env.ADMIN_PASSWORD || null;

  function checkAdmin(req, res) {
    if (!ADMIN_PASS) { res.status(503).json({ error: 'Admin not configured. Set ADMIN_PASSWORD env var.' }); return false; }
    const auth = req.headers.authorization;
    if (!auth || auth !== 'Bearer ' + ADMIN_PASS) { res.status(401).json({ error: 'Invalid admin password' }); return false; }
    return true;
  }

  // GET /api/team/admin/keys - List all keys
  router.get('/admin/keys', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { exists, data, corrupt } = loadAllowlist();
    if (!exists) return res.json({ keys: [], authEnabled: false });
    if (corrupt) return res.status(500).json({ error: 'Allowlist is corrupted' });
    res.json({ keys: data.map(u => {
      const devData = loadDeveloper(u.devId);
      return { devId: u.devId, name: u.name, email: u.email, key: u.key, timezone: devData?.timezone || null };
    }), authEnabled: true });
  });

  // POST /api/team/admin/rotate - Rotate key for a developer
  router.post('/admin/rotate', express.json(), (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { devId } = req.body;
    if (!devId) return res.status(400).json({ error: 'Missing devId' });
    const { exists, data, corrupt } = loadAllowlist();
    if (!exists || corrupt || !data) return res.status(500).json({ error: 'Allowlist not available' });
    const entry = data.find(u => u.devId === devId);
    if (!entry) return res.status(404).json({ error: 'Developer not found' });
    const salt = process.env.HMAC_SALT || 'rotate-' + Date.now();
    entry.key = crypto.createHmac('md5', salt).update(entry.email + '-' + Date.now()).digest('hex');
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2));
    uploadFile(ALLOWLIST_PATH);
    res.json({ ok: true, devId, newKey: entry.key });
  });

  // POST /api/team/admin/add - Add a developer
  router.post('/admin/add', express.json(), (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing name or email' });
    const { exists, data, corrupt } = loadAllowlist();
    let list = (exists && !corrupt && data) ? data : [];
    if (list.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists' });
    const salt = process.env.HMAC_SALT || 'default';
    const devId = generateUniqueDevId(name, list);
    if (!devId) return res.status(400).json({ error: 'Invalid name. Could not derive devId.' });
    const key = crypto.createHmac('md5', salt).update(email.toLowerCase()).digest('hex');
    list.push({ devId, name, email: email.toLowerCase(), key });
    fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));
    uploadFile(ALLOWLIST_PATH);
    res.json({ ok: true, devId, key });
  });

  // POST /api/team/admin/remove - Remove a developer from allowlist
  router.post('/admin/remove', express.json(), (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { devId } = req.body;
    if (!devId) return res.status(400).json({ error: 'Missing devId' });
    const { exists, data, corrupt } = loadAllowlist();
    if (!exists || corrupt || !data) return res.status(500).json({ error: 'Allowlist not available' });
    const filtered = data.filter(u => u.devId !== devId);
    if (filtered.length === data.length) return res.status(404).json({ error: 'Developer not found' });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(filtered, null, 2));
    uploadFile(ALLOWLIST_PATH);
    res.json({ ok: true, removed: devId });
  });

  // POST /api/team/admin/ai-review - Generate AI performance review for a developer
  router.post('/admin/ai-review', express.json(), async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { devId, from, to } = req.body;
    if (!devId) return res.status(400).json({ error: 'Missing devId' });
    const { isConfigured, generateDevReview } = require('./ai-review');
    if (!isConfigured()) return res.status(503).json({ error: 'AI review not configured. Set GOOGLE_CREDENTIALS_BASE64 env var.' });
    try {
      const analytics = getProductivityAnalytics(from, to);
      const devMetrics = analytics.developers.find(d => d.devId === devId);
      if (!devMetrics) return res.status(404).json({ error: 'Developer not found' });
      if (devMetrics.sessions === 0) return res.status(400).json({ error: 'No sessions in selected period' });
      // Load full session data for rich AI review (includes prompts, tools, projects)
      const devData = loadDeveloper(devId);
      const allSessions = devData ? (devData.sessions || []) : [];
      const sessions = filterSessions(allSessions, from, to);
      // Build team baseline for comparative context
      const allDevs = analytics.developers;
      const teamBaseline = buildTeamBaseline(allDevs, devId);
      const devTimezone = devData ? devData.timezone : null;
      const review = await generateDevReview(devMetrics, sessions, teamBaseline, devTimezone);
      res.json({ ok: true, devId, review });
    } catch (err) {
      res.status(500).json({ error: 'AI review failed: ' + err.message });
    }
  });

  // GET /api/team/admin/ai-status - Check if AI review is configured
  router.get('/admin/ai-status', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { isConfigured } = require('./ai-review');
    res.json({ configured: isConfigured() });
  });

  // GET /api/team/prompt-quality - Score all devs' prompt quality via Gemini
  router.get('/prompt-quality', async (req, res) => {
    try {
      const { isConfigured, getPromptQuality } = require('./ai-review');
      if (!isConfigured()) return res.json({ error: 'AI not configured', scores: {} });

      const { from, to } = req.query;
      const allDevs = listDevelopers();
      const devIds = allDevs.map(d => d.devId).filter(Boolean);
      const scores = {};

      // Process devs in parallel (max 4 concurrent to avoid rate limits)
      const chunks = [];
      for (let i = 0; i < devIds.length; i += 4) chunks.push(devIds.slice(i, i + 4));

      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (devId) => {
          try {
            const devData = loadDeveloper(devId);
            if (!devData || !devData.sessions || devData.sessions.length === 0) {
              scores[devId] = { score: 0, rating: 'none', feedback: 'No sessions.' };
              return;
            }
            const sessions = (from || to) ? filterSessions(devData.sessions, from, to) : devData.sessions;
            scores[devId] = await getPromptQuality(devId, sessions);
          } catch (e) {
            scores[devId] = { score: 0, rating: 'error', feedback: e.message };
          }
        }));
      }

      res.json({ scores });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* === Project Tagging === */
  const TAGS_PATH = path.join(process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team'), 'project-tags.json');

  function loadProjectTags() {
    if (!fs.existsSync(TAGS_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(TAGS_PATH, 'utf-8')); } catch { return {}; }
  }

  // GET /api/team/admin/archive-health - Check archive integrity for all devs
  router.get('/admin/archive-health', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');
    const archiveDir = path.join(DATA_DIR, 'archive');
    const devs = listDevelopers();
    const results = devs.map(d => {
      const archivePath = path.join(archiveDir, d.devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_') + '.jsonl');
      const totalQueryCount = (d.totals && d.totals.totalQueries) || 0;
      if (!fs.existsSync(archivePath)) {
        return { devId: d.devId, status: 'missing', archivedQueries: 0, expectedQueries: totalQueryCount };
      }
      try {
        const lines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean);
        let archivedQueries = 0;
        for (const line of lines) {
          try { archivedQueries += (JSON.parse(line).queries || []).length; } catch {}
        }
        const avgPerEntry = lines.length > 0 ? archivedQueries / lines.length : 0;
        const healthy = lines.length === 0 || avgPerEntry > 2;
        return {
          devId: d.devId,
          status: healthy ? 'ok' : 'corrupted',
          archiveEntries: lines.length,
          archivedQueries,
          expectedQueries: totalQueryCount,
          coverage: totalQueryCount > 0 ? Math.round(archivedQueries / totalQueryCount * 100) + '%' : 'n/a',
        };
      } catch {
        return { devId: d.devId, status: 'error', archivedQueries: 0, expectedQueries: totalQueryCount };
      }
    });
    const corrupted = results.filter(r => r.status !== 'ok').length;
    res.json({ corrupted, total: results.length, devs: results });
  });

  // POST /api/team/admin/recompact - Recompact a dev's sessions from archive JSONL
  router.post('/admin/recompact', express.json(), async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { devId } = req.body;
    if (!devId) {
      // Recompact all devs
      const devs = listDevelopers();
      const results = [];
      for (const d of devs) {
        try {
          const r = await recompactFromArchive(d.devId);
          results.push({ devId: d.devId, ...r });
        } catch (err) {
          results.push({ devId: d.devId, error: err.message });
        }
      }
      return res.json({ ok: true, results });
    }
    try {
      const result = await recompactFromArchive(devId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/team/project-tags
  router.get('/project-tags', (req, res) => {
    res.json(loadProjectTags());
  });

  // POST /api/team/project-tags (admin only) - { tags: { "project-name": "tag", ... } }
  router.post('/project-tags', express.json(), (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { tags } = req.body;
    const safeTags = sanitizeProjectTagsInput(tags);
    if (!safeTags) return res.status(400).json({ error: 'Missing tags object' });
    const existing = sanitizeProjectTagsInput(loadProjectTags()) || {};
    const merged = { ...existing, ...safeTags };
    const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
    for (const [k, v] of Object.entries(tags || {})) {
      if (forbidden.has(k)) continue;
      if (typeof k !== 'string') continue;
      if (v === '' || v === null) delete merged[k];
    }
    fs.mkdirSync(path.dirname(TAGS_PATH), { recursive: true });
    fs.writeFileSync(TAGS_PATH, JSON.stringify(merged, null, 2));
    uploadFile(TAGS_PATH);
    res.json({ ok: true, tags: merged });
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

module.exports = { createTeamRouter, generateUniqueDevId, sanitizeProjectTagsInput };
