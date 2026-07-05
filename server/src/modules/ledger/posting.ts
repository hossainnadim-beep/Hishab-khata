import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';
import { ensurePeriodsFor } from './periods.ts';

export interface PostLine {
  accountId: string;
  debit?: string | number;
  credit?: string | number;
  description?: string | null;
  contactId?: string | null;
  taxCodeId?: string | null;
}

export interface PostEntryInput {
  companyId: string;
  txnDate: string; // YYYY-MM-DD
  currency?: string; // defaults to company base currency
  exchangeRate?: string | number; // base currency per 1 unit of txn currency
  memo?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  reversesEntryId?: string | null;
  userId?: string | null;
  lines: PostLine[];
}

export interface PostedEntry {
  id: string;
  entryNo: number;
}

/**
 * Posts a balanced journal entry inside the caller's transaction.
 * - Lines are given in the transaction currency; base amounts are computed
 *   at the entry's exchange rate and any conversion-rounding residual is
 *   posted to the company's rounding account, so the entry balances in both
 *   currencies to the penny.
 * - DB triggers independently enforce balance, immutability, and closed periods.
 */
export async function postEntry(trx: Knex, input: PostEntryInput): Promise<PostedEntry> {
  const company = await trx('companies').where({ id: input.companyId }).first();
  if (!company) throw badRequest('Unknown company');

  const currency = (input.currency ?? company.base_currency).toUpperCase();
  const isBase = currency === company.base_currency;
  const rate = d(input.exchangeRate ?? 1);
  if (isBase && !rate.equals(1)) throw badRequest('Exchange rate must be 1 for base-currency entries');
  if (rate.lte(0)) throw badRequest('Exchange rate must be positive');
  if (!input.lines || input.lines.length < 2) throw badRequest('A journal entry needs at least two lines');

  // Validate txn-currency balance — the caller must supply a balanced entry.
  // Amounts are stored rounded to 2dp, so balance is checked on rounded values.
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const line of input.lines) {
    const dr = d(line.debit ?? 0);
    const cr = d(line.credit ?? 0);
    if (dr.lt(0) || cr.lt(0)) throw badRequest('Line amounts must be non-negative');
    if (dr.gt(0) && cr.gt(0)) throw badRequest('A line cannot have both debit and credit');
    if (dr.isZero() && cr.isZero()) throw badRequest('A line must have a debit or credit amount');
    totalDebit = totalDebit.plus(money(dr));
    totalCredit = totalCredit.plus(money(cr));
  }
  if (!totalDebit.equals(totalCredit)) {
    throw badRequest(
      `Entry does not balance: debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}`,
    );
  }

  await ensurePeriodsFor(trx, input.companyId, input.txnDate, company.fiscal_year_start_month);

  // Per-line base conversion with 2dp rounding, tracking the residual.
  const rows = input.lines.map((line, i) => {
    const dr = d(line.debit ?? 0);
    const cr = d(line.credit ?? 0);
    return {
      line_no: i + 1,
      account_id: line.accountId,
      description: line.description ?? null,
      debit: money(dr),
      credit: money(cr),
      base_debit: money(dr.times(rate)),
      base_credit: money(cr.times(rate)),
      contact_id: line.contactId ?? null,
      tax_code_id: line.taxCodeId ?? null,
    };
  });

  const baseDr = rows.reduce((a, r) => a.plus(r.base_debit), new Decimal(0));
  const baseCr = rows.reduce((a, r) => a.plus(r.base_credit), new Decimal(0));
  const residual = baseDr.minus(baseCr); // >0 means debits exceed credits in base

  if (!residual.isZero()) {
    const roundingAccount = await trx('company_accounts')
      .where({ company_id: input.companyId, purpose: 'rounding' })
      .first();
    if (!roundingAccount) throw badRequest('No rounding account configured for company');
    // Base-currency-only line: zero in txn currency, absorbs the conversion residual.
    rows.push({
      line_no: rows.length + 1,
      account_id: roundingAccount.account_id,
      description: 'Currency conversion rounding',
      debit: '0.00',
      credit: '0.00',
      base_debit: residual.lt(0) ? money(residual.abs()) : '0.00',
      base_credit: residual.gt(0) ? money(residual) : '0.00',
      contact_id: null,
      tax_code_id: null,
    });
  }

  const [entry] = await trx('companies')
    .where({ id: input.companyId })
    .increment('next_entry_no', 1)
    .returning(['next_entry_no']);
  const entryNo = Number(entry.next_entry_no) - 1;

  const [je] = await trx('journal_entries')
    .insert({
      company_id: input.companyId,
      entry_no: entryNo,
      txn_date: input.txnDate,
      currency,
      exchange_rate: rate.toFixed(10),
      memo: input.memo ?? null,
      source_type: input.sourceType ?? 'manual',
      source_id: input.sourceId ?? null,
      status: 'draft',
      reverses_entry_id: input.reversesEntryId ?? null,
      created_by: input.userId ?? null,
    })
    .returning(['id']);

  await trx('journal_lines').insert(rows.map((r) => ({ ...r, entry_id: je.id })));

  await trx('journal_entries').where({ id: je.id }).update({
    status: 'posted',
    posted_at: trx.fn.now(),
    posted_by: input.userId ?? null,
  });

  return { id: je.id, entryNo };
}

