export const version = 4;
export const name = 'team_roles';

export function up(db) {
  db.exec(`
    ALTER TABLE team_links ADD COLUMN role_id TEXT;
  `);
}
