import fs from 'node:fs';
import path from 'node:path';
import { route, HttpError, RAW } from '../http.js';
import { all, get, run, tx, audit, setSetting, DATA_DIR, db } from '../db.js';
import { str, int, bool, token, shortCode } from '../util.js';
import { simulate } from '../draw.js';
import * as S from '../services.js';
import { emit } from '../events.js';
import { hostConfigured, setHostPassword, checkHostPassword, createSession, clearSession, isHost, loginLimiter } from '../auth.js';

const H = { auth: 'host' };
const cur = () => S.currentGame();
const changed = (g, ...types) => { for (const t of types) emit(t, { gameId: g.id }); };

// ───────────── Authentification hôte ─────────────
route('GET', '/api/host/session', ({ req }) => ({ configured: hostConfigured(), authed: isHost(req) }));

route('POST', '/api/host/setup', ({ body, res, secure }) => {
  if (hostConfigured()) throw new HttpError(409, 'Le mot de passe hôte est déjà défini.');
  setHostPassword(body.password);
  createSession(res, secure);
  audit(null, 'hôte', 'Mot de passe hôte créé');
  return { ok: true };
});

route('POST', '/api/host/login', ({ body, res, ip, secure }) => {
  if (!loginLimiter.allowed(ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  if (!checkHostPassword(body.password)) {
    loginLimiter.fail(ip);
    throw new HttpError(401, 'Mot de passe incorrect.');
  }
  loginLimiter.reset(ip);
  createSession(res, secure);
  audit(null, 'hôte', 'Connexion hôte');
  return { ok: true };
});

route('POST', '/api/host/logout', ({ req, res }) => {
  clearSession(req, res);
  return { ok: true };
});

route('POST', '/api/host/password', H, ({ body, res, secure }) => {
  if (!checkHostPassword(body.old)) throw new HttpError(403, 'Ancien mot de passe incorrect.');
  setHostPassword(body.new);
  createSession(res, secure);
  audit(null, 'hôte', 'Mot de passe hôte modifié');
  return { ok: true };
});

// ───────────── État complet ─────────────
route('GET', '/api/host/state', H, () => S.hostState(cur()));

route('GET', '/api/host/audit', H, ({ query }) => {
  const limit = Math.min(500, int(query.get('limit'), { min: 1, max: 500, def: 150 }));
  const scope = query.get('scope') === 'all' ? '' : 'WHERE game_id = ? OR game_id IS NULL';
  const rows = scope ? all(`SELECT * FROM audit ${scope} ORDER BY id DESC LIMIT ?`, cur().id, limit) : all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit);
  return rows;
});

// ───────────── Parties ─────────────
route('POST', '/api/host/games', H, ({ body }) => {
  const prev = cur();
  const g = S.createGame(body.name, body.copy_players ? prev.id : null);
  audit(g.id, 'hôte', 'Partie créée', g.name);
  changed(g, 'game', 'scores', 'me');
  return { id: g.id };
});

route('PATCH', '/api/host/game', H, ({ body }) => {
  const g = cur();
  const f = {};
  if ('name' in body) f.name = str(body.name, 80) || g.name;
  if ('team_a' in body) f.team_a = str(body.team_a, 40) || g.team_a;
  if ('team_b' in body) f.team_b = str(body.team_b, 40) || g.team_b;
  if ('teams_enabled' in body) f.teams_enabled = bool(body.teams_enabled);
  const cols = Object.keys(f);
  if (cols.length) run(`UPDATE games SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...cols.map((c) => f[c]), g.id);
  audit(g.id, 'hôte', 'Paramètres de la partie modifiés', JSON.stringify(f));
  changed(g, 'game', 'me');
  return { ok: true };
});

route('POST', '/api/host/games/:id/activate', H, ({ params }) => {
  const g = get('SELECT * FROM games WHERE id=?', Number(params.id));
  if (!g) throw new HttpError(404, 'Partie introuvable.');
  setSetting('current_game', g.id);
  audit(g.id, 'hôte', 'Partie activée', g.name);
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});

route('DELETE', '/api/host/games/:id', H, ({ params }) => {
  const g = get('SELECT * FROM games WHERE id=?', Number(params.id));
  if (!g) throw new HttpError(404, 'Partie introuvable.');
  const wasCurrent = g.id === cur().id;
  run('DELETE FROM games WHERE id=?', g.id);
  audit(null, 'hôte', 'Partie supprimée', g.name);
  if (wasCurrent) S.currentGame(); // bascule sur la plus récente ou en crée une
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});

route('POST', '/api/host/game/distribute', H, () => {
  const g = cur();
  const n = S.distributeRoles(g);
  audit(g.id, 'hôte', 'Rôles distribués', `${n} joueurs`);
  changed(g, 'game', 'me');
  return { ok: true, players: n };
});
route('POST', '/api/host/game/start', H, () => {
  const g = cur();
  S.setStatus(g, 'running');
  audit(g.id, 'hôte', 'Partie lancée');
  changed(g, 'game', 'me');
  return { ok: true };
});
route('POST', '/api/host/game/end', H, () => {
  const g = cur();
  S.setStatus(g, 'ended');
  audit(g.id, 'hôte', 'Partie terminée');
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});
route('POST', '/api/host/game/reset', H, ({ body }) => {
  const g = cur();
  S.resetGame(g, !!body.keep_scores);
  audit(g.id, 'hôte', 'Partie réinitialisée', body.keep_scores ? 'scores conservés' : 'scores effacés');
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});
route('POST', '/api/host/game/reveal-roles', H, ({ body }) => {
  const g = cur();
  if (g.status !== 'ended') throw new HttpError(409, 'Disponible uniquement après la fin de la partie.');
  run('UPDATE games SET roles_revealed=? WHERE id=?', bool(body.value), g.id);
  audit(g.id, 'hôte', body.value ? 'Rôles révélés publiquement' : 'Rôles de nouveau masqués');
  changed(g, 'game', 'me');
  return { ok: true };
});

// ───────────── Vote de fin de partie ─────────────
route('POST', '/api/host/votes/open', H, () => {
  const g = cur();
  S.openVotes(g);
  audit(g.id, 'hôte', 'Vote de fin de partie ouvert');
  changed(g, 'game', 'me');
  return { ok: true };
});
route('POST', '/api/host/votes/close', H, () => {
  const g = cur();
  const r = S.closeVotes(g);
  audit(g.id, 'hôte', 'Vote clôturé, points attribués', `${r.votes} vote(s), ${r.events} évènement(s) de score`);
  changed(g, 'game', 'scores', 'me');
  return { ok: true, ...r };
});
route('POST', '/api/host/votes/reopen', H, () => {
  const g = cur();
  S.reopenVotes(g);
  audit(g.id, 'hôte', 'Vote rouvert, points du vote annulés');
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});
route('PUT', '/api/host/votes/rules', H, ({ body }) => {
  const g = cur();
  const rules = S.cleanVoteRules(body);
  setSetting('vote_rules', JSON.stringify(rules));
  audit(g.id, 'hôte', 'Règles de points du vote modifiées', JSON.stringify(rules));
  changed(g, 'game', 'me');
  return { ok: true, rules };
});

// ───────────── Joueurs ─────────────
route('POST', '/api/host/players', H, ({ body }) => {
  const g = cur();
  const team = body.team === 0 || body.team === 1 ? body.team : null;
  const id = S.addPlayer(g.id, body.name, team);
  audit(g.id, 'hôte', 'Joueur ajouté', str(body.name, 40));
  changed(g, 'game', 'scores');
  return { id };
});

route('POST', '/api/host/players/count', H, ({ body }) => {
  const g = cur();
  const n = int(body.n, { min: 0, max: 100, def: null });
  if (n === null) throw new HttpError(400, 'Nombre invalide.');
  tx(() => {
    const players = all('SELECT id, name FROM players WHERE game_id=? ORDER BY id', g.id);
    if (n > players.length) {
      let k = 1;
      const names = new Set(players.map((p) => p.name.toLowerCase()));
      for (let i = players.length; i < n; i++) {
        while (names.has(`joueur ${k}`)) k++;
        S.addPlayer(g.id, `Joueur ${k}`);
        names.add(`joueur ${k}`);
      }
    } else if (n < players.length) {
      for (const p of players.slice(n)) run('DELETE FROM players WHERE id=?', p.id);
    }
  });
  audit(g.id, 'hôte', 'Nombre de participants défini', String(n));
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});

route('POST', '/api/host/players/teams', H, ({ body }) => {
  const g = cur();
  if (body.mode === 'clear') run('UPDATE players SET team=NULL WHERE game_id=?', g.id);
  else S.balanceTeams(g.id, body.mode === 'all');
  audit(g.id, 'hôte', 'Équipes réparties', body.mode || 'auto');
  changed(g, 'game', 'scores', 'me');
  return { ok: true };
});

route('PATCH', '/api/host/players/:id', H, ({ params, body }) => {
  const g = cur();
  const p = get('SELECT * FROM players WHERE id=? AND game_id=?', Number(params.id), g.id);
  if (!p) throw new HttpError(404, 'Joueur introuvable.');
  const f = {};
  if ('name' in body) {
    const name = str(body.name, 40);
    if (!name) throw new HttpError(400, 'Le nom est obligatoire.');
    if (get('SELECT 1 FROM players WHERE game_id=? AND lower(name)=lower(?) AND id<>?', g.id, name, p.id)) throw new HttpError(409, 'Ce nom est déjà utilisé.');
    f.name = name;
  }
  if ('team' in body) f.team = body.team === 0 || body.team === 1 ? body.team : null;
  if ('role_id' in body) {
    if (body.role_id === null || body.role_id === '') { f.role_id = null; f.role_name = null; f.revealed = 0; f.revealed_at = null; }
    else {
      const r = S.getRole(Number(body.role_id));
      if (!r) throw new HttpError(404, 'Rôle introuvable.');
      f.role_id = r.id; f.role_name = r.name;
    }
  }
  if (body.reset_reveal) { f.revealed = 0; f.revealed_at = null; }
  const cols = Object.keys(f);
  if (cols.length) run(`UPDATE players SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...cols.map((c) => f[c]), p.id);
  audit(g.id, 'hôte', 'Joueur modifié', `${p.name} → ${JSON.stringify(f)}`);
  changed(g, 'game', 'scores');
  emit('me', { playerId: p.id });
  return { ok: true };
});

route('POST', '/api/host/players/:id/regenerate', H, ({ params }) => {
  const g = cur();
  const p = get('SELECT * FROM players WHERE id=? AND game_id=?', Number(params.id), g.id);
  if (!p) throw new HttpError(404, 'Joueur introuvable.');
  run('UPDATE players SET token=?, code=? WHERE id=?', token(24), shortCode(8), p.id);
  audit(g.id, 'hôte', 'Lien personnel régénéré', p.name);
  changed(g, 'game');
  return { ok: true };
});

route('DELETE', '/api/host/players/:id', H, ({ params }) => {
  const g = cur();
  const p = get('SELECT * FROM players WHERE id=? AND game_id=?', Number(params.id), g.id);
  if (!p) throw new HttpError(404, 'Joueur introuvable.');
  run('DELETE FROM players WHERE id=?', p.id);
  audit(g.id, 'hôte', 'Joueur supprimé', p.name);
  changed(g, 'game', 'scores');
  return { ok: true };
});

// ───────────── Rôles & tirage ─────────────
route('POST', '/api/host/roles', H, ({ body }) => {
  const id = S.insertRole(S.cleanRoleInput(body));
  audit(null, 'hôte', 'Rôle créé', str(body.name, 60));
  emit('host');
  return { id };
});

route('PUT', '/api/host/roles/:id', H, ({ params, body }) => {
  const r = S.getRole(Number(params.id));
  if (!r) throw new HttpError(404, 'Rôle introuvable.');
  const f = S.cleanRoleInput(body, r);
  S.updateRole(r.id, f);
  audit(null, 'hôte', 'Rôle modifié', `${r.name} → ${Object.keys(f).join(', ')}`);
  emit('host');
  emit('me');
  return { ok: true };
});

route('DELETE', '/api/host/roles/:id', H, ({ params }) => {
  const r = S.getRole(Number(params.id));
  if (!r) throw new HttpError(404, 'Rôle introuvable.');
  run('DELETE FROM roles WHERE id=?', r.id);
  audit(null, 'hôte', 'Rôle supprimé', r.name);
  emit('host');
  emit('me');
  return { ok: true };
});

route('POST', '/api/host/roles/:id/duplicate', H, ({ params }) => {
  const r = S.getRole(Number(params.id));
  if (!r) throw new HttpError(404, 'Rôle introuvable.');
  const { id, ...rest } = r;
  const id2 = S.insertRole({ ...rest, name: `${r.name} (copie)`, rewards: JSON.stringify(r.rewards), sort: r.sort + 1 });
  audit(null, 'hôte', 'Rôle dupliqué', r.name);
  emit('host');
  return { id: id2 };
});

// Remet les poids à une somme de 100 pour que « poids = pourcentage »
route('POST', '/api/host/roles/normalize', H, () => {
  const roles = S.listRoles().filter((r) => r.enabled && !(r.exact_count > 0) && r.weight > 0);
  const total = roles.reduce((s, r) => s + r.weight, 0);
  if (!total) throw new HttpError(409, 'Aucun rôle tiré au sort avec un poids positif.');
  tx(() => { for (const r of roles) run('UPDATE roles SET weight=? WHERE id=?', Math.round((r.weight / total) * 10000) / 100, r.id); });
  audit(null, 'hôte', 'Probabilités normalisées à 100 %');
  emit('host');
  return { ok: true };
});

route('POST', '/api/host/draw/simulate', H, ({ body }) => {
  const g = cur();
  const real = all('SELECT id, team FROM players WHERE game_id=?', g.id).length;
  const n = int(body.players, { min: 1, max: 100, def: real || 8 });
  const runs = int(body.runs, { min: 100, max: 5000, def: 1000 });
  const players = Array.from({ length: n }, (_, i) => ({ id: i + 1, team: g.teams_enabled ? i % 2 : null }));
  const roles = S.listRoles();
  try { return { players: n, runs, results: simulate(players, roles, runs) }; }
  catch (e) { throw new HttpError(422, e.message); }
});

// ───────────── Roues ─────────────
route('POST', '/api/host/wheels', H, ({ body }) => {
  const w = S.createWheel(body.label);
  audit(cur().id, 'hôte', 'Roue créée', w.label);
  emit('host');
  return w;
});

route('DELETE', '/api/host/wheels/:key', H, ({ params }) => {
  const label = S.WHEELS[params.key];
  const roles = S.deleteWheel(params.key);
  audit(cur().id, 'hôte', `Roue « ${label} » supprimée`, roles.length ? `rôles détachés : ${roles.map((r) => r.name).join(', ')}` : '');
  emit('host');
  emit('me');
  return { ok: true, detached: roles.length };
});

route('PUT', '/api/host/wheels/:key', H, ({ params, body }) => {
  const g = cur();
  if (!S.WHEELS[params.key]) throw new HttpError(404, 'Roue inconnue.');
  if ('label' in body) { S.renameWheel(params.key, body.label); audit(g.id, 'hôte', 'Roue renommée', S.WHEELS[params.key]); }
  const f = {};
  if ('enabled' in body) f.enabled = bool(body.enabled);
  if ('rule' in body) {
    if (!['opponents', 'teammates', 'all'].includes(body.rule)) throw new HttpError(400, 'Règle invalide.');
    f.rule = body.rule;
  }
  if ('max_spins' in body) f.max_spins = int(body.max_spins, { min: 1, max: 20, def: 1 });
  if ('share_team' in body) f.share_team = bool(body.share_team);
  if ('excluded' in body) {
    const ids = new Set(all('SELECT id FROM players WHERE game_id=?', g.id).map((p) => p.id));
    f.excluded = JSON.stringify([...new Set((Array.isArray(body.excluded) ? body.excluded : []).map(Number).filter((i) => ids.has(i)))]);
  }
  const cols = Object.keys(f);
  if (cols.length) run(`UPDATE wheel_config SET ${cols.map((c) => c + '=?').join(',')} WHERE game_id=? AND wheel=?`, ...cols.map((c) => f[c]), g.id, params.key);
  audit(g.id, 'hôte', `Roue « ${S.WHEELS[params.key]} » configurée`, JSON.stringify(f));
  changed(g, 'me');
  return { ok: true };
});

route('POST', '/api/host/wheels/:key/reset', H, ({ params, body }) => {
  const g = cur();
  if (!S.WHEELS[params.key]) throw new HttpError(404, 'Roue inconnue.');
  if (body.player_id) run('DELETE FROM wheel_spins WHERE game_id=? AND wheel=? AND player_id=?', g.id, params.key, Number(body.player_id));
  else run('DELETE FROM wheel_spins WHERE game_id=? AND wheel=?', g.id, params.key);
  audit(g.id, 'hôte', `Roue « ${S.WHEELS[params.key]} » réinitialisée`, body.player_id ? `joueur #${body.player_id}` : 'tous les joueurs');
  changed(g, 'me');
  return { ok: true };
});

// ───────────── Missions ─────────────
route('POST', '/api/host/claims/:id/:action', H, ({ params }) => {
  const g = cur();
  if (!['approve', 'reject'].includes(params.action)) throw new HttpError(404, 'Action inconnue.');
  const c = S.resolveClaim(g, Number(params.id), params.action === 'approve');
  audit(g.id, 'hôte', params.action === 'approve' ? 'Mission validée' : 'Mission refusée', c.label);
  changed(g, 'scores', 'me');
  return { ok: true };
});

// ───────────── Points & classement ─────────────
route('POST', '/api/host/score', H, ({ body }) => {
  const g = cur();
  const pts = S.addScore(g, Number(body.player_id), String(body.kind), body.points, body.comment);
  audit(g.id, 'hôte', 'Points modifiés', `joueur #${body.player_id} : ${body.kind} ${pts}${body.comment ? ' — ' + str(body.comment, 120) : ''}`);
  changed(g, 'scores');
  emit('me', { playerId: Number(body.player_id) });
  return { ok: true, points: pts };
});

route('POST', '/api/host/score/set-total', H, ({ body }) => {
  const g = cur();
  const row = S.scoreboard(g.id).find((r) => r.id === Number(body.player_id));
  if (!row) throw new HttpError(404, 'Joueur introuvable.');
  const target = int(body.total, { min: -100000, max: 100000, def: null });
  if (target === null) throw new HttpError(400, 'Total invalide.');
  const delta = target - row.total;
  if (delta === 0) return { ok: true, unchanged: true };
  S.addScore(g, row.id, 'points', delta, `Ajustement manuel (${row.total} → ${target})${body.comment ? ' : ' + str(body.comment, 200) : ''}`);
  audit(g.id, 'hôte', 'Score modifié directement', `${row.name} : ${row.total} → ${target}`);
  changed(g, 'scores');
  emit('me', { playerId: row.id });
  return { ok: true };
});

route('DELETE', '/api/host/score/events/:id', H, ({ params }) => {
  const g = cur();
  const e = get('SELECT * FROM score_events WHERE id=? AND game_id=?', Number(params.id), g.id);
  if (!e) throw new HttpError(404, 'Événement introuvable.');
  run('DELETE FROM score_events WHERE id=?', e.id);
  audit(g.id, 'hôte', 'Événement de score annulé', `joueur #${e.player_id} : ${e.kind} ${e.points}`);
  changed(g, 'scores');
  emit('me', { playerId: e.player_id });
  return { ok: true };
});

route('POST', '/api/host/score/reset', H, () => {
  const g = cur();
  run('DELETE FROM score_events WHERE game_id=?', g.id);
  audit(g.id, 'hôte', 'Scores réinitialisés');
  changed(g, 'scores', 'me');
  return { ok: true };
});

route('GET', '/api/host/export.csv', H, ({ res }) => {
  const g = cur();
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="classement-${g.id}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(S.rankingCsv(g));
  return RAW;
});

// ───────────── Sauvegarde ─────────────
route('GET', '/api/host/backup', H, ({ res }) => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = path.join(DATA_DIR, 'backups', `export-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename="sauvegarde-lol-roles.db"',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res).on('close', () => fs.rm(file, () => {}));
  return RAW;
});
