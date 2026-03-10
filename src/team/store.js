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
      } else if (s.queryCount > (prev.queryCount || 0) || (!prev.promptCount && s.queries)) {
        // Session grew or needs recompact (e.g. missing promptCount)
        updatedSessions.push(s);
        existingMap.set(s.sessionId, compactSession(s));
      }
    }

    // Archive queries before compacting
    const safe = devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const archivePath = path.join(ARCHIVE_DIR, safe + '.jsonl');

    // Check if archive needs full rebuild (corrupted by bad dedup)
    let needsFullRebuild = false;
    try {
      if (fs.existsSync(archivePath)) {
        const archiveLines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean);
        const archivedQueries = archiveLines.reduce((sum, l) => {
          try { return sum + (JSON.parse(l).queries || []).length; } catch { return sum; }
        }, 0);
        // Corrupted if avg queries/entry ≤ 2 (healthy archives have dozens+)
        const avgPerEntry = archiveLines.length > 0 ? archivedQueries / archiveLines.length : 0;
        needsFullRebuild = archiveLines.length > 0 && avgPerEntry <= 2;
      }
    } catch {}

    const toArchive = [];
    if (needsFullRebuild) {
      // Full rebuild: archive ALL incoming sessions with queries
      for (const s of (data.sessions || [])) {
        if (s.queries && s.queries.length > 0) toArchive.push(s);
      }
      if (toArchive.length > 0) {
        // Overwrite corrupted archive
        const lines = toArchive.map(s => JSON.stringify(s)).join('\n') + '\n';
        fs.writeFileSync(archivePath, lines);
        uploadFile(archivePath);
        console.log(`[archive] Rebuilt ${safe}.jsonl: ${toArchive.length} sessions`);
      }
    } else {
      // Build set of session IDs already in the archive
      const archivedSessionIds = new Set();
      try {
        if (fs.existsSync(archivePath)) {
          for (const line of fs.readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean)) {
            try { archivedSessionIds.add(JSON.parse(line).sessionId); } catch {}
          }
        }
      } catch {}

      // Normal: archive new queries + sessions missing from archive
      for (const s of rawNewSessions) {
        if (s.queries && s.queries.length > 0) toArchive.push(s);
      }
      for (const s of updatedSessions) {
        if (s.queries && s.queries.length > 0) {
          if (!archivedSessionIds.has(s.sessionId)) {
            // Session missing from archive entirely — archive all queries
            toArchive.push(s);
          } else {
            const prev = existing.sessions.find(p => p.sessionId === s.sessionId);
            const prevCount = prev ? (prev.queryCount || 0) : 0;
            const newQueries = s.queries.slice(prevCount);
            if (newQueries.length > 0) {
              toArchive.push({ ...s, queries: newQueries });
            }
          }
        }
      }
      // Also archive any incoming session with queries that's missing from the archive
      for (const s of (data.sessions || [])) {
        if (s.queries && s.queries.length > 0 && !archivedSessionIds.has(s.sessionId) &&
            !toArchive.find(a => a.sessionId === s.sessionId)) {
          toArchive.push(s);
        }
      }
      if (toArchive.length > 0) {
        const lines = toArchive.map(s => JSON.stringify(s)).join('\n') + '\n';
        fs.appendFileSync(archivePath, lines);
        uploadFile(archivePath);
      }
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

function migrateSessionsIfNeeded(data, fp) {
  if (data.sessions && data.sessions.some(s => s.queries && s.queries.length > 0)) {
    data.sessions = data.sessions.map(compactSession);
    fs.writeFileSync(fp, JSON.stringify(data));
    uploadFile(fp);
  }
}

