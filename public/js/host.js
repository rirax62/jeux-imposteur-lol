import {
  h, mount, clear, api, act, live, toast, fail, copy, confirmDialog, modal, scoreTable, teamBar, statusBadge, brand, connDot,
  fmtCode, fmtDate, fmtPct, signed, teamName, lines, STATUS, $,
} from './common.js';

const app = $('#app');
const conn = connDot();
let S = null;                 // état complet de l'hôte (GET /api/host/state)
let section = 'game';
let blurRoles = false;
try { blurRoles = localStorage.getItem('blurRoles') === '1'; } catch { /* ignoré */ }
let content = null, navEl = null;
let dirty = false;
let auditScope = 'current', auditRows = [], pastGame = null, simResult = null, rankComment = '';

const SECTIONS = [
  ['game', '🎮 Partie'], ['players', '👥 Joueurs'], ['roles', '🛡️ Rôles'], ['draw', '🎲 Tirage & probabilités'], ['wheels', '🎡 Roues'],
  ['missions', '🎯 Missions'], ['points', '➕ Points'], ['ranking', '🏆 Classement'], ['history', '📜 Historique'],
];

// ───────────── Accès ─────────────
async function boot() {
  let s;
  try { s = await api('/api/host/session'); } catch (e) { return fail(e); }
  if (!s.configured) return authScreen(true);
  if (!s.authed) return authScreen(false);
  await startDashboard();
}

function authScreen(setup) {
  const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', placeholder: 'Mot de passe', 'aria-label': 'Mot de passe', minlength: 8 });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Confirmer le mot de passe', 'aria-label': 'Confirmation' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (setup && pw.value !== pw2.value) return toast('Les mots de passe ne correspondent pas.', 'err');
      const r = await act(() => api(setup ? '/api/host/setup' : '/api/host/login', { method: 'POST', body: { password: pw.value } }));
      if (r) startDashboard();
    },
  }, h('div', { class: 'field' }, pw), setup ? h('div', { class: 'field' }, pw2) : null,
  h('button', { class: 'btn btn-primary btn-lg', style: { width: '100%' } }, setup ? 'Créer l\'espace hôte' : 'Se connecter'));
  mount(app, h('div', { class: 'topbar' }, brand()),
    h('div', { class: 'wrap', style: { maxWidth: '460px' } }, h('div', { class: 'hero' }, h('h1', 'Espace hôte')),
      h('div', { class: 'panel' }, h('h2', setup ? 'Première configuration' : 'Connexion'),
        setup ? h('p', { class: 'muted' }, 'Choisissez un mot de passe d\'au moins 8 caractères. Il protège toute l\'administration (rôles, scores, paramètres).') : null,
        form)));
  pw.focus();
}

async function startDashboard() {
  await refresh(true);
  live('host', null, { host: refresh, game: refresh, scores: refresh, me: refresh, status: conn.set });
}

// ───────────── Données ─────────────
let refreshTimer = null;
function refresh(force = false) {
  clearTimeout(refreshTimer);
  return new Promise((resolve) => {
    refreshTimer = setTimeout(async () => {
      try {
        S = await api('/api/host/state');
        if (section === 'history') auditRows = await api('/api/host/audit?scope=' + auditScope + '&limit=200');
        renderAll(force);
      } catch (e) {
        if (e.status === 401) return authScreen(false);
        fail(e);
      }
      resolve();
    }, force ? 0 : 120);
  });
}

/** Action serveur + rafraîchissement immédiat. */
async function doIt(path, method = 'POST', body = {}, okMsg) {
  const r = await act(() => api(path, { method, body }), okMsg);
  if (r !== undefined) { document.activeElement?.blur?.(); await refresh(true); }
  else await refresh(true); // remet l'affichage d'aplomb après une erreur
  return r;
}

const editing = () => content && content.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'checkbox';

function renderAll(force) {
  if (!navEl) buildShell();
  updateNav();
  if (!force && editing()) { dirty = true; return; }
  dirty = false;
  renderContent();
}

function buildShell() {
  navEl = h('nav', { class: 'sidenav', 'aria-label': 'Sections' });
  content = h('main', { class: 'stack' });
  content.addEventListener('focusout', () => setTimeout(() => { if (dirty && !editing()) { dirty = false; renderContent(); } }, 150));
  mount(app,
    h('div', { class: 'topbar' }, brand('/host'),
      h('div', { class: 'row' }, conn.el, h('a', { class: 'btn btn-sm', href: '/', target: '_blank', rel: 'noopener' }, 'Voir côté joueurs ↗'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await api('/api/host/logout', { method: 'POST' }); location.reload(); } }, 'Déconnexion'))),
    h('div', { class: 'wrap', style: { maxWidth: '1300px' } }, h('div', { class: 'sidebar-layout' }, navEl, content)));
}

function updateNav() {
  const pending = S.claims.filter((c) => c.status === 'pending').length;
  mount(navEl, SECTIONS.map(([k, label]) => h('button', { class: 'tab' + (section === k ? ' active' : ''), onclick: () => go(k) }, label, k === 'missions' && pending ? h('span', { class: 'count' }, pending) : null)));
}

async function go(k) {
  section = k;
  if (k === 'history') { try { auditRows = await api('/api/host/audit?scope=' + auditScope + '&limit=200'); } catch (e) { fail(e); } }
  updateNav();
  renderContent();
  window.scrollTo({ top: 0 });
}

function renderContent() {
  const g = S.game;
  const head = h('div', { class: 'panel' }, h('div', { class: 'row between' },
    h('div', h('div', { class: 'muted small' }, 'Partie active'), h('h2', { style: { margin: 0 } }, g.name)),
    h('div', { class: 'row' }, statusBadge(g.status), h('span', { class: 'muted' }, `${S.players.length} joueur(s)`))));
  const fn = { game: gameSection, players: playersSection, roles: rolesSection, draw: drawSection, wheels: wheelsSection, missions: missionsSection, points: pointsSection, ranking: rankingSection, history: historySection }[section];
  mount(content, head, fn());
}

// ───────────── Petits composants ─────────────
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { class: 'f' }, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
const numInput = (value, onchange, { min = 0, max = 100000, step = 1, placeholder = '' } = {}) =>
  h('input', { type: 'number', class: 'num', value: value ?? '', min, max, step, placeholder, onchange: (e) => onchange(e.target.value === '' ? null : Number(e.target.value)) });
const checkbox = (checked, onchange, label) => h('label', { class: 'row', style: { gap: '.4rem', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onchange(e.target.checked) }), label);
const playerSelect = (id = 'player_select', current) => h('select', { id }, S.players.map((p) => h('option', { value: p.id, selected: p.id === current }, p.name)));
const roleOf = (id) => S.roles.find((r) => r.id === id);
const teamSelect = (value, onchange) => h('select', { onchange: (e) => onchange(e.target.value === '' ? null : Number(e.target.value)) },
  h('option', { value: '', selected: value === null }, '—'), h('option', { value: 0, selected: value === 0 }, S.game.team_a), h('option', { value: 1, selected: value === 1 }, S.game.team_b));
const baseUrl = () => location.origin;
const linkOf = (p) => `${baseUrl()}/j/${p.token}`;

