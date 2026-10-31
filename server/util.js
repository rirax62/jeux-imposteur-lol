import crypto from 'node:crypto';

export const now = () => Date.now();

export const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
export function shortCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[crypto.randomInt(ALPHA.length)];
  return s;
}
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(h, expected);
  } catch {
    return false;
  }
}

/** Limiteur en mémoire : max tentatives échouées par fenêtre glissante. */
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }
  _clean(key) {
    const t = now();
    const arr = (this.map.get(key) || []).filter((x) => t - x < this.windowMs);
    this.map.set(key, arr);
    return arr;
  }
  allowed(key) {
    return this._clean(key).length < this.max;
  }
  fail(key) {
    this._clean(key).push(now());
  }
  reset(key) {
    this.map.delete(key);
  }
}
setInterval(() => {}, 1 << 30).unref();

export const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export function int(v, { min = -1e9, max = 1e9, def = null } = {}) {
  if (v === null || v === undefined || v === '') return def;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
export function num(v, { min = 0, max = 1e6, def = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
