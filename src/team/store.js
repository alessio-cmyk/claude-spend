const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function devPath(devId) {
  // Sanitize to prevent path traversal
  const safe = devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return path.join(DATA_DIR, safe + '.json');
}

function saveDeveloper(devId, data) {
  ensureDir();
  const fp = devPath(devId);
  let existing = { devId, sessions: [], dailyUsage: [], totals: {} };

  if (fs.existsSync(fp)) {
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }

  // Merge sessions by sessionId (deduplicate)
  const existingIds = new Set((existing.sessions || []).map(s => s.sessionId));
  const newSessions = (data.sessions || []).filter(s => !existingIds.has(s.sessionId));
  const merged = [...(existing.sessions || []), ...newSessions];

  const result = {
    devId,
    lastSync: new Date().toISOString(),
    sessions: merged,
    totals: computeTotals(merged),
    dailyUsage: computeDailyUsage(merged),
  };

  fs.writeFileSync(fp, JSON.stringify(result));
  return result;
}

function loadDeveloper(devId) {
  ensureDir();
  const fp = devPath(devId);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
}

function listDevelopers() {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
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

function loadAllDevelopers() {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')); }
    catch { return null; }
  }).filter(Boolean);
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
    if (!map[s.date]) map[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0 };
    map[s.date].tokens += s.totalTokens || 0;
    map[s.date].cost += s.cost || 0;
    map[s.date].sessions += 1;
    map[s.date].queries += s.queryCount || 0;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

function filterSessions(sessions, from, to) {
  return sessions.filter(s => {
    if (!s.date || s.date === 'unknown') return false;
    if (from && s.date < from) return false;
    if (to && s.date > to) return false;
    return true;
  });
}

module.exports = {
  saveDeveloper, loadDeveloper, listDevelopers, loadAllDevelopers,
  computeTotals, computeDailyUsage, filterSessions,
};
