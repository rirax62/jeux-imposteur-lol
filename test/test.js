// Test d'intégration : lance un serveur sur une base temporaire et vérifie les parcours clés.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { distribute, probabilities } from '../server/draw.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolroles-'));
const PORT = 4100 + Math.floor(Math.random() * 500);
const base = `http://localhost:${PORT}`;
let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };

// ── Tests unitaires de l'algorithme ──
{
  const roles = [
    { id: 1, name: 'A', enabled: 1, weight: 0, exact_count: 1, per_team: 1, max_count: null },
    { id: 2, name: 'B', enabled: 1, weight: 30, exact_count: null, max_count: 2, per_team: 0 },
    { id: 3, name: 'C', enabled: 1, weight: 70, exact_count: null, max_count: null, per_team: 0 },
    { id: 4, name: 'Off', enabled: 0, weight: 999, exact_count: null, max_count: null, per_team: 0 },
  ];
  const players = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, team: i % 2 }));
  for (let k = 0; k < 300; k++) {
    const a = distribute(players, roles);
    const by = (rid, t) => players.filter((p) => a.get(p.id) === rid && (t === undefined || p.team === t)).length;
    assert.equal(by(1, 0), 1); assert.equal(by(1, 1), 1);       // 1 « A » par équipe exactement
    assert.ok(by(2) <= 2);                                       // plafond respecté
    assert.equal(by(4), 0);                                      // rôle désactivé jamais tiré
    assert.equal(a.size, 10);
  }
  ok('distribution : effectifs exacts par équipe, plafonds, rôles désactivés');
  const pr = probabilities(roles);
  assert.ok(Math.abs(pr[2] - 0.3) < 1e-9 && Math.abs(pr[3] - 0.7) < 1e-9 && pr[1] === 0 && pr[4] === 0);
  ok('probabilités recalculées automatiquement');
  // Fréquence statistique ≈ 30/70 (sans plafond)
  const r2 = [{ ...roles[1], max_count: null }, roles[2]];
  let b = 0, tot = 0;
  for (let k = 0; k < 2000; k++) { const a = distribute(players, r2); for (const v of a.values()) { tot++; if (v === 2) b++; } }
  assert.ok(Math.abs(b / tot - 0.3) < 0.03, `fréquence B = ${b / tot}`);
  ok('distribution pondérée : fréquence observée ≈ poids');
  assert.throws(() => distribute(players.slice(0, 1), [{ ...roles[0], per_team: 0, exact_count: 2 }]), /Pas assez de joueurs/);
  ok('erreur claire si pas assez de joueurs');
}

const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server/index.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => String(d).includes('http://') && res()); srv.on('exit', rej); setTimeout(() => rej(new Error('démarrage trop long')), 8000); });

