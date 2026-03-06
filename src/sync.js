const http = require('http');
const https = require('https');

async function syncToTeam(serverUrl, devId, parsedData, apiKey) {
  const body = { devId, data: parsedData };
  if (apiKey) body.key = apiKey;
  const payload = JSON.stringify(body);
  const url = new URL('/api/team/sync', serverUrl);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
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
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

async function resolveDevId(serverUrl, apiKey) {
  const url = new URL('/api/team/whoami?key=' + encodeURIComponent(apiKey), serverUrl);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: 'GET' }, (res) => {
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

module.exports = { syncToTeam, resolveDevId };