// ───────────── Vote de fin de partie (panneau hôte) ─────────────
function voteHostPanel() {
  const V = S.votes || { state: 'none', rules: {} }, g = S.game, R = V.rules;
  const label = { none: 'Non ouvert', open: 'Ouvert', closed: 'Clôturé' }[V.state];
  const btns = [];
  if (V.state === 'none') btns.push(h('button', { class: 'btn btn-primary', disabled: !['running', 'ended'].includes(g.status), onclick: () => doIt('/api/host/votes/open', 'POST', {}, 'Vote ouvert : les joueurs peuvent voter.') }, '🗳️ Ouvrir le vote de fin de partie'));
  if (V.state === 'open') btns.push(h('button', { class: 'btn btn-primary', onclick: async () => {
    if (await confirmDialog(`Clôturer le vote ? Les points seront calculés et ajoutés au classement. ${V.voters} joueur(s) sur ${V.total} ont voté.`, { okLabel: 'Clôturer et attribuer les points' })) doIt('/api/host/votes/close', 'POST', {}, 'Vote clôturé : points attribués.');
  } }, '✅ Clôturer le vote et attribuer les points'));
  if (V.state === 'closed') btns.push(h('button', { class: 'btn btn-danger', onclick: async () => {
    if (await confirmDialog('Rouvrir le vote ? Les points du vote seront annulés, et les joueurs pourront modifier leurs votes.', { danger: true, okLabel: 'Annuler les points et rouvrir' })) doIt('/api/host/votes/reopen', 'POST', {}, 'Vote rouvert, points annulés.');
  } }, '↩ Rouvrir le vote (annule les points)'));

  const num = (k) => numInput(R[k], () => {}, { min: 0, max: 1000 });
  const I = { find_impostor: num('find_impostor'), find_role: num('find_role'), wrong: num('wrong'), impostor_gain: num('impostor_gain') };
  const mode = h('select', h('option', { value: 'per_vote', selected: R.impostor_mode !== 'once' }, 'À chaque vote erroné'), h('option', { value: 'once', selected: R.impostor_mode === 'once' }, 'Une seule fois'));
  const hidden = (txt) => h('span', { class: blurRoles ? 'blur-role' : '', title: blurRoles ? 'Cliquer pour afficher' : '', onclick: (e) => blurRoles && e.currentTarget.classList.toggle('show') }, txt || '—');
  const rows = V.rows || [], gains = V.gains || [];

  return h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, '🗳️ Vote de fin de partie'), h('span', { class: 'badge b-' + (V.state === 'open' ? 'running' : V.state === 'closed' ? 'ended' : 'lobby') }, label)),
    h('p', { class: 'muted small' }, 'Chaque joueur attribue un rôle à ses coéquipiers (ou s\'abstient). À la clôture, les points sont ajoutés au classement et tracés dans l\'historique. L\'« imposteur » est le rôle coché « Rôle d\'imposteur » dans l\'éditeur de rôle.'),
    h('div', { class: 'row', style: { marginTop: '.6rem' } }, btns, V.state !== 'none' ? h('span', { class: 'muted' }, `${V.voters} joueur(s) sur ${V.total} ont voté`) : null),
    h('h3', { style: { marginTop: '1rem' } }, 'Points du vote'),
    h('div', { class: 'row' }, field('Imposteur démasqué', I.find_impostor), field('Rôle trouvé', I.find_role), field('Erreur (points perdus)', I.wrong), field('Bonus de l\'imposteur si on se trompe sur lui', I.impostor_gain), field('Bonus de l\'imposteur', mode)),
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => doIt('/api/host/votes/rules', 'PUT', { find_impostor: I.find_impostor.value, find_role: I.find_role.value, wrong: I.wrong.value, impostor_gain: I.impostor_gain.value, impostor_mode: mode.value }, 'Règles du vote enregistrées.') }, 'Enregistrer les règles')),
    V.state !== 'none' ? h('div', [
      h('h3', { style: { marginTop: '1rem' } }, V.state === 'closed' ? 'Votes et points attribués' : 'Votes reçus (points prévus à la clôture)'),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', h('tr', ['Votant', 'Cible', 'Vote', 'Vrai rôle', 'Résultat', 'Points'].map((t) => h('th', t)))),
        h('tbody', rows.map((r) => h('tr', h('td', r.voter), h('td', r.target), h('td', r.guess), h('td', hidden(r.actual)), h('td', r.correct ? '✅' : '❌'),
          h('td', { class: 'r ' + (r.points >= 0 ? 'pos' : 'neg') }, signed(r.points))))))) : h('div', { class: 'empty' }, 'Aucun vote pour le moment.'),
      gains.length ? h('div', [h('h3', { style: { marginTop: '1rem' } }, 'Bonus gagnés par les imposteurs'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('tbody', gains.map((x) => h('tr', h('td', h('strong', x.player)), h('td', { class: 'muted' }, x.because), h('td', { class: 'r ' + (x.points >= 0 ? 'pos' : 'neg') }, signed(x.points)))))))]) : null,
    ]) : null);
}

