// Tests du vote de fin de partie : règles de points, abstention, confidentialité, annulation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lolvotes-'));
const { get, run, all } = await import('../server/db.js');
const S = await import('../server/services.js');

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };
const throwsStatus = (fn, status) => { try { fn(); } catch (e) { assert.equal(e.status, status, e.message); return; } assert.fail('aucune erreur levée'); };

const role = (name) => get('SELECT id, name FROM roles WHERE name=?', name);
const IMP = role('Imposteur'), PEI = role('Peintre'), TOU = role('Touriste'), HERO = role('Super Héro');
assert.equal(get('SELECT is_impostor FROM roles WHERE id=?', IMP.id).is_impostor, 1);
ok('le rôle « Imposteur » est marqué comme rôle d\'imposteur par défaut');

function setup() {
  const game = S.createGame('Test vote').id;
  const g = (n) => get('SELECT * FROM games WHERE id=?', n);
  const mk = (name, team, r) => {
    const id = S.addPlayer(game, name, team);
    run('UPDATE players SET role_id=?, role_name=? WHERE id=?', r.id, r.name, id);
    return id;
  };
  const ids = {
    imp: mk('Imposteur', 0, IMP), pein: mk('Peintre', 0, PEI), tour: mk('Touriste', 0, TOU), hero: mk('Hero', 0, HERO),
    other: mk('Adverse', 1, HERO), other2: mk('Adverse2', 1, HERO),
  };
  run("UPDATE games SET status='running' WHERE id=?", game);
  const P = (k) => get('SELECT * FROM players WHERE id=?', ids[k]);
  return { game, g: () => g(game), ids, P };
}
const total = (game, id) => S.scoreboard(game).find((r) => r.id === id).total;

// ── Scénario de l'énoncé ──
let { game, g, ids, P } = setup();
throwsStatus(() => S.submitVotes(g(), P('pein'), []), 409); // vote pas encore ouvert
S.openVotes(g());
assert.equal(g().votes_state, 'open');
ok('le vote s\'ouvre pendant la partie');

// Peintre : trouve l'imposteur (+4), trouve le Touriste (+2), se trompe sur Hero (-1)
S.submitVotes(g(), P('pein'), [{ target_id: ids.imp, role_id: IMP.id }, { target_id: ids.tour, role_id: TOU.id }, { target_id: ids.hero, role_id: PEI.id }]);
// Touriste : rate l'imposteur (« Peintre » → l'imposteur +2), s'abstient sur Peintre, accuse Hero d'être imposteur (-1 ; Hero -2 ; l'imposteur ne gagne rien)
S.submitVotes(g(), P('tour'), [{ target_id: ids.imp, role_id: PEI.id }, { target_id: ids.pein, role_id: null }, { target_id: ids.hero, role_id: IMP.id }]);
// Hero : trouve l'imposteur (+4)
S.submitVotes(g(), P('hero'), [{ target_id: ids.imp, role_id: IMP.id }]);
// L'imposteur vote aussi : trouve le Peintre (+2)
S.submitVotes(g(), P('imp'), [{ target_id: ids.pein, role_id: PEI.id }]);

throwsStatus(() => S.submitVotes(g(), P('pein'), [{ target_id: ids.other, role_id: HERO.id }]), 400);
ok('on ne peut voter que sur ses coéquipiers');
throwsStatus(() => S.submitVotes(g(), P('pein'), [{ target_id: ids.imp, role_id: 99999 }]), 400);
ok('rôle inconnu refusé');
assert.equal(get('SELECT COUNT(*) c FROM votes WHERE voter_id=?', ids.tour).c, 2);
ok('abstention : aucun vote enregistré pour ce joueur');

const before = S.scoreboard(game).reduce((s, r) => s + r.total, 0);
assert.equal(before, 0);
S.closeVotes(g());
assert.equal(g().votes_state, 'closed');
assert.equal(total(game, ids.pein), 4 + 2 - 1);
assert.equal(total(game, ids.tour), -1 - 1);
assert.equal(total(game, ids.hero), 4 - 2);          // +4 (imposteur trouvé) -2 (accusé à tort d'être l'imposteur)
assert.equal(total(game, ids.imp), 2 + 2);           // +2 (bon vote) +2 (raté à son sujet) ; rien pour l'innocent accusé
assert.equal(total(game, ids.other), 0);
ok('points : +4 imposteur trouvé, +2 rôle trouvé, -1 erreur, +2 à l\'imposteur si on se trompe sur lui, -2 à l\'innocent accusé, abstention neutre');

