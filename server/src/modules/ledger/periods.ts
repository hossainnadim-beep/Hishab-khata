import type { Knex } from 'knex';
import { badRequest } from '../../lib/errors.ts';

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fiscal year boundaries containing `date`, given the FY start month (1-12). */
export function fiscalYearFor(date: string, startMonth: number): { start: string; end: string } {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0)); // day 0 = last day of prior month
  return { start: fmt(start), end: fmt(end) };
}

/** Creates the fiscal year + 12 monthly periods covering `date`, if missing. */
export async function ensurePeriodsFor(
  trx: Knex,
  companyId: string,
  date: string,
  fyStartMonth: number,
): Promise<void> {
  const { start, end } = fiscalYearFor(date, fyStartMonth);
  const existing = await trx('fiscal_years')
    .where({ company_id: companyId, start_date: start })
    .first();
  if (existing) return;

  const [fy] = await trx('fiscal_years')
    .insert({ company_id: companyId, start_date: start, end_date: end })
    .onConflict(['company_id', 'start_date'])
    .ignore()
    .returning(['id']);
  if (!fy) return; // concurrent insert won

  const [sy, sm] = start.split('-').map(Number);
  const periods = [];
  for (let i = 0; i < 12; i++) {
    const ps = new Date(Date.UTC(sy, sm - 1 + i, 1));
    const pe = new Date(Date.UTC(sy, sm + i, 0));
    periods.push({
      company_id: companyId,
      fiscal_year_id: fy.id,
      start_date: fmt(ps),
      end_date: fmt(pe),
    });
  }
  await trx('accounting_periods').insert(periods);
}

export async function setPeriodStatus(
  trx: Knex,
  companyId: string,
  periodId: string,
  status: 'open' | 'closed',
): Promise<void> {
  const period = await trx('accounting_periods')
    .where({ id: periodId, company_id: companyId })
    .first();
  if (!period) throw badRequest('Period not found');
  const fy = await trx('fiscal_years').where({ id: period.fiscal_year_id }).first();
  if (fy.status === 'closed') throw badRequest('Fiscal year is closed');
  await trx('accounting_periods').where({ id: periodId }).update({ status });
}

/** Closing a fiscal year closes all its periods; requires all periods closed first is NOT
 *  demanded — closing the year closes everything in one step. */
export async function setFiscalYearStatus(
  trx: Knex,
  companyId: string,
  fiscalYearId: string,
  status: 'open' | 'closed',
): Promise<void> {
  const fy = await trx('fiscal_years')
    .where({ id: fiscalYearId, company_id: companyId })
    .first();
  if (!fy) throw badRequest('Fiscal year not found');
  await trx('fiscal_years').where({ id: fiscalYearId }).update({ status });
  if (status === 'closed') {
    await trx('accounting_periods')
      .where({ fiscal_year_id: fiscalYearId })
      .update({ status: 'closed' });
  }
}
