export const version = 1;
export const name = 'init';

/**
 * Storage design notes (why the schema looks like this):
 *
 *  - Discord snowflakes are 19-char text. We store each one ONCE (guilds.discord_id,
 *    users.discord_id) and reference tiny integer surrogate keys everywhere else.
 *  - The team catalog is global and shared by every guild. A guild only stores the
 *    teams it *deviates* from the catalog default on (guild_team_overrides).
 *  - Guild settings are stored as a compressed JSON diff against code defaults, so a
 *    guild with default settings costs 0 bytes of settings.
 *  - Timestamps are unix seconds (INTEGER). Colours are 24-bit INTEGERs.
 *  - Enumerations (end reason, audit action) are small ints.
 *  - Old data is cold-stored: ended seasons collapse into one brotli blob
 *    (season_archives) and audit rows are pruned by retention.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE guilds (
      id          INTEGER PRIMARY KEY,
      discord_id  TEXT    NOT NULL UNIQUE,
      joined_at   INTEGER NOT NULL,
      left_at     INTEGER,
      settings    BLOB                       -- codec blob: JSON diff vs defaults, NULL = all defaults
    );

    CREATE TABLE users (
      id          INTEGER PRIMARY KEY,
      discord_id  TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE conferences (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE
    );

    -- Global team catalog (seeded from data/teams.json).
    CREATE TABLE teams (
      id                INTEGER PRIMARY KEY,
      key               TEXT    NOT NULL UNIQUE,   -- stable identifier, e.g. 'Air Force'
      name              TEXT    NOT NULL,
      full_name         TEXT    NOT NULL,
      abbr              TEXT    NOT NULL,          -- NOT unique in source data (BUFF, UNM)
      mascot            TEXT    NOT NULL DEFAULT '',
      conference_id     INTEGER REFERENCES conferences(id),
      color1            INTEGER NOT NULL DEFAULT 0,
      color2            INTEGER NOT NULL DEFAULT 0,
      color1_name       TEXT,
      color2_name       TEXT,
      group_id          INTEGER NOT NULL DEFAULT 0,
      logo1             INTEGER NOT NULL DEFAULT 0,
      logo2             INTEGER NOT NULL DEFAULT 0,
      scoreboard_text   INTEGER,
      emoji             TEXT,
      stadium_name      TEXT,
      stadium_location  TEXT,
      stadium_capacity  INTEGER,
      stadium_indoor    INTEGER NOT NULL DEFAULT 0,
      stadium_icon      INTEGER,
      stadium_thumb     INTEGER,
      stadium_asset     INTEGER,
      active            INTEGER NOT NULL DEFAULT 0, -- flagged "Active" in the game's data
      default_enabled   INTEGER NOT NULL DEFAULT 1  -- catalog default for guilds with no override
    );
    CREATE INDEX teams_conference ON teams(conference_id);

    CREATE TABLE team_aliases (
      alias    TEXT    NOT NULL COLLATE NOCASE,
      team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY (alias, team_id)
    ) WITHOUT ROWID;

    -- Only rows that differ from teams.default_enabled are stored.
    CREATE TABLE guild_team_overrides (
      guild_id  INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      team_id   INTEGER NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
      enabled   INTEGER NOT NULL,
      PRIMARY KEY (guild_id, team_id)
    ) WITHOUT ROWID;

    CREATE TABLE seasons (
      id          INTEGER PRIMARY KEY,
      guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      number      INTEGER NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      UNIQUE (guild_id, number)
    );
    -- At most one open season per guild.
    CREATE UNIQUE INDEX seasons_one_open ON seasons(guild_id) WHERE ended_at IS NULL;

    CREATE TABLE signings (
      id          INTEGER PRIMARY KEY,
      guild_id    INTEGER NOT NULL REFERENCES guilds(id)  ON DELETE CASCADE,
      season_id   INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      team_id     INTEGER NOT NULL REFERENCES teams(id),
      signed_at   INTEGER NOT NULL,
      ended_at    INTEGER,
      end_reason  INTEGER,
      by_user_id  INTEGER REFERENCES users(id)  -- who performed the signing (NULL = same as user)
    );
    -- Partial indexes: only live signings are indexed, so history doesn't bloat them.
    CREATE INDEX signings_live_team ON signings(guild_id, team_id) WHERE ended_at IS NULL;
    CREATE INDEX signings_live_user ON signings(guild_id, user_id) WHERE ended_at IS NULL;
    CREATE INDEX signings_season    ON signings(season_id);
    CREATE INDEX signings_user_hist ON signings(guild_id, user_id, signed_at);

    -- Ended seasons collapse into one compressed blob (columnar, delta-encoded).
    CREATE TABLE season_archives (
      season_id      INTEGER PRIMARY KEY REFERENCES seasons(id) ON DELETE CASCADE,
      guild_id       INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      signing_count  INTEGER NOT NULL,
      archived_at    INTEGER NOT NULL,
      data           BLOB    NOT NULL
    );
    CREATE INDEX season_archives_guild ON season_archives(guild_id);

    CREATE TABLE audit_log (
      id              INTEGER PRIMARY KEY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      ts              INTEGER NOT NULL,
      action          INTEGER NOT NULL,
      actor_user_id   INTEGER REFERENCES users(id),
      target_user_id  INTEGER REFERENCES users(id),
      team_id         INTEGER REFERENCES teams(id),
      data            BLOB                        -- optional codec blob with extra detail
    );
    CREATE INDEX audit_guild_ts ON audit_log(guild_id, ts);
  `);
}
