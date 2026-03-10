const http = require('http');
const https = require('https');

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
          if (res.statusCode >= 400) reject(new Error(json.error || 'Server error ' + res.statusCode));
          else resolve(json);
        } catch {
          const preview = (body || '').substring(0, 200);
          reject(new Error(`Invalid response from server (HTTP ${res.statusCode}, ${body.length} bytes): ${preview}`));
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
    const url = new URL('/api/team/dev/' + encodeURIComponent(devId), serverUrl);
    const data = await httpRequest(url, { method: 'GET', timeout: 15000 });
    // Return map of sessionId -> { queryCount, promptCount } for diff logic
    const map = new Map();
    for (const s of (data.sessions || [])) {
      map.set(s.sessionId, { queryCount: s.queryCount || 0, promptCount: s.promptCount || 0 });
    }
    return map;
  } catch {
    return new Map(); // Server doesn't have this dev yet, send everything
  }
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
      // Resend if server version needs recompact (missing promptCount)
      if (!server.promptCount && s.queries && s.queries.length > 0) return true;
      return false;
    });
  }

  if (sessions.length < totalSessions) {
    process.stdout.write(`  Incremental sync: ${sessions.length} new of ${totalSessions} sessions, ${serverMap.size} on server\n`);
  }

  // Batch uploads to stay under server payload limit (~40MB safe)
  const MAX_BATCH_BYTES = 40 * 1024 * 1024;
  const batches = [[]];
  let batchSize = 0;
  for (const s of sessions) {
    const sSize = JSON.stringify(s).length;
    if (batchSize + sSize > MAX_BATCH_BYTES && batches[batches.length - 1].length > 0) {
      batches.push([]);
      batchSize = 0;
    }
    batches[batches.length - 1].push(s);
    batchSize += sSize;
  }

  let lastResult;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const body = { devId, data: { ...parsedData, sessions: batch } };
    if (apiKey) body.key = apiKey;
    try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    const payload = JSON.stringify(body);
    const sizeMB = (Buffer.byteLength(payload) / 1024 / 1024).toFixed(1);

    if (batches.length > 1) {
      process.stdout.write(`  Batch ${i + 1}/${batches.length}: ${batch.length} sessions (${sizeMB}MB)\n`);
    }

    const url = new URL('/api/team/sync', serverUrl);
    lastResult = await httpRequest(url, {
      method: 'POST',
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, payload);
  }

  return lastResult || { ok: true, devId, sessionCount: serverMap.size };
}

async function resolveDevId(serverUrl, apiKey) {
  const url = new URL('/api/team/whoami?key=' + encodeURIComponent(apiKey), serverUrl);
  return httpRequest(url, { method: 'GET', timeout: 10000 });
}

module.exports = { syncToTeam, resolveDevId };
