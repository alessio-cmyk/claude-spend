const fs = require('fs');
const path = require('path');
const { uploadFile } = require('./s3');
const {
  archiveDir, forEachArchiveEntry, appendToArchive, getArchivedSessionIds,
  loadIndex: loadArchiveIndex,
} = require('./archive');
const { queryCost } = require('../pricing');

const DATA_DIR = process.env.CLAUDE_SPEND_DATA || path.join(process.cwd(), 'data', 'team');

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
  fs.mkdirSync(archiveDir(), { recursive: true });
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

    // Price on the server so costs don't depend on which client version synced
    data = { ...data, sessions: (data.sessions || []).map(repriceSession) };

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

    // Archive queries before compacting. Uses the small session-ID index instead of
    // reading the (potentially huge) archive. null = archives not hydrated yet and no
    // index on disk: we can't tell what's archived, so archive every incoming session in
    // full. Readers dedupe repeated queries, whereas archiving only a tail would get the
    // session into the index and hide the missing head from backfill forever.
    const archiveIndex = loadArchiveIndex(devId);
    const isArchived = sid => (archiveIndex ? archiveIndex.has(sid) : false);
    const prevById = new Map((existing.sessions || []).map(p => [p.sessionId, p]));

    const toArchive = [];
    for (const s of rawNewSessions) {
      if (s.queries && s.queries.length > 0) toArchive.push(s);
    }
    for (const s of updatedSessions) {
      if (s.queries && s.queries.length > 0) {
        if (!isArchived(s.sessionId)) {
          // Session missing from archive entirely — archive all queries
          toArchive.push(s);
        } else {
          const prev = prevById.get(s.sessionId);
          const prevCount = prev ? (prev.queryCount || 0) : 0;
          const newQueries = s.queries.slice(prevCount);
          if (newQueries.length > 0) {
            toArchive.push({ ...s, queries: newQueries });
          }
        }
      }
    }
    // Also archive any incoming session with queries that's missing from the archive
    const queued = new Set(toArchive.map(a => a.sessionId));
    for (const s of (data.sessions || [])) {
      if (s.queries && s.queries.length > 0 && !isArchived(s.sessionId) && !queued.has(s.sessionId)) {
        toArchive.push(s);
        queued.add(s.sessionId);
      }
    }
    // If the archive couldn't be persisted, fail the sync before updating the summary:
    // otherwise the summary's higher queryCount would stop the client from ever resending
    // the queries that never reached S3. The client retries them on its next sync.
    if (!(await appendToArchive(devId, toArchive))) {
      throw new Error('Archive upload failed; please retry the sync');
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

// Parse a dev archive: group all queries by sessionId -> { meta, queries[] }
// Group a dev's archived queries by sessionId (deduped by timestamp), streaming across
// the legacy archive file and all shards with bounded read memory.
function readArchiveSessions(devId) {
  const archiveSessions = new Map(); // sessionId -> { meta, queries[], seen }
  forEachArchiveEntry(devId, s => {
    if (!s || !s.sessionId) return;
    const sid = s.sessionId;
    if (!archiveSessions.has(sid)) {
      const { queries, ...meta } = s;
      archiveSessions.set(sid, { meta, queries: [], seen: new Set() });
    }
    const entry = archiveSessions.get(sid);
    // Keep most complete metadata
    if ((s.queryCount || 0) > (entry.meta.queryCount || 0)) {
      const { queries, ...meta } = s;
      entry.meta = meta;
    }
    // Collect all queries (dedup by timestamp)
    for (const q of (s.queries || [])) {
      const key = (q.userTimestamp || '') + '|' + (q.assistantTimestamp || '');
      if (key !== '|' && entry.seen.has(key)) continue;
      entry.seen.add(key);
      entry.queries.push(q);
    }
  });
  return archiveSessions;
}

// Recompute per-query and session cost from token counts with current pricing
function repriceSession(s) {
  if (!Array.isArray(s.queries) || s.queries.length === 0) return s;
  let cost = 0;
  const queries = s.queries.map(q => {
    const c = queryCost(q);
    cost += c;
    return { ...q, cost: c };
  });
  return { ...s, queries, cost };
}

// Rewrite the cost fields of a compacted session from its full query list
function applyQueryCosts(session, queries) {
  const models = {};
  for (const [m, v] of Object.entries(session._models || {})) models[m] = { ...v, cost: 0 };
  const daily = {};
  for (const [d, v] of Object.entries(session._dailyBreakdown || {})) daily[d] = { ...v, cost: 0 };
  let cost = 0;
  for (const q of queries) {
    const c = queryCost(q);
    cost += c;
    if (models[q.model]) models[q.model].cost += c;
    const qDate = (q.assistantTimestamp || q.userTimestamp || '').split('T')[0] || session.date;
    if (daily[qDate]) daily[qDate].cost += c;
  }
  const out = { ...session, cost };
  if (session._models) out._models = models;
  if (session._dailyBreakdown) out._dailyBreakdown = daily;
  return out;
}

// Estimate a new cost for a compacted session with no archived queries: split the
// session's token counts across its models by token share, then scale daily costs.
function repriceFromTotals(session) {
  const models = session._models && Object.keys(session._models).length > 0
    ? session._models
    : { [session.model || 'unknown']: { tokens: session.totalTokens || 0, cost: session.cost || 0 } };
  const totalModelTokens = Object.values(models).reduce((sum, v) => sum + (v.tokens || 0), 0);
  const newModels = {};
  let cost = 0;
  for (const [m, v] of Object.entries(models)) {
    const share = totalModelTokens > 0 ? (v.tokens || 0) / totalModelTokens : 1 / Object.keys(models).length;
    const c = queryCost({
      model: m,
      inputTokens: (session.inputTokens || 0) * share,
      cacheCreationTokens: (session.cacheCreationTokens || 0) * share,
      cacheReadTokens: (session.cacheReadTokens || 0) * share,
      outputTokens: (session.outputTokens || 0) * share,
    });
    newModels[m] = { ...v, cost: c };
    cost += c;
  }
  const out = { ...session, cost };
  if (session._models) out._models = newModels;
  if (session._dailyBreakdown) {
    // Spread the new cost over days by their old cost share, or by token share
    // when there was no old cost to go by
    const days = Object.entries(session._dailyBreakdown);
    const oldDailyCost = days.reduce((sum, [, v]) => sum + (v.cost || 0), 0);
    const dailyTokens = days.reduce((sum, [, v]) => sum + (v.tokens || 0), 0);
    out._dailyBreakdown = {};
    for (const [d, v] of days) {
      const share = oldDailyCost > 0 ? (v.cost || 0) / oldDailyCost
        : dailyTokens > 0 ? (v.tokens || 0) / dailyTokens
        : 1 / days.length;
      out._dailyBreakdown[d] = { ...v, cost: cost * share };
    }
  }
  return out;
}

// Recompute every stored session's cost with current pricing. Uses archived queries
// when the archive holds the whole session, otherwise estimates from session totals.
async function repriceDeveloper(devId) {
  const release = await acquireLock('dev:' + devId);
  try {
    ensureDir();
    const fp = devPath(devId);
    if (!fs.existsSync(fp)) return { error: 'Developer not found' };

    const archiveSessions = readArchiveSessions(devId);

    const existing = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const oldCost = (existing.sessions || []).reduce((sum, s) => sum + (s.cost || 0), 0);
    let fromQueries = 0, estimated = 0;
    const sessions = (existing.sessions || []).map(s => {
      const archived = archiveSessions.get(s.sessionId);
      if (archived && archived.queries.length >= (s.queryCount || 0) && archived.queries.length > 0) {
        fromQueries++;
        return applyQueryCosts(s, archived.queries);
      }
      estimated++;
      return repriceFromTotals(s);
    });

    const result = {
      ...existing,
      sessions,
      totals: computeTotals(sessions),
      dailyUsage: computeDailyUsage(sessions),
    };

    const tmpPath = fp + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(result));
    fs.renameSync(tmpPath, fp);
    uploadFile(fp);
    invalidateDevCache();

    return { ok: true, sessions: sessions.length, fromQueries, estimated, oldCost, newCost: result.totals.totalCost };
  } finally {
    release();
  }
}

