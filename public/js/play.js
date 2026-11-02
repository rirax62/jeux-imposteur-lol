import { h, mount, api, act, live, scoreTable, teamBar, statusBadge, brand, connDot, fmtDate, confirmDialog, lines, signed, teamName, fail, $ } from './common.js';
import { Wheel } from './wheel.js';

const app = $('#app');
const conn = connDot();

// Le jeton vient du lien personnel /j/<jeton> (ou de la session mémorisée)
let token = null;
const m = location.pathname.match(/^\/j\/([A-Za-z0-9_-]+)/);
try {
  if (m) { token = m[1]; localStorage.setItem('player_token', token); }
  else token = localStorage.getItem('player_token');
} catch { token = m ? m[1] : null; }

let S = null;            // état renvoyé par /api/me (uniquement les données de CE joueur)
let view = 'role';
let roleHidden = false;  // masquage local de la carte (confidentialité à l'écran)
let spinning = false, reloadAfterSpin = false;
let revealedResult = null;
let voteDraft = null;    // brouillon local du vote (survit aux rafraîchissements temps réel)

// La roue vit dans un élément persistant pour ne pas être détruite par les rafraîchissements temps réel
const wheelBox = h('div', { class: 'wheel-box' }, h('canvas'), h('div', { class: 'wheel-pointer' }));
let wheel = null;

async function load() {
  if (spinning) { reloadAfterSpin = true; return; }
  try {
    S = await api('/api/me', { token });
    render();
  } catch (e) {
    if (e.status === 401) return invalid();
    fail(e);
  }
}

function invalid() {
  try { localStorage.removeItem('player_token'); } catch { /* ignoré */ }
  mount(app, h('div', { class: 'topbar' }, brand()),
    h('div', { class: 'wrap' }, h('div', { class: 'panel center' }, h('h2', 'Lien invalide'),
      h('p', 'Ce lien personnel n\'existe pas ou a été régénéré par l\'hôte. Demandez votre nouveau code ou lien.'),
      h('a', { class: 'btn btn-primary', href: '/' }, 'Entrer un code'))));
}

// ───────────── Fiche de rôle ─────────────
function bullets(text) { const l = lines(text); return l.length ? h('ul', l.map((x) => h('li', x))) : null; }
function section(title, content) { return content ? h('div', h('h4', title), content) : null; }

function rewardRows(rewards) {
  return rewards.map((r) => h('div', { class: 'reward-row' }, h('span', r.label), h('span', { class: 'pts ' + (r.points >= 0 ? 'p' : 'm') }, signed(r.points) + ' pt' + (Math.abs(r.points) > 1 ? 's' : ''))));
}

function roleCard(role) {
  const card = h('div', { class: 'role-card' });
  card.style.setProperty('--rc', role.color);
  const gains = role.rewards.filter((r) => r.type !== 'penalty');
  const pens = role.rewards.filter((r) => r.type === 'penalty');
  const para = (t) => (t ? h('p', lines(t).join('\n')) : null);
  card.append(
    h('div', { class: 'row between' },
      h('div', h('div', { class: 'kicker' }, 'Mon rôle'), h('h2', role.name.toUpperCase())),
      h('div', { class: 'icon', 'aria-hidden': 'true' }, role.icon)),
    role.mission ? h('div', { class: 'mission' }, h('strong', 'Mission : '), role.mission) : null,
    section('Description', para(role.description)),
    section('Objectifs', bullets(role.objectives)),
    section('Actions autorisées', bullets(role.allowed_actions)),
    section('Conditions de victoire', para(role.victory)),
    section('Conditions particulières', para(role.conditions)),
    gains.length ? section('Récompenses', h('div', rewardRows(gains))) : null,
    pens.length || role.penalties ? section('Pénalités', h('div', bullets(role.penalties), pens.length ? h('div', rewardRows(pens)) : null)) : null,
    role.wheel ? h('p', { class: 'small muted', style: { marginTop: '1rem' } }, '🎡 Ce rôle dispose d\'une roue : onglet « Ma roue ».') : null);
  return card;
}

async function reveal() {
  if (!(await confirmDialog('Assurez-vous que personne ne regarde votre écran. Révéler votre rôle maintenant ?', { okLabel: 'Révéler mon rôle' }))) return;
  const r = await act(() => api('/api/me/reveal', { method: 'POST', token }));
  if (r) { S = r; roleHidden = false; render(); }
}

