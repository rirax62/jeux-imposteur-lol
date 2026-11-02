import { randomInt } from 'node:crypto';
import { all, get, run, tx, getSetting, setSetting, audit } from './db.js';
import { token, shortCode, str, int, num, bool } from './util.js';
import { distribute, probabilities, shuffle } from './draw.js';
import { HttpError } from './http.js';
import { emit } from './events.js';

// Roues : { clé: libellé }, rechargé depuis la base (créées / renommées / supprimées par l'hôte)
export const WHEELS = {};
export function reloadWheels() {
  for (const k of Object.keys(WHEELS)) delete WHEELS[k];
  for (const w of all('SELECT key, label FROM wheel_defs ORDER BY sort, rowid')) WHEELS[w.key] = w.label;
}
reloadWheels();
export const REWARD_TYPES = ['mission', 'secondary', 'bonus', 'penalty'];
const SCORE_KINDS = ['points', 'mission_success', 'mission_fail', 'bonus', 'malus'];

// ───────────────────────── Parties ─────────────────────────
export function createGame(name, copyFromId = null) {
  return tx(() => {
    const r = run('INSERT INTO games(name, created_at) VALUES(?,?)', str(name, 80) || 'Nouvelle partie', Date.now());
    const id = Number(r.lastInsertRowid);
    for (const w of Object.keys(WHEELS)) run('INSERT OR IGNORE INTO wheel_config(game_id, wheel) VALUES(?,?)', id, w);
    if (copyFromId) {
      const prev = get('SELECT * FROM games WHERE id=?', copyFromId);
      if (prev) {
        run('UPDATE games SET team_a=?, team_b=?, teams_enabled=? WHERE id=?', prev.team_a, prev.team_b, prev.teams_enabled, id);
        for (const p of all('SELECT name, team FROM players WHERE game_id=? ORDER BY id', copyFromId)) addPlayer(id, p.name, p.team);
      }
    }
    setSetting('current_game', id);
    return get('SELECT * FROM games WHERE id=?', id);
  });
}

export function currentGame() {
  const id = getSetting('current_game');
  let g = id ? get('SELECT * FROM games WHERE id=?', Number(id)) : null;
  if (!g) g = get('SELECT * FROM games ORDER BY id DESC LIMIT 1');
  if (!g) g = createGame('Partie 1');
  else if (!id || g.id !== Number(id)) setSetting('current_game', g.id);
  return g;
}

export function addPlayer(gameId, name, team = null) {
  name = str(name, 40);
  if (!name) throw new HttpError(400, 'Le nom du joueur est obligatoire.');
  if (get('SELECT 1 FROM players WHERE game_id=? AND lower(name)=lower(?)', gameId, name))
    throw new HttpError(409, `Le nom « ${name} » est déjà utilisé dans cette partie.`);
  for (let i = 0; i < 20; i++) {
    try {
      const r = run('INSERT INTO players(game_id,name,token,code,team,created_at) VALUES(?,?,?,?,?,?)', gameId, name, token(24), shortCode(8), team, Date.now());
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE') || String(e.message).includes('players.name')) throw e;
    }
  }
  throw new HttpError(500, 'Impossible de générer un code unique.');
}

export function balanceTeams(gameId, forceAll = false) {
  const players = all('SELECT id, team FROM players WHERE game_id=? ORDER BY id', gameId);
  let a = 0, b = 0;
  const todo = [];
  for (const p of players) {
    if (!forceAll && p.team === 0) a++;
    else if (!forceAll && p.team === 1) b++;
    else todo.push(p.id);
  }
  for (const id of shuffle(todo)) {
    const t = a < b ? 0 : b < a ? 1 : randomInt(2);
    t === 0 ? a++ : b++;
    run('UPDATE players SET team=? WHERE id=?', t, id);
  }
}

// ───────────────────────── Rôles ─────────────────────────
export function parseRole(r) {
  if (!r) return r;
  let rewards = [];
  try { rewards = JSON.parse(r.rewards || '[]'); } catch { /* ignoré */ }
  return { ...r, rewards };
}
export const listRoles = () => all('SELECT * FROM roles ORDER BY sort, id').map(parseRole);
export const getRole = (id) => parseRole(get('SELECT * FROM roles WHERE id=?', id));

const TEXT_FIELDS = ['mission', 'description', 'objectives', 'allowed_actions', 'victory', 'conditions', 'penalties'];

