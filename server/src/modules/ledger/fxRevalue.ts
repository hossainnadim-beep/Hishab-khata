import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';
import { postEntry, reverseEntry, type PostLine } from './posting.ts';
import { purposeAccount } from '../companies/service.ts';

/**
 * Unrealized FX revaluation as of a date.
 * Revalues, at the supplied closing rates:
 *  - open foreign-currency AR (invoice balances) and AP (bill balances)
 *  - foreign-currency bank/cash accounts (account.currency set)
 * Posts a base-currency-only adjustment against the unrealized FX account,
 * then an automatic reversing entry dated the next day, so settlements are
 * never affected.
 */
export async function revalueFx(
  trx: Knex,
  opts: {
    companyId: string;
    asOfDate: string;
    rates: Record<string, string | number>; // e.g. { USD: 123.5 }
    userId?: string | null;
  },
): Promise<{ adjustmentEntryId: string | null; reversalEntryId: string | null; total: string }> {
  const company = await trx('companies').where({ id: opts.companyId }).first();
  if (!company) throw badRequest('Unknown company');
  const base = company.base_currency;
  const rates = Object.fromEntries(
    Object.entries(opts.rates).map(([k, v]) => [k.toUpperCase(), d(v)]),
  );
  for (const [ccy, rate] of Object.entries(rates)) {
    if (rate.lte(0)) throw badRequest(`Rate for ${ccy} must be positive`);
    if (ccy === base) throw badRequest('Cannot revalue the base currency');
  }

  const lines: PostLine[] = [];
  let netAdjustment = new Decimal(0); // + = debit needed (asset up / gain), accumulated per account

  const arAccount = await purposeAccount(trx, opts.companyId, 'ar');
  const apAccount = await purposeAccount(trx, opts.companyId, 'ap');

  // Open AR by currency: balance_due at invoice rate vs closing rate.
  const openInvoices = await trx('invoices')
    .where({ company_id: opts.companyId, status: 'open' })
    .andWhere('issue_date', '<=', opts.asOfDate)
    .whereNot('currency', base);
  const arAdj = new Map<string, Decimal>();
  for (const inv of openInvoices) {
    const rate = rates[inv.currency];
    if (!rate) continue;
    const diff = d(inv.balance_due).times(rate).minus(d(inv.balance_due).times(d(inv.exchange_rate)));
    arAdj.set(inv.currency, (arAdj.get(inv.currency) ?? new Decimal(0)).plus(diff));
  }
  for (const [ccy, diff] of arAdj) {
    const rounded = d(money(diff));
    if (rounded.isZero()) continue;
    // AR is an asset: rate up → asset up → debit AR, credit unrealized gain.
    if (rounded.gt(0)) lines.push({ accountId: arAccount, debit: 0, baseDebit: money(rounded), description: `Revalue AR ${ccy}` });
    else lines.push({ accountId: arAccount, credit: 0, baseCredit: money(rounded.abs()), description: `Revalue AR ${ccy}` });
    netAdjustment = netAdjustment.plus(rounded);
  }

  // Open AP by currency.
  const openBills = await trx('bills')
    .where({ company_id: opts.companyId, status: 'open' })
    .andWhere('issue_date', '<=', opts.asOfDate)
    .whereNot('currency', base);
  const apAdj = new Map<string, Decimal>();
  for (const bill of openBills) {
    const rate = rates[bill.currency];
    if (!rate) continue;
    const diff = d(bill.balance_due).times(rate).minus(d(bill.balance_due).times(d(bill.exchange_rate)));
    apAdj.set(bill.currency, (apAdj.get(bill.currency) ?? new Decimal(0)).plus(diff));
  }
  for (const [ccy, diff] of apAdj) {
    const rounded = d(money(diff));
    if (rounded.isZero()) continue;
    // AP is a liability: rate up → liability up in base → credit AP, debit unrealized loss.
    if (rounded.gt(0)) lines.push({ accountId: apAccount, credit: 0, baseCredit: money(rounded), description: `Revalue AP ${ccy}` });
    else lines.push({ accountId: apAccount, debit: 0, baseDebit: money(rounded.abs()), description: `Revalue AP ${ccy}` });
    netAdjustment = netAdjustment.minus(rounded);
  }

  // Foreign-currency bank/cash accounts: txn-currency balance × closing rate vs booked base.
  const fcAccounts = await trx('accounts')
    .where({ company_id: opts.companyId, archived: false })
    .whereIn('subtype', ['bank', 'cash'])
    .whereNotNull('currency')
    .whereNot('currency', base);
  for (const acct of fcAccounts) {
    const rate = rates[acct.currency];
    if (!rate) continue;
    const [bal] = await trx('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where({ 'je.company_id': opts.companyId, 'je.status': 'posted', 'jl.account_id': acct.id })
      .andWhere('je.txn_date', '<=', opts.asOfDate)
      .select(
        trx.raw('coalesce(sum(jl.debit) - sum(jl.credit),0) as txn_bal'),
        trx.raw('coalesce(sum(jl.base_debit) - sum(jl.base_credit),0) as base_bal'),
      );
    const target = d(bal.txn_bal).times(rate);
    const diff = d(money(target.minus(d(bal.base_bal))));
    if (diff.isZero()) continue;
    if (diff.gt(0)) lines.push({ accountId: acct.id, debit: 0, baseDebit: money(diff), description: `Revalue ${acct.name}` });
    else lines.push({ accountId: acct.id, credit: 0, baseCredit: money(diff.abs()), description: `Revalue ${acct.name}` });
    netAdjustment = netAdjustment.plus(diff);
  }

  if (!lines.length) return { adjustmentEntryId: null, reversalEntryId: null, total: '0.00' };

  // Balance with the unrealized FX P&L account.
  const unrealizedAccount = await purposeAccount(trx, opts.companyId, 'unrealized_fx');
  const net = d(money(netAdjustment));
  if (net.gt(0)) {
    lines.push({ accountId: unrealizedAccount, credit: 0, baseCredit: money(net), description: 'Unrealized FX gain' });
  } else if (net.lt(0)) {
    lines.push({ accountId: unrealizedAccount, debit: 0, baseDebit: money(net.abs()), description: 'Unrealized FX loss' });
  }

  const adj = await postEntry(trx, {
    companyId: opts.companyId,
    txnDate: opts.asOfDate,
    memo: `Unrealized FX revaluation as of ${opts.asOfDate}`,
    sourceType: 'fx_revaluation',
    userId: opts.userId,
    lines,
  });

  const nextDay = new Date(new Date(opts.asOfDate + 'T00:00:00Z').getTime() + 86400000)
    .toISOString()
    .slice(0, 10);
  const rev = await reverseEntry(trx, {
    companyId: opts.companyId,
    entryId: adj.id,
    txnDate: nextDay,
    memo: `Auto-reversal of FX revaluation ${opts.asOfDate}`,
    userId: opts.userId,
  });

  return { adjustmentEntryId: adj.id, reversalEntryId: rev.id, total: money(net) };
}
