import * as m001 from './001_init.js';
import * as m002 from './002_scheduling_and_teams.js';
import * as m003 from './003_suspensions.js';
import * as m004 from './004_team_roles.js';

/** Ordered list of migrations. Append only; never edit one that has shipped. */
export const migrations = [m001, m002, m003, m004];


