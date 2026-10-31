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
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',          -- lobby | distributed | running | ended
  team_a TEXT NOT NULL DEFAULT 'Équipe Bleue',
  team_b TEXT NOT NULL DEFAULT 'Équipe Rouge',
  teams_enabled INTEGER NOT NULL DEFAULT 1,
  roles_revealed INTEGER NOT NULL DEFAULT 0,     -- rôles publics après la fin de partie
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
    'Protéger un joueur de votre équipe et remplir les objectifs associés.',
    "Vous êtes le bouclier de votre équipe. Votre roue désigne un joueur adverse à garder à l'œil pendant toute la partie.",
    'Protéger votre cible.\nRespecter les conditions de votre mission.\nRemplir les objectifs secondaires.',
    "Lancer votre roue une fois pendant la partie.\nProtéger vos coéquipiers pendant les combats.",
    'Votre cible survit et vous avez rempli la mission principale.',
    'Le résultat de votre roue reste secret.',
    'Si votre cible meurt par votre faute : -5 points.',
    0, 1, null, 1, 'bodyguard', -5, '#4aa3ff', '🛡️',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1), R('Objectif secondaire', 5, 'secondary', 2), R('Bonus spécial', 3, 'bonus', 3), R('Cible perdue', -5, 'penalty', 4)]),
    1
  );
  ins.run(
    'Observateur',
    'Surveiller discrètement un joueur adverse et rapporter ses actions.',
    "Vos yeux voient tout. Votre roue désigne un joueur adverse dont vous devez suivre chaque mouvement.",
    'Observer votre cible.\nNoter ses déplacements et ses objectifs.\nRemplir les objectifs secondaires.',
    "Lancer votre roue une fois pendant la partie.\nPoser des questions à l'hôte sur votre cible.",
    "Vos observations s'avèrent exactes à la fin de la partie.",
    'Le résultat de votre roue reste secret.',
    'Observation erronée : -3 points.',
    0, 1, null, 1, 'observer', -3, '#a855f7', '👁️',
    JSON.stringify([R('Mission réussie', 10, 'mission', 1), R('Observation validée', 5, 'secondary', 2), R('Bonus spécial', 3, 'bonus', 3), R('Observation erronée', -3, 'penalty', 4)]),
    2
  );
  ins.run(
    'Assassin',
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
    'Stratège',
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
    'Éclaireur',
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
    'Joueur standard',
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
}
seedRoles();

// --- Roues par défaut (l'hôte peut en créer, renommer et supprimer) ---
function seedWheels() {
  if (get('SELECT COUNT(*) c FROM wheel_defs').c > 0) return;
  run("INSERT INTO wheel_defs(key,label,sort) VALUES('bodyguard','Garde du corps',1)");
  run("INSERT INTO wheel_defs(key,label,sort) VALUES('observer','Observateur',2)");
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
