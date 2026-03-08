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
        } catch { reject(new Error('Invalid response from server')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncToTeam(serverUrl, devId, parsedData, apiKey) {
  const body = { devId, data: parsedData };
  if (apiKey) body.key = apiKey;
  try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const payload = JSON.stringify(body);
  const url = new URL('/api/team/sync', serverUrl);

  return httpRequest(url, {
    method: 'POST',
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
