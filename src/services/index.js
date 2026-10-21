import { openDatabase } from '../database/connection.js';
import { migrate } from '../database/migrator.js';
import { createCodec } from '../utils/compression.js';
import { AuditService } from './audit-service.js';
import { GuildService } from './guild-service.js';
import { MaintenanceService } from './maintenance-service.js';
import { PermissionService } from './permission-service.js';
import { SeasonService } from './season-service.js';
import { SigningService } from './signing-service.js';
import { TeamService } from './team-service.js';
import { UserService } from './user-service.js';

/**
 * Composition root for the backend: opens + migrates the database, seeds the team catalog,
 * and wires every service. Discord-agnostic - scripts and tests use it too.
 *
 * @param {{ config: ReturnType<typeof import('../config/index.js').loadConfig>, logger?: any, dbPath?: string, clock?: () => number, seedTeams?: boolean | object[] }} deps
 */
export function createServices({ config, logger, dbPath, clock, seedTeams = true }) {
  const db = openDatabase(dbPath ?? config.database.path, { logger });
  migrate(db, { logger });

  const codec = createCodec({ level: config.compressionLevel });
  const clockDep = clock ? { clock } : {};

  const guilds = new GuildService({ db, codec, ...clockDep });
  const users = new UserService({ db });
  const teams = new TeamService({ db });
  const audit = new AuditService({ db, codec, ...clockDep });
  const seasons = new SeasonService({ db, codec, audit, ...clockDep });
  const signings = new SigningService({ db, guilds, users, teams, seasons, audit, ...clockDep });
  const permissions = new PermissionService();
  const maintenance = new MaintenanceService({ db, config, guilds, seasons, audit, logger });

  if (seedTeams) {
    const { total } = teams.seed(Array.isArray(seedTeams) ? seedTeams : undefined);
    logger?.info({ total }, 'team catalog synced');
  }

  return {
    db,
    codec,
    guilds,
    users,
    teams,
    audit,
    seasons,
    signings,
    permissions,
    maintenance,
    close: () => db.close(),
  };
}
