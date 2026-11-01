// Algorithme de distribution des rôles — module pur (sans base de données), testable.
// Tous les tirages utilisent le générateur cryptographique de Node (crypto.randomInt).
import { randomInt } from 'node:crypto';

export function shuffle(arr, rnd = randomInt) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Tirage pondéré : renvoie l'index choisi dans items (chaque item a .weight > 0). */
export function pickWeighted(items, rnd = randomInt) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  const SCALE = 1_000_000_000;
  let r = (rnd(SCALE) / SCALE) * total;
  for (let i = 0; i < items.length; i++) {
    r -= items[i].weight;
    if (r < 0) return i;
  }
  return items.length - 1;
}

const isExact = (r) => Number(r.exact_count) > 0;

/** Probabilités affichées : poids / somme des poids des rôles « tirés au sort » activés. */
export function probabilities(roles) {
  const pool = roles.filter((r) => r.enabled && !isExact(r) && r.weight > 0);
  const total = pool.reduce((s, r) => s + r.weight, 0);
  const out = {};
  for (const r of roles) out[r.id] = pool.includes(r) && total > 0 ? r.weight / total : 0;
  return out;
}

/**
 * players : [{id, team}]  roles : lignes de la table roles.
 * Étape 1 : rôles à effectif exact (éventuellement « par équipe »).
 * Étape 2 : joueurs restants, tirage pondéré parmi les rôles activés non « exacts » (plafond max_count respecté).
 * Retourne Map(playerId -> roleId). Lance une Error (message en français) si impossible.
 */
export function distribute(players, roles, rnd = randomInt) {
  const active = roles.filter((r) => r.enabled);
  if (!players.length) throw new Error('Aucun joueur dans la partie.');
  if (!active.length) throw new Error('Aucun rôle activé.');

  const assign = new Map();
  const counts = new Map(active.map((r) => [r.id, 0]));
  const free = new Set(players.map((p) => p.id));
  const teamOf = new Map(players.map((p) => [p.id, p.team ?? null]));

  const takeFrom = (candidateIds, role, n, label) => {
    if (candidateIds.length < n)
      throw new Error(
        `Pas assez de joueurs${label} pour le rôle « ${role.name} » (${n} demandé(s), ${candidateIds.length} disponible(s)).`
      );
    for (const id of shuffle(candidateIds, rnd).slice(0, n)) {
      assign.set(id, role.id);
      free.delete(id);
      counts.set(role.id, counts.get(role.id) + 1);
    }
  };

  // Étape 1 — effectifs exacts (ordre aléatoire des rôles pour ne favoriser personne en cas de pénurie)
  for (const role of shuffle(active.filter(isExact), rnd)) {
    const n = Number(role.exact_count);
    if (role.per_team) {
      const teams = [...new Set(players.map((p) => p.team ?? null))];
      for (const t of teams) {
        const ids = [...free].filter((id) => teamOf.get(id) === t);
        takeFrom(ids, role, n, t === null ? '' : ` dans l'équipe ${t === 0 ? 'A' : 'B'}`);
      }
    } else {
      takeFrom([...free], role, n, '');
    }
  }

  // Étape 2 — tirage pondéré des joueurs restants
  for (const pid of shuffle([...free], rnd)) {
    const pool = active.filter(
      (r) => !isExact(r) && r.weight > 0 && (!(Number(r.max_count) > 0) || counts.get(r.id) < Number(r.max_count))
    );
    if (!pool.length)
      throw new Error(
        'Pas assez de rôles disponibles pour tous les joueurs : augmentez un plafond, un poids, ou activez un rôle sans limite (ex. « Super Héro »).'
      );
    const role = pool[pickWeighted(pool, rnd)];
    assign.set(pid, role.id);
    counts.set(role.id, counts.get(role.id) + 1);
  }
  return assign;
}

/** Simulation statistique pour aider l'hôte à régler ses poids. */
export function simulate(players, roles, runs = 1000) {
  const stats = new Map(roles.map((r) => [r.id, { sum: 0, min: Infinity, max: 0 }]));
  let ok = 0;
  let lastError = null;
  for (let i = 0; i < runs; i++) {
    try {
      const a = distribute(players, roles);
      const c = new Map();
      for (const rid of a.values()) c.set(rid, (c.get(rid) || 0) + 1);
      for (const r of roles) {
        const n = c.get(r.id) || 0;
        const s = stats.get(r.id);
        s.sum += n;
        s.min = Math.min(s.min, n);
        s.max = Math.max(s.max, n);
      }
      ok++;
    } catch (e) {
      lastError = e.message;
    }
  }
  if (!ok) throw new Error(lastError || 'Simulation impossible.');
  return roles.map((r) => {
    const s = stats.get(r.id);
    return { role_id: r.id, avg: s.sum / ok, min: s.min === Infinity ? 0 : s.min, max: s.max };
  });
}
