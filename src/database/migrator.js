import { migrations } from './migrations/index.js';

/**
 * Minimal forward-only migrator backed by `PRAGMA user_version`.
 * Each migration runs in its own transaction; a failure leaves the DB at the previous version.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ logger?: any }} [opts]
 * @returns {number} the resulting schema version
 */
export function migrate(db, { logger } = {}) {
  const current = db.pragma('user_version', { simple: true });
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    logger?.info({ version: m.version, name: m.name }, 'migration applied');
  }
  return pending.length ? pending[pending.length - 1].version : current;
}
