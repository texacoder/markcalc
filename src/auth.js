const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const COOKIE = 'mc_session';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(key, expected);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(secure, maxAgeSeconds) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return token;
}

function setSessionCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOptions(secure, SESSION_DAYS * 86400)}`);
}

function clearSessionCookie(res, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions(secure, 0)}`);
}

async function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.get(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    Date.now(),
  );
  return row ? { id: row.id, name: row.name, email: row.email, token } : null;
}

async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

// Simple fixed-window limiter kept in memory (fine for a single server instance).
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateSignup({ name, email, password }) {
  if (!String(name || '').trim()) throw new HttpError(400, 'Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) throw new HttpError(400, 'Please enter a valid email address.');
  if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
}

module.exports = {
  HttpError,
  sha256,
  hashPassword,
  verifyPassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  sessionUser,
  destroySession,
  rateLimiter,
  normalizeEmail,
  validateSignup,
};