/** Valide et normalise les champs fournis (mise à jour partielle possible). */
export function cleanRoleInput(input, existing = null) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (has('name') || !existing) {
    out.name = str(input.name, 60);
    if (!out.name) throw new HttpError(400, 'Le nom du rôle est obligatoire.');
  }
  for (const k of TEXT_FIELDS) if (has(k)) out[k] = str(input[k], 4000);
  if (has('weight')) out.weight = num(input.weight, { min: 0, max: 1e6, def: 0 });
  if (has('exact_count')) { const n = int(input.exact_count, { min: 0, max: 500, def: null }); out.exact_count = n > 0 ? n : null; }
  if (has('max_count')) { const n = int(input.max_count, { min: 0, max: 500, def: null }); out.max_count = n > 0 ? n : null; }
  if (has('per_team')) out.per_team = bool(input.per_team);
  if (has('is_impostor')) out.is_impostor = bool(input.is_impostor);
  if (has('enabled')) out.enabled = bool(input.enabled);
  if (has('wheel')) {
    const w = str(input.wheel, 20);
    if (w && !WHEELS[w]) throw new HttpError(400, 'Roue inconnue.');
    out.wheel = w;
  }
  if (has('fail_points')) out.fail_points = int(input.fail_points, { min: -1000, max: 1000, def: 0 });
  if (has('color')) out.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#c8aa6e';
  if (has('icon')) out.icon = str(input.icon, 8) || '⚔️';
  if (has('sort')) out.sort = int(input.sort, { min: 0, max: 9999, def: 0 });
  if (has('rewards')) {
    if (!Array.isArray(input.rewards)) throw new HttpError(400, 'Récompenses invalides.');
    const seen = new Set();
    out.rewards = JSON.stringify(
      input.rewards.slice(0, 30).map((r, i) => {
        let id = str(r.id, 20).replace(/[^\w-]/g, '') || 'r' + token(4);
        while (seen.has(id)) id = 'r' + token(4);
        seen.add(id);
        const label = str(r.label, 120);
        if (!label) throw new HttpError(400, 'Chaque récompense doit avoir un libellé.');
        return { id, label, points: int(r.points, { min: -1000, max: 1000, def: 0 }), type: REWARD_TYPES.includes(r.type) ? r.type : 'mission' };
      })
    );
  }
  return out;
}

export function insertRole(fields) {
  const defaults = { mission: '', description: '', objectives: '', allowed_actions: '', victory: '', conditions: '', penalties: '', weight: 10, exact_count: null, max_count: null, per_team: 0, enabled: 1, wheel: '', fail_points: 0, is_impostor: 0, color: '#c8aa6e', icon: '⚔️', rewards: '[]', sort: (get('SELECT COALESCE(MAX(sort),0)+1 n FROM roles').n) };
  const f = { ...defaults, ...fields };
  const cols = Object.keys(f);
  const r = run(`INSERT INTO roles(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => f[c]));
  return Number(r.lastInsertRowid);
}
export function updateRole(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  run(`UPDATE roles SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, ...cols.map((c) => fields[c]), id);
  if (fields.name) run('UPDATE players SET role_name=? WHERE role_id=?', fields.name, id);
}

/** Vue d'un rôle destinée à un joueur : AUCUNE donnée de tirage (poids, effectifs…). */
export function roleForPlayer(r) {
  return {
    id: r.id, name: r.name, mission: r.mission, description: r.description, objectives: r.objectives,
    allowed_actions: r.allowed_actions, victory: r.victory, conditions: r.conditions, penalties: r.penalties,
    color: r.color, icon: r.icon, wheel: r.wheel, rewards: r.rewards,
  };
}

// ───────────────────────── Déroulement de la partie ─────────────────────────
export function distributeRoles(game) {
  if (!['lobby', 'distributed'].includes(game.status)) throw new HttpError(409, 'Les rôles ne peuvent plus être redistribués : réinitialisez la partie.');
  const roles = listRoles();
  return tx(() => {
    if (game.teams_enabled && get('SELECT 1 FROM players WHERE game_id=? AND team IS NULL', game.id)) balanceTeams(game.id);
    const players = all('SELECT id, team FROM players WHERE game_id=?', game.id);
    let assign;
    try { assign = distribute(players, roles); } catch (e) { throw new HttpError(422, e.message); }
    const nameOf = new Map(roles.map((r) => [r.id, r.name]));
    for (const p of players) {
      const rid = assign.get(p.id);
      run('UPDATE players SET role_id=?, role_name=?, revealed=0, revealed_at=NULL WHERE id=?', rid, nameOf.get(rid), p.id);
    }
    run('DELETE FROM wheel_spins WHERE game_id=?', game.id);
    run('DELETE FROM claims WHERE game_id=?', game.id);
    run('DELETE FROM votes WHERE game_id=?', game.id);
    run("UPDATE games SET votes_state='none', votes_applied='[]', votes_result='null' WHERE id=?", game.id);
    run("UPDATE games SET status='distributed', distributed_at=?, roles_revealed=0 WHERE id=?", Date.now(), game.id);
    return players.length;
  });
}

