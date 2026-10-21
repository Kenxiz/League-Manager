export const version = 3;
export const name = 'suspensions';

export function up(db) {
  db.exec(`
    CREATE TABLE suspensions (
      id              INTEGER PRIMARY KEY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      reason          TEXT    NOT NULL,
      bail_robux      INTEGER NOT NULL DEFAULT 0,
      bail_dollars    REAL    NOT NULL DEFAULT 0.0,
      suspended_at    INTEGER NOT NULL,
      unsuspended_at  INTEGER,
      by_user_id      INTEGER NOT NULL REFERENCES users(id),
      unby_user_id    INTEGER REFERENCES users(id),
      active          INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX suspensions_lookup ON suspensions(guild_id, user_id, active);
    CREATE INDEX suspensions_active_guild ON suspensions(guild_id, active);
  `);
}
