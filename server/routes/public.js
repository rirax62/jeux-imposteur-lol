import { route, HttpError } from '../http.js';
import { all, get } from '../db.js';
import { currentGame, publicState, scoreboard, publicGame, teamTotals } from '../services.js';
import { playerFromCode, playerFromToken, codeLimiter, isHost } from '../auth.js';
import { addClient } from '../events.js';

route('GET', '/api/public/state', () => publicState(currentGame()));

route('GET', '/api/public/history', () => {
  const cur = currentGame();
  return all("SELECT id FROM games WHERE status='ended' ORDER BY ended_at DESC LIMIT 50").map(({ id }) => {
    const g = get('SELECT * FROM games WHERE id=?', id);
    const ranking = scoreboard(id);
    return { ...publicGame(g), current: g.id === cur.id, players: ranking.length, podium: ranking.slice(0, 3).map((r) => ({ name: r.name, total: r.total })), team_totals: teamTotals(ranking) };
  });
});

route('GET', '/api/public/games/:id', ({ params }) => {
  const g = get("SELECT * FROM games WHERE id=? AND status='ended'", Number(params.id));
  if (!g) throw new HttpError(404, 'Partie introuvable.');
  return publicState(g);
});

// Connexion d'un joueur avec son code individuel (ou lien complet collé)
route('POST', '/api/join', ({ body, ip }) => {
  if (!codeLimiter.allowed(ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  let input = String(body.code || '').trim();
  let player = null;
  const m = input.match(/\/j\/([A-Za-z0-9_-]{10,100})/);
  if (m) player = playerFromToken(m[1]);
  else player = playerFromCode(input);
  if (!player) {
    codeLimiter.fail(ip);
    throw new HttpError(404, 'Code ou lien invalide.');
  }
  return { token: player.token, name: player.name };
});

// Flux temps réel
route('GET', '/api/events', ({ req, res, query }) => {
  const scope = query.get('scope') || 'public';
  let info = { scope: 'public' };
  if (scope === 'host') {
    if (!isHost(req)) throw new HttpError(401, 'Connexion hôte requise.');
    info = { scope: 'host' };
  } else if (scope === 'player') {
    const p = playerFromToken(query.get('t'));
    if (!p) throw new HttpError(401, 'Lien joueur invalide.');
    info = { scope: 'player', playerId: p.id, gameId: p.game_id };
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  addClient(res, info);
  return Symbol.for('raw');
});