function rolePanel() {
  const p = S.player;
  if (!p.distributed) {
    return h('div', { class: 'card-back' }, h('div', { class: 'big waiting' }, '⏳'), h('h2', 'Les rôles n\'ont pas encore été distribués'),
      h('p', { class: 'muted' }, 'Patientez : cette page se mettra à jour automatiquement.'));
  }
  if (!S.role) {
    return h('div', { class: 'card-back' }, h('div', { class: 'big' }, '🔒'), h('h2', 'Votre rôle est prêt'),
      h('p', { class: 'muted' }, 'Il n\'est visible que par vous. Personne d\'autre ne peut le consulter.'),
      h('button', { class: 'btn btn-primary btn-lg', onclick: reveal }, 'Révéler mon rôle'));
  }
  if (roleHidden) {
    return h('div', { class: 'card-back' }, h('div', { class: 'big' }, '🙈'), h('h2', 'Carte masquée'),
      h('button', { class: 'btn btn-primary', onclick: () => { roleHidden = false; render(); } }, 'Afficher ma carte'));
  }
  return h('div', roleCard(S.role), h('div', { class: 'row end', style: { marginTop: '.8rem' } },
    h('button', { class: 'btn btn-sm', onclick: () => { roleHidden = true; render(); } }, '🙈 Masquer ma carte')),
    S.team_results.length ? h('div', { class: 'panel', style: { marginTop: '1rem' } }, h('h3', 'Infos partagées par votre équipe'),
      S.team_results.map((t) => h('p', `${t.wheel} ${t.by} → cible : `, h('strong', t.target)))) : null);
}

// ───────────── Roue ─────────────
function wheelPanel() {
  const w = S.wheel;
  if (!w) return h('div', { class: 'panel center' }, h('p', { class: 'muted' }, 'Votre rôle n\'a pas de roue.'));
  const labels = w.candidates.map((c) => c.name);
  if (!wheel) wheel = new Wheel(wheelBox.querySelector('canvas'), labels);
  if (!spinning) {
    wheel.setLabels(labels);
    const last = w.spins[w.spins.length - 1];
    const idx = last ? labels.indexOf(last.target) : -1;
    if (idx >= 0) wheel.setTo(idx);
  }
  const last = w.spins[w.spins.length - 1];
  let hint = null;
  if (!w.enabled) hint = 'Cette roue est désactivée par l\'hôte.';
  else if (S.game.status !== 'running' && !last) hint = 'La roue sera disponible quand la partie sera lancée.';
  else if (!labels.length && !last) hint = 'Aucun joueur éligible pour le moment.';
  const btn = h('button', { class: 'btn btn-purple btn-lg', disabled: !w.can_spin || spinning, onclick: () => spin(btn) }, '🎡 Lancer ma roue');
  return h('div', { class: 'panel center' },
    h('h2', 'Roue — ' + w.label),
    h('p', { class: 'muted small' }, 'Le tirage est effectué par le serveur. Seuls vous et l\'hôte voyez le résultat.'),
    wheelBox,
    h('div', { style: { marginTop: '1.2rem' } }, btn),
    hint ? h('p', { class: 'muted' }, hint) : null,
    last && !revealedResult ? h('div', { class: 'result-box' }, h('div', { class: 'muted small' }, w.spins.length > 1 ? `Dernière cible (${w.spins.length} lancers)` : 'Votre cible'), h('div', { class: 'name' }, last.target)) : null,
    w.spins.length > 1 ? h('p', { class: 'muted small' }, 'Historique : ' + w.spins.map((s) => s.target).join(' → ')) : null);
}

async function spin(btn) {
  btn.disabled = true;
  const r = await act(() => api('/api/me/wheel/spin', { method: 'POST', token }));
  if (!r) { btn.disabled = false; return; }
  spinning = true; revealedResult = r;
  wheel.setLabels(r.candidates.map((c) => c.name));
  render(); // affiche la roue sans le résultat
  await wheel.spinTo(r.index);
  spinning = false; revealedResult = null;
  await load();
  reloadAfterSpin = false;
}

// ───────────── Missions & score ─────────────
async function claim(rw) {
  const r = await act(() => api('/api/me/claims', { method: 'POST', token, body: { reward_id: rw.id } }), 'Demande envoyée à l\'hôte.');
  if (r) load();
}

