import Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/cookie-proxy.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    key_prefix  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at  TEXT,
    last_used   TEXT,
    use_count   INTEGER NOT NULL DEFAULT 0,
    rate_limit  INTEGER NOT NULL DEFAULT 60
  );
  CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);
`);

const hash = (raw) => createHash('sha256').update(raw).digest('hex');

export function issueKey(label, rateLimit = 60) {
  const raw = 'cp_' + randomBytes(24).toString('base64url');
  const prefix = raw.slice(0, 10);
  db.prepare(
    'INSERT INTO api_keys (label, key_hash, key_prefix, rate_limit) VALUES (?, ?, ?, ?)'
  ).run(label, hash(raw), prefix, rateLimit);
  return raw;
}

export function revokeKey(prefixOrId) {
  const stmt = /^\d+$/.test(prefixOrId)
    ? db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    : db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE key_prefix = ? AND revoked_at IS NULL");
  return stmt.run(prefixOrId).changes;
}

export function listKeys() {
  return db
    .prepare(
      'SELECT id, label, key_prefix, created_at, revoked_at, last_used, use_count, rate_limit FROM api_keys ORDER BY id'
    )
    .all();
}

const lookupStmt = db.prepare(
  'SELECT id, label, rate_limit FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
);
const touchStmt = db.prepare(
  "UPDATE api_keys SET last_used = datetime('now'), use_count = use_count + 1 WHERE id = ?"
);

export function authenticate(rawKey) {
  if (!rawKey) return null;
  const row = lookupStmt.get(hash(rawKey));
  if (!row) return null;
  touchStmt.run(row.id);
  return row;
}