export function setStatus(game, status) {
  const t = Date.now();
  if (status === 'running') {
    if (game.status !== 'distributed') throw new HttpError(409, 'Distribuez d\'abord les rôles avant de lancer la partie.');
    run("UPDATE games SET status='running', started_at=? WHERE id=?", t, game.id);
  } else if (status === 'ended') {
    if (!['running', 'distributed'].includes(game.status)) throw new HttpError(409, 'La partie n\'est pas en cours.');
    run("UPDATE games SET status='ended', ended_at=? WHERE id=?", t, game.id);
  }
}

export function resetGame(game, keepScores = false) {
  tx(() => {
    run('DELETE FROM wheel_spins WHERE game_id=?', game.id);
    run('DELETE FROM claims WHERE game_id=?', game.id);
    run('DELETE FROM votes WHERE game_id=?', game.id);
    run("UPDATE games SET votes_state='none', votes_applied='[]', votes_result='null' WHERE id=?", game.id);
    if (!keepScores) run('DELETE FROM score_events WHERE game_id=?', game.id);
    run('UPDATE players SET role_id=NULL, role_name=NULL, revealed=0, revealed_at=NULL WHERE game_id=?', game.id);
    run("UPDATE games SET status='lobby', distributed_at=NULL, started_at=NULL, ended_at=NULL, roles_revealed=0 WHERE id=?", game.id);
  });
}

// ───────────────────────── Scores ─────────────────────────
export function scoreboard(gameId) {
  const rows = all(
    `SELECT p.id, p.name, p.team,
       COALESCE(SUM(CASE WHEN e.kind IN ('points','mission_success','mission_fail') THEN e.points END),0) AS points,
       COALESCE(SUM(CASE WHEN e.kind='mission_success' THEN 1 END),0) AS success,
       COALESCE(SUM(CASE WHEN e.kind='mission_fail' THEN 1 END),0) AS fail,
       COALESCE(SUM(CASE WHEN e.kind='bonus' THEN e.points END),0) AS bonus,
       COALESCE(SUM(CASE WHEN e.kind='malus' THEN e.points END),0) AS malus,
       COALESCE(SUM(e.points),0) AS total
     FROM players p LEFT JOIN score_events e ON e.player_id=p.id
     WHERE p.game_id=? GROUP BY p.id ORDER BY total DESC, success DESC, p.name COLLATE NOCASE`,
    gameId
  );
  let rank = 0, prev = null;
  rows.forEach((r, i) => {
    if (r.total !== prev) { rank = i + 1; prev = r.total; }
    r.rank = rank;
  });
  return rows;
}

export function teamTotals(rows) {
  const t = [0, 0];
  for (const r of rows) if (r.team === 0 || r.team === 1) t[r.team] += r.total;
  return t;
}

export function addScore(game, playerId, kind, points, comment = '', actor = 'hôte') {
  if (!SCORE_KINDS.includes(kind)) throw new HttpError(400, 'Type de points inconnu.');
  if (!get('SELECT 1 FROM players WHERE id=? AND game_id=?', playerId, game.id)) throw new HttpError(404, 'Joueur introuvable.');
  let pts = int(points, { min: -100000, max: 100000, def: null });
  if (pts === null) throw new HttpError(400, 'Nombre de points invalide.');
  if (kind === 'bonus' || kind === 'mission_success') pts = Math.abs(pts);
  if (kind === 'malus' || kind === 'mission_fail') pts = -Math.abs(pts);
  run('INSERT INTO score_events(game_id,player_id,kind,points,comment,actor,created_at) VALUES(?,?,?,?,?,?,?)', game.id, playerId, kind, pts, str(comment, 300), actor, Date.now());
  return pts;
}

// ───────────────────────── Vote de fin de partie ─────────────────────────
export const DEFAULT_VOTE_RULES = { find_impostor: 4, find_role: 2, wrong: 1, impostor_gain: 2, false_accusation: 2, impostor_mode: 'per_vote' };

export function voteRules() {
  let saved = {};
  try { saved = JSON.parse(getSetting('vote_rules', '{}')) || {}; } catch { /* ignoré */ }
  return { ...DEFAULT_VOTE_RULES, ...saved };
}

