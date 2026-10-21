import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens (creating if needed) the SQLite database with production-safe pragmas.
 * Pass ':memory:' for tests.
 *
 * @param {string} path
 * @param {{ logger?: any }} [opts]
 */
export function openDatabase(path, { logger } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  // auto_vacuum only takes effect on a brand-new file (before any table exists).
  // INCREMENTAL lets maintenance reclaim freed pages without a full VACUUM.
  if (db.pragma('user_version', { simple: true }) === 0) db.pragma('auto_vacuum = INCREMENTAL');

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -16000'); // ~16 MB
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');

  logger?.debug({ path }, 'database opened');
  return db;
}
