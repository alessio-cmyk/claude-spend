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

async function fetchServerSessionIds(serverUrl, devId) {
  try {
    const url = new URL('/api/team/dev/' + encodeURIComponent(devId), serverUrl);
    const data = await httpRequest(url, { method: 'GET', timeout: 15000 });
    return new Set((data.sessions || []).map(s => s.sessionId));
  } catch {
    return new Set(); // Server doesn't have this dev yet, send everything
  }
}

async function syncToTeam(serverUrl, devId, parsedData, apiKey) {
  // Incremental sync: only send sessions the server doesn't have or that grew
  const serverIds = await fetchServerSessionIds(serverUrl, devId);
  let sessions = parsedData.sessions || [];
  const totalSessions = sessions.length;
  if (serverIds.size > 0) {
    sessions = sessions.filter(s => !serverIds.has(s.sessionId));
  }

  const body = { devId, data: { ...parsedData, sessions } };
  if (apiKey) body.key = apiKey;
  try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const payload = JSON.stringify(body);
  const sizeMB = (Buffer.byteLength(payload) / 1024 / 1024).toFixed(1);

  if (sessions.length < totalSessions) {
    process.stdout.write(`  Incremental sync: ${sessions.length} new sessions (${sizeMB}MB), ${serverIds.size} already on server\n`);
  }

  const url = new URL('/api/team/sync', serverUrl);
  return httpRequest(url, {
    method: 'POST',
    timeout: 120000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);
}

async function resolveDevId(serverUrl, apiKey) {
  const url = new URL('/api/team/whoami?key=' + encodeURIComponent(apiKey), serverUrl);
  return httpRequest(url, { method: 'GET', timeout: 10000 });
}

module.exports = { syncToTeam, resolveDevId };