export function cleanVoteRules(input) {
  const cur = voteRules();
  const out = { ...cur };
  for (const k of ['find_impostor', 'find_role', 'wrong', 'impostor_gain', 'false_accusation']) {
    if (Object.prototype.hasOwnProperty.call(input, k)) {
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, 'Les points doivent être un nombre entier entre 0 et 1000.');
      out[k] = n;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'impostor_mode')) {
    if (!['per_vote', 'once'].includes(input.impostor_mode)) throw new HttpError(400, 'Mode invalide.');
    out.impostor_mode = input.impostor_mode;
  }
  return out;
}

/** Joueurs sur lesquels `player` peut voter : ses coéquipiers (ou tous les autres joueurs sans équipes). */
export function voteTargets(game, player) {
  const others = all('SELECT id, name, team FROM players WHERE game_id=? AND id<>? ORDER BY id', game.id, player.id);
  return game.teams_enabled && player.team !== null ? others.filter((p) => p.team === player.team) : others;
}

export function openVotes(game) {
  if (!['running', 'ended'].includes(game.status)) throw new HttpError(409, 'Le vote s\'ouvre pendant ou après la partie.');
  if (game.votes_state === 'open') return;
  if (game.votes_state === 'closed') throw new HttpError(409, 'Le vote est clôturé : rouvrez-le pour annuler les points et modifier les votes.');
  if (!get('SELECT 1 FROM players WHERE game_id=? AND role_id IS NOT NULL', game.id)) throw new HttpError(409, 'Aucun rôle n\'a été distribué.');
  run("UPDATE games SET votes_state='open' WHERE id=?", game.id);
}

/** Enregistre (remplace) les votes d'un joueur. role_id vide = abstention : aucun point gagné ni perdu. */
export function submitVotes(game, player, votes) {
  if (game.votes_state !== 'open') throw new HttpError(409, 'Le vote n\'est pas ouvert.');
  if (!Array.isArray(votes)) throw new HttpError(400, 'Votes invalides.');
  const targets = new Map(voteTargets(game, player).map((t) => [t.id, t]));
  const roleIds = new Set(all('SELECT id FROM roles').map((r) => r.id));
  const clean = new Map();
  for (const v of votes.slice(0, 200)) {
    const tid = Number(v && v.target_id);
    if (!targets.has(tid)) throw new HttpError(400, 'Ce joueur ne fait pas partie de ceux sur lesquels vous pouvez voter.');
    const rid = v.role_id === null || v.role_id === undefined || v.role_id === '' ? null : Number(v.role_id);
    if (rid !== null && !roleIds.has(rid)) throw new HttpError(400, 'Rôle inconnu.');
    clean.set(tid, rid);
  }
  tx(() => {
    for (const [tid, rid] of clean) {
      run('DELETE FROM votes WHERE voter_id=? AND target_id=?', player.id, tid);
      if (rid !== null) run('INSERT INTO votes(game_id,voter_id,target_id,role_id,created_at) VALUES(?,?,?,?,?)', game.id, player.id, tid, rid, Date.now());
    }
  });
  return clean.size;
}

/** Calcule (sans rien écrire) les points du vote selon les règles. */
export function computeVoteOutcome(game, rules = voteRules()) {
  const players = new Map(all('SELECT id, name, team, role_id FROM players WHERE game_id=?', game.id).map((p) => [p.id, p]));
  const roles = new Map(all('SELECT id, name, is_impostor FROM roles').map((r) => [r.id, r]));
  const votes = all('SELECT voter_id, target_id, role_id FROM votes WHERE game_id=? ORDER BY voter_id, target_id', game.id);
  const impostorsOfTeam = (voter, excludeIds) => [...players.values()].filter((p) =>
    p.id !== voter.id && !excludeIds.includes(p.id) && roles.get(p.role_id)?.is_impostor
    && (!game.teams_enabled || voter.team === null || p.team === voter.team));
  const rows = [];
  let gains = [];
  for (const v of votes) {
    const voter = players.get(v.voter_id), target = players.get(v.target_id);
    const actual = target && roles.get(target.role_id), guessed = roles.get(v.role_id);
    if (!voter || !target || !actual || !guessed) continue; // joueur supprimé ou rôle non distribué
    const correct = target.role_id === v.role_id;
    const imp = !!actual.is_impostor;
    const points = correct ? (imp ? rules.find_impostor : rules.find_role) : -rules.wrong;
    rows.push({ voter_id: voter.id, target_id: target.id, role_id: v.role_id, correct, impostor: imp, points });
    // Seul le vrai imposteur gagne un bonus, et seulement quand on se trompe à SON sujet.
    // Un innocent désigné à tort comme imposteur perd des points ; l'imposteur ne gagne rien dans ce cas.
    if (!correct && imp) gains.push({ player_id: target.id, points: rules.impostor_gain, voter_id: voter.id, target_id: target.id });
    else if (!correct && guessed.is_impostor && !imp) gains.push({ player_id: target.id, points: -rules.false_accusation, voter_id: voter.id, target_id: target.id });
  }
  if (rules.impostor_mode === 'once') {
    const seen = new Set();
    gains = gains.filter((g) => g.points < 0 || (seen.has(g.player_id) ? false : (seen.add(g.player_id), true)));
  }
  return { rows, gains };
}