function missionsPanel() {
  if (!S.role) return h('div', { class: 'panel empty' }, 'Révélez d\'abord votre rôle pour voir vos missions.');
  const running = S.game.status === 'running';
  const pending = new Set(S.claims.filter((c) => c.status === 'pending').map((c) => c.reward_id));
  const gains = S.role.rewards.filter((r) => r.type !== 'penalty');
  return h('div', h('div', { class: 'panel' }, h('h2', 'Valider une mission'),
    !running ? h('div', { class: 'note warn' }, 'Les missions ne peuvent être validées que pendant une partie en cours.') : h('div', { class: 'note' }, 'Votre demande est envoyée à l\'hôte, qui la valide ou la refuse.'),
    h('div', { style: { marginTop: '.8rem' } }, gains.length ? gains.map((r) => h('div', { class: 'reward-row' },
      h('span', r.label, h('span', { class: 'muted small' }, r.type === 'secondary' ? '  · secondaire' : r.type === 'bonus' ? '  · bonus' : '')),
      h('span', { class: 'row' }, h('span', { class: 'pts p' }, signed(r.points)),
        h('button', { class: 'btn btn-sm btn-blue', disabled: !running || pending.has(r.id), onclick: () => claim(r) }, pending.has(r.id) ? 'En attente…' : 'Valider une mission')))) : h('div', { class: 'empty' }, 'Aucune mission configurée pour ce rôle.'))),
    S.claims.length ? h('div', { class: 'panel' }, h('h3', 'Mes demandes'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('tbody', S.claims.map((c) => h('tr', h('td', fmtDate(c.created_at)), h('td', c.label), h('td', { class: 'r' }, signed(c.points)),
        h('td', h('span', { class: 'badge b-' + c.status }, { pending: 'En attente', approved: 'Validée', rejected: 'Refusée' }[c.status]))))))) ) : null);
}

function scorePanel() {
  const me = S.me;
  return h('div',
    h('div', { class: 'panel' }, h('h2', 'Mon score'),
      h('div', { class: 'row between' }, h('span', { style: { fontSize: '2.4rem', fontFamily: 'var(--serif)', color: 'var(--gold-hi)' } }, `${me.total} pts`), h('span', { class: 'muted' }, `Rang ${me.rank} / ${S.ranking.length}`)),
      h('p', { class: 'muted small' }, `${me.success} mission(s) réussie(s) · ${me.fail} échouée(s) · bonus ${me.bonus} · malus ${me.malus}`),
      S.events.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('tbody', S.events.map((e) => h('tr', h('td', fmtDate(e.created_at)), h('td', e.comment || { points: 'Points', mission_success: 'Mission réussie', mission_fail: 'Mission échouée', bonus: 'Bonus', malus: 'Malus' }[e.kind]),
        h('td', { class: 'r ' + (e.points >= 0 ? 'pos' : 'neg') }, signed(e.points))))))) : h('div', { class: 'empty' }, 'Aucun point pour le moment.')),
    h('div', { class: 'panel' }, h('h2', 'Classement général'), teamBar(S.game, S.team_totals), scoreTable(S.ranking, S.game, { meId: S.player.id }),
      h('p', { class: 'muted small' }, 'Les rôles des autres joueurs ne sont jamais visibles.')));
}

