import { statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DAY = 86400;
/** Finished seasons are cold-stored this long after they end. */
const ARCHIVE_AFTER_SEC = 30 * DAY;
/** Data of guilds that kicked the bot is kept this long (in case they re-invite) before purge. */
const PURGE_LEFT_GUILDS_AFTER_SEC = 30 * DAY;

/** Housekeeping that keeps the database small. Run on boot + daily (and via `npm run maintenance`). */
export class MaintenanceService {
  constructor({ db, config, guilds, seasons, audit, logger }) {
    Object.assign(this, { db, config, guilds, seasons, audit, logger });
  }

  /** @returns {{ auditPruned: number, archived: number, guildsPurged: number }} */
  run() {
    const auditPruned = this.audit.prune(this.config.auditRetentionDays);
    const archived = this.seasons.archiveOld(ARCHIVE_AFTER_SEC);
    const guildsPurged = this.guilds.purgeLeft(PURGE_LEFT_GUILDS_AFTER_SEC);

    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('incremental_vacuum(500)'); // reclaim up to 500 free pages per run
    this.db.pragma('optimize');

    const result = { auditPruned, archived, guildsPurged };
    this.logger?.info(result, 'maintenance complete');
    return result;
  }

  /** Online, consistent backup using SQLite's backup API (safe while the bot is running). */
  async backup(dir = join(dirname(this.config.database.path), 'backups')) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `leaguebot-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await this.db.backup(file);
    this.logger?.info({ file }, 'backup written');
    return file;
  }

  /** Quick size/shape report. */
  stats() {
    const one = (sql) => this.db.prepare(sql).get().n;
    const pageSize = this.db.pragma('page_size', { simple: true });
    let fileBytes = null;
    if (this.config.database.path !== ':memory:') {
      try {
        fileBytes = statSync(this.config.database.path).size;
      } catch {
        /* not created yet */
      }
    }
    return {
      fileBytes,
      dbBytes: pageSize * this.db.pragma('page_count', { simple: true }),
      freeBytes: pageSize * this.db.pragma('freelist_count', { simple: true }),
      guilds: one('SELECT COUNT(*) AS n FROM guilds WHERE left_at IS NULL'),
      users: one('SELECT COUNT(*) AS n FROM users'),
      liveSignings: one('SELECT COUNT(*) AS n FROM signings WHERE ended_at IS NULL'),
      historicSignings: one('SELECT COUNT(*) AS n FROM signings WHERE ended_at IS NOT NULL'),
      archivedSignings: one('SELECT COALESCE(SUM(signing_count),0) AS n FROM season_archives'),
      auditRows: one('SELECT COUNT(*) AS n FROM audit_log'),
    };
  }
}
