/** Пароли (scrypt), сессии в БД, middleware авторизации. */
const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'pcb_sid';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

async function createSession(res, userType, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000);
  await db.run(
    'INSERT INTO sessions (token, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)',
    [token, userType, userId, expires.toISOString().slice(0, 19).replace('T', ' ')]
  );
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  );
  return token;
}

async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function loadUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = await db.get(
    'SELECT user_type, user_id, expires_at FROM sessions WHERE token = ?',
    [token]
  );
  if (!s) return null;
  if (new Date(String(s.expires_at).replace(' ', 'T')).getTime() < Date.now()) {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  if (s.user_type === 'client') {
    const u = await db.get(
      'SELECT id, full_name, phone, email, city, address, note, created_at FROM clients WHERE id = ?',
      [s.user_id]
    );
    return u ? { type: 'client', id: u.id, name: u.full_name, ...u } : null;
  }
  const u = await db.get(
    'SELECT id, login, full_name, role FROM staff WHERE id = ?',
    [s.user_id]
  );
  return u ? { type: 'staff', id: u.id, name: u.full_name, ...u } : null;
}

async function attachUser(req, _res, next) {
  try {
    req.user = await loadUser(req);
  } catch {
    req.user = null;
  }
  next();
}

function requireClient(req, res, next) {
  if (!req.user || req.user.type !== 'client') return res.status(401).json({ error: 'Требуется вход как клиент' });
  next();
}

function requireStaff(req, res, next) {
  if (!req.user || req.user.type !== 'staff') return res.status(401).json({ error: 'Требуется вход как сотрудник' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, loadUser,
  attachUser, requireClient, requireStaff, parseCookies, COOKIE,
};