// Les évènements de score portent un commentaire lisible
const evs = all("SELECT comment, points FROM score_events WHERE game_id=? AND actor='vote'", game);
assert.ok(evs.some((e) => /démasqué l'imposteur/.test(e.comment) && e.points === 4));
assert.ok(evs.some((e) => /s'est trompé/.test(e.comment) && e.points === -1));
ok('chaque point du vote est tracé dans l\'historique avec un commentaire');

// Plus de vote après la clôture
throwsStatus(() => S.submitVotes(g(), P('pein'), []), 409);
throwsStatus(() => S.openVotes(g()), 409);
throwsStatus(() => S.closeVotes(g()), 409);
ok('vote verrouillé après la clôture');

// Confidentialité
const vw = S.voteView(g(), P('pein'));
assert.equal(vw.state, 'closed');
assert.ok(!JSON.stringify(vw).includes('is_impostor'), 'le drapeau imposteur ne doit pas fuiter');
assert.ok(vw.results.every((r) => !('actual' in r)), 'rôles réels masqués tant que non révélés');
assert.equal(vw.results.length, 3);
assert.equal(vw.targets.some((t) => t.id === ids.other), false);
assert.equal(S.voteView(g(), P('imp')).as_impostor, 2);
assert.equal(S.voteView(g(), P('pein')).as_impostor, 0);
assert.equal(S.voteView(g(), P('hero')).as_impostor, -2);
run('UPDATE games SET roles_revealed=1 WHERE id=?', game);
assert.ok(S.voteView(g(), P('pein')).results.every((r) => 'actual' in r));
ok('le joueur ne voit que ses cibles et ses résultats ; vrais rôles seulement une fois révélés');

// Annulation : points supprimés, vote rouvert, votes conservés
S.reopenVotes(g());
assert.equal(g().votes_state, 'open');
for (const k of Object.keys(ids)) assert.equal(total(game, ids[k]), 0);
assert.equal(get('SELECT COUNT(*) c FROM votes WHERE game_id=?', game).c, 7);
ok('réouverture : points annulés, votes conservés');

// Mode « une seule fois » pour l'imposteur
S.closeVotes(g());
S.reopenVotes(g());
run("INSERT INTO settings(key,value) VALUES('vote_rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ impostor_mode: 'once' }));
S.closeVotes(g());
assert.equal(total(game, ids.imp), 2 + 2);           // +2 bon vote, +2 une seule fois
ok('mode « une seule fois » : l\'imposteur ne gagne qu\'un bonus');

// Règles modifiables
const r2 = S.cleanVoteRules({ find_impostor: 6, wrong: 0, impostor_mode: 'per_vote' });
assert.equal(r2.find_impostor, 6); assert.equal(r2.wrong, 0); assert.equal(r2.find_role, 2);
assert.throws(() => S.cleanVoteRules({ find_role: -3 }));
assert.throws(() => S.cleanVoteRules({ impostor_mode: 'x' }));
ok('règles de points modifiables et validées');

// Redistribution : les votes sont effacés
S.reopenVotes(g());
run("UPDATE games SET status='lobby' WHERE id=?", game);
S.distributeRoles(g());
assert.equal(get('SELECT COUNT(*) c FROM votes WHERE game_id=?', game).c, 0);
assert.equal(g().votes_state, 'none');
ok('redistribuer les rôles efface les votes');

// Scénario sans équipes
{
  const gid = S.createGame('Sans équipes').id;
  run('UPDATE games SET teams_enabled=0, status=? WHERE id=?', 'running', gid);
  const a = S.addPlayer(gid, 'A', null), b = S.addPlayer(gid, 'B', null), c = S.addPlayer(gid, 'C', null);
  run('UPDATE players SET role_id=?, role_name=? WHERE id=?', IMP.id, IMP.name, a);
  run('UPDATE players SET role_id=?, role_name=? WHERE id=?', PEI.id, PEI.name, b);
  run('UPDATE players SET role_id=?, role_name=? WHERE id=?', HERO.id, HERO.name, c);
  const G = () => get('SELECT * FROM games WHERE id=?', gid);
  S.openVotes(G());
  const pb = get('SELECT * FROM players WHERE id=?', b);
  assert.deepEqual(S.voteTargets(G(), pb).map((t) => t.id).sort(), [a, c].sort());
  S.submitVotes(G(), pb, [{ target_id: a, role_id: IMP.id }]);
  S.closeVotes(G());
  assert.equal(total(gid, b), 4);
  ok('sans équipes : on peut voter sur tous les autres joueurs');
}

console.log(`\n${pass} vérifications de vote réussies ✔`);
