# Hextech Roles — Randomizer de rôles (League of Legends)

Application web complète : serveur Node.js, base SQLite persistante, tirages côté serveur, accès joueurs par lien/code personnel, espace hôte, roues animées, scores en temps réel.

## Démarrage
Prérequis : Node.js 22.13 ou plus récent. Aucune dépendance à installer.

    npm start

- Joueurs : http://localhost:3000
- Hôte : http://localhost:3000/host (au premier accès, vous créez le mot de passe hôte, 8 caractères min.)

Variables optionnelles : PORT, DATA_DIR (dossier de la base), HOST_PASSWORD (mot de passe initial),
TRUST_PROXY=1 et COOKIE_SECURE=1 (derrière un proxy HTTPS).

## Utilisation
1. Joueurs : ajoutez les joueurs, copiez les liens personnels (ou les codes XXXX-XXXX) et transmettez-les.
2. Rôles / Tirage : modifiez textes, points, poids, effectifs exacts, plafonds. Les % se recalculent seuls.
3. Partie : « Distribuer les rôles » puis « Lancer la partie ».
4. Les joueurs cliquent « Révéler mon rôle », lancent leur roue, demandent la validation de missions.
5. Vous validez, ajoutez/retirez des points, exportez le classement (CSV), puis « Terminer la partie ».

## Mise en ligne
Hébergez sur un serveur Node (VPS, Render, Railway… avec disque persistant pour DATA_DIR) derrière HTTPS.
Pour jouer entre amis à distance sans hébergement, un tunnel (ex. cloudflared) vers le port 3000 suffit.

## Confidentialité
- Rôles et tirages stockés et calculés côté serveur (crypto.randomInt).
- L'API n'envoie le rôle qu'au joueur concerné, et seulement après « Révéler mon rôle ». Poids/effectifs ne sont jamais envoyés aux joueurs.
- Les événements temps réel ne contiennent aucune donnée ; les clients rechargent via l'API autorisée.
- Hôte : session par cookie HttpOnly, mot de passe haché (scrypt), limitation des tentatives, protection CSRF.
- Sauvegardes automatiques dans data/backups (au démarrage puis toutes les 6 h) + téléchargement manuel.

## Tests
    npm test
