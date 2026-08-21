const http = require('http');
const https = require('https');
const zlib = require('zlib');

function httpRequest(url, options, payload) {
  const transport = url.protocol === 'https:' ? https : http;
  const timeout = options.timeout || 30000;
  delete options.timeout;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode >= 400) {
            const err = new Error(json.error || 'Server error ' + res.statusCode);
            err.statusCode = res.statusCode;
            reject(err);
          } else resolve(json);
        } catch {
          const preview = (body || '').substring(0, 200);
          const err = new Error(`Invalid response from server (HTTP ${res.statusCode}, ${body.length} bytes): ${preview}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchServerSessions(serverUrl, devId) {
  try {
    const url = new URL('/api/team/dev/' + encodeURIComponent(devId) + '?archived=1', serverUrl);
    const data = await httpRequest(url, { method: 'GET', timeout: 15000 });
    const archivedIds = new Set(data._archivedSessionIds || []);
    // Return map of sessionId -> { queryCount, promptCount, archived } for diff logic
    const map = new Map();
    for (const s of (data.sessions || [])) {
      map.set(s.sessionId, {
        queryCount: s.queryCount || 0,
        promptCount: s.promptCount || 0,
        archived: archivedIds.has(s.sessionId),
      });
    }
    return map;
  } catch {
    return new Map(); // Server doesn't have this dev yet, send everything
  }
}

// Cap per-query text length; null caps of 0 drop the field entirely.
function slimSession(session, promptCap, responseCap) {
  const queries = session.queries.map(q => {
    const slim = { ...q };
    if (typeof slim.userPrompt === 'string' && slim.userPrompt.length > promptCap) {
      slim.userPrompt = slim.userPrompt.substring(0, promptCap);
    }
    if (typeof slim.assistantResponse === 'string') {
      slim.assistantResponse = responseCap > 0 ? slim.assistantResponse.substring(0, responseCap) : null;
    }
    return slim;
  });
  return { ...session, queries };
}

async function syncToTeam(serverUrl, devId, parsedData, apiKey) {
  // Incremental sync: only send new sessions or those needing recompact
  const serverMap = await fetchServerSessions(serverUrl, devId);
  let sessions = parsedData.sessions || [];
  const totalSessions = sessions.length;
  if (serverMap.size > 0) {
    sessions = sessions.filter(s => {
      const server = serverMap.get(s.sessionId);
      if (!server) return true; // new session
      // Resend if local has more queries than server (session grew since last sync)
      const localQueries = s.queryCount || (s.queries && s.queries.length) || 0;
      if (localQueries > server.queryCount) return true;
      // Resend if server version needs recompact (missing promptCount)
      if (!server.promptCount && s.queries && s.queries.length > 0) return true;
      // Resend if server archive is missing this session's queries
      if (!server.archived && s.queries && s.queries.length > 0) return true;
      return false;
    });
  }

  if (sessions.length < totalSessions) {
    process.stdout.write(`  Incremental sync: ${sessions.length} new of ${totalSessions} sessions, ${serverMap.size} on server\n`);
  }

  // Batch uploads: cap both size and session count to avoid gateway timeouts
  const MAX_BATCH_BYTES = 10 * 1024 * 1024; // 10MB per batch (safe for proxy timeouts)
  const MAX_BATCH_SESSIONS = 50;

  // Sessions are the atomic sync unit, so a single session must fit in a batch.
  // Query text is only used for short previews and prompt grouping server-side;
  // token/cost/tool usage is never touched by the caps.
  const TEXT_CAPS = [[4000, 4000], [1000, 500], [300, 0], [100, 0]];
  const fitSession = (s) => {
    if (!Array.isArray(s.queries) || JSON.stringify(s).length <= MAX_BATCH_BYTES) return s;
    for (const [promptCap, responseCap] of TEXT_CAPS) {
      const slim = slimSession(s, promptCap, responseCap);
      if (JSON.stringify(slim).length <= MAX_BATCH_BYTES) return slim;
    }
    return slimSession(s, TEXT_CAPS[TEXT_CAPS.length - 1][0], 0);
  };
  sessions = sessions.map(fitSession);

  const batches = [[]];
  let batchSize = 0;
  for (const s of sessions) {
    const sSize = JSON.stringify(s).length;
    if ((batchSize + sSize > MAX_BATCH_BYTES || batches[batches.length - 1].length >= MAX_BATCH_SESSIONS)
        && batches[batches.length - 1].length > 0) {
      batches.push([]);
      batchSize = 0;
    }
    batches[batches.length - 1].push(s);
    batchSize += sSize;
  }

  const url = new URL('/api/team/sync', serverUrl);
  const sendBatch = (batch) => {
    const body = { devId, data: { ...parsedData, sessions: batch } };
    if (apiKey) body.key = apiKey;
    try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    const raw = JSON.stringify(body);
    const payload = zlib.gzipSync(Buffer.from(raw));
    return {
      sizeMB: (Buffer.byteLength(raw) / 1024 / 1024).toFixed(1),
      result: httpRequest(url, {
        method: 'POST',
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': payload.length,
        },
      }, payload),
    };
  };

  let lastResult;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { sizeMB, result } = sendBatch(batch);

    if (batches.length > 1) {
      process.stdout.write(`  Batch ${i + 1}/${batches.length}: ${batch.length} sessions (${sizeMB}MB)\n`);
    }

    try {
      lastResult = await result;
    } catch (err) {
      if (err.statusCode !== 413) throw err;
      // Server still rejected the size: strip all text and retry so usage data lands
      process.stdout.write(`  Batch ${i + 1} too large for server, retrying without message text...\n`);
      lastResult = await sendBatch(batch.map(s => Array.isArray(s.queries) ? slimSession(s, 100, 0) : s)).result;
    }
  }

  return lastResult || { ok: true, devId, sessionCount: serverMap.size };
}

async function resolveDevId(serverUrl, apiKey) {
  const url = new URL('/api/team/whoami?key=' + encodeURIComponent(apiKey), serverUrl);
  return httpRequest(url, { method: 'GET', timeout: 10000 });
}

module.exports = { syncToTeam, resolveDevId };
