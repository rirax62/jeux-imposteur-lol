// Synchronisation temps réel (Server-Sent Events).
// Les événements ne transportent JAMAIS de données confidentielles : seulement un type,
// les clients rechargent ensuite leurs données via l'API (qui applique les permissions).
const clients = new Set(); // { res, scope: 'host'|'player'|'public', playerId, gameId }

export function addClient(res, info) {
  const c = { res, ...info };
  clients.add(c);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignoré */ }
  }, 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
  });
  res.write('retry: 3000\n\n');
  res.write('event: hello\ndata: {}\n\n');
}

/**
 * type : 'scores' | 'game' | 'me' | 'host'
 * - scores / game : tout le monde ; me : joueurs (un seul si playerId, sinon tous ceux de la partie) ; host : hôte uniquement.
 */
export function emit(type, { gameId = null, playerId = null } = {}) {
  const msg = `event: ${type}\ndata: {}\n\n`;
  for (const c of clients) {
    let ok = false;
    if (type === 'scores' || type === 'game') ok = true;
    else if (type === 'host') ok = c.scope === 'host';
    else if (type === 'me') ok = c.scope === 'player' && (playerId ? c.playerId === playerId : gameId ? c.gameId === gameId : true);
    if (!ok) continue;
    try { c.res.write(msg); } catch { /* ignoré */ }
  }
  // Toute action de jeu doit aussi rafraîchir le tableau de bord de l'hôte.
  if (type !== 'host') {
    for (const c of clients) if (c.scope === 'host') { try { c.res.write('event: host\ndata: {}\n\n'); } catch { /* ignoré */ } }
  }
}
