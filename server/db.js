import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
export const DB_FILE = path.join(DATA_DIR, 'app.db');

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS host_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mission TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  objectives TEXT NOT NULL DEFAULT '',
  allowed_actions TEXT NOT NULL DEFAULT '',
  victory TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  penalties TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 10,
  exact_count INTEGER,
  max_count INTEGER,
  per_team INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  wheel TEXT NOT NULL DEFAULT '',
  fail_points INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#c8aa6e',
  icon TEXT NOT NULL DEFAULT '⚔️',
  rewards TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  is_impostor INTEGER NOT NULL DEFAULT 0          -- rôle « imposteur » du vote de fin de partie
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',          -- lobby | distributed | running | ended
  team_a TEXT NOT NULL DEFAULT 'Équipe Bleue',
  team_b TEXT NOT NULL DEFAULT 'Équipe Rouge',
  teams_enabled INTEGER NOT NULL DEFAULT 1,
  roles_revealed INTEGER NOT NULL DEFAULT 0,     -- rôles publics après la fin de partie
  votes_state TEXT NOT NULL DEFAULT 'none',      -- none | open | closed (vote de fin de partie)
  votes_applied TEXT NOT NULL DEFAULT '[]',      -- ids des évènements de score créés par la clôture du vote
  votes_result TEXT NOT NULL DEFAULT 'null',     -- résultat figé à la clôture
  created_at INTEGER NOT NULL,
  distributed_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  team INTEGER,                                   -- 0 = équipe A, 1 = équipe B, NULL = aucune
  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  role_name TEXT,
  revealed INTEGER NOT NULL DEFAULT 0,
  revealed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);

CREATE TABLE IF NOT EXISTS score_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                             -- points | mission_success | mission_fail | bonus | malus
  points INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'hôte',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_game ON score_events(game_id);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reward_id TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  points INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | approved | rejected
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS wheel_config (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  wheel TEXT NOT NULL,                            -- bodyguard | observer
  enabled INTEGER NOT NULL DEFAULT 1,
  rule TEXT NOT NULL DEFAULT 'opponents',         -- opponents | teammates | all
  excluded TEXT NOT NULL DEFAULT '[]',            -- ids de joueurs non sélectionnables
  max_spins INTEGER NOT NULL DEFAULT 1,
  share_team INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, wheel)
);

CREATE TABLE IF NOT EXISTS votes (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  voter_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (voter_id, target_id)
);

