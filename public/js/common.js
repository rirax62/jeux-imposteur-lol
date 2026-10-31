// Utilitaires partagés. AUCUN innerHTML avec des données : tout passe par h() / textContent (anti-XSS).
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/** Mini hyperscript : h('div', {class:'x', onclick: fn}, 'texte', enfant, ...) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) el[k] = true; }
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); kids.flat().forEach((k) => k && el.appendChild(k)); return el; };

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Player-Token'] = token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), credentials: 'same-origin' });
  } catch {
    throw new ApiError('Connexion au serveur impossible. Vérifiez votre réseau.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Erreur ${res.status}`, res.status);
  return data;
}

export function toast(msg, type = '') {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
  const t = h('div', { class: 'toast ' + type }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
}
export const fail = (e) => toast(e.message || String(e), 'err');

/** Exécute une action serveur avec retour utilisateur. */
export async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { fail(e); return undefined; }
}

/** Flux temps réel avec reconnexion automatique. handlers: { scores, game, me, host, status(connected) } */
export function live(scope, token, handlers) {
  let es, timer;
  const open = () => {
    es = new EventSource(`/api/events?scope=${scope}` + (token ? `&t=${encodeURIComponent(token)}` : ''));
    es.addEventListener('hello', () => handlers.status?.(true));
    for (const t of ['scores', 'game', 'me', 'host']) es.addEventListener(t, () => handlers[t]?.());
    es.onerror = () => { handlers.status?.(false); es.close(); clearTimeout(timer); timer = setTimeout(open, 3000); };
  };
  open();
  return () => { es?.close(); clearTimeout(timer); };
}

export const fmtCode = (c) => (c ? c.slice(0, 4) + '-' + c.slice(4) : '');
export const fmtDate = (t) => (t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtPct = (x) => (x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
export const signed = (n) => (n > 0 ? '+' + n : String(n));
export const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean);
export const STATUS = { lobby: 'Préparation', distributed: 'Rôles distribués', running: 'En cours', ended: 'Terminée' };
export const teamName = (game, t) => (t === 0 ? game.team_a : t === 1 ? game.team_b : '—');
export const statusBadge = (s) => h('span', { class: 'badge b-' + s }, STATUS[s] || s);

export async function copy(text, msg = 'Copié !') {
  try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(msg, 'ok'); } catch { toast('Copie impossible : sélectionnez le texte manuellement.', 'err'); }
    ta.remove();
  }
}

export function confirmDialog(message, { danger = false, okLabel = 'Confirmer' } = {}) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'modal-bg', onclick: (e) => e.target === bg && close(false) },
      h('div', { class: 'panel modal', style: { maxWidth: '460px', marginTop: '15vh' }, role: 'alertdialog' },
        h('p', message),
        h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Annuler'),
          h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => close(true) }, okLabel))));
    document.body.appendChild(bg);
    bg.querySelector('.btn-primary, .btn-danger').focus();
  });
}

export function modal(content, { onClose } = {}) {
  const close = () => { bg.remove(); onClose?.(); };
  const bg = h('div', { class: 'modal-bg', onclick: (e) => e.target === bg && close() }, h('div', { class: 'panel modal' }, content));
  document.body.appendChild(bg);
  return close;
}

export function scoreTable(ranking, game, { meId = null, compact = false } = {}) {
  if (!ranking.length) return h('div', { class: 'empty' }, 'Aucun joueur pour le moment.');
  const th = (t, r) => h('th', { class: r ? 'r' : '' }, t);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', h('tr', th('#'), th('Joueur'), compact ? null : th('Équipe'), th('Points', 1), th('Réussies', 1), th('Échouées', 1), th('Bonus', 1), th('Malus', 1), th('Total', 1))),
    h('tbody', ranking.map((r) => h('tr', { class: r.id === meId ? 'me' : '' },
      h('td', { class: `rank rank-${r.rank}` }, r.rank),
      h('td', r.name),
      compact ? null : h('td', { class: 'team-' + r.team }, teamName(game, r.team)),
      h('td', { class: 'r' }, r.points), h('td', { class: 'r' }, r.success), h('td', { class: 'r' }, r.fail),
      h('td', { class: 'r pos' }, r.bonus ? signed(r.bonus) : '0'), h('td', { class: 'r neg' }, r.malus || '0'),
      h('td', { class: 'r' }, h('strong', r.total)))))));
}

export function teamBar(game, totals) {
  if (!game.teams_enabled) return null;
  return h('div', { class: 'row between', style: { marginBottom: '.8rem' } },
    h('span', { class: 'team-0' }, `${game.team_a} : `, h('strong', totals[0])),
    h('span', { class: 'team-1' }, `${game.team_b} : `, h('strong', totals[1])));
}

export const brand = (href = '/') => h('a', { class: 'brand', href },
  h('img', { class: 'logo', src: '/favicon.svg', alt: '' }), 'Hextech Roles');

export function connDot() {
  const d = h('span', { class: 'dot', title: 'Synchronisation temps réel' });
  const lab = h('span', { class: 'small muted' }, 'connexion…');
  return { el: h('span', d, lab), set: (ok) => { d.className = 'dot ' + (ok ? 'on' : 'off'); lab.textContent = ok ? 'en direct' : 'reconnexion…'; } };
}
