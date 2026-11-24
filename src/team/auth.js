// Authentication for the team server.
//
// Everything under /api/team is deny-by-default: a request must be explicitly public,
// carry the admin bearer token, carry a valid dashboard session cookie, or (for a
// developer's own sync bookkeeping only) carry that developer's API key.
//
// Credentials (SSM / env):
//   DASHBOARD_PASSWORD  shared viewer password -> signed HttpOnly session cookie
//   ADMIN_PASSWORD      admin bearer token (admin panel, admin APIs)
//   HMAC_SALT           mixed into the session signing key
// If DASHBOARD_PASSWORD is unset, dashboard login is disabled (fail closed).

const crypto = require('crypto');

const COOKIE_NAME = 'cs_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Routes reachable without any credentials. Each handles its own auth where relevant:
// /sync and /whoami validate the developer API key; /login checks the password.
const PUBLIC_ROUTES = new Set([
  'POST /sync',
  'GET /whoami',
  'POST /login',
  'POST /logout',
  'GET /session',
]);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// Constant-time string comparison (hash first so lengths always match).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function dashboardPassword() {
  return process.env.DASHBOARD_PASSWORD || null;
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

// Derived from the password, so rotating DASHBOARD_PASSWORD revokes every session.
function signingKey() {
  return sha256('cs-session:v1:' + dashboardPassword() + ':' + (process.env.HMAC_SALT || ''));
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function createSessionToken(now = Date.now()) {
  const payload = 'v1.' + (now + SESSION_TTL_MS);
  return payload + '.' + sign(payload);
}

function verifySessionToken(token, now = Date.now()) {
  if (!dashboardPassword() || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  return safeEqual(parts[2], sign(parts[0] + '.' + parts[1]));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

function hasValidSession(req) {
  return verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function isAdminRequest(req) {
  const pass = adminPassword();
  const auth = req.headers.authorization;
  if (!pass || typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  return safeEqual(auth.slice(7), pass);
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/* Login brute-force limiter: 10 failed attempts per client per 15 minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // clientId -> { count, resetAt }

function clientId(req) {
  // App Runner's proxy appends the real client IP to X-Forwarded-For.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginBlocked(id, now = Date.now()) {
  const e = loginFailures.get(id);
  if (!e) return false;
  if (e.resetAt <= now) { loginFailures.delete(id); return false; }
  return e.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(id, now = Date.now()) {
  const e = loginFailures.get(id);
  if (!e || e.resetAt <= now) loginFailures.set(id, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count++;
  if (loginFailures.size > 10000) {
    for (const [k, v] of loginFailures) if (v.resetAt <= now) loginFailures.delete(k);
  }
}

/**
 * Deny-by-default middleware for the /api/team router.
 * resolveKey(key) -> allowlist entry ({ devId, ... }) or null.
 */
function createAuthMiddleware({ resolveKey }) {
  return function requireAuth(req, res, next) {
    const route = req.method + ' ' + req.path;
    if (PUBLIC_ROUTES.has(route)) return next();

    if (isAdminRequest(req)) { req.auth = { role: 'admin' }; return next(); }
    if (hasValidSession(req)) { req.auth = { role: 'viewer' }; return next(); }

    // A developer's sync client may read its OWN summary (to diff before syncing) with its API key.
    const key = req.headers['x-api-key'];
    if (req.method === 'GET' && typeof key === 'string' && key) {
      const m = /^\/dev\/([^/]+)$/.exec(req.path);
      if (m) {
        let devId;
        try { devId = decodeURIComponent(m[1]); } catch { devId = null; }
        const entry = resolveKey(key);
        if (entry && devId && entry.devId === devId) {
          req.auth = { role: 'dev', devId };
          return next();
        }
      }
    }

    res.status(401).json({ error: 'Authentication required' });
  };
}

function registerAuthRoutes(router, express) {
  router.post('/login', express.json({ limit: '4kb' }), (req, res) => {
    if (!dashboardPassword()) {
      return res.status(503).json({ error: 'Dashboard login is not configured. Set DASHBOARD_PASSWORD.' });
    }
    const id = clientId(req);
    if (loginBlocked(id)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    const password = req.body && req.body.password;
    if (!safeEqual(typeof password === 'string' ? password : '', dashboardPassword())) {
      recordLoginFailure(id);
      return res.status(401).json({ error: 'Invalid password' });
    }
    loginFailures.delete(id);
    setSessionCookie(req, res, createSessionToken());
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    res.json({ authenticated: hasValidSession(req) });
  });
}

function _resetForTests() {
  loginFailures.clear();
}

module.exports = {
  PUBLIC_ROUTES, COOKIE_NAME,
  safeEqual, createSessionToken, verifySessionToken, parseCookies,
  hasValidSession, isAdminRequest,
  createAuthMiddleware, registerAuthRoutes,
  _resetForTests,
};
