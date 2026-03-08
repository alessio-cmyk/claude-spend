const fs = require('fs');
const path = require('path');
const { uploadFile } = require('./s3');

const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

/* === File-level locking to prevent race conditions on concurrent syncs === */
const _locks = new Map();
function acquireLock(key) {
  if (!_locks.has(key)) _locks.set(key, Promise.resolve());
  let release;
  const next = new Promise(resolve => { release = resolve; });
  const prev = _locks.get(key);
  _locks.set(key, next);
  return prev.then(() => release);
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function devPath(devId) {
  // Sanitize to prevent path traversal
  const safe = devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return path.join(DATA_DIR, safe + '.json');
}

async function saveDeveloper(devId, data, timezone) {
  const release = await acquireLock('dev:' + devId);
  try {
    ensureDir();
    const fp = devPath(devId);
    let existing = { devId, sessions: [], dailyUsage: [], totals: {} };

    if (fs.existsSync(fp)) {
      try { existing = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
    }

    // Merge sessions by sessionId — update existing if incoming has more queries
    const existingMap = new Map((existing.sessions || []).map(s => [s.sessionId, s]));
    const rawNewSessions = [];
    const updatedSessions = [];
    for (const s of (data.sessions || [])) {
      const prev = existingMap.get(s.sessionId);
      if (!prev) {
        rawNewSessions.push(s);
      } else if (s.queryCount > (prev.queryCount || 0)) {
        // Session grew — update it
        updatedSessions.push(s);
        existingMap.set(s.sessionId, compactSession(s));
      }
    }

    // Archive full sessions with queries[] before compacting
    const toArchive = [...rawNewSessions, ...updatedSessions];
    if (toArchive.length > 0) {
      const safe = devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const archivePath = path.join(ARCHIVE_DIR, safe + '.jsonl');
      const lines = toArchive.map(s => JSON.stringify(s)).join('\n') + '\n';
      fs.appendFileSync(archivePath, lines);
      uploadFile(archivePath);
    }

    const newSessions = rawNewSessions.map(compactSession);
    const merged = [...existingMap.values(), ...newSessions];

    // Persist client timezone if provided
    if (timezone) existing.timezone = timezone;

    const result = {
      devId,
      lastSync: new Date().toISOString(),
      timezone: existing.timezone || null,
      sessions: merged,
      totals: computeTotals(merged),
      dailyUsage: computeDailyUsage(merged),
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = fp + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(result));
    fs.renameSync(tmpPath, fp);
    uploadFile(fp);
    invalidateDevCache();
    return result;
  } finally {
    release();
  }
}

function loadDeveloper(devId) {
  ensureDir();
  const fp = devPath(devId);
  if (!fs.existsSync(fp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    // Migrate: compact any sessions that still have raw queries[]
    if (data.sessions && data.sessions.some(s => s.queries && s.queries.length > 0)) {
      data.sessions = data.sessions.map(compactSession);
      fs.writeFileSync(fp, JSON.stringify(data));
      uploadFile(fp);
    }
    return data;
  } catch { return null; }
}

/* === FEATURE 3: Files to exclude from developer listings === */
const NON_DEV_FILES = new Set(['health-history.json', 'allowlist.json', 'project-tags.json']);

function listDevelopers() {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !NON_DEV_FILES.has(f));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
      return {
        devId: data.devId,
        lastSync: data.lastSync,
        sessionCount: (data.sessions || []).length,
        totals: data.totals || {},
      };
    } catch { return null; }
  }).filter(Boolean);
}

/* === Dev data cache (TTL-based, invalidated on save) === */
let _allDevsCache = null;
let _allDevsCacheTime = 0;
const CACHE_TTL_MS = 10000; // 10s

function invalidateDevCache() { _allDevsCache = null; _allDevsCacheTime = 0; }

function loadAllDevelopers() {
  if (_allDevsCache && (Date.now() - _allDevsCacheTime) < CACHE_TTL_MS) return _allDevsCache;
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !NON_DEV_FILES.has(f));
  const result = files.map(f => {
    try {
      const fp = path.join(DATA_DIR, f);
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (data.sessions && data.sessions.some(s => s.queries && s.queries.length > 0)) {
        data.sessions = data.sessions.map(compactSession);
        fs.writeFileSync(fp, JSON.stringify(data));
        uploadFile(fp);
      }
      return data;
    } catch { return null; }
  }).filter(Boolean);
  _allDevsCache = result;
  _allDevsCacheTime = Date.now();
  return result;
}

function computeTotals(sessions) {
  let totalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0;
  let totalCacheReadTokens = 0, totalCacheCreationTokens = 0;
  let totalCost = 0, totalQueries = 0;

  for (const s of sessions) {
    totalTokens += s.totalTokens || 0;
    totalInputTokens += s.inputTokens || 0;
    totalOutputTokens += s.outputTokens || 0;
    totalCacheReadTokens += s.cacheReadTokens || 0;
    totalCacheCreationTokens += s.cacheCreationTokens || 0;
    totalCost += s.cost || 0;
    totalQueries += s.queryCount || 0;
  }

  return {
    totalTokens, totalInputTokens, totalOutputTokens,
    totalCacheReadTokens, totalCacheCreationTokens,
    totalCost, totalQueries,
    totalSessions: sessions.length,
  };
}