// ───────────── 1. Partie ─────────────
function gameSection() {
  const g = S.game, n = S.players.length;
  const order = ['lobby', 'distributed', 'running', 'ended'];
  const idx = order.indexOf(g.status);
  const steps = h('div', { class: 'stepper' }, order.map((s, i) => h('div', { class: 'step' + (i < idx ? ' done' : i === idx ? ' now' : '') }, `${i + 1}. ${STATUS[s]}`)));

  // Vérification de faisabilité de la distribution
  const teams = g.teams_enabled ? 2 : 1;
  const fixed = S.roles.filter((r) => r.enabled && r.exact_count > 0).reduce((s, r) => s + r.exact_count * (r.per_team ? teams : 1), 0);
  const warnings = [];
  if (n === 0) warnings.push('Ajoutez au moins un joueur.');
  if (fixed > n) warnings.push(`Les rôles à effectif exact demandent ${fixed} joueurs, il n'y en a que ${n}.`);
  if (!S.roles.some((r) => r.enabled && !(r.exact_count > 0) && r.weight > 0 && !(r.max_count > 0)) && fixed < n) warnings.push('Aucun rôle sans plafond : ajoutez ou activez un rôle « de base » (ex. Joueur standard) pour accueillir tous les joueurs.');

  const act1 = [];
  if (g.status === 'lobby' || g.status === 'distributed') act1.push(h('button', { class: g.status === 'lobby' ? 'btn btn-primary btn-lg' : 'btn', disabled: n === 0, onclick: async () => {
    if (g.status === 'distributed' && !(await confirmDialog('Redistribuer les rôles ? Les rôles actuels, les roues utilisées et les demandes de missions seront effacés.', { danger: true }))) return;
    doIt('/api/host/game/distribute', 'POST', {}, 'Rôles distribués.');
  } }, g.status === 'lobby' ? '🎲 Distribuer les rôles' : '🔁 Redistribuer les rôles'));
  if (g.status === 'distributed') act1.push(h('button', { class: 'btn btn-blue btn-lg', onclick: () => doIt('/api/host/game/start', 'POST', {}, 'Partie lancée !') }, '▶ Lancer la partie'));
  if (g.status === 'running') act1.push(h('button', { class: 'btn btn-primary btn-lg', onclick: async () => { if (await confirmDialog('Terminer la partie ? Les joueurs ne pourront plus lancer de roue ni valider de mission.')) doIt('/api/host/game/end', 'POST', {}, 'Partie terminée.'); } }, '🏁 Terminer la partie'));
  if (g.status === 'ended') act1.push(h('button', { class: 'btn', onclick: () => doIt('/api/host/game/reveal-roles', 'POST', { value: !g.roles_revealed }) }, g.roles_revealed ? '🙈 Masquer de nouveau les rôles' : '🎭 Révéler tous les rôles publiquement'));

  const nameI = h('input', { value: g.name, maxlength: 80 }), aI = h('input', { value: g.team_a, maxlength: 40 }), bI = h('input', { value: g.team_b, maxlength: 40 });
  let teamsOn = g.teams_enabled;
  const newName = h('input', { placeholder: `Partie ${S.games.length + 1}`, maxlength: 80 });
  let copyPlayers = true;
  const oldPw = h('input', { type: 'password', autocomplete: 'current-password' }), newPw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });

  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', 'Déroulement'), steps,
      warnings.length ? h('div', { class: 'note warn', style: { marginTop: '.8rem' } }, warnings.map((w) => h('div', '⚠ ' + w))) : null,
      h('div', { class: 'row', style: { marginTop: '1rem' } }, act1,
        h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Réinitialiser la partie ? Rôles, roues, missions ET scores seront effacés. Les joueurs sont conservés.', { danger: true, okLabel: 'Tout réinitialiser' })) doIt('/api/host/game/reset', 'POST', {}, 'Partie réinitialisée.'); } }, '⟲ Réinitialiser la partie'),
        h('button', { class: 'btn btn-danger btn-ghost', onclick: async () => { if (await confirmDialog('Remettre la partie en préparation en conservant les scores ?', { danger: true })) doIt('/api/host/game/reset', 'POST', { keep_scores: true }, 'Partie remise en préparation.'); } }, 'Réinitialiser (garder les scores)'))),
    voteHostPanel(),
    h('div', { class: 'grid cols2' },
      h('div', { class: 'panel' }, h('h3', 'Paramètres de la partie'),
        field('Nom de la partie', nameI), h('div', { class: 'grid cols2' }, field('Équipe A', aI), field('Équipe B', bI)),
        checkbox(teamsOn, (v) => { teamsOn = v; }, 'Jouer par équipes (nécessaire pour « équipe adverse »)'),
        h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary', onclick: () => doIt('/api/host/game', 'PATCH', { name: nameI.value, team_a: aI.value, team_b: bI.value, teams_enabled: teamsOn }, 'Paramètres enregistrés.') }, 'Enregistrer'))),
      h('div', { class: 'panel' }, h('h3', 'Nouvelle partie'),
        field('Nom', newName), checkbox(true, (v) => { copyPlayers = v; }, 'Reprendre les joueurs (nouveaux liens personnels)'),
        h('p', { class: 'muted small' }, 'La partie actuelle est conservée dans l\'historique.'),
        h('div', { class: 'row end' }, h('button', { class: 'btn btn-blue', onclick: async () => { if (await doIt('/api/host/games', 'POST', { name: newName.value || newName.placeholder, copy_players: copyPlayers }, 'Nouvelle partie créée.')) section = 'players'; renderContent(); updateNav(); } }, '＋ Créer la partie')))),
    h('div', { class: 'panel' }, h('h3', 'Toutes les parties'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', h('tr', ['Partie', 'Statut', 'Joueurs', 'Créée le', ''].map((t) => h('th', t)))),
        h('tbody', S.games.map((x) => h('tr', h('td', x.name, x.id === S.current_game ? h('span', { class: 'badge b-running', style: { marginLeft: '.5rem' } }, 'active') : null), h('td', statusBadge(x.status)), h('td', x.players), h('td', fmtDate(x.created_at)),
          h('td', h('div', { class: 'row end' }, x.id !== S.current_game ? h('button', { class: 'btn btn-sm', onclick: () => doIt(`/api/host/games/${x.id}/activate`, 'POST', {}, 'Partie activée.') }, 'Activer') : null,
            h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (await confirmDialog(`Supprimer définitivement « ${x.name} » (joueurs, scores, historique) ?`, { danger: true, okLabel: 'Supprimer' })) doIt('/api/host/games/' + x.id, 'DELETE', {}, 'Partie supprimée.'); } }, 'Supprimer'))))))))),
    h('div', { class: 'grid cols2' },
      h('div', { class: 'panel' }, h('h3', 'Sauvegarde'),
        h('p', { class: 'muted small' }, 'Toutes les données sont dans une base SQLite persistante. Une copie automatique est faite au démarrage puis toutes les 6 h (dossier data/backups).'),
        h('a', { class: 'btn', href: '/api/host/backup', download: '' }, '⬇ Télécharger une sauvegarde')),
      h('div', { class: 'panel' }, h('h3', 'Mot de passe hôte'), field('Ancien', oldPw), field('Nouveau (8 caractères min.)', newPw),
        h('button', { class: 'btn', onclick: async () => { const r = await act(() => api('/api/host/password', { method: 'POST', body: { old: oldPw.value, new: newPw.value } }), 'Mot de passe modifié.'); if (r) { oldPw.value = newPw.value = ''; } } }, 'Modifier'))));
}