/** Clôture le vote : calcule les points et les ajoute au classement (annulable avec reopenVotes). */
export function closeVotes(game) {
  if (game.votes_state !== 'open') throw new HttpError(409, 'Le vote n\'est pas ouvert.');
  const rules = voteRules();
  const out = computeVoteOutcome(game, rules);
  const names = new Map(all('SELECT id, name FROM players WHERE game_id=?', game.id).map((p) => [p.id, p.name]));
  const ids = [];
  const addEvent = (playerId, points, comment) => {
    if (!points) return;
    const r = run('INSERT INTO score_events(game_id,player_id,kind,points,comment,actor,created_at) VALUES(?,?,?,?,?,?,?)',
      game.id, playerId, points > 0 ? 'points' : 'malus', points, str(comment, 300), 'vote', Date.now());
    ids.push(Number(r.lastInsertRowid));
  };
  tx(() => {
    for (const r of out.rows) {
      const t = names.get(r.target_id);
      addEvent(r.voter_id, r.points, r.correct ? (r.impostor ? `Vote : a démasqué l'imposteur (${t})` : `Vote : a trouvé le rôle de ${t}`) : `Vote : s'est trompé sur ${t}`);
    }
    for (const g of out.gains) addEvent(g.player_id, g.points, g.points > 0 ? `Vote : ${names.get(g.voter_id)} s'est trompé sur l'imposteur` : `Vote : accusé à tort d'être l'imposteur par ${names.get(g.voter_id)}`);
    run("UPDATE games SET votes_state='closed', votes_applied=?, votes_result=? WHERE id=?", JSON.stringify(ids), JSON.stringify(out), game.id);
  });
  return { votes: out.rows.length, events: ids.length };
}

/** Annule les points du vote clôturé et rouvre le vote (les votes sont conservés et modifiables). */
export function reopenVotes(game) {
  if (game.votes_state !== 'closed') throw new HttpError(409, 'Le vote n\'est pas clôturé.');
  let ids = [];
  try { ids = JSON.parse(game.votes_applied || '[]'); } catch { /* ignoré */ }
  tx(() => {
    for (const id of ids) run('DELETE FROM score_events WHERE id=? AND game_id=?', Number(id), game.id);
    run("UPDATE games SET votes_state='open', votes_applied='[]', votes_result='null' WHERE id=?", game.id);
  });
}

/** Ce que voit UN joueur : ses cibles, ses votes, et ses résultats après la clôture. Jamais les rôles réels avant la fin. */
export function voteView(game, player) {
  if (!game.votes_state || game.votes_state === 'none') return { state: 'none' };
  const roles = all('SELECT id, name, icon, color FROM roles ORDER BY sort, id');
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const targets = voteTargets(game, player).map((t) => ({ id: t.id, name: t.name }));
  const mine = {};
  for (const v of all('SELECT target_id, role_id FROM votes WHERE voter_id=?', player.id)) mine[v.target_id] = v.role_id;
  const rules = voteRules();
  const out = { state: game.votes_state, targets, roles, mine, rules: { find_impostor: rules.find_impostor, find_role: rules.find_role, wrong: rules.wrong, impostor_gain: rules.impostor_gain, false_accusation: rules.false_accusation } };
  if (game.votes_state === 'closed') {
    let res = null;
    try { res = JSON.parse(game.votes_result); } catch { /* ignoré */ }
    if (res) {
      const names = new Map(targets.map((t) => [t.id, t.name]));
      const actual = new Map(all('SELECT id, role_name FROM players WHERE game_id=?', game.id).map((p) => [p.id, p.role_name]));
      out.results = res.rows.filter((r) => r.voter_id === player.id).map((r) => ({
        target: names.get(r.target_id) || '?', guess: roleName.get(r.role_id) || '?', correct: r.correct, points: r.points,
        ...(game.roles_revealed ? { actual: actual.get(r.target_id) } : {}),
      }));
      out.as_impostor = res.gains.filter((g) => g.player_id === player.id).reduce((s, g) => s + g.points, 0);
    }
  }
  return out;
}

