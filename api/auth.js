// api/auth.js — Google SSO authentication + login logging
// POST: verify Google ID token, set session cookie, log login
// GET:  return current user from session cookie
// DELETE: logout (clear cookie)

const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-me-in-production';
const ALLOWED_DOMAIN = 'spyne.ai';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const COOKIE_NAME = 'ops_session';
const COOKIE_MAX_AGE = 60 * 60; // 1 hour auto-logout

// ── Google Sheets login logging (optional) ──────────────────────────
const GS_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const GS_KEY   = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n');
const LOG_SHEET = process.env.LOGIN_LOG_SHEET_ID || '';

let gsAccessToken = null;
let gsTokenExpiry = 0;

function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getGoogleSheetsToken() {
  if (gsAccessToken && Date.now() < gsTokenExpiry) return gsAccessToken;
  if (!GS_EMAIL || !GS_KEY) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: GS_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = base64url(sign.sign(GS_KEY));

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${signature}`,
  });

  if (!resp.ok) {
    console.error('Google Sheets token error:', await resp.text());
    return null;
  }

  const data = await resp.json();
  gsAccessToken = data.access_token;
  gsTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return gsAccessToken;
}

async function logLoginToSheet(user, req) {
  if (!LOG_SHEET) {
    console.log('[LOGIN]', JSON.stringify({
      ts: new Date().toISOString(),
      email: user.email,
      name: user.name,
      ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '',
      ua: (req.headers['user-agent'] || '').slice(0, 120),
    }));
    return;
  }

  try {
    const token = await getGoogleSheetsToken();
    if (!token) return;

    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const ts = ist.toISOString().replace('T', ' ').replace('Z', '') + ' IST';

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${LOG_SHEET}/values/Sheet1!A:E:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          values: [[
            ts,
            user.email,
            user.name,
            req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '',
            (req.headers['user-agent'] || '').slice(0, 120),
          ]],
        }),
      }
    );
  } catch (e) {
    console.error('Sheet log error:', e.message);
  }
}

// ── Session cookie helpers ──────────────────────────────────────────
function signPayload(payload) {
  const json = JSON.stringify(payload);
  const data = base64url(json);
  const hmac = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest();
  return `${data}.${base64url(hmac)}`;
}

function verifySession(cookieStr) {
  if (!cookieStr) return null;
  const [data, sig] = cookieStr.split('.');
  if (!data || !sig) return null;

  const expected = base64url(
    crypto.createHmac('sha256', AUTH_SECRET).update(data).digest()
  );
  if (sig !== expected) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function sessionCookie(value, maxAge) {
  const parts = [`${COOKIE_NAME}=${value}`, `Max-Age=${maxAge}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.VERCEL) parts.push('Secure');
  return parts.join('; ');
}

// ── Main handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const cookies = parseCookies(req.headers.cookie);

  // GET — return current user
  if (req.method === 'GET') {
    const user = verifySession(cookies[COOKIE_NAME]);
    if (!user) return res.status(401).json({ error: 'not authenticated' });
    return res.json({ email: user.email, name: user.name, picture: user.picture });
  }

  // DELETE — logout
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return res.json({ ok: true });
  }

  // POST — login with Google credential
  if (req.method === 'POST') {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'missing credential' });

    // Verify with Google
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!verify.ok) return res.status(401).json({ error: 'invalid token' });

    const info = await verify.json();

    // Check client ID
    if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'token audience mismatch' });
    }

    // Check domain
    if (info.hd !== ALLOWED_DOMAIN) {
      return res.status(403).json({ error: `only @${ALLOWED_DOMAIN} accounts allowed` });
    }

    // Check email allowlist (if configured)
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(info.email.toLowerCase())) {
      return res.status(403).json({ error: 'your account is not authorized to access this dashboard' });
    }

    const user = {
      email: info.email,
      name: info.name || info.email.split('@')[0],
      picture: info.picture || '',
      exp: Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE,
    };

    res.setHeader('Set-Cookie', sessionCookie(signPayload(user), COOKIE_MAX_AGE));

    // Log login (non-blocking)
    logLoginToSheet(user, req).catch(() => {});

    return res.json({ email: user.email, name: user.name, picture: user.picture });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
