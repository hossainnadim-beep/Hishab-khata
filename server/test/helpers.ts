import { db } from '../src/db.ts';
import { migrationSource } from '../src/migrations/index.ts';
import { createCompany } from '../src/modules/companies/service.ts';

/** Wipes and re-migrates the test database. */
export async function resetDb(): Promise<void> {
  await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate.latest({ migrationSource });
}

let userCounter = 0;

export async function makeUser() {
  const [user] = await db('users')
    .insert({
      email: `test${++userCounter}-${Date.now()}@test.local`,
      password_hash: 'x',
      name: 'Test User',
    })
    .returning('*');
  return user;
}

export async function makeCompany(opts: { baseCurrency?: string } = {}) {
  const user = await makeUser();
  const company = await db.transaction((trx) =>
    createCompany(trx, {
      name: 'Test Co',
      baseCurrency: opts.baseCurrency ?? 'BDT',
      ownerUserId: user.id,
    }),
  );
  const accounts = await db('accounts').where({ company_id: company.id });
  const byCode = Object.fromEntries(accounts.map((a: any) => [a.code, a]));
  return { user, company, accounts, byCode };
}

/** Sum of posted base debits minus credits — must always be exactly 0. */
export async function trialBalanceDiff(companyId: string): Promise<string> {
  const [row] = await db('journal_lines as jl')
    .join('journal_entries as je', 'je.id', 'jl.entry_id')
    .where({ 'je.company_id': companyId, 'je.status': 'posted' })
    .select(
      db.raw('coalesce(sum(jl.base_debit),0) - coalesce(sum(jl.base_credit),0) as diff'),
    );
  return row.diff;
}
