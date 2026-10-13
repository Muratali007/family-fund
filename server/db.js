// Тонкая обёртка над БД: Postgres, если задан DATABASE_URL, иначе встроенный SQLite (для локальной разработки).
// Во всех запросах используем плейсхолдеры "?" — для Postgres они превращаются в $1, $2, ...
const path = require('path');
const fs = require('fs');

// Переменные от `neon env pull` (.env.local) или .env — если файлы есть; на хостинге берутся из окружения
for (const f of ['.env.local', '.env']) {
  const p = path.join(__dirname, '..', f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

const usePg = !!process.env.DATABASE_URL;

const SCHEMA = (pg) => {
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = pg ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' : "TEXT NOT NULL DEFAULT (datetime('now'))";
  const money = pg ? 'BIGINT' : 'INTEGER';
  return [
    `CREATE TABLE IF NOT EXISTS families (
      id ${id},
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id ${id},
      family_id INTEGER NOT NULL REFERENCES families(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      relation_to INTEGER REFERENCES users(id),
      avatar TEXT,
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS items (
      id ${id},
      family_id INTEGER NOT NULL REFERENCES families(id),
      creator_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT,
      photo TEXT,
      price ${money} NOT NULL,
      own_amount ${money} NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'voting',
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS votes (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      approve INTEGER NOT NULL,
      created_at ${ts},
      PRIMARY KEY (item_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id ${id},
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      contribution_id INTEGER,
      text TEXT NOT NULL,
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS reminders (
      kind TEXT NOT NULL,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sent_at TEXT NOT NULL,
      times INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, item_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id ${id},
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at ${ts}
    )`,
    `CREATE TABLE IF NOT EXISTS contributions (
      id ${id},
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount ${money} NOT NULL,
      comment TEXT,
      created_at ${ts}
    )`,
  ];
};

// Новые колонки для уже существующих баз: [таблица, колонка, тип]
const COLUMNS = (pg) => [
  ['users', 'kaspi_phone', 'TEXT'],
  ['users', 'notify_email', 'INTEGER NOT NULL DEFAULT 1'],
  ['items', 'kaspi_phone', 'TEXT'],
  ['items', 'kaspi_name', 'TEXT'],
  // старые взносы (до чеков) считаем подтверждёнными
  ['contributions', 'status', "TEXT NOT NULL DEFAULT 'confirmed'"],
  ['contributions', 'receipt', 'TEXT'],
  ['contributions', 'reject_reason', 'TEXT'],
  ['contributions', 'reviewed_at', pg ? 'TIMESTAMPTZ' : 'TEXT'],
  // смена пароля / выход везде увеличивает версию — старые сессии перестают работать
  ['users', 'session_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'lang', "TEXT NOT NULL DEFAULT 'ru'"],
  ['families', 'owner_id', 'INTEGER'],
  ['items', 'deadline', 'TEXT'], // YYYY-MM-DD
  ['items', 'bought_at', 'TEXT'], // ISO-время
  ['items', 'bought_proof', 'TEXT'],
  ['items', 'bought_note', 'TEXT'],
];

// Данные, которые надо дозаполнить после добавления колонок
const BACKFILL = [
  // главой семьи считаем того, кто её создал (первый участник)
  'UPDATE families SET owner_id = (SELECT MIN(u.id) FROM users u WHERE u.family_id = families.id) WHERE owner_id IS NULL',
];

let impl;

if (usePg) {
  const { Pool } = require('pg');
  // BIGINT/COUNT приходят строками — приводим к числу
  require('pg').types.setTypeParser(20, (v) => Number(v));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  impl = {
    async init() {
      // DDL — через прямое подключение (без -pooler), запросы приложения — через пул
      const { Client } = require('pg');
      const direct = new Client({
        connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
        ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      });
      await direct.connect();
      try {
        for (const s of SCHEMA(true)) await direct.query(s);
        for (const [t, c, type] of COLUMNS(true)) await direct.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${type}`);
        for (const q of BACKFILL) await direct.query(q);
      } finally {
        await direct.end();
      }
    },
    async all(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows[0];
    },
    async run(sql, params = []) {
      const r = await pool.query(toPg(sql), params);
      return { rows: r.rows, changes: r.rowCount };
    },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  impl = {
    async init() {
      for (const s of SCHEMA(false)) db.exec(s);
      for (const [t, c, type] of COLUMNS(false)) {
        const has = db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
        if (!has) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
      }
      for (const q of BACKFILL) db.exec(q);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    async run(sql, params = []) {
      const st = db.prepare(sql);
      if (/returning/i.test(sql)) return { rows: st.all(...params), changes: 1 };
      const r = st.run(...params);
      return { rows: [], changes: Number(r.changes) };
    },
  };
}

impl.kind = usePg ? 'postgres' : 'sqlite';
module.exports = impl;
