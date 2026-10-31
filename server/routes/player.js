import { route, HttpError } from '../http.js';
import { run, get, audit } from '../db.js';
import { playerView, spinWheel, createClaim } from '../services.js';
import { emit } from '../events.js';

const A = { auth: 'player' };

route('GET', '/api/me', A, ({ player }) => playerView(player));

// « Révéler mon rôle » : le rôle n'est envoyé au client qu'après cet appel.
route('POST', '/api/me/reveal', A, ({ player }) => {
  const game = get('SELECT * FROM games WHERE id=?', player.game_id);
  if (game.status === 'lobby' || !player.role_id) throw new HttpError(409, 'Les rôles n\'ont pas encore été distribués.');
  if (!player.revealed) {
    run('UPDATE players SET revealed=1, revealed_at=? WHERE id=?', Date.now(), player.id);
    audit(game.id, player.name, 'Rôle révélé par le joueur', '');
    emit('host', { gameId: game.id });
  }
  return playerView(get('SELECT * FROM players WHERE id=?', player.id));
});

// « Lancer ma roue » : tirage 100 % côté serveur ; le résultat n'est visible que du joueur (et de l'hôte).
route('POST', '/api/me/wheel/spin', A, ({ player }) => {
  const r = spinWheel(player);
  const game = get('SELECT * FROM games WHERE id=?', player.game_id);
  audit(game.id, player.name, 'Roue lancée', `Cible : ${r.target.name}`);
  emit('me', { gameId: game.id }); // coéquipiers éventuels (si partage activé)
  emit('host', { gameId: game.id });
  return r;
});

// « Valider une mission » : demande envoyée à l'hôte, qui l'approuve ou la refuse.
route('POST', '/api/me/claims', A, ({ player, body }) => {
  const id = createClaim(player, String(body.reward_id || ''));
  emit('host', { gameId: player.game_id });
  return { id };
});