/** Vue hôte : participation, votes détaillés avec les vrais rôles, et points prévus / appliqués. */
export function voteHostView(game) {
  const rules = voteRules();
  const base = { state: game.votes_state || 'none', rules };
  if (base.state === 'none') return base;
  const players = new Map(all('SELECT id, name, role_name FROM players WHERE game_id=?', game.id).map((p) => [p.id, p]));
  const roleName = new Map(all('SELECT id, name FROM roles').map((r) => [r.id, r.name]));
  const out = computeVoteOutcome(game, rules);
  return {
    ...base,
    voters: new Set(all('SELECT voter_id FROM votes WHERE game_id=?', game.id).map((v) => v.voter_id)).size,
    total: players.size,
    rows: out.rows.map((r) => ({ voter: players.get(r.voter_id)?.name, target: players.get(r.target_id)?.name, guess: roleName.get(r.role_id), actual: players.get(r.target_id)?.role_name, correct: r.correct, points: r.points })),
    gains: out.gains.map((g) => ({ player: players.get(g.player_id)?.name, points: g.points, because: `${players.get(g.voter_id)?.name} → ${players.get(g.target_id)?.name}` })),
  };
}

// ───────────────────────── Roues ─────────────────────────
export function wheelConfig(gameId, wheel) {
  if (!WHEELS[wheel]) return null;
  // Une roue créée en cours de route n'a pas encore de réglages pour cette partie : on les crée à la volée.
  run('INSERT OR IGNORE INTO wheel_config(game_id, wheel) VALUES(?,?)', gameId, wheel);
  const c = get('SELECT * FROM wheel_config WHERE game_id=? AND wheel=?', gameId, wheel);
  if (!c) return null;
  let excluded = [];
  try { excluded = JSON.parse(c.excluded); } catch { /* ignoré */ }
  return { ...c, excluded };
}

/** Joueurs que cette roue peut désigner pour ce joueur (ordre stable par id). */
export function wheelCandidates(game, cfg, player) {
  let list = all('SELECT id, name, team FROM players WHERE game_id=? ORDER BY id', game.id).filter((p) => p.id !== player.id && !cfg.excluded.includes(p.id));
  if (game.teams_enabled && player.team !== null) {
    if (cfg.rule === 'opponents') list = list.filter((p) => p.team !== null && p.team !== player.team);
    else if (cfg.rule === 'teammates') list = list.filter((p) => p.team === player.team);
  }
  return list;
}