// ───────────── 2. Joueurs ─────────────
function playersSection() {
  const g = S.game;
  const nameI = h('input', { placeholder: 'Nom du joueur', maxlength: 40 });
  let nTeam = null;
  const countI = h('input', { type: 'number', min: 0, max: 100, value: S.players.length, class: 'num' });
  const showRole = (p) => {
    if (!p.role_id) return h('span', { class: 'muted' }, '—');
    const txt = h('span', { class: blurRoles ? 'blur-role' : '', title: blurRoles ? 'Cliquer pour afficher' : '', onclick: (e) => blurRoles && e.currentTarget.classList.toggle('show') }, p.role_name || roleOf(p.role_id)?.name || '?');
    return txt;
  };
  const roleSelect = (p) => blurRoles ? showRole(p) : h('select', { onchange: (e) => doIt('/api/host/players/' + p.id, 'PATCH', { role_id: e.target.value === '' ? null : Number(e.target.value) }) },
    h('option', { value: '', selected: !p.role_id }, '—'), S.roles.map((r) => h('option', { value: r.id, selected: r.id === p.role_id }, r.name)));
  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', 'Gestion des joueurs'),
      h('div', { class: 'inline-form' },
        h('div', { class: 'field' }, h('label', { class: 'f' }, 'Ajouter un joueur'), nameI),
        h('div', { class: 'field', style: { flex: '0 0 160px' } }, h('label', { class: 'f' }, 'Équipe'), teamSelect(null, (v) => { nTeam = v; })),
        h('button', { class: 'btn btn-primary', onclick: async () => { if (await doIt('/api/host/players', 'POST', { name: nameI.value, team: nTeam }, 'Joueur ajouté.') !== undefined) nameI.value = ''; } }, '＋ Ajouter')),
      h('div', { class: 'inline-form', style: { marginTop: '.8rem' } },
        h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('label', { class: 'f' }, 'Nombre de participants'), countI),
        h('button', { class: 'btn', onclick: async () => { const n = Number(countI.value); if (n < S.players.length && !(await confirmDialog(`Supprimer les ${S.players.length - n} derniers joueurs ?`, { danger: true }))) return; doIt('/api/host/players/count', 'POST', { n }, 'Nombre de participants mis à jour.'); } }, 'Appliquer'),
        h('span', { class: 'muted small' }, 'Ajoute « Joueur N » ou retire les derniers.')),
      g.teams_enabled ? h('div', { class: 'row', style: { marginTop: '.8rem' } },
        h('button', { class: 'btn btn-sm', onclick: () => doIt('/api/host/players/teams', 'POST', { mode: 'auto' }, 'Équipes réparties.') }, '⚖ Compléter les équipes (équilibré)'),
        h('button', { class: 'btn btn-sm', onclick: () => doIt('/api/host/players/teams', 'POST', { mode: 'all' }, 'Équipes mélangées.') }, '🔀 Tout mélanger'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => doIt('/api/host/players/teams', 'POST', { mode: 'clear' }) }, 'Retirer les équipes')) : null),
    h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'Liste & liens personnels'),
      h('div', { class: 'row' }, checkbox(blurRoles, (v) => { blurRoles = v; try { localStorage.setItem('blurRoles', v ? '1' : '0'); } catch { /* ignoré */ } renderContent(); }, 'Masquer les rôles à l\'écran (je joue aussi)'),
        h('button', { class: 'btn btn-sm', onclick: () => copy(S.players.map((p) => `${p.name} — ${linkOf(p)} — code ${fmtCode(p.code)}`).join('\n'), 'Tous les liens ont été copiés.') }, '📋 Copier tous les liens'))),
      blurRoles ? h('div', { class: 'note', style: { margin: '.6rem 0' } }, 'Rôles floutés (cliquez pour afficher). C\'est un confort d\'affichage local : l\'hôte garde techniquement accès à toutes les données.') : null,
      S.players.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', h('tr', ['#', 'Nom', 'Équipe', 'Rôle', 'Vu', 'Code', 'Lien', ''].map((t) => h('th', t)))),
        h('tbody', S.players.map((p, i) => h('tr',
          h('td', i + 1),
          h('td', h('input', { value: p.name, maxlength: 40, style: { minWidth: '9rem' }, onchange: (e) => doIt('/api/host/players/' + p.id, 'PATCH', { name: e.target.value }) })),
          h('td', g.teams_enabled ? teamSelect(p.team, (v) => doIt('/api/host/players/' + p.id, 'PATCH', { team: v })) : '—'),
          h('td', roleSelect(p)),
          h('td', p.revealed ? h('span', { class: 'pos', title: 'Rôle révélé' }, '✔') : h('span', { class: 'muted' }, '—')),
          h('td', h('button', { class: 'btn btn-sm mono', title: 'Copier le code', onclick: () => copy(fmtCode(p.code), 'Code copié.') }, fmtCode(p.code))),
          h('td', h('button', { class: 'btn btn-sm', onclick: () => copy(linkOf(p), 'Lien copié.') }, '🔗 Copier')),
          h('td', h('div', { class: 'row end' },
            p.revealed ? h('button', { class: 'btn btn-sm btn-icon', title: 'Remettre « non révélé »', onclick: () => doIt('/api/host/players/' + p.id, 'PATCH', { reset_reveal: true }) }, '👁') : null,
            h('button', { class: 'btn btn-sm btn-icon', title: 'Régénérer le lien et le code (l\'ancien devient invalide)', onclick: async () => { if (await confirmDialog(`Régénérer le lien de ${p.name} ? L'ancien lien ne fonctionnera plus.`)) doIt(`/api/host/players/${p.id}/regenerate`, 'POST', {}, 'Nouveau lien généré.'); } }, '♻'),
            h('button', { class: 'btn btn-sm btn-danger btn-icon', title: 'Supprimer', onclick: async () => { if (await confirmDialog(`Supprimer ${p.name} (et ses points) ?`, { danger: true, okLabel: 'Supprimer' })) doIt('/api/host/players/' + p.id, 'DELETE', {}, 'Joueur supprimé.'); } }, '🗑')))))))) : h('div', { class: 'empty' }, 'Aucun joueur. Ajoutez-en ci-dessus.'),
      h('p', { class: 'muted small' }, 'Transmettez à chaque joueur son lien ou son code (à saisir sur la page d\'accueil). Chacun ne peut voir que son propre rôle.')));
}

// ───────────── 3. Rôles ─────────────
function rolesSection() {
  return h('div', { class: 'stack' }, h('div', { class: 'panel' },
    h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'Gestion des rôles'), h('button', { class: 'btn btn-primary', onclick: () => openRoleEditor(null) }, '＋ Nouveau rôle')),
    h('div', { class: 'table-wrap', style: { marginTop: '.8rem' } }, h('table', { class: 'data' },
      h('thead', h('tr', ['Rôle', 'Actif', 'Mission', 'Roue', 'Récompenses', ''].map((t) => h('th', t)))),
      h('tbody', S.roles.map((r) => h('tr',
        h('td', h('span', { style: { color: r.color, fontWeight: 700 } }, `${r.icon} ${r.name}`)),
        h('td', h('input', { type: 'checkbox', checked: !!r.enabled, title: 'Activer / désactiver', onchange: (e) => doIt('/api/host/roles/' + r.id, 'PUT', { enabled: e.target.checked }) })),
        h('td', { class: 'small muted', style: { maxWidth: '22rem' } }, r.mission || '—'),
        h('td', r.wheel ? h('span', { class: 'badge b-distributed' }, (S.wheels[r.wheel]?.label ?? '—')) : '—'),
        h('td', r.rewards.length),
        h('td', h('div', { class: 'row end' }, h('button', { class: 'btn btn-sm', onclick: () => openRoleEditor(r) }, 'Modifier'),
          h('button', { class: 'btn btn-sm', onclick: () => doIt(`/api/host/roles/${r.id}/duplicate`, 'POST', {}, 'Rôle dupliqué.') }, 'Dupliquer'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { if (await confirmDialog(`Supprimer le rôle « ${r.name} » ? Les joueurs qui l'ont perdent leur attribution.`, { danger: true, okLabel: 'Supprimer' })) doIt('/api/host/roles/' + r.id, 'DELETE', {}, 'Rôle supprimé.'); } }, 'Supprimer'))))))))),
    h('p', { class: 'muted small' }, 'Les poids, effectifs exacts et plafonds se règlent dans « Tirage & probabilités ».'));
}