function dedupArchives() {
  ensureDir();
  const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const archivePath = path.join(ARCHIVE_DIR, file);
    const lines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean);
    // Group by sessionId, keep all queries deduplicated
    const sessionQueries = new Map(); // sessionId -> Map<queryIndex, query>
    const sessionMeta = new Map();    // sessionId -> latest session metadata
    for (const line of lines) {
      const s = JSON.parse(line);
      const sid = s.sessionId;
      if (!sessionQueries.has(sid)) sessionQueries.set(sid, { map: new Map(), offset: 0 });
      const { map: qMap } = sessionQueries.get(sid);
      let offset = sessionQueries.get(sid).offset;
      const queries = s.queries || [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const key = (q.userTimestamp || '') + '|' + (q.assistantTimestamp || '');
        // Use sequential index as tiebreaker only when timestamps are missing
        const dedupKey = key === '|' ? `__idx_${offset + i}` : key;
        if (!qMap.has(dedupKey)) qMap.set(dedupKey, q);
      }
      sessionQueries.get(sid).offset = offset + queries.length;
      // Keep latest metadata (most queries = most complete)
      const prev = sessionMeta.get(sid);
      if (!prev || (s.queryCount || 0) >= (prev.queryCount || 0)) {
        const { queries, ...meta } = s;
        sessionMeta.set(sid, meta);
      }
    }
    // Rebuild: one entry per session with all unique queries
    const deduped = [];
    for (const [sid, { map: qMap }] of sessionQueries) {
      const meta = sessionMeta.get(sid);
      const queries = [...qMap.values()].sort((a, b) =>
        (a.userTimestamp || '').localeCompare(b.userTimestamp || ''));
      deduped.push(JSON.stringify({ ...meta, queries }));
    }
    const tmpPath = archivePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, deduped.join('\n') + '\n');
    fs.renameSync(tmpPath, archivePath);
    console.log(`[archive] Deduped ${file}: ${lines.length} entries → ${deduped.length}`);
  }
}

