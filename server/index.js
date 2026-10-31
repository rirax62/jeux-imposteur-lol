import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, HttpError, RAW } from './http.js';
import { isHost, playerFromToken } from './auth.js';
import { backupNow } from './db.js';
import { currentGame } from './services.js';
import './routes/public.js';
import './routes/player.js';
import './routes/host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', // le jeton joueur est dans l'URL : jamais transmis en Referer
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { const v = JSON.parse(raw); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/') rel = '/index.html';
  else if (rel === '/host') rel = '/host.html';
  else if (rel === '/play' || rel.startsWith('/j/')) rel = '/play.html';
  let file;
  try { file = path.normalize(path.join(PUB, decodeURIComponent(rel))); } catch { return sendJson(res, 400, { error: 'URL invalide.' }); }
  if (!file.startsWith(PUB + path.sep)) return sendJson(res, 403, { error: 'Accès refusé.' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Page introuvable.' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée.');
      return serveStatic(req, res, pathname);
    }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let match = null, pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Méthode non autorisée.' : 'Route inconnue.');

    // Anti-CSRF : toute écriture doit être une requête JSON (impossible depuis un formulaire tiers) + cookie SameSite=Strict
    if (method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type JSON requis.');

    const ip = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    const ctx = { req, res, params: match.params, query: url.searchParams, ip, secure, body: {} };

    if (match.r.opts.auth === 'host' && !isHost(req)) throw new HttpError(401, 'Connexion hôte requise.');
    if (match.r.opts.auth === 'player') {
      const p = playerFromToken(req.headers['x-player-token']);
      if (!p) throw new HttpError(401, 'Lien joueur invalide.');
      ctx.player = p;
    }
    if (method !== 'GET') ctx.body = await readBody(req);

    const out = await match.r.handler(ctx);
    if (out === RAW) return;
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* ignoré */ } return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Erreur interne du serveur.' });
  }
});

server.listen(PORT, () => {
  currentGame(); // garantit qu'une partie existe
  try { backupNow(); } catch (e) { console.error('Sauvegarde automatique impossible :', e.message); }
  setInterval(() => { try { backupNow(); } catch (e) { console.error(e.message); } }, 6 * 3600 * 1000).unref();
  console.log(`\n  ⚔  Randomizer de rôles LoL — http://localhost:${PORT}`);
  console.log(`  Interface hôte : http://localhost:${PORT}/host\n`);
});

export { server };