function openRoleEditor(role) {
  const d = role ? JSON.parse(JSON.stringify(role)) : { name: '', icon: '⚔️', color: '#c8aa6e', enabled: 1, wheel: '', weight: 10, exact_count: null, max_count: null, per_team: 0, fail_points: 0, mission: '', description: '', objectives: '', allowed_actions: '', victory: '', conditions: '', penalties: '', rewards: [] };
  const I = {};
  const txt = (key, label, rows, hint) => { I[key] = h('textarea', { rows, maxlength: 4000 }); I[key].value = d[key] || ''; return field(label, I[key], hint); };
  I.name = h('input', { value: d.name, maxlength: 60 }); I.icon = h('input', { value: d.icon, maxlength: 8, style: { width: '5rem' } });
  I.color = h('input', { type: 'color', value: d.color });
  I.wheel = h('select', h('option', { value: '', selected: !d.wheel }, 'Aucune'), Object.entries(S.wheels).map(([k, w]) => h('option', { value: k, selected: d.wheel === k }, w.label)));
  I.fail = numInput(d.fail_points, () => {}, { min: -1000, max: 1000 });
  let enabled = !!d.enabled, perTeam = !!d.per_team, isImp = !!d.is_impostor;
  I.weight = numInput(d.weight, () => {}, { step: 0.1 }); I.exact = numInput(d.exact_count, () => {}, { placeholder: '—' }); I.max = numInput(d.max_count, () => {}, { placeholder: '—' });
  const rewardsBox = h('div');
  const drawRewards = () => mount(rewardsBox,
    d.rewards.length ? null : h('div', { class: 'empty' }, 'Aucune récompense.'),
    d.rewards.map((r, i) => h('div', { class: 'row', style: { marginBottom: '.4rem', flexWrap: 'nowrap' } },
      h('input', { value: r.label, placeholder: 'Libellé (ex. Mission réussie)', maxlength: 120, oninput: (e) => { r.label = e.target.value; } }),
      h('input', { type: 'number', class: 'num', value: r.points, min: -1000, max: 1000, oninput: (e) => { r.points = Number(e.target.value); }, 'aria-label': 'Points' }),
      h('select', { style: { width: '9rem' }, onchange: (e) => { r.type = e.target.value; } }, [['mission', 'Mission'], ['secondary', 'Secondaire'], ['bonus', 'Bonus'], ['penalty', 'Pénalité']].map(([v, l]) => h('option', { value: v, selected: r.type === v }, l))),
      h('button', { class: 'btn btn-sm btn-danger btn-icon', onclick: () => { d.rewards.splice(i, 1); drawRewards(); } }, '✕'))));
  drawRewards();
  const close = modal(h('div',
    h('h2', role ? `Modifier le rôle : ${role.name}` : 'Nouveau rôle'),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { class: 'field', style: { flex: '1 1 220px' } }, h('label', { class: 'f' }, 'Nom du rôle'), I.name), field('Icône', I.icon), field('Couleur', I.color), field('Roue associée', I.wheel)),
    checkbox(enabled, (v) => { enabled = v; }, 'Rôle activé (tiré au sort)'),
    checkbox(isImp, (v) => { isImp = v; }, 'Rôle d\'imposteur (cible spéciale du vote de fin de partie : +points si on le démasque)'),
    h('div', { style: { height: '.6rem' } }),
    txt('mission', 'Mission (résumé)', 2), txt('description', 'Description complète', 3),
    txt('objectives', 'Objectifs de la mission', 3, 'Un objectif par ligne.'), txt('allowed_actions', 'Actions autorisées', 3, 'Une action par ligne.'),
    txt('victory', 'Conditions de victoire', 2), txt('conditions', 'Conditions particulières', 2), txt('penalties', 'Pénalités (texte)', 2),
    h('h3', 'Points gagnés selon les actions'),
    rewardsBox,
    h('div', { class: 'row' }, h('button', { class: 'btn btn-sm', onclick: () => { d.rewards.push({ id: '', label: '', points: 5, type: 'mission' }); drawRewards(); } }, '＋ Ajouter une récompense'),
      h('span', { class: 'muted small' }, 'Pénalité : saisissez un nombre négatif.'), h('span', { style: { flex: 1 } }), h('label', { class: 'f', style: { margin: 0 } }, 'Points en cas d\'échec de mission'), I.fail),
    h('h3', { style: { marginTop: '1.2rem' } }, 'Tirage'),
    h('div', { class: 'row' }, field('Poids', I.weight), field('Effectif exact', I.exact, 'Vide = tiré au sort'), field('Plafond', I.max, 'Vide = illimité'), checkbox(perTeam, (v) => { perTeam = v; }, 'Effectif exact par équipe')),
    h('div', { class: 'row end', style: { marginTop: '1rem' } }, h('button', { class: 'btn', onclick: () => close() }, 'Annuler'),
      h('button', { class: 'btn btn-primary', onclick: async () => {
        const body = {
          name: I.name.value, icon: I.icon.value, color: I.color.value, enabled, is_impostor: isImp, wheel: I.wheel.value, fail_points: I.fail.value,
          weight: I.weight.value, exact_count: I.exact.value, max_count: I.max.value, per_team: perTeam, rewards: d.rewards,
          ...Object.fromEntries(['mission', 'description', 'objectives', 'allowed_actions', 'victory', 'conditions', 'penalties'].map((k) => [k, I[k].value])),
        };
        const r = await act(() => api(role ? '/api/host/roles/' + role.id : '/api/host/roles', { method: role ? 'PUT' : 'POST', body }), 'Rôle enregistré.');
        if (r) { close(); refresh(true); }
      } }, 'Enregistrer'))));
}