CREATE TABLE IF NOT EXISTS wheel_defs (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wheel_spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  wheel TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_game ON audit(game_id);
`);

export function getSetting(key, def = null) {
  const r = get('SELECT value FROM settings WHERE key=?', key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

export function audit(gameId, actor, action, detail = '') {
  run('INSERT INTO audit(game_id,at,actor,action,detail) VALUES(?,?,?,?,?)', gameId ?? null, Date.now(), actor, action, String(detail).slice(0, 1000));
}


// --- Migrations légères pour une base créée avant le vote de fin de partie ---
for (const sql of [
  "ALTER TABLE games ADD COLUMN votes_state TEXT NOT NULL DEFAULT 'none'",
  "ALTER TABLE games ADD COLUMN votes_applied TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE games ADD COLUMN votes_result TEXT NOT NULL DEFAULT 'null'",
  'ALTER TABLE roles ADD COLUMN is_impostor INTEGER NOT NULL DEFAULT 0',
]) {
  try { db.exec(sql); } catch { /* colonne déjà présente */ }
}

// --- Rôles par défaut (modifiables à volonté par l'hôte) ---
function seedRoles() {
  if (get('SELECT COUNT(*) c FROM roles').c > 0) return;
  const ins = db.prepare(
    `INSERT INTO roles(name,mission,description,objectives,allowed_actions,victory,conditions,penalties,weight,exact_count,max_count,per_team,enabled,wheel,fail_points,color,icon,rewards,sort)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`
  );
  const R = (label, points, type, i) => ({ id: 'r' + i, label, points, type });
  ins.run(
    'Garde du corps',
    "Le but du garde du corps est de faire en sorte que votre allié désigné aléatoirement grâce à la roue ait le moins de morts possible.",
    "Le but du garde du corps est de faire en sorte que votre allié désigné aléatoirement grâce à la roue ait le moins de morts possible. Votre allié sous votre protection doit avoir la moitié moins de morts qu'un autre allié qui a le moins de morts.",
    "Protégez votre équipier, tout en gagnant la partie.",
    '',
    "Votre allié sous votre protection doit avoir la moitié moins de morts qu'un autre allié qui a le moins de morts.",
    "Si l'allié sous votre protection à 0 mort, vous gagnerez un bonus de points.\nSi vous gagnez la partie, vous gagnez des points bonus.\nSi l'allié estime que vous avez essayé de bien faire votre travail, vous gagnez un bonus de points.",
    '',
    0, 1, null, 1, 'bodyguard', 0, '#4aa3ff', '🛡️',
    JSON.stringify([R("Mission réussie", 10, 'mission', 1), R("Allié à 0 mort", 5, 'bonus', 2), R("Partie gagnée", 3, 'bonus', 3), R("Allié satisfait de votre travail", 3, 'bonus', 4)]),
    1
  );
  ins.run(
    'Obsédé',
    "Faites en sorte que votre cible désignée termine la partie avec le plus grand nombre de morts de la partie.",
    "Avant le début de la partie, une roue désigne aléatoirement un joueur de l'équipe adverse. Ce joueur devient votre cible.\n\nVotre mission consiste à pousser votre cible à mourir le plus souvent possible durant la partie. Vous devrez adapter votre manière de jouer pour provoquer sa chute et faire en sorte qu'elle soit celle qui accumule le plus de morts parmi les dix joueurs.",
    "Faire mourir le joueur adverse désigné aléatoirement par la roue le plus de fois de la partie.",
    '',
    "Votre mission est parfaitement accomplie si votre cible désignée termine la partie avec le plus grand nombre de morts parmi tous les joueurs.",
    "Si votre cible ne remplit pas la condition de victoire principale, vous pouvez tout de même réussir votre mission en remplissant une condition secondaire basée sur son nombre de morts par rapport à celui des autres joueurs : votre cible doit avoir le plus de morts de son équipe.",
    '',
    0, 1, null, 1, 'observer', -3, '#a855f7', '👁️',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1), R('Observation validée', 5, 'secondary', 2), R('Bonus spécial', 3, 'bonus', 3), R('Observation erronée', -3, 'penalty', 4)]),
    2
  );
  ins.run(
    'Imposteur',
    "Éliminer l'objectif prioritaire de la partie.",
    "Discret et létal, vous frappez là où ça fait mal.",
    "Réaliser le plus d'éliminations ciblées.\nNe pas mourir en solitaire.",
    'Engager sur les cibles isolées.',
    'Vous réalisez votre quota d\'éliminations.',
    'Aucune.',
    'Mort sans impact : -2 points.',
    20, null, 2, 0, '', -2, '#e84057', '🗡️',
    JSON.stringify([R('Mission réussie', 12, 'mission', 1), R('Objectif secondaire', 5, 'secondary', 2), R('Mort sans impact', -2, 'penalty', 3)]),
    3
  );
  ins.run(
    'Peintre',
    "Guider l'équipe vers la victoire.",
    "Vous lisez la partie mieux que personne.",
    "Coordonner les objectifs.\nAnnoncer les timings.",
    'Appeler les décisions importantes.',
    'Votre équipe remporte les objectifs que vous avez appelés.',
    'Aucune.',
    'Mauvais appel : -2 points.',
    15, null, 2, 0, '', -2, '#0ac8b9', '🧠',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1), R('Bon appel', 4, 'secondary', 2), R('Mauvais appel', -2, 'penalty', 3)]),
    4
  );
  ins.run(
    'Touriste',
    "Ouvrir la vision et révéler la carte.",
    "Vous êtes les yeux de l'équipe.",
    'Placer des balises de vision.\nRepérer les menaces.',
    'Traquer les ennemis dans la jungle.',
    'Vous placez le nombre de balises demandé.',
    'Aucune.',
    'Aucune.',
    10, null, null, 0, '', 0, '#f0b232', '🔭',
    JSON.stringify([R('Mission réussie', 8, 'mission', 1), R('Bonus spécial', 3, 'bonus', 2)]),
    5
  );
  ins.run(
    'Super Héro',
    "Jouer au mieux pour l'équipe.",
    "Pas de pouvoir spécial : votre talent suffit.",
    "Gagner la partie.\nSoutenir les rôles spéciaux de l'équipe.",
    'Toutes les actions de jeu normales.',
    'Votre équipe gagne la partie.',
    'Aucune.',
    'Aucune.',
    55, null, null, 0, '', 0, '#c8aa6e', '⚔️',
    JSON.stringify([R('Victoire de l\'équipe', 8, 'mission', 1), R('Bonus spécial', 3, 'bonus', 2)]),
    6
  );
  ins.run(
    'Pacifiste',
    'Mission à définir par l\'hôte.',
    'Rôle en cours de conception.',
    '', '', '', 'Aucune.', 'Aucune.',
    10, null, 2, 0, '', 0, '#7bd88f', '🕊️',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1)]),
    7
  );
  ins.run(
    'Berzerker',
    'Mission à définir par l\'hôte.',
    'Rôle en cours de conception.',
    '', '', '', 'Aucune.', 'Aucune.',
    10, null, 2, 0, '', 0, '#ff6b35', '🪓',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1)]),
    8
  );
}
seedRoles();

// Textes officiels des rôles « Garde du corps » et « Obsédé » (appliqués une seule fois sur une base existante)
if (getSetting('roles_text_v1', null) === null) {
  const upd = db.prepare("UPDATE roles SET mission=?, description=?, objectives=?, allowed_actions='', victory=?, conditions=?, penalties='' WHERE name=?");
  const T = {
  "Garde du corps": {
    "mission": "Protégez votre allié désigné et veillez à ce qu'il ne meurt pas durant toute la partie.",
    "description": "Avant le début de la partie, une roue désigne aléatoirement un joueur de votre équipe. Ce joueur devient votre protégé.\n\nVotre mission consiste à assurer sa survie tout au long de la partie. Vous devrez adapter votre manière de jouer pour le protéger et limiter autant que possible ses morts.",
    "objectives": "Empêcher le joueur allié désigné aléatoirement par la roue de mourir ou le faire le moins possible.",
    "victory": "Votre mission est parfaitement accomplie si votre allié désigné termine la partie avec 0 mort.",
    "conditions": "Si votre allié ne remplit pas la condition de victoire principale, vous pouvez tout de même réussir votre mission en remplissant une condition secondaire basée sur son nombre de morts par rapport à celui des autres joueurs (= l'allié doit avoir le moins de mort de la partie)."
  },
  "Obsédé": {
    "mission": "Faites en sorte que votre cible désignée termine la partie avec le plus grand nombre de morts de la partie.",
    "description": "Avant le début de la partie, une roue désigne aléatoirement un joueur de l'équipe adverse. Ce joueur devient votre cible.\n\nVotre mission consiste à pousser votre cible à mourir le plus souvent possible durant la partie. Vous devrez adapter votre manière de jouer pour provoquer sa chute et faire en sorte qu'elle soit celle qui accumule le plus de morts parmi les dix joueurs.",
    "objectives": "Faire mourir le joueur adverse désigné aléatoirement par la roue le plus de fois de la partie.",
    "victory": "Votre mission est parfaitement accomplie si votre cible désignée termine la partie avec le plus grand nombre de morts parmi tous les joueurs.",
    "conditions": "Si votre cible ne remplit pas la condition de victoire principale, vous pouvez tout de même réussir votre mission en remplissant une condition secondaire basée sur son nombre de morts par rapport à celui des autres joueurs : votre cible doit avoir le plus de morts de son équipe."
  }
};
  for (const [name, t] of Object.entries(T)) upd.run(t.mission, t.description, t.objectives, t.victory, t.conditions, name);
  setSetting('roles_text_v1', '1');
}

// Garde du corps : nouveau texte et nouveaux gains (appliqué une seule fois sur une base existante)
if (getSetting('roles_text_v2', null) === null) {
  const G = {
  "mission": "Le but du garde du corps est de faire en sorte que votre allié désigné aléatoirement grâce à la roue ait le moins de morts possible.",
  "description": "Le but du garde du corps est de faire en sorte que votre allié désigné aléatoirement grâce à la roue ait le moins de morts possible. Votre allié sous votre protection doit avoir la moitié moins de morts qu'un autre allié qui a le moins de morts.",
  "objectives": "Protégez votre équipier, tout en gagnant la partie.",
  "victory": "Votre allié sous votre protection doit avoir la moitié moins de morts qu'un autre allié qui a le moins de morts.",
  "conditions": "Si l'allié sous votre protection à 0 mort, vous gagnerez un bonus de points.\nSi vous gagnez la partie, vous gagnez des points bonus.\nSi l'allié estime que vous avez essayé de bien faire votre travail, vous gagnez un bonus de points.",
  "rewards": [
    {
      "id": "r1",
      "label": "Mission réussie",
      "points": 10,
      "type": "mission"
    },
    {
      "id": "r2",
      "label": "Allié à 0 mort",
      "points": 5,
      "type": "bonus"
    },
    {
      "id": "r3",
      "label": "Partie gagnée",
      "points": 3,
      "type": "bonus"
    },
    {
      "id": "r4",
      "label": "Allié satisfait de votre travail",
      "points": 3,
      "type": "bonus"
    }
  ]
};
  db.prepare("UPDATE roles SET mission=?, description=?, objectives=?, allowed_actions='', victory=?, conditions=?, penalties='', fail_points=0, rewards=? WHERE name='Garde du corps'")
    .run(G.mission, G.description, G.objectives, G.victory, G.conditions, JSON.stringify(G.rewards));
  setSetting('roles_text_v2', '1');
}
// Le rôle « Imposteur » sert de cible spéciale au vote de fin de partie (modifiable dans l'éditeur de rôle).
run("UPDATE roles SET is_impostor=1 WHERE name='Imposteur' AND NOT EXISTS (SELECT 1 FROM roles WHERE is_impostor=1)");

// --- Roues par défaut (l'hôte peut en créer, renommer et supprimer) ---
function seedWheels() {
  if (get('SELECT COUNT(*) c FROM wheel_defs').c > 0) return;
  run("INSERT INTO wheel_defs(key,label,sort) VALUES('bodyguard','Garde du corps',1)");
  run("INSERT INTO wheel_defs(key,label,sort) VALUES('observer','Obsédé',2)");
}
seedWheels();

// --- Sauvegardes automatiques de la base ---
export function backupNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `app-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;
  const file = path.join(DATA_DIR, 'backups', name);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter((f) => f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(DATA_DIR, 'backups', f));
  return file;
}
