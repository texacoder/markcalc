// Storage: SQLite through libSQL. Works with a local file (file:./data/markcalc.db)
// or a free hosted Turso database (libsql://…), so the app can run on hosts without a disk.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  total_marks TEXT NOT NULL DEFAULT '',
  syllabus TEXT NOT NULL DEFAULT '',
  scheme TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '',
  question_text TEXT NOT NULL DEFAULT '',
  presets TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS exam_files (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  mimetype TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  exam_id INTEGER NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  roll_no TEXT NOT NULL DEFAULT '',
  total_awarded REAL NOT NULL,
  total_maximum REAL NOT NULL,
  data TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS site_usage (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_exams_user ON exams(user_id);
CREATE INDEX IF NOT EXISTS idx_files_exam ON exam_files(exam_id);
CREATE INDEX IF NOT EXISTS idx_results_exam ON results(exam_id);
`;

// Plain objects so rows can be spread / serialized normally.
function toObject(row, columns) {
  if (!row) return undefined;
  const out = {};
  columns.forEach((c, i) => (out[c] = row[i]));
  return out;
}

// Small promise API shared by the client and by transactions.
function wrap(executor) {
  const exec = (sql, args) => executor.execute({ sql, args: args.map((a) => (typeof a === 'boolean' ? Number(a) : a)) });
  return {
    async get(sql, ...args) {
      const r = await exec(sql, args);
      return toObject(r.rows[0], r.columns);
    },
    async all(sql, ...args) {
      const r = await exec(sql, args);
      return r.rows.map((row) => toObject(row, r.columns));
    },
    async run(sql, ...args) {
      const r = await exec(sql, args);
      return { lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid), changes: r.rowsAffected };
    },
  };
}

function resolveUrl(url) {
  const value = url || 'file:./data/markcalc.db';
  if (value.startsWith('file:')) {
    const file = value.slice(5);
    if (file && file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  return value;
}

async function openDb({ url, authToken } = {}) {
  const client = createClient({ url: resolveUrl(url), authToken: authToken || undefined });
  await client.executeMultiple(SCHEMA);
  const db = wrap(client);

  // Run fn(txDb) inside a write transaction.
  db.tx = async (fn) => {
    const t = await client.transaction('write');
    try {
      const out = await fn(wrap(t));
      await t.commit();
      return out;
    } catch (err) {
      await t.rollback().catch(() => {});
      throw err;
    } finally {
      t.close();
    }
  };
  db.close = () => client.close();
  return db;
}

module.exports = { openDb };