// ───────────── 4. Tirage & probabilités ─────────────
function drawSection() {
  const g = S.game, n = S.players.length;
  const rowsData = S.roles;
  const probCells = new Map();
  const inputs = new Map(); // roleId -> {enabled, exact, weight}
  const recalc = () => {
    let total = 0;
    for (const r of rowsData) { const v = inputs.get(r.id); if (v.enabled.checked && !(Number(v.exact.value) > 0)) total += Math.max(0, Number(v.weight.value) || 0); }
    for (const r of rowsData) {
      const v = inputs.get(r.id), cell = probCells.get(r.id);
      const fixed = Number(v.exact.value) > 0;
      const w = Math.max(0, Number(v.weight.value) || 0);
      const p = v.enabled.checked && !fixed && total > 0 ? w / total : 0;
      mount(cell, fixed ? h('span', { class: 'muted' }, 'effectif fixe') : h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('div', { class: 'bar', style: { flex: 1 } }, h('i', { style: { width: (p * 100).toFixed(1) + '%' } })), h('strong', { style: { minWidth: '4.5rem', textAlign: 'right' } }, v.enabled.checked ? fmtPct(p) : '—')));
    }
  };
  const save = (r, f) => doIt('/api/host/roles/' + r.id, 'PUT', f);
  const body = S.roles.map((r) => {
    const v = {
      enabled: h('input', { type: 'checkbox', checked: !!r.enabled, onchange: (e) => { recalc(); save(r, { enabled: e.target.checked }); } }),
      exact: h('input', { type: 'number', class: 'num', min: 0, value: r.exact_count ?? '', placeholder: '—', oninput: recalc, onchange: (e) => save(r, { exact_count: e.target.value }) }),
      perTeam: h('input', { type: 'checkbox', checked: !!r.per_team, onchange: (e) => save(r, { per_team: e.target.checked }) }),
      max: h('input', { type: 'number', class: 'num', min: 0, value: r.max_count ?? '', placeholder: '∞', onchange: (e) => save(r, { max_count: e.target.value }) }),
      weight: h('input', { type: 'number', class: 'num', min: 0, step: 0.1, value: r.weight, oninput: recalc, onchange: (e) => save(r, { weight: e.target.value }) }),
    };
    inputs.set(r.id, v);
    const cell = h('td', { style: { minWidth: '11rem' } }); probCells.set(r.id, cell);
    return h('tr', h('td', h('span', { style: { color: r.color, fontWeight: 700 } }, `${r.icon} ${r.name}`)), h('td', v.enabled), h('td', v.exact), h('td', g.teams_enabled ? v.perTeam : h('span', { class: 'muted' }, '—')), h('td', v.max), h('td', v.weight), cell);
  });
  const t = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', h('tr', ['Rôle', 'Actif', 'Effectif exact', 'Par équipe', 'Plafond', 'Poids', 'Probabilité de tirage'].map((x) => h('th', x)))), h('tbody', body)));
  queueMicrotask(recalc);

  const fixed = S.roles.filter((r) => r.enabled && r.exact_count > 0).reduce((s, r) => s + r.exact_count * (r.per_team && g.teams_enabled ? 2 : 1), 0);
  const simPlayers = h('input', { type: 'number', class: 'num', min: 1, max: 100, value: n || 10 }), simRuns = h('input', { type: 'number', class: 'num', min: 100, max: 5000, step: 100, value: 1000 });

  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', 'Probabilités de pioche & effectifs'),
      h('div', { class: 'note' }, h('strong', 'Comment ça marche : '), '1) les rôles à ', h('em', 'effectif exact'), ' sont attribués d\'abord (ex. exactement 1 Garde du corps par équipe). 2) Les autres joueurs reçoivent un rôle tiré au hasard selon le ', h('em', 'poids'), ' (probabilité = poids ÷ somme des poids), en respectant les ', h('em', 'plafonds'), '. Les pourcentages se recalculent automatiquement.'),
      h('div', { style: { height: '.8rem' } }), t,
      h('div', { class: 'row', style: { marginTop: '.8rem' } },
        h('button', { class: 'btn', onclick: () => doIt('/api/host/roles/normalize', 'POST', {}, 'Poids ramenés à un total de 100.') }, '∑ Normaliser à 100 (poids = %)'),
        h('span', { class: 'muted small' }, `${n} joueur(s) · ${fixed} place(s) à effectif fixe · ${Math.max(0, n - fixed)} tirée(s) au sort`))),
    h('div', { class: 'panel' }, h('h3', 'Simulation'), h('p', { class: 'muted small' }, 'Teste vos réglages sans toucher à la partie : répartition moyenne des rôles sur de nombreux tirages.'),
      h('div', { class: 'inline-form' }, h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('label', { class: 'f' }, 'Joueurs'), simPlayers), h('div', { class: 'field', style: { flex: '0 0 auto' } }, h('label', { class: 'f' }, 'Tirages'), simRuns),
        h('button', { class: 'btn btn-blue', onclick: async () => { const r = await act(() => api('/api/host/draw/simulate', { method: 'POST', body: { players: Number(simPlayers.value), runs: Number(simRuns.value) } })); if (r) { simResult = r; renderContent(); } } }, '▶ Simuler')),
      simResult ? h('div', { class: 'table-wrap', style: { marginTop: '.8rem' } }, h('table', { class: 'data' }, h('thead', h('tr', ['Rôle', 'Moyenne / partie', 'Min', 'Max'].map((x) => h('th', x)))),
        h('tbody', simResult.results.map((x) => { const r = roleOf(x.role_id); return r ? h('tr', h('td', `${r.icon} ${r.name}`), h('td', x.avg.toFixed(2)), h('td', x.min), h('td', x.max)) : null; })))) : null));
}

// ───────────── 5. Roues ─────────────
function wheelsSection() {
  const g = S.game;
  const newI = h('input', { placeholder: 'Nom de la nouvelle roue (ex. Espion)', maxlength: 40, 'aria-label': 'Nom de la nouvelle roue' });
  const create = async () => { if (await doIt('/api/host/wheels', 'POST', { label: newI.value }, 'Roue créée. Associez-la à un rôle dans « Rôles ».') !== undefined) newI.value = ''; };
  newI.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  return h('div', { class: 'stack' }, h('div', { class: 'note' }, 'Les roues sont indépendantes. Le tirage est effectué par le serveur ; le résultat n\'est visible que par le joueur concerné (et par vous). Vous pouvez choisir de le partager avec son équipe.'),
    h('div', { class: 'panel' }, h('h2', '➕ Créer une nouvelle roue'),
      h('p', { class: 'muted small' }, 'Créez autant de roues que vous voulez, puis associez-les à un rôle dans l\'onglet « Rôles » (champ « Roue »). Le joueur qui reçoit ce rôle verra sa roue dans son interface.'),
      h('div', { class: 'row' }, h('div', { class: 'field', style: { flex: '1 1 260px', margin: 0 } }, newI), h('button', { class: 'btn btn-primary', onclick: create }, '＋ Créer la roue'))),
    !Object.keys(S.wheels).length ? h('div', { class: 'empty' }, 'Aucune roue pour l\'instant. Créez-en une ci-dessus.') : null,
    Object.entries(S.wheels).map(([key, w]) => {
      const holders = S.players.filter((p) => roleOf(p.role_id)?.wheel === key);
      const spins = S.spins.filter((s) => s.wheel === key);
      const toggleExcluded = (pid, selectable) => {
        const ex = new Set(w.excluded); selectable ? ex.delete(pid) : ex.add(pid);
        doIt('/api/host/wheels/' + key, 'PUT', { excluded: [...ex] });
      };
      const usedBy = S.roles.filter((r) => r.wheel === key);
      const renameI = h('input', { value: w.label, maxlength: 40, 'aria-label': 'Renommer la roue', style: { width: '14rem' }, onchange: (e) => doIt('/api/host/wheels/' + key, 'PUT', { label: e.target.value }, 'Roue renommée.') });
      const del = async () => {
        const msg = usedBy.length ? `Supprimer la roue « ${w.label} » ? Les rôles qui l'utilisent (${usedBy.map((r) => r.name).join(', ')}) n'auront plus de roue, et ses tirages seront effacés.` : `Supprimer la roue « ${w.label} » ?`;
        if (await confirmDialog(msg, { danger: true })) doIt('/api/host/wheels/' + key, 'DELETE', {}, 'Roue supprimée.');
      };
      return h('div', { class: 'panel' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', { style: { margin: 0 } }, `🎡 Roue ${w.label}`), h('div', { class: 'row' }, renameI, h('button', { class: 'btn btn-danger btn-sm', onclick: del }, '🗑 Supprimer'))),
        h('p', { class: 'muted small' }, usedBy.length ? 'Utilisée par : ' + usedBy.map((r) => r.name).join(', ') : 'Aucun rôle n\'utilise encore cette roue : choisissez-la dans la fiche d\'un rôle.'),
        h('div', { class: 'row' }, checkbox(w.enabled, (v) => doIt('/api/host/wheels/' + key, 'PUT', { enabled: v }), 'Roue activée'),
          h('div', { class: 'row' }, h('span', 'Cibles :'), h('select', { onchange: (e) => doIt('/api/host/wheels/' + key, 'PUT', { rule: e.target.value }) },
            [['opponents', 'Équipe adverse'], ['teammates', 'Mon équipe'], ['all', 'Tous les autres joueurs']].map(([v, l]) => h('option', { value: v, selected: w.rule === v }, l)))),
          h('div', { class: 'row' }, h('span', 'Lancers par joueur :'), numInput(w.max_spins, (v) => doIt('/api/host/wheels/' + key, 'PUT', { max_spins: v }), { min: 1, max: 20 })),
          checkbox(w.share_team, (v) => doIt('/api/host/wheels/' + key, 'PUT', { share_team: v }), 'Partager le résultat avec les coéquipiers')),
        !g.teams_enabled && w.rule !== 'all' ? h('div', { class: 'note warn', style: { marginTop: '.6rem' } }, 'Les équipes sont désactivées : la roue propose tous les autres joueurs.') : null,
        h('h3', { style: { marginTop: '1rem' } }, 'Joueurs sélectionnables'),
        h('p', { class: 'muted small' }, 'Décochez un joueur pour qu\'il ne puisse jamais être tiré par cette roue.'),
        h('div', { class: 'row' }, S.players.length ? S.players.map((p) => h('label', { class: 'badge b-lobby', style: { cursor: 'pointer', textTransform: 'none' } }, h('input', { type: 'checkbox', checked: !w.excluded.includes(p.id), onchange: (e) => toggleExcluded(p.id, e.target.checked) }), ' ' + p.name)) : h('span', { class: 'muted' }, 'Aucun joueur.')),
        h('h3', { style: { marginTop: '1rem' } }, 'Tirages effectués'),
        spins.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', h('tr', ['Joueur', 'Cible tirée', 'Quand', ''].map((x) => h('th', x)))),
          h('tbody', spins.map((s) => h('tr', h('td', s.player), h('td', h('strong', s.target)), h('td', fmtDate(s.created_at)),
            h('td', h('button', { class: 'btn btn-sm', onclick: () => doIt(`/api/host/wheels/${key}/reset`, 'POST', { player_id: s.player_id }, 'Roue réinitialisée pour ce joueur.') }, 'Réinitialiser'))))))) : h('div', { class: 'empty' }, 'Aucun tirage pour l\'instant.'),
        h('div', { class: 'row', style: { marginTop: '.6rem' } }, holders.length ? h('span', { class: 'muted small' }, 'Porteurs du rôle : ', h('span', { class: blurRoles ? 'blur-role' : '', onclick: (e) => e.currentTarget.classList.toggle('show') }, holders.map((p) => p.name).join(', '))) : h('span', { class: 'muted small' }, 'Aucun joueur n\'a de rôle avec cette roue.'),
          h('span', { style: { flex: 1 } }), h('button', { class: 'btn btn-danger btn-sm', onclick: async () => { if (await confirmDialog(`Réinitialiser la roue ${w.label} pour tous les joueurs ?`, { danger: true })) doIt(`/api/host/wheels/${key}/reset`, 'POST', {}, 'Roue réinitialisée.'); } }, '⟲ Réinitialiser la roue')));
    }));
}