function computeDailyUsage(sessions) {
  const map = {};
  for (const s of sessions) {
    if (!s.date || s.date === 'unknown') continue;
    // Use per-query daily breakdown if available
    if (s._dailyBreakdown) {
      const days = new Set();
      for (const [day, stats] of Object.entries(s._dailyBreakdown)) {
        if (!map[day]) map[day] = { date: day, tokens: 0, cost: 0, sessions: 0, queries: 0 };
        map[day].tokens += stats.tokens || 0;
        map[day].cost += stats.cost || 0;
        map[day].queries += stats.queries || 0;
        days.add(day);
      }
      // Count session once per day it was active
      for (const d of days) map[d].sessions += 1;
    } else {
      // Fallback: attribute all to session start date
      if (!map[s.date]) map[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0 };
      map[s.date].tokens += s.totalTokens || 0;
      map[s.date].cost += s.cost || 0;
      map[s.date].sessions += 1;
      map[s.date].queries += s.queryCount || 0;
    }
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

// Strip raw queries[], pre-aggregate into _models, _tools, _hasToolCall, _dailyBreakdown
function compactSession(s) {
  if (!s.queries || s.queries.length === 0) {
    // Already compacted or no queries
    return { ...s, queries: undefined };
  }
  const tools = {};
  const models = {};
  const dailyBreakdown = {};
  let hasToolCall = false;
  for (const q of s.queries) {
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
    // Per-day breakdown from query timestamps
    const qDate = (q.assistantTimestamp || q.userTimestamp || '').split('T')[0] || s.date;
    if (qDate && qDate !== 'unknown') {
      if (!dailyBreakdown[qDate]) dailyBreakdown[qDate] = { tokens: 0, cost: 0, queries: 0 };
      dailyBreakdown[qDate].tokens += q.totalTokens || 0;
      dailyBreakdown[qDate].cost += q.cost || 0;
      dailyBreakdown[qDate].queries += 1;
    }
  }
  const lastQuery = s.queries[s.queries.length - 1];
  const lastDate = (lastQuery.assistantTimestamp || lastQuery.userTimestamp || '').split('T')[0] || s.date;
  const { queries, ...rest } = s;
  return { ...rest, lastDate, _models: models, _tools: tools, _hasToolCall: hasToolCall, _dailyBreakdown: dailyBreakdown };
}

function filterSessions(sessions, from, to) {
  return sessions.filter(s => {
    if (!s.date || s.date === 'unknown') return false;
    // Use daily breakdown if available — include session if any day falls in range
    if (s._dailyBreakdown) {
      const days = Object.keys(s._dailyBreakdown);
      return days.some(d => (!from || d >= from) && (!to || d <= to));
    }
    // Fallback: use session date range (date to lastDate)
    const end = s.lastDate || s.date;
    if (from && end < from) return false;
    if (to && s.date > to) return false;
    return true;
  });
}

/* === FEATURE 3a: Health Score History Persistence === */
const HEALTH_HISTORY_PATH = path.join(DATA_DIR, 'health-history.json');
const MAX_HEALTH_HISTORY_DAYS = 180;

function snapshotHealthHistory(teamScore, devScores) {
  ensureDir();
  let history = [];
  if (fs.existsSync(HEALTH_HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HEALTH_HISTORY_PATH, 'utf-8')); } catch {}
  }
  if (!Array.isArray(history)) history = [];

  const today = new Date().toISOString().split('T')[0];
  const existingIdx = history.findIndex(h => h.date === today);
  const entry = { date: today, teamScore, devScores };

  if (existingIdx >= 0) {
    history[existingIdx] = entry; // last write wins
  } else {
    history.push(entry);
  }

  // Cap at 180 days
  if (history.length > MAX_HEALTH_HISTORY_DAYS) {
    history = history.slice(history.length - MAX_HEALTH_HISTORY_DAYS);
  }

  fs.writeFileSync(HEALTH_HISTORY_PATH, JSON.stringify(history));
  uploadFile(HEALTH_HISTORY_PATH);
}

function loadHealthHistory(days) {
  ensureDir();
  if (!fs.existsSync(HEALTH_HISTORY_PATH)) return [];
  try {
    let history = JSON.parse(fs.readFileSync(HEALTH_HISTORY_PATH, 'utf-8'));
    if (!Array.isArray(history)) return [];
    if (days && days < 180) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      history = history.filter(h => h.date >= cutoffStr);
    }
    return history;
  } catch { return []; }
}

// Compute totals from filtered daily usage (accurate for date-filtered multi-day sessions)
function computeTotalsFromDaily(dailyUsage, sessions) {
  let totalTokens = 0, totalCost = 0, totalQueries = 0;
  for (const d of dailyUsage) {
    totalTokens += d.tokens || 0;
    totalCost += d.cost || 0;
    totalQueries += d.queries || 0;
  }
  return {
    totalTokens,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost: totalCost,
    totalQueries,
    totalSessions: sessions.length,
  };
}

module.exports = {
  saveDeveloper, loadDeveloper, listDevelopers, loadAllDevelopers,
  computeTotals, computeTotalsFromDaily, computeDailyUsage, filterSessions,
  snapshotHealthHistory, loadHealthHistory,
};
