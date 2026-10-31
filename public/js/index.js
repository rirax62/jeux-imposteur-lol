import { h, mount, api, act, live, scoreTable, teamBar, statusBadge, brand, connDot, fmtDate, fail, $ } from './common.js';

const app = $('#app');
const conn = connDot();
let state = null, history = [], openGame = null, codeValue = '';

const stored = () => { try { return localStorage.getItem('player_token'); } catch { return null; } };

async function join(code) {
  const r = await act(() => api('/api/join', { method: 'POST', body: { code } }));
  if (!r) return;
  try { localStorage.setItem('player_token', r.token); } catch { /* stockage indisponible */ }
  location.href = '/j/' + r.token;
}

async function load() {
  try {
    [state, history] = await Promise.all([api('/api/public/state'), api('/api/public/history')]);
    render();
  } catch (e) { fail(e); }
}

function render() {
  const g = state.game;
  const hadFocus = document.activeElement?.classList?.contains('codebox');
  const input = h('input', { class: 'codebox', placeholder: 'XXXX-XXXX', maxlength: 120, autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Code personnel', value: codeValue, oninput: (e) => { codeValue = e.target.value; } });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); join(input.value); } },
    h('div', { class: 'field' }, input),
    h('button', { class: 'btn btn-primary btn-lg', style: { width: '100%' } }, 'Entrer dans l\'arène'));
  const saved = stored();

  mount(app,
    h('div', { class: 'topbar' }, brand(), h('div', { class: 'row' }, conn.el, h('a', { class: 'btn btn-sm', href: '/host' }, 'Espace hôte'))),
    h('div', { class: 'wrap' },
      h('div', { class: 'hero' }, h('h1', 'Hextech Roles'), h('p', { class: 'muted' }, 'Votre rôle secret vous attend. Entrez votre code personnel pour le découvrir.')),
      h('div', { class: 'grid cols2' },
        h('div', { class: 'panel' }, h('h2', 'Accès joueur'), form,
          saved ? h('p', { class: 'center', style: { marginTop: '1rem' } }, h('a', { class: 'btn', href: '/j/' + saved }, '↩ Reprendre ma session')) : null,
          h('p', { class: 'muted small' }, 'Votre code (ou votre lien personnel) vous a été transmis par l\'hôte. Ne le partagez avec personne : il donne accès à votre rôle.')),
        h('div', { class: 'panel' }, h('h2', g.name), h('div', { class: 'row' }, statusBadge(g.status), h('span', { class: 'muted' }, `${state.players.length} joueur(s)`)),
          g.status === 'lobby' ? h('p', { class: 'muted waiting' }, 'La partie se prépare… les rôles seront bientôt distribués.') : null)),
      h('div', { class: 'panel' }, h('h2', 'Classement général'), teamBar(g, state.team_totals), scoreTable(state.ranking, g, { meId: null }),
        h('p', { class: 'muted small' }, 'Les rôles des joueurs restent secrets et n\'apparaissent jamais ici.')),
      history.length ? h('div', { class: 'panel' }, h('h2', 'Historique des parties'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', h('tr', ['Partie', 'Terminée le', 'Joueurs', 'Podium', ''].map((t) => h('th', t)))),
          h('tbody', history.map((x) => h('tr', h('td', x.name), h('td', fmtDate(x.ended_at)), h('td', x.players),
            h('td', x.podium.map((p, i) => `${['🥇', '🥈', '🥉'][i]} ${p.name} (${p.total})`).join('  ')),
            h('td', h('button', { class: 'btn btn-sm', onclick: () => showGame(x.id) }, 'Détails'))))))),
        openGame ? h('div', { style: { marginTop: '1rem' } }, h('h3', openGame.game.name), scoreTable(openGame.ranking, openGame.game),
          openGame.game.roles_revealed ? h('div', { class: 'note' }, 'Rôles révélés : ', openGame.players.map((p) => `${p.name} = ${p.role_name || '—'}`).join(' · ')) : null) : null) : null));
  if (hadFocus) $('.codebox').focus();
}

async function showGame(id) {
  const d = await act(() => api('/api/public/games/' + id));
  if (d) { openGame = d; render(); }
}

load();
live('public', null, { scores: load, game: load, status: conn.set });