async function recompactFromArchive(devId) {
  const release = await acquireLock('dev:' + devId);
  try {
    ensureDir();
    const fp = devPath(devId);
    if (!fs.existsSync(fp)) return { error: 'Developer not found' };

    const archiveSessions = readArchiveSessions(devId);
    if (archiveSessions.size === 0) return { error: 'No archive found for ' + devId };

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

// Read a dev's archive and return Map<sessionId, string[]> of distinct user prompts in order.
// The archive is the only place full per-query prompts survive compaction.
function loadArchivePrompts(devId) {
  const bySession = new Map();
  try {
    forEachArchiveEntry(devId, s => {
      if (!s || !s.sessionId || !Array.isArray(s.queries)) return;
      let entry = bySession.get(s.sessionId);
      if (!entry) { entry = { prompts: [], seen: new Set() }; bySession.set(s.sessionId, entry); }
      for (const q of s.queries) {
        const p = (q.userPrompt || '').trim();
        if (!p || entry.seen.has(p)) continue;
        // Skip system-injected wrappers (<ide_opened_file>, <command-name>, <system-reminder>, ...)
        if (p.startsWith('<') && p.includes('>')) continue;
        entry.seen.add(p);
        entry.prompts.push(p);
      }
    });
  } catch {}
  const result = new Map();
  for (const [sid, { prompts }] of bySession) result.set(sid, prompts);
  return result;
}

module.exports = {
  saveDeveloper, loadDeveloper, listDevelopers, loadAllDevelopers,
  computeTotals, computeTotalsFromDaily, computeDailyUsage, filterSessions,
  snapshotHealthHistory, loadHealthHistory, recompactFromArchive, repriceDeveloper,
  getArchivedSessionIds, loadArchivePrompts,
};
