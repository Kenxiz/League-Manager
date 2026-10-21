export const version = 2;
export const name = 'scheduling_and_teams';

export function up(db) {
  db.exec(`
    CREATE TABLE matches (
      id              INTEGER PRIMARY KEY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      week            INTEGER NOT NULL DEFAULT 1,
      home_team_id    INTEGER NOT NULL REFERENCES teams(id),
      away_team_id    INTEGER NOT NULL REFERENCES teams(id),
      scheduled_at    INTEGER,                           -- unix seconds, NULL = TBD
      status          INTEGER NOT NULL DEFAULT 1,        -- MatchStatus enum (1=scheduled)
      stadium_name    TEXT,
      home_score      INTEGER,
      away_score      INTEGER,
      winner_team_id              INTEGER REFERENCES teams(id),
      notes                       TEXT,
      coordination_thread_id      TEXT,                           -- Discord thread snowflake for team coordination
      proposed_time               INTEGER,                        -- Proposed unix timestamp
      proposed_by_user_id         INTEGER REFERENCES users(id),
      home_confirmed_at           INTEGER,
      home_confirmed_by_user_id   INTEGER REFERENCES users(id),
      away_confirmed_at           INTEGER,
      away_confirmed_by_user_id   INTEGER REFERENCES users(id),
      created_at                  INTEGER NOT NULL,
      updated_at                  INTEGER NOT NULL
    );
    CREATE INDEX matches_guild_season ON matches(guild_id, season_id);
    CREATE INDEX matches_scheduled ON matches(guild_id, scheduled_at) WHERE scheduled_at IS NOT NULL;
    CREATE INDEX matches_teams ON matches(guild_id, home_team_id, away_team_id);
    CREATE INDEX matches_thread ON matches(guild_id, coordination_thread_id) WHERE coordination_thread_id IS NOT NULL;

    CREATE TABLE match_reports (
      id                  INTEGER PRIMARY KEY,
      match_id            INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      reported_by_user_id INTEGER NOT NULL REFERENCES users(id),
      home_score          INTEGER NOT NULL,
      away_score          INTEGER NOT NULL,
      proof_url           TEXT,
      notes               TEXT,
      status              INTEGER NOT NULL DEFAULT 1,     -- ReportStatus enum (1=pending)
      reviewed_by_user_id INTEGER REFERENCES users(id),
      reviewed_at         INTEGER,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX match_reports_match ON match_reports(match_id);

    CREATE TABLE team_captains (
      guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      team_id      INTEGER NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      role         TEXT    NOT NULL DEFAULT 'captain',    -- 'captain', 'co-captain', 'coach'
      assigned_at  INTEGER NOT NULL,
      PRIMARY KEY (guild_id, team_id, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX team_captains_user ON team_captains(guild_id, user_id);

    CREATE TABLE team_links (
      guild_id            INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      team_id             INTEGER NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
      external_server_id  TEXT,
      invite_url          TEXT,
      webhook_url         TEXT,
      PRIMARY KEY (guild_id, team_id)
    ) WITHOUT ROWID;

    CREATE TABLE roblox_links (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      roblox_id        TEXT    NOT NULL UNIQUE,
      roblox_username  TEXT    NOT NULL,
      verified_at      INTEGER NOT NULL
    );

    CREATE TABLE player_positions (
      signing_id     INTEGER PRIMARY KEY REFERENCES signings(id) ON DELETE CASCADE,
      position       TEXT    NOT NULL,
      jersey_number  INTEGER
    );

    CREATE TABLE league_bans (
      id          INTEGER PRIMARY KEY,
      guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      reason      TEXT,
      banned_at   INTEGER NOT NULL,
      expires_at  INTEGER,                           -- NULL = permanent
      by_user_id  INTEGER REFERENCES users(id),
      UNIQUE (guild_id, user_id)
    );
    CREATE INDEX league_bans_check ON league_bans(guild_id, user_id);
  `);
}