let cookie = '';
async function api(method, url, { body, host, player, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (host && cookie) headers.Cookie = cookie;
  if (player) headers['X-Player-Token'] = player;
  const r = await fetch(base + url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j) ? j : { status: r.status, ...j };
}

try {
  // Sécurité d'accès
  assert.equal((await api('GET', '/api/host/state')).status, 401);
  ok('API hôte refusée sans connexion');
  assert.equal((await api('POST', '/api/host/setup', { body: { password: 'court' } })).status, 400);
  assert.equal((await api('POST', '/api/host/setup', { body: { password: 'motdepasse-solide' } })).status, 200);
  assert.equal((await api('POST', '/api/host/setup', { body: { password: 'autre-mot-de-passe' } })).status, 409);
  assert.equal((await api('GET', '/api/host/state', { host: true })).status, 200);
  ok('création du mot de passe hôte (une seule fois) + session');
  const csrf = await fetch(base + '/api/host/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(csrf.status, 415);
  ok('requêtes non-JSON refusées (anti-CSRF)');

  // Joueurs
  let st = (await api('GET', '/api/host/state', { host: true }));
  assert.equal(st.game.status, 'lobby');
  await api('POST', '/api/host/players/count', { host: true, body: { n: 8 } });
  const dup = await api('POST', '/api/host/players', { host: true, body: { name: 'joueur 1' } });
  assert.equal(dup.status, 409);
  await api('PATCH', `/api/host/players/${(await api('GET', '/api/host/state', { host: true })).players[0].id}`, { host: true, body: { name: 'Faker' } });
  ok('gestion des joueurs (nombre, doublons, renommage)');

  // Distribution
  const d = await api('POST', '/api/host/game/distribute', { host: true });
  assert.equal(d.status, 200);
  st = await api('GET', '/api/host/state', { host: true });
  assert.ok(st.players.every((p) => p.role_id), 'tous les joueurs ont un rôle');
  const teamCount = (t, name) => st.players.filter((p) => p.team === t && p.role_name === name).length;
  assert.equal(teamCount(0, 'Garde du corps'), 1); assert.equal(teamCount(1, 'Garde du corps'), 1);
  assert.equal(teamCount(0, 'Obsédé'), 1); assert.equal(teamCount(1, 'Obsédé'), 1);
  ok('distribution serveur : 1 Garde du corps + 1 Obsédé par équipe');

  // Confidentialité
  const pub = await api('GET', '/api/public/state');
  const pubStr = JSON.stringify(pub).replace(/"roles_revealed":(true|false)/g, '');
  assert.ok(!/role/i.test(pubStr), 'aucun champ « rôle » dans l\'état public');
  for (const p of st.players) assert.ok(!pubStr.includes(p.token) && !pubStr.includes(p.code), 'jetons absents du public');
  ok('état public : aucun rôle, aucun jeton');

  const bg = st.players.find((p) => p.role_name === 'Garde du corps' && p.team === 0);
  let me = await api('GET', '/api/me', { player: bg.token });
  assert.equal(me.role, null);
  assert.ok(!/Garde du corps/.test(JSON.stringify(me)), 'rôle absent avant révélation');
  ok('le rôle n\'est PAS envoyé au client avant « Révéler mon rôle »');
  assert.equal((await api('GET', '/api/me', { player: 'jeton-bidon-invalide' })).status, 401);
  assert.equal((await api('GET', '/api/me')).status, 401);
  ok('API joueur refusée sans jeton valide');

  me = await api('POST', '/api/me/reveal', { player: bg.token });
  assert.equal(me.role.name, 'Garde du corps');
  assert.ok(!('weight' in me.role) && !('exact_count' in me.role) && !('max_count' in me.role) && !('per_team' in me.role));
  assert.ok(!/weight|probab|exact_count/.test(JSON.stringify(me)));
  ok('après révélation : seulement SON rôle, sans statistiques de pioche');

  // Un autre joueur ne voit pas ce rôle
  const other = st.players.find((p) => p.id !== bg.id && p.role_name !== 'Garde du corps');
  const meO = await api('POST', '/api/me/reveal', { player: other.token });
  assert.notEqual(meO.role.name, 'Garde du corps');
  assert.ok(!JSON.stringify(meO).includes(bg.token));
  ok('un joueur ne peut pas lire le rôle d\'un autre');

  // Connexion par code
  const j = await api('POST', '/api/join', { body: { code: bg.code.slice(0, 4) + '-' + bg.code.slice(4).toLowerCase() } });
  assert.equal(j.token, bg.token);
  const j2 = await api('POST', '/api/join', { body: { code: `${base}/j/${bg.token}` } });
  assert.equal(j2.token, bg.token);
  assert.equal((await api('POST', '/api/join', { body: { code: 'ZZZZ-ZZZZ' } })).status, 404);
  ok('connexion par code individuel ou par lien personnel');

  // Roue (partie non lancée)
  assert.equal((await api('POST', '/api/me/wheel/spin', { player: bg.token })).status, 409);
  await api('POST', '/api/host/game/start', { host: true });
  me = await api('GET', '/api/me', { player: bg.token });
  assert.equal(me.wheel.key, 'bodyguard');
  const oppIds = st.players.filter((p) => p.team === bg.team && p.id !== bg.id).map((p) => p.id); // Garde du corps : coéquipiers
  assert.deepEqual(me.wheel.candidates.map((c) => c.id).sort(), oppIds.sort());
  assert.ok(!me.wheel.candidates.some((c) => c.id === bg.id));
  ok('roue du Garde du corps : uniquement les coéquipiers éligibles');
  const spin = await api('POST', '/api/me/wheel/spin', { player: bg.token });
  assert.equal(spin.status, 200);
  assert.ok(oppIds.includes(spin.target.id));
  assert.equal(spin.candidates[spin.index].id, spin.target.id);
  assert.equal((await api('POST', '/api/me/wheel/spin', { player: bg.token })).status, 409);
  ok('roue : tirage serveur, résultat cohérent, un seul lancer');
  // Résultat invisible pour les autres, visible pour l'hôte
  const meO2 = await api('GET', '/api/me', { player: other.token });
  assert.ok(!JSON.stringify(meO2).includes(`"target":"${spin.target.name}"`) || meO2.wheel === null);
  st = await api('GET', '/api/host/state', { host: true });
  assert.equal(st.spins.length, 1);
  ok('résultat de roue visible par le joueur et l\'hôte uniquement');
  // Exclusion + reset
  await api('PUT', '/api/host/wheels/bodyguard', { host: true, body: { excluded: [spin.target.id], max_spins: 2 } });
  await api('POST', '/api/host/wheels/bodyguard/reset', { host: true, body: {} });
  me = await api('GET', '/api/me', { player: bg.token });
  assert.ok(!me.wheel.candidates.some((c) => c.id === spin.target.id));
  assert.equal(me.wheel.spins.length, 0);
  ok('hôte : exclusion de cibles et réinitialisation de roue');

  // Roues personnalisées : créer / renommer / associer à un rôle / supprimer
  assert.equal((await api('POST', '/api/host/wheels', { body: { label: 'Espion' } })).status, 401);
  const nw = await api('POST', '/api/host/wheels', { host: true, body: { label: 'Espion' } });
  assert.ok(nw.key && nw.label === 'Espion');
  assert.equal((await api('POST', '/api/host/wheels', { host: true, body: { label: 'espion' } })).status, 409);
  assert.equal((await api('POST', '/api/host/wheels', { host: true, body: { label: '  ' } })).status, 400);
  let hs = await api('GET', '/api/host/state', { host: true });
  assert.equal(hs.wheels[nw.key].label, 'Espion');
  assert.equal(hs.wheels[nw.key].enabled, 1);
  const roleId = hs.roles.find((r) => !r.wheel).id;
  assert.equal((await api('PUT', '/api/host/roles/' + roleId, { host: true, body: { wheel: nw.key } })).status, 200);
  await api('PUT', '/api/host/wheels/' + nw.key, { host: true, body: { label: 'Espionne', max_spins: 3 } });
  hs = await api('GET', '/api/host/state', { host: true });
  assert.equal(hs.wheels[nw.key].label, 'Espionne');
  assert.equal(hs.wheels[nw.key].max_spins, 3);
  assert.equal(hs.roles.find((r) => r.id === roleId).wheel, nw.key);
  assert.equal((await api('PUT', '/api/host/roles/' + roleId, { host: true, body: { wheel: 'inconnue' } })).status, 400);
  const del = await api('DELETE', '/api/host/wheels/' + nw.key, { host: true });
  assert.equal(del.detached, 1);
  hs = await api('GET', '/api/host/state', { host: true });
  assert.ok(!hs.wheels[nw.key]);
  assert.equal(hs.roles.find((r) => r.id === roleId).wheel, '');
  assert.equal((await api('PUT', '/api/host/wheels/' + nw.key, { host: true, body: { enabled: false } })).status, 404);
  assert.ok(hs.wheels.bodyguard && hs.wheels.observer);
  ok('roues personnalisées : création, renommage, association à un rôle, suppression');

  // Missions / scores
  const reward = me.role.rewards.find((r) => r.type === 'mission');
  const cl = await api('POST', '/api/me/claims', { player: bg.token, body: { reward_id: reward.id } });
  assert.equal(cl.status, 200);
  assert.equal((await api('POST', '/api/me/claims', { player: bg.token, body: { reward_id: reward.id } })).status, 409);
  st = await api('GET', '/api/host/state', { host: true });
  const claim = st.claims.find((c) => c.status === 'pending');
  await api('POST', `/api/host/claims/${claim.id}/approve`, { host: true });
  let row = (await api('GET', '/api/public/state')).ranking.find((r) => r.id === bg.id);
  assert.equal(row.total, reward.points); assert.equal(row.success, 1);
  ok('« Valider une mission » → validation hôte → score mis à jour');
  await api('POST', '/api/host/score', { host: true, body: { player_id: bg.id, kind: 'bonus', points: 3, comment: 'test' } });
  await api('POST', '/api/host/score', { host: true, body: { player_id: bg.id, kind: 'malus', points: 2 } });
  await api('POST', '/api/host/score', { host: true, body: { player_id: bg.id, kind: 'mission_fail', points: 1 } });
  row = (await api('GET', '/api/public/state')).ranking.find((r) => r.id === bg.id);
  assert.equal(row.bonus, 3); assert.equal(row.malus, -2); assert.equal(row.fail, 1); assert.equal(row.total, reward.points + 3 - 2 - 1);
  await api('POST', '/api/host/score/set-total', { host: true, body: { player_id: bg.id, total: 42 } });
  row = (await api('GET', '/api/public/state')).ranking.find((r) => r.id === bg.id);
  assert.equal(row.total, 42); assert.equal(row.rank, 1);
  ok('points, bonus, malus, échec, modification directe du total');
  const csv = await (await api('GET', '/api/host/export.csv', { host: true, raw: true })).text();
  assert.ok(csv.includes('Rang;Joueur') && csv.includes('42'));
  ok('export CSV du classement');

  // Temps réel (SSE)
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/events?scope=public`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  let got = '';
  const waiter = (async () => { while (!got.includes('event: scores')) { const { value, done } = await reader.read(); if (done) break; got += new TextDecoder().decode(value); } })();
  await new Promise((r) => setTimeout(r, 200));
  await api('POST', '/api/host/score', { host: true, body: { player_id: bg.id, kind: 'points', points: 1 } });
  await Promise.race([waiter, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE: aucun événement reçu')), 3000))]);
  ctrl.abort();
  assert.ok(!got.replace('hello','').includes('role'));
  ok('synchronisation temps réel (SSE) des scores');
  assert.equal((await fetch(`${base}/api/events?scope=host`)).status, 401);
  ok('flux temps réel hôte protégé');

  // Fin, historique, réinitialisation
  await api('POST', '/api/host/game/end', { host: true });
  const hist = await api('GET', '/api/public/history');
  assert.ok(Array.isArray(hist) || hist.length === undefined);
  await api('POST', '/api/host/game/reveal-roles', { host: true, body: { value: true } });
  assert.ok(JSON.stringify(await api('GET', '/api/public/state')).includes('role_name'));
  await api('POST', '/api/host/game/reveal-roles', { host: true, body: { value: false } });
  const g1 = st.game.id;
  const ng = await api('POST', '/api/host/games', { host: true, body: { name: 'Partie 2', copy_players: true } });
  st = await api('GET', '/api/host/state', { host: true });
  assert.equal(st.players.length, 8); assert.equal(st.game.status, 'lobby'); assert.notEqual(st.game.id, g1);
  assert.ok(st.players.every((p) => !p.role_id && p.token !== bg.token));
  const hist2 = await api('GET', '/api/public/history');
  assert.equal(hist2.length, 1);
  assert.ok(!/role/i.test(JSON.stringify(hist2).replace(/"roles_revealed":(true|false)/g, '')));
  ok('fin de partie, historique, nouvelle partie avec joueurs recopiés (nouveaux liens)');
  assert.equal((await api('GET', '/api/me', { player: bg.token })).game.id, g1);
  ok('l\'ancien lien joueur reste lié à l\'ancienne partie');

  const audit = await api('GET', '/api/host/audit?scope=all', { host: true });
  assert.ok(audit.length > 10);
  ok('historique des modifications (journal d\'audit)');

  const bk = await api('GET', '/api/host/backup', { host: true, raw: true });
  assert.equal(bk.status, 200);
  assert.equal(Buffer.from(await bk.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  ok('sauvegarde téléchargeable de la base');

  // Traversée de chemin
  const trav = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(trav.status, 200);
  ok('protection contre la traversée de répertoires');

  console.log(`\n${pass} vérifications réussies ✔`);
} catch (e) {
  console.error('\n✘ ÉCHEC :', e);
  process.exitCode = 1;
} finally {
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