/** Creates and posts the mirror image of a posted entry. The only legal "correction". */
export async function reverseEntry(
  trx: Knex,
  opts: { companyId: string; entryId: string; txnDate: string; memo?: string; userId?: string | null },
): Promise<PostedEntry> {
  const original = await trx('journal_entries')
    .where({ id: opts.entryId, company_id: opts.companyId })
    .first();
  if (!original) throw badRequest('Journal entry not found');
  if (original.status !== 'posted') throw badRequest('Only posted entries can be reversed');

  const existing = await trx('journal_entries')
    .where({ reverses_entry_id: opts.entryId })
    .first();
  if (existing) throw badRequest(`Entry already reversed by entry #${existing.entry_no}`);

  const lines = await trx('journal_lines')
    .where({ entry_id: opts.entryId })
    .orderBy('line_no');

  // Swap sides verbatim (same rate) so the reversal nets to exactly zero.
  const rows = lines.map((l: any, i: number) => ({
    line_no: i + 1,
    account_id: l.account_id,
    description: l.description,
    debit: l.credit,
    credit: l.debit,
    base_debit: l.base_credit,
    base_credit: l.base_debit,
    contact_id: l.contact_id,
    tax_code_id: l.tax_code_id,
  }));

  const company = await trx('companies').where({ id: opts.companyId }).first();
  await ensurePeriodsFor(trx, opts.companyId, opts.txnDate, company.fiscal_year_start_month);

  const [c] = await trx('companies')
    .where({ id: opts.companyId })
    .increment('next_entry_no', 1)
    .returning(['next_entry_no']);
  const entryNo = Number(c.next_entry_no) - 1;

  const [je] = await trx('journal_entries')
    .insert({
      company_id: opts.companyId,
      entry_no: entryNo,
      txn_date: opts.txnDate,
      currency: original.currency,
      exchange_rate: original.exchange_rate,
      memo: opts.memo ?? `Reversal of entry #${original.entry_no}`,
      source_type: 'reversal',
      source_id: original.source_id,
      status: 'draft',
      reverses_entry_id: original.id,
      created_by: opts.userId ?? null,
    })
    .returning(['id']);

  await trx('journal_lines').insert(rows.map((r: any) => ({ ...r, entry_id: je.id })));
  await trx('journal_entries').where({ id: je.id }).update({
    status: 'posted',
    posted_at: trx.fn.now(),
    posted_by: opts.userId ?? null,
  });

  return { id: je.id, entryNo };
}
