# leaguebot

Multi-guild Discord bot for signing coaches/players to College Football league teams
(TeamSign-style). This repo currently contains the **core foundation** only - no slash
commands beyond `/ping` yet.

## Quick start

```bash
npm install
cp .env.example .env      # fill in DISCORD_TOKEN + DISCORD_CLIENT_ID
npm run deploy            # register slash commands (DEV_GUILD_ID = instant, guild-only)
npm start
npm test
```

## Layout

| Path | Responsibility |
| --- | --- |
| `src/config` | Validated env config (zod), frozen, secrets never logged |
| `src/database` | SQLite connection (WAL), forward-only migrator, schema in `migrations/` |
| `src/services` | **All business logic.** Discord-agnostic; takes Discord IDs, returns plain objects |
| `src/integrations` | Hardened HTTP client + Roblox thumbnail API (team logos -> image URLs) |
| `src/discord` | Client, command/event loaders, interaction pipeline, permission context |
| `src/utils` | Errors, logger (with redaction), compression codec, constants, helpers |
| `data/teams.json` | Team catalog generated from the game's `teams.luau` (`scripts/import-teams.js`) |
| `scripts/` | `deploy-commands`, `migrate`, `seed-teams`, `maintenance`, `import-teams` |

## Services

`createServices()` (`src/services/index.js`) wires everything:

`guilds` (registry + settings) - `users` - `teams` (catalog, search, per-guild enable) -
`seasons` (+ archiving) - `signings` (sign / release / transfer / rosters) - `audit` -
`permissions` - `maintenance`.

Adding a command: drop a file in `src/discord/commands/` exporting `{ data, execute }`
(see `ping.js`). Throw an `AppError` subclass for user-visible failures; anything else is
logged and shown as a generic error.

## Multi-guild + storage design

- Every row is scoped by an internal integer `guild_id`. Discord snowflakes are stored once
  (`guilds`, `users`) and referenced by small ints everywhere else.
- **Team catalog is global** (143 teams, stored once). A guild only stores the teams where it
  *differs* from the catalog default (`guild_team_overrides`). High-school teams are off by default.
- **Settings are a compressed JSON diff** against code defaults; a default guild stores nothing.
- Timestamps are unix seconds, colours are 24-bit ints, enums are small ints.
- Partial indexes only cover *live* signings, so history doesn't bloat them.
- **Cold storage:** finished seasons (>30 days) collapse into one columnar, delta-encoded,
  brotli blob per season (~3 bytes/signing measured). Audit rows are pruned after
  `AUDIT_RETENTION_DAYS`. Guilds that kick the bot are purged after 30 days.
- `npm run maintenance [-- --backup]` runs all of this on demand (also runs daily in the bot).

## Permissions

Tiers: `member < coach < commissioner < admin`, cumulative bit-flag permissions
(`src/utils/constants.js`). Admin = bot owner / server owner / Discord Administrator / admin role.
Each guild maps roles to tiers and may override tier masks in settings. Admin can't be reduced
(no lock-out); changing roles/masks needs `MANAGE_PERMISSIONS`. Empty `coachRoleIds` means every
member is a coach (open league).

## Security notes

- Config validated at boot; errors never echo secret values; logger redacts tokens/secret keys.
- Least-privilege gateway: only the `Guilds` intent; mentions disabled; unused caches zeroed.
- Parameterised SQL only; Discord IDs validated as snowflakes; free text via `sanitizeText`.
- Per-user global + per-command rate limits; external HTTP is HTTPS-only with a host allow-list,
  timeouts, retries and a response-size cap; decompression has an output cap.
- Internal errors are logged in full but shown to users as a generic message.

## Known data quirks in `teams.luau`

See `scripts/import-teams.js` and `TeamService.seed`: inconsistent conference spellings are
normalised, duplicate abbreviations (`BUFF`, `UNM`) are tolerated (teams are keyed by `key`), and
the game's `Active` list uses `"LSU"` for the team keyed `"Louisiana State"` (resolved by abbreviation).