// ───────────── 6. Missions ─────────────
const kindOfReward = (type) => (type === 'bonus' ? 'bonus' : type === 'penalty' ? 'malus' : 'mission_success');

function missionsSection() {
  const pending = S.claims.filter((c) => c.status === 'pending');
  const done = S.claims.filter((c) => c.status !== 'pending').slice(0, 15);
  const sel = playerSelect('mission_player');
  const rewardBox = h('div');
  const drawRewards = () => {
    const pid = Number(sel.value), p = S.players.find((x) => x.id === pid), role = p && roleOf(p.role_id);
    mount(rewardBox, !p ? h('div', { class: 'empty' }, 'Aucun joueur.') : !role ? h('div', { class: 'empty' }, 'Ce joueur n\'a pas encore de rôle.') : h('div',
      h('p', { class: 'muted small' }, 'Rôle : ', h('span', { class: blurRoles ? 'blur-role' : '', onclick: (e) => e.currentTarget.classList.toggle('show') }, role.name)),
      role.rewards.map((r) => h('div', { class: 'reward-row' }, h('span', r.label, h('span', { class: 'muted small' }, ` · ${{ mission: 'mission', secondary: 'secondaire', bonus: 'bonus', penalty: 'pénalité' }[r.type]}`)),
        h('span', { class: 'row' }, h('span', { class: 'pts ' + (r.points >= 0 ? 'p' : 'm') }, signed(r.points)),
          h('button', { class: 'btn btn-sm btn-blue', onclick: () => doIt('/api/host/score', 'POST', { player_id: pid, kind: kindOfReward(r.type), points: r.points, comment: (r.type === 'penalty' ? 'Pénalité : ' : 'Mission validée : ') + r.label }, 'Points attribués.') }, 'Appliquer')))),
      h('div', { style: { marginTop: '.6rem' } }, h('button', { class: 'btn btn-sm btn-danger', onclick: () => doIt('/api/host/score', 'POST', { player_id: pid, kind: 'mission_fail', points: role.fail_points || 0, comment: 'Mission échouée' }, 'Échec enregistré.') }, `Mission échouée (${signed(-Math.abs(role.fail_points || 0))} pt)`))));
  };
  sel.onchange = drawRewards;
  queueMicrotask(drawRewards);

  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', `Demandes de validation (${pending.length})`),
      pending.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('tbody', pending.map((c) => h('tr', h('td', fmtDate(c.created_at)), h('td', h('strong', c.player)), h('td', c.label), h('td', { class: 'r pts ' + (c.points >= 0 ? 'p' : 'm') }, signed(c.points)),
        h('td', h('div', { class: 'row end' }, h('button', { class: 'btn btn-sm btn-blue', onclick: () => doIt(`/api/host/claims/${c.id}/approve`, 'POST', {}, 'Mission validée.') }, '✔ Valider'), h('button', { class: 'btn btn-sm btn-danger', onclick: () => doIt(`/api/host/claims/${c.id}/reject`, 'POST', {}, 'Demande refusée.') }, '✕ Refuser')))))))) : h('div', { class: 'empty' }, 'Aucune demande en attente.'),
      done.length ? h('details', h('summary', { class: 'muted' }, 'Dernières demandes traitées'), h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('tbody', done.map((c) => h('tr', h('td', fmtDate(c.created_at)), h('td', c.player), h('td', c.label), h('td', h('span', { class: 'badge b-' + c.status }, c.status === 'approved' ? 'Validée' : 'Refusée'))))))) ) : null),
    h('div', { class: 'panel' }, h('h2', 'Valider une mission pour un joueur'), h('div', { class: 'field' }, h('label', { class: 'f' }, 'Joueur'), sel), rewardBox),
    h('div', { class: 'panel' }, h('h2', 'Missions & objectifs par rôle'), h('p', { class: 'muted small' }, 'Textes, objectifs et points sont modifiables via « Modifier ».'),
      h('div', { class: 'grid cols2' }, S.roles.map((r) => h('div', { class: 'panel', style: { margin: 0, borderColor: r.color } },
        h('div', { class: 'row between' }, h('strong', { style: { color: r.color } }, `${r.icon} ${r.name}`), h('button', { class: 'btn btn-sm', onclick: () => openRoleEditor(r) }, 'Modifier')),
        h('p', { class: 'small' }, r.mission || h('span', { class: 'muted' }, 'Pas de mission définie.')),
        lines(r.objectives).length ? h('ul', { class: 'small', style: { margin: '.3rem 0', paddingLeft: '1.1rem' } }, lines(r.objectives).map((o) => h('li', o))) : null,
        r.rewards.map((x) => h('div', { class: 'reward-row small' }, h('span', x.label), h('span', { class: 'pts ' + (x.points >= 0 ? 'p' : 'm') }, signed(x.points)))))))));
}