// ───────────── Vote de fin de partie ─────────────
function votePanel() {
  const v = S.vote;
  const plural = (n) => (Math.abs(n) > 1 ? 'pts' : 'pt');
  const rules = h('div', { class: 'note' }, h('strong', 'Comment ça marche : '),
    `attribuez un rôle à chacun de vos coéquipiers. Rôle trouvé : +${v.rules.find_role} ${plural(v.rules.find_role)} · imposteur démasqué : +${v.rules.find_impostor} ${plural(v.rules.find_impostor)} · erreur : −${v.rules.wrong} ${plural(v.rules.wrong)}. `,
    'Vous n\'êtes pas obligé de voter : si vous vous abstenez pour un joueur, personne ne gagne ni ne perd de points.');

  if (v.state === 'open') {
    if (!v.targets.length) return h('div', { class: 'panel center' }, h('h2', 'Vote de fin de partie'), h('p', { class: 'muted' }, 'Il n\'y a personne sur qui voter.'));
    if (!voteDraft) voteDraft = { ...v.mine };
    const rows = v.targets.map((t) => {
      const sel = h('select', { 'aria-label': 'Rôle de ' + t.name, onchange: (e) => { voteDraft[t.id] = e.target.value ? Number(e.target.value) : null; } },
        h('option', { value: '' }, '— Je m\'abstiens —'),
        v.roles.map((r) => h('option', { value: r.id, selected: voteDraft[t.id] === r.id }, `${r.icon} ${r.name}`)));
      return h('div', { class: 'reward-row' }, h('strong', t.name), sel);
    });
    const save = async () => {
      const votes = v.targets.map((t) => ({ target_id: t.id, role_id: voteDraft[t.id] ?? null }));
      const r = await act(() => api('/api/me/votes', { method: 'POST', token, body: { votes } }), 'Votes enregistrés !');
      if (r) { voteDraft = null; load(); }
    };
    return h('div', { class: 'panel' }, h('h2', '🗳️ Vote de fin de partie'), rules,
      h('div', { style: { marginTop: '.8rem' } }, rows),
      h('div', { class: 'row end', style: { marginTop: '1rem' } }, h('button', { class: 'btn btn-primary btn-lg', onclick: save }, 'Valider mes votes')),
      h('p', { class: 'muted small' }, 'Vous pouvez modifier vos votes tant que l\'hôte n\'a pas clôturé le vote.'));
  }

  voteDraft = null;
  const res = v.results || [];
  const gain = res.reduce((s, r) => s + r.points, 0) + (v.as_impostor || 0);
  return h('div', { class: 'panel' }, h('h2', '🗳️ Résultat du vote'),
    res.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', h('tr', ['Joueur', 'Votre choix', 'Résultat', 'Points'].map((t) => h('th', t)))),
      h('tbody', res.map((r) => h('tr', h('td', h('strong', r.target)), h('td', r.guess),
        h('td', r.correct ? '✅ Bien vu' : '❌ Raté', r.actual ? h('span', { class: 'muted small' }, ` (c'était : ${r.actual})`) : null),
        h('td', { class: 'r ' + (r.points >= 0 ? 'pos' : 'neg') }, signed(r.points))))))) : h('div', { class: 'empty' }, 'Vous n\'avez pas voté : aucun point gagné ni perdu.'),
    v.as_impostor > 0 ? h('p', { class: 'gold' }, `🎭 On s'est trompé sur vous (l'imposteur) : +${v.as_impostor} pts.`) : null,
    h('p', { style: { fontFamily: 'var(--serif)', fontSize: '1.3rem' } }, 'Total du vote : ', h('strong', { class: gain >= 0 ? 'pos' : 'neg' }, signed(gain) + ' pts')),
    h('p', { class: 'muted small' }, 'Ces points sont ajoutés à votre score.'));
}

// ───────────── Page ─────────────
function render() {
  const g = S.game;
  const voteOn = S.vote && S.vote.state !== 'none';
  const tabs = [['role', '🛡️ Mon rôle'], ...(S.wheel ? [['wheel', '🎡 Ma roue']] : []), ['missions', '🎯 Missions'], ...(voteOn ? [['vote', S.vote.state === 'open' ? '🗳️ Vote ●' : '🗳️ Vote']] : []), ['score', '🏆 Score & classement']];
  if (!tabs.some(([k]) => k === view)) view = 'role';
  const content = view === 'role' ? rolePanel() : view === 'wheel' ? wheelPanel() : view === 'missions' ? missionsPanel() : view === 'vote' ? votePanel() : scorePanel();
  // Le conteneur de la roue doit rester monté ailleurs que dans une autre vue
  mount(app,
    h('div', { class: 'topbar' }, brand(),
      h('div', { class: 'row' }, conn.el, h('span', { class: 'gold' }, S.player.name), S.player.team !== null && g.teams_enabled ? h('span', { class: 'team-' + S.player.team }, teamName(g, S.player.team)) : null,
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { try { localStorage.removeItem('player_token'); } catch { /* ignoré */ } location.href = '/'; } }, 'Quitter'))),
    h('div', { class: 'wrap' },
      h('div', { class: 'row between', style: { marginBottom: '.8rem' } }, h('h1', { style: { margin: 0 } }, g.name), statusBadge(g.status)),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', { class: 'tab' + (view === k ? ' active' : ''), role: 'tab', onclick: () => { view = k; render(); } }, label))),
      voteOn && S.vote.state === 'open' && view !== 'vote' ? h('div', { class: 'note', style: { cursor: 'pointer' }, onclick: () => { view = 'vote'; render(); } }, '🗳️ Le vote de fin de partie est ouvert : cliquez ici pour voter.') : null,
      content));
  if (view === 'wheel' && wheel && !spinning) wheel.setLabels(S.wheel.candidates.map((c) => c.name)), restoreWheel();
}

function restoreWheel() {
  const labels = S.wheel.candidates.map((c) => c.name);
  const last = S.wheel.spins[S.wheel.spins.length - 1];
  const idx = last ? labels.indexOf(last.target) : -1;
  if (idx >= 0) wheel.setTo(idx);
}

if (!token) invalid();
else {
  load();
  live('player', token, { me: load, scores: load, game: load, status: conn.set });
}
