import type { Knex } from 'knex';
import * as m001 from './001_foundation.ts';
import * as m002 from './002_ledger.ts';
import * as m003 from './003_tax.ts';
import * as m004 from './004_documents.ts';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

export const migrations: Migration[] = [
  { name: '001_foundation', ...m001 },
  { name: '002_ledger', ...m002 },
  { name: '003_tax', ...m003 },
  { name: '004_documents', ...m004 },
];

/** Knex MigrationSource backed by the static list above (native TS imports). */
export const migrationSource = {
  getMigrations: async () => migrations,
  getMigrationName: (m: Migration) => m.name,
  getMigration: async (m: Migration) => m,
};