function loadDeveloper(devId) {
  ensureDir();
  const fp = devPath(devId);
  if (!fs.existsSync(fp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    migrateSessionsIfNeeded(data, fp);
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
      migrateSessionsIfNeeded(data, fp);
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
  let totalCost = 0, totalQueries = 0, totalPrompts = 0;

  for (const s of sessions) {
    totalTokens += s.totalTokens || 0;
    totalInputTokens += s.inputTokens || 0;
    totalOutputTokens += s.outputTokens || 0;
    totalCacheReadTokens += s.cacheReadTokens || 0;
    totalCacheCreationTokens += s.cacheCreationTokens || 0;
    totalCost += s.cost || 0;
    totalQueries += s.queryCount || 0;
    totalPrompts += s.promptCount || 0;
  }

  return {
    totalTokens, totalInputTokens, totalOutputTokens,
    totalCacheReadTokens, totalCacheCreationTokens,
    totalCost, totalQueries, totalPrompts,
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
        if (!map[day]) map[day] = { date: day, tokens: 0, cost: 0, sessions: 0, queries: 0, prompts: 0 };
        map[day].tokens += stats.tokens || 0;
        map[day].cost += stats.cost || 0;
        map[day].queries += stats.queries || 0;
        map[day].prompts += stats.prompts || 0;
        days.add(day);
      }
      // Count session once per day it was active
      for (const d of days) map[d].sessions += 1;
    } else {
      // Fallback: attribute all to session start date
      if (!map[s.date]) map[s.date] = { date: s.date, tokens: 0, cost: 0, sessions: 0, queries: 0, prompts: 0 };
      map[s.date].tokens += s.totalTokens || 0;
      map[s.date].cost += s.cost || 0;
      map[s.date].sessions += 1;
      map[s.date].queries += s.queryCount || 0;
      map[s.date].prompts += s.promptCount || 0;
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
  // Check if isNewPrompt flags are available (parser v2+)
  const hasPromptFlags = s.queries.some(q => q.isNewPrompt !== undefined);
  const tools = {};
  const models = {};
  const dailyBreakdown = {};
  let hasToolCall = false;
  let lastUserPrompt = null; // for inferring prompts when isNewPrompt missing
  let inferredPromptCount = 0;
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
    // Determine if this query represents a new prompt
    let isPrompt = false;
    if (hasPromptFlags) {
      isPrompt = !!q.isNewPrompt;
    } else if (q.userPrompt !== null && q.userPrompt !== undefined && q.userPrompt !== lastUserPrompt) {
      // Filter out system messages that aren't real human prompts
      const p = q.userPrompt;
      const isSystem = p.startsWith('<task-notification>') ||
        p.startsWith('This session is being continued from a previous conversation');
      if (!isSystem) {
        isPrompt = true;
        lastUserPrompt = q.userPrompt;
        inferredPromptCount++;
      }
    }
    // Per-day breakdown from query timestamps
    const qDate = (q.assistantTimestamp || q.userTimestamp || '').split('T')[0] || s.date;
    if (qDate && qDate !== 'unknown') {
      if (!dailyBreakdown[qDate]) dailyBreakdown[qDate] = { tokens: 0, cost: 0, queries: 0, prompts: 0 };
      dailyBreakdown[qDate].tokens += q.totalTokens || 0;
      dailyBreakdown[qDate].cost += q.cost || 0;
      dailyBreakdown[qDate].queries += 1;
      if (isPrompt) dailyBreakdown[qDate].prompts += 1;
    }
  }
  const lastQuery = s.queries[s.queries.length - 1];
  const lastDate = (lastQuery.assistantTimestamp || lastQuery.userTimestamp || '').split('T')[0] || s.date;
  const promptCount = hasPromptFlags
    ? s.queries.filter(q => q.isNewPrompt).length
    : inferredPromptCount;
  const { queries, ...rest } = s;
  return { ...rest, promptCount, lastDate, _models: models, _tools: tools, _hasToolCall: hasToolCall, _dailyBreakdown: dailyBreakdown };
}

function filterSessions(sessions, from, to) {
  if (!from && !to) return sessions;

  return sessions.map(s => {
    if (!s.date || s.date === 'unknown') return null;

    if (s._dailyBreakdown) {
      // Slice _dailyBreakdown to only in-range days
      const sliced = {};
      for (const [day, stats] of Object.entries(s._dailyBreakdown)) {
        if (from && day < from) continue;
        if (to && day > to) continue;
        sliced[day] = stats;
      }
      if (Object.keys(sliced).length === 0) return null;

      // Recompute aggregate fields from sliced days
      let tokens = 0, cost = 0, queries = 0, prompts = 0;
      for (const stats of Object.values(sliced)) {
        tokens += stats.tokens || 0;
        cost += stats.cost || 0;
        queries += stats.queries || 0;
        prompts += stats.prompts || 0;
      }

      // Proportion ratio for fields not tracked per-day (models, tools, cache tokens)
      const fullTokens = s.totalTokens || 1;
      const ratio = tokens / fullTokens;

      return {
        ...s,
        totalTokens: tokens,
        cost,
        queryCount: queries,
        promptCount: prompts,
        inputTokens: Math.round((s.inputTokens || 0) * ratio),
        outputTokens: Math.round((s.outputTokens || 0) * ratio),
        cacheReadTokens: Math.round((s.cacheReadTokens || 0) * ratio),
        cacheCreationTokens: Math.round((s.cacheCreationTokens || 0) * ratio),
        _dailyBreakdown: sliced,
        _models: scaleModels(s._models, ratio),
        _tools: scaleTools(s._tools, ratio),
      };
    }

    // Fallback: no daily breakdown — include/exclude whole session
    const end = s.lastDate || s.date;
    if (from && end < from) return null;
    if (to && s.date > to) return null;
    return s;
  }).filter(Boolean);
}

function scaleModels(models, ratio) {
  if (!models || ratio >= 1) return models;
  const scaled = {};
  for (const [m, v] of Object.entries(models)) {
    scaled[m] = {
      queries: Math.round((v.queries || 0) * ratio),
      tokens: Math.round((v.tokens || 0) * ratio),
      cost: Math.round((v.cost || 0) * ratio * 100) / 100,
    };
  }
  return scaled;
}

function scaleTools(tools, ratio) {
  if (!tools || ratio >= 1) return tools;
  const scaled = {};
  for (const [t, count] of Object.entries(tools)) {
    scaled[t] = Math.round((count || 0) * ratio);
  }
  return scaled;
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
  let totalTokens = 0, totalCost = 0, totalQueries = 0, totalPrompts = 0;
  for (const d of dailyUsage) {
    totalTokens += d.tokens || 0;
    totalCost += d.cost || 0;
    totalQueries += d.queries || 0;
    totalPrompts += d.prompts || 0;
  }
  return {
    totalTokens,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCost,
    totalQueries,
    totalPrompts,
    totalSessions: sessions.length,
  };
}

async function recompactFromArchive(devId) {
  const release = await acquireLock('dev:' + devId);
  try {
    ensureDir();
    const fp = devPath(devId);
    if (!fs.existsSync(fp)) return { error: 'Developer not found' };

    const safe = devId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const archivePath = path.join(ARCHIVE_DIR, safe + '.jsonl');
    if (!fs.existsSync(archivePath)) return { error: 'No archive found for ' + devId };

    // Parse archive: group all queries by sessionId
    const lines = fs.readFileSync(archivePath, 'utf-8').trim().split('\n').filter(Boolean);
    const archiveSessions = new Map(); // sessionId -> { meta, queries[] }
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        const sid = s.sessionId;
        if (!archiveSessions.has(sid)) {
          const { queries, ...meta } = s;
          archiveSessions.set(sid, { meta, queries: [] });
        }
        const entry = archiveSessions.get(sid);
        // Keep most complete metadata
        if ((s.queryCount || 0) > (entry.meta.queryCount || 0)) {
          const { queries, ...meta } = s;
          entry.meta = meta;
        }
        // Collect all queries (dedup by timestamp)
        const seen = new Set(entry.queries.map(q => (q.userTimestamp || '') + '|' + (q.assistantTimestamp || '')));
        for (const q of (s.queries || [])) {
          const key = (q.userTimestamp || '') + '|' + (q.assistantTimestamp || '');
          if (key !== '|' && seen.has(key)) continue;
          seen.add(key);
          entry.queries.push(q);
        }
      } catch {}
    }

    // Load existing dev data
    const existing = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const existingMap = new Map((existing.sessions || []).map(s => [s.sessionId, s]));

    // Recompact from archive where existing session lacks promptCount
    let recompacted = 0;
    for (const [sid, { meta, queries }] of archiveSessions) {
      const prev = existingMap.get(sid);
      if (!prev) continue; // archive-only session not in current data, skip
      if (prev.promptCount && prev._dailyBreakdown) continue; // already good

      // Build full session with queries for compaction
      const full = { ...meta, queries: queries.sort((a, b) =>
        (a.userTimestamp || '').localeCompare(b.userTimestamp || ''))
      };
      full.queryCount = queries.length;
      existingMap.set(sid, compactSession(full));
      recompacted++;
    }

    if (recompacted === 0) return { ok: true, recompacted: 0, message: 'All sessions already have promptCount' };

    const merged = [...existingMap.values()];
    const result = {
      ...existing,
      sessions: merged,
      totals: computeTotals(merged),
      dailyUsage: computeDailyUsage(merged),
      lastSync: existing.lastSync,
    };

    const tmpPath = fp + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(result));
    fs.renameSync(tmpPath, fp);
    uploadFile(fp);
    invalidateDevCache();

    return { ok: true, recompacted, totalSessions: merged.length, totalPrompts: result.totals.totalPrompts };
  } finally {
    release();
  }
}

module.exports = {
  saveDeveloper, loadDeveloper, listDevelopers, loadAllDevelopers,
  computeTotals, computeTotalsFromDaily, computeDailyUsage, filterSessions,
  snapshotHealthHistory, loadHealthHistory, dedupArchives, recompactFromArchive,
};
