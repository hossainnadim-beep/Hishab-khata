import knex, { type Knex } from 'knex';
import pg from 'pg';
import { config } from './config.ts';

// NUMERIC comes back as string (never float) — money math uses decimal.js on strings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => v);
// DATE as plain YYYY-MM-DD string, no timezone surprises.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

export const db: Knex = knex({
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
});

export type Trx = Knex.Transaction;