export function createWheel(label) {
  const name = str(label, 40);
  if (!name) throw new HttpError(400, 'Donnez un nom à la roue.');
  if (Object.keys(WHEELS).length >= 30) throw new HttpError(409, 'Nombre maximum de roues atteint (30).');
  if (Object.values(WHEELS).some((l) => l.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Une roue porte déjà ce nom.');
  const key = 'w' + token(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  const sort = (get('SELECT COALESCE(MAX(sort),0) m FROM wheel_defs').m || 0) + 1;
  run('INSERT INTO wheel_defs(key,label,sort) VALUES(?,?,?)', key, name, sort);
  reloadWheels();
  return { key, label: name };
}

export function renameWheel(key, label) {
  const name = str(label, 40);
  if (!WHEELS[key]) throw new HttpError(404, 'Roue inconnue.');
  if (!name) throw new HttpError(400, 'Le nom ne peut pas être vide.');
  if (Object.entries(WHEELS).some(([k, l]) => k !== key && l.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Une roue porte déjà ce nom.');
  run('UPDATE wheel_defs SET label=? WHERE key=?', name, key);
  reloadWheels();
}

/** Supprime la roue, ses réglages et ses tirages ; les rôles qui l'utilisaient n'ont plus de roue. */
export function deleteWheel(key) {
  if (!WHEELS[key]) throw new HttpError(404, 'Roue inconnue.');
  const roles = all('SELECT id, name FROM roles WHERE wheel=?', key);
  tx(() => {
    run("UPDATE roles SET wheel='' WHERE wheel=?", key);
    run('DELETE FROM wheel_spins WHERE wheel=?', key);
    run('DELETE FROM wheel_config WHERE wheel=?', key);
    run('DELETE FROM wheel_defs WHERE key=?', key);
  });
  reloadWheels();
  return roles;
}

export function spinWheel(player) {
  const game = get('SELECT * FROM games WHERE id=?', player.game_id);
  if (game.status !== 'running') throw new HttpError(409, 'La partie n\'est pas en cours.');
  if (!player.revealed) throw new HttpError(409, 'Révélez d\'abord votre rôle.');
  const role = player.role_id ? getRole(player.role_id) : null;
  if (!role || !role.wheel) throw new HttpError(403, 'Votre rôle n\'a pas de roue.');
  const cfg = wheelConfig(game.id, role.wheel);
  if (!cfg || !cfg.enabled) throw new HttpError(409, 'Cette roue est désactivée par l\'hôte.');
  return tx(() => {
    const used = get('SELECT COUNT(*) c FROM wheel_spins WHERE game_id=? AND wheel=? AND player_id=?', game.id, role.wheel, player.id).c;
    if (used >= cfg.max_spins) throw new HttpError(409, 'Vous avez déjà utilisé votre roue.');
    const candidates = wheelCandidates(game, cfg, player);
    if (!candidates.length) throw new HttpError(409, 'Aucun joueur éligible pour cette roue.');
    const index = randomInt(candidates.length);
    const target = candidates[index];
    run('INSERT INTO wheel_spins(game_id,wheel,player_id,target_id,created_at) VALUES(?,?,?,?,?)', game.id, role.wheel, player.id, target.id, Date.now());
    return { candidates: candidates.map((c) => ({ id: c.id, name: c.name })), index, target: { id: target.id, name: target.name } };
  });
}

// ───────────────────────── Missions (demandes de validation) ─────────────────────────
export function createClaim(player, rewardId) {
  const game = get('SELECT * FROM games WHERE id=?', player.game_id);
  if (game.status !== 'running') throw new HttpError(409, 'La partie n\'est pas en cours.');
  if (!player.revealed || !player.role_id) throw new HttpError(409, 'Révélez d\'abord votre rôle.');
  const role = getRole(player.role_id);
  const rw = role?.rewards.find((r) => r.id === rewardId);
  if (!rw || rw.type === 'penalty') throw new HttpError(400, 'Mission inconnue.');
  if (get("SELECT 1 FROM claims WHERE player_id=? AND reward_id=? AND status='pending'", player.id, rw.id))
    throw new HttpError(409, 'Cette mission est déjà en attente de validation.');
  const r = run('INSERT INTO claims(game_id,player_id,reward_id,label,type,points,created_at) VALUES(?,?,?,?,?,?,?)', game.id, player.id, rw.id, rw.label, rw.type, rw.points, Date.now());
  return Number(r.lastInsertRowid);
}

export function resolveClaim(game, claimId, approve) {
  return tx(() => {
    const c = get("SELECT * FROM claims WHERE id=? AND game_id=? AND status='pending'", claimId, game.id);
    if (!c) throw new HttpError(404, 'Demande introuvable ou déjà traitée.');
    if (approve) {
      const kind = c.type === 'bonus' ? 'bonus' : c.type === 'penalty' ? 'malus' : 'mission_success';
      addScore(game, c.player_id, kind, c.points, `Mission validée : ${c.label}`);
    }
    run('UPDATE claims SET status=?, resolved_at=? WHERE id=?', approve ? 'approved' : 'rejected', Date.now(), c.id);
    return c;
  });
}

// ───────────────────────── Vues API ─────────────────────────
export function publicGame(g) {
  return {
    id: g.id, name: g.name, status: g.status, team_a: g.team_a, team_b: g.team_b, teams_enabled: !!g.teams_enabled,
    roles_revealed: !!g.roles_revealed, votes_state: g.votes_state || 'none', created_at: g.created_at, started_at: g.started_at, ended_at: g.ended_at,
  };
}

/** État public : aucune information de rôle (sauf si l'hôte a choisi de les révéler après la fin). */
export function publicState(game) {
  const ranking = scoreboard(game.id);
  const showRoles = game.status === 'ended' && game.roles_revealed;
  const roleNames = showRoles ? new Map(all('SELECT id, role_name FROM players WHERE game_id=?', game.id).map((p) => [p.id, p.role_name])) : null;
  return {
    game: publicGame(game),
    players: all('SELECT id, name, team FROM players WHERE game_id=? ORDER BY id', game.id).map((p) => ({ ...p, ...(showRoles ? { role_name: roleNames.get(p.id) } : {}) })),
    ranking,
    team_totals: teamTotals(ranking),
  };
}

export function playerView(player) {
  const game = get('SELECT * FROM games WHERE id=?', player.game_id);
  const base = publicState(game);
  const me = base.ranking.find((r) => r.id === player.id);
  const distributed = game.status !== 'lobby' && !!player.role_id;
  const roleRow = player.role_id ? getRole(player.role_id) : null;
  const role = player.revealed && roleRow ? roleForPlayer(roleRow) : null;

  let wheel = null;
  const teamResults = [];
  if (role && role.wheel) {
    const cfg = wheelConfig(game.id, role.wheel);
    if (cfg) {
      const spins = all('SELECT s.id, s.target_id, s.created_at, p.name AS target_name FROM wheel_spins s JOIN players p ON p.id=s.target_id WHERE s.game_id=? AND s.wheel=? AND s.player_id=? ORDER BY s.id', game.id, role.wheel, player.id);
      const candidates = wheelCandidates(game, cfg, player).map((c) => ({ id: c.id, name: c.name }));
      wheel = {
        key: role.wheel, label: WHEELS[role.wheel], enabled: !!cfg.enabled, max_spins: cfg.max_spins,
        candidates, spins: spins.map((s) => ({ id: s.id, target: s.target_name })),
        can_spin: game.status === 'running' && !!cfg.enabled && spins.length < cfg.max_spins && candidates.length > 0,
      };
    }
  }
  if (player.team !== null) {
    for (const w of Object.keys(WHEELS)) {
      const cfg = wheelConfig(game.id, w);
      if (!cfg || !cfg.share_team) continue;
      for (const s of all('SELECT s.player_id, pp.name AS by_name, tp.name AS target_name FROM wheel_spins s JOIN players pp ON pp.id=s.player_id JOIN players tp ON tp.id=s.target_id WHERE s.game_id=? AND s.wheel=? AND pp.team=? AND s.player_id<>? ORDER BY s.id', game.id, w, player.team, player.id))
        teamResults.push({ wheel: WHEELS[w], by: s.by_name, target: s.target_name });
    }
  }
  return {
    player: { id: player.id, name: player.name, team: player.team, revealed: !!player.revealed, distributed },
    game: base.game,
    players: base.players,
    ranking: base.ranking,
    team_totals: base.team_totals,
    me,
    role,
    wheel,
    team_results: teamResults,
    vote: voteView(game, player),
    claims: all('SELECT id, reward_id, label, type, points, status, created_at FROM claims WHERE player_id=? ORDER BY id DESC LIMIT 30', player.id),
    events: all('SELECT id, kind, points, comment, created_at FROM score_events WHERE player_id=? ORDER BY id DESC LIMIT 50', player.id),
  };
}

export function hostState(game) {
  const roles = listRoles();
  const probs = probabilities(roles);
  const players = all('SELECT id, name, team, token, code, role_id, role_name, revealed FROM players WHERE game_id=? ORDER BY id', game.id);
  const names = new Map(players.map((p) => [p.id, p.name]));
  const ranking = scoreboard(game.id);
  const wheels = {};
  for (const w of Object.keys(WHEELS)) wheels[w] = { label: WHEELS[w], ...wheelConfig(game.id, w) };
  return {
    game: publicGame(game),
    games: all('SELECT id, name, status, created_at, ended_at, (SELECT COUNT(*) FROM players WHERE game_id=games.id) AS players FROM games ORDER BY id DESC'),
    current_game: game.id,
    players,
    roles: roles.map((r) => ({ ...r, probability: probs[r.id] })),
    wheels,
    spins: all('SELECT id, wheel, player_id, target_id, created_at FROM wheel_spins WHERE game_id=? ORDER BY id DESC', game.id).map((s) => ({ ...s, player: names.get(s.player_id), target: names.get(s.target_id) })),
    claims: all("SELECT c.*, p.name AS player FROM claims c JOIN players p ON p.id=c.player_id WHERE c.game_id=? ORDER BY (c.status='pending') DESC, c.id DESC LIMIT 100", game.id),
    ranking,
    team_totals: teamTotals(ranking),
    votes: voteHostView(game),
    events: all('SELECT e.*, p.name AS player FROM score_events e JOIN players p ON p.id=e.player_id WHERE e.game_id=? ORDER BY e.id DESC LIMIT 200', game.id),
  };
}

export const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise l'injection de formules
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function rankingCsv(game) {
  const team = (t) => (t === 0 ? game.team_a : t === 1 ? game.team_b : '');
  const lines = [['Rang', 'Joueur', 'Équipe', 'Points', 'Missions réussies', 'Missions échouées', 'Bonus', 'Malus', 'Total'].join(';')];
  for (const r of scoreboard(game.id)) lines.push([r.rank, r.name, team(r.team), r.points, r.success, r.fail, r.bonus, r.malus, r.total].map(csvCell).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