// ───────────── 7. Points ─────────────
function pointsSection() {
  const sel = playerSelect('pt_player');
  const kind = h('select', [['points+', 'Ajouter des points'], ['points-', 'Retirer des points'], ['bonus', 'Bonus'], ['malus', 'Malus / pénalité'], ['mission_success', 'Mission réussie'], ['mission_fail', 'Mission échouée']].map(([v, l]) => h('option', { value: v }, l)));
  const amount = h('input', { type: 'number', value: 5, class: 'num', min: 0, max: 100000 });
  const comment = h('input', { placeholder: 'Commentaire (explication visible dans l\'historique)', maxlength: 300 });
  const submit = async () => {
    if (!S.players.length) return;
    let k = kind.value, pts = Math.abs(Number(amount.value) || 0);
    if (k === 'points+') k = 'points'; else if (k === 'points-') { k = 'points'; pts = -pts; }
    await doIt('/api/host/score', 'POST', { player_id: Number(sel.value), kind: k, points: pts, comment: comment.value }, 'Points enregistrés.');
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', 'Gestion des points'),
      h('div', { class: 'grid cols2' }, field('Joueur', sel), field('Type', kind), field('Nombre de points', amount), field('Commentaire', comment)),
      h('div', { class: 'row end' }, h('button', { class: 'btn btn-primary btn-lg', disabled: !S.players.length, onclick: submit }, '➕ Ajouter des points'))),
    h('div', { class: 'panel' }, h('h3', 'Dernières modifications'),
      S.events.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', h('tr', ['Quand', 'Joueur', 'Type', 'Points', 'Commentaire', ''].map((x) => h('th', x)))),
        h('tbody', S.events.slice(0, 40).map((e) => h('tr', h('td', fmtDate(e.created_at)), h('td', e.player), h('td', { points: 'Points', mission_success: 'Mission réussie', mission_fail: 'Mission échouée', bonus: 'Bonus', malus: 'Malus' }[e.kind]),
          h('td', { class: e.points >= 0 ? 'pos' : 'neg' }, signed(e.points)), h('td', { class: 'small muted' }, e.comment), h('td', h('button', { class: 'btn btn-sm btn-danger btn-icon', title: 'Annuler cette modification', onclick: async () => { if (await confirmDialog('Annuler cette modification de score ?', { danger: true })) doIt('/api/host/score/events/' + e.id, 'DELETE', {}, 'Modification annulée.'); } }, '↶'))))))) : h('div', { class: 'empty' }, 'Aucun point attribué pour l\'instant.')));
}

// ───────────── 8. Classement ─────────────
function rankingSection() {
  const g = S.game;
  const cmt = h('input', { placeholder: 'Commentaire pour la prochaine modification (optionnel)', value: rankComment, maxlength: 200, oninput: (e) => { rankComment = e.target.value; } });
  return h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'Tableau des scores'), h('span', { class: 'muted small' }, 'Mise à jour en temps réel')),
    h('div', { style: { height: '.8rem' } }), teamBar(g, S.team_totals),
    S.ranking.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', h('tr', ['#', 'Joueur', 'Équipe', 'Points', 'Réussies', 'Échouées', 'Bonus', 'Malus', 'Total (modifiable)'].map((x, i) => h('th', { class: i > 2 ? 'r' : '' }, x)))),
      h('tbody', S.ranking.map((r) => h('tr', h('td', { class: `rank rank-${r.rank}` }, r.rank), h('td', r.name), h('td', { class: 'team-' + r.team }, teamName(g, r.team)),
        h('td', { class: 'r' }, r.points), h('td', { class: 'r' }, r.success), h('td', { class: 'r' }, r.fail), h('td', { class: 'r pos' }, r.bonus), h('td', { class: 'r neg' }, r.malus),
        h('td', { class: 'r' }, h('input', { type: 'number', class: 'num', value: r.total, 'aria-label': `Total de ${r.name}`, onchange: (e) => doIt('/api/host/score/set-total', 'POST', { player_id: r.id, total: e.target.value, comment: rankComment }, 'Score modifié.') }))))))) : h('div', { class: 'empty' }, 'Aucun joueur.'),
    h('div', { class: 'field', style: { marginTop: '.8rem' } }, cmt),
    h('div', { class: 'row', style: { marginTop: '.4rem' } }, h('a', { class: 'btn', href: '/api/host/export.csv', download: '' }, '⬇ Exporter le classement (CSV)'),
      h('button', { class: 'btn', onclick: () => copy(S.ranking.map((r) => `${r.rank}. ${r.name} — ${r.total} pts`).join('\n'), 'Classement copié.') }, '📋 Copier le classement'),
      h('span', { style: { flex: 1 } }), h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Réinitialiser TOUS les scores de cette partie ?', { danger: true, okLabel: 'Réinitialiser' })) doIt('/api/host/score/reset', 'POST', {}, 'Scores réinitialisés.'); } }, '⟲ Réinitialiser les scores')));
}

// ───────────── 9. Historique ─────────────
function historySection() {
  const ended = S.games.filter((x) => x.status === 'ended');
  return h('div', { class: 'stack' },
    h('div', { class: 'panel' }, h('h2', 'Historique des parties'),
      S.games.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', h('tr', ['Partie', 'Statut', 'Joueurs', 'Terminée le', ''].map((x) => h('th', x)))),
        h('tbody', S.games.map((x) => h('tr', h('td', x.name), h('td', statusBadge(x.status)), h('td', x.players), h('td', fmtDate(x.ended_at)),
          h('td', x.status === 'ended' ? h('button', { class: 'btn btn-sm', onclick: async () => { const d = await act(() => api('/api/public/games/' + x.id)); if (d) { pastGame = d; renderContent(); } } }, 'Voir le classement final') : null)))))) : null,
      !ended.length ? h('p', { class: 'muted small' }, 'Les parties terminées apparaîtront ici.') : null,
      pastGame ? h('div', { style: { marginTop: '1rem' } }, h('h3', pastGame.game.name), scoreTable(pastGame.ranking, pastGame.game)) : null),
    h('div', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', { style: { margin: 0 } }, 'Journal des modifications'),
      h('select', { style: { width: 'auto' }, onchange: async (e) => { auditScope = e.target.value; auditRows = await api('/api/host/audit?scope=' + auditScope + '&limit=200'); renderContent(); } },
        h('option', { value: 'current', selected: auditScope === 'current' }, 'Partie active'), h('option', { value: 'all', selected: auditScope === 'all' }, 'Toutes les parties'))),
      auditRows.length ? h('div', { class: 'table-wrap', style: { marginTop: '.6rem' } }, h('table', { class: 'data' }, h('thead', h('tr', ['Date', 'Auteur', 'Action', 'Détail'].map((x) => h('th', x)))),
        h('tbody', auditRows.map((a) => h('tr', h('td', fmtDate(a.at)), h('td', a.actor), h('td', a.action), h('td', { class: 'small muted' }, a.detail)))))) : h('div', { class: 'empty' }, 'Journal vide.')));
}

boot();
