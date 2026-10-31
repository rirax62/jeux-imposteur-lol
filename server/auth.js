import { get, run, getSetting, setSetting } from './db.js';
import { token, sha256, hashPassword, verifyPassword, RateLimiter, normCode } from './util.js';
import { HttpError } from './http.js';

const COOKIE = 'lh_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;

export const loginLimiter = new RateLimiter(8, 10 * 60 * 1000); // 8 échecs / 10 min / IP
export const codeLimiter = new RateLimiter(15, 10 * 60 * 1000);

export const hostConfigured = () => !!getSetting('host_password');

// Mot de passe initial via variable d'environnement (optionnel)
if (!hostConfigured() && process.env.HOST_PASSWORD && process.env.HOST_PASSWORD.length >= 8) {
  setSetting('host_password', hashPassword(process.env.HOST_PASSWORD));
}

export function setHostPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
  if (pw.length > 200) throw new HttpError(400, 'Mot de passe trop long.');
  setSetting('host_password', hashPassword(pw));
  run('DELETE FROM host_sessions'); // invalide toutes les sessions existantes
}

export function checkHostPassword(pw) {
  const stored = getSetting('host_password');
  return !!stored && typeof pw === 'string' && verifyPassword(pw, stored);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(res, secure) {
  const t = token(32);
  const now = Date.now();
  run('DELETE FROM host_sessions WHERE expires_at < ?', now);
  run('INSERT INTO host_sessions(token_hash, created_at, expires_at) VALUES(?,?,?)', sha256(t), now, now + SESSION_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
}

export function clearSession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) run('DELETE FROM host_sessions WHERE token_hash=?', sha256(t));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function isHost(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return false;
  const s = get('SELECT expires_at FROM host_sessions WHERE token_hash=?', sha256(t));
  return !!s && s.expires_at > Date.now();
}

export function playerFromToken(t) {
  if (typeof t !== 'string' || t.length < 10 || t.length > 100) return null;
  return get('SELECT * FROM players WHERE token=?', t) || null;
}
export function playerFromCode(c) {
  const n = normCode(c);
  if (n.length !== 8) return null;
  return get('SELECT * FROM players WHERE code=?', n) || null;
}
