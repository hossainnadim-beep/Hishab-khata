import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';

/** Per-account signed base balance (debit positive) with opening/movement split. */
export async function accountBalances(
  db: Knex,
  companyId: string,
  opts: { from?: string; to?: string },
): Promise<
  Array<{
    id: string; code: string; name: string; type: string; subtype: string | null;
    opening: Decimal; movement: Decimal; closing: Decimal;
  }>
> {
  const rows = await db('accounts as a')
    .leftJoin('journal_lines as jl', 'jl.account_id', 'a.id')
    .leftJoin('journal_entries as je', function () {
      this.on('je.id', 'jl.entry_id').andOnVal('je.status', 'posted');
    })
    .where('a.company_id', companyId)
    .groupBy('a.id')
    .orderBy('a.code')
    .select(
      'a.id', 'a.code', 'a.name', 'a.type', 'a.subtype',
      db.raw(
        `coalesce(sum(case when je.id is not null AND ?::date is not null AND je.txn_date < ?::date
           then jl.base_debit - jl.base_credit else 0 end), 0) as opening`,
        [opts.from ?? null, opts.from ?? null],
      ),
      db.raw(
        `coalesce(sum(case when je.id is not null
           AND (?::date is null OR je.txn_date >= ?::date)
           AND (?::date is null OR je.txn_date <= ?::date)
           then jl.base_debit - jl.base_credit else 0 end), 0) as movement`,
        [opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null],
      ),
    );
  return rows.map((r: any) => {
    const opening = d(r.opening);
    const movement = d(r.movement);
    return { ...r, opening, movement, closing: opening.plus(movement) };
  });
}

export async function trialBalance(db: Knex, companyId: string, asOf: string) {
  const balances = await accountBalances(db, companyId, { to: asOf });
  const rows = balances
    .filter((b) => !b.closing.isZero())
    .map((b) => ({
      accountId: b.id,
      code: b.code,
      account: b.name,
      type: b.type,
      debit: b.closing.gt(0) ? money(b.closing) : '',
      credit: b.closing.lt(0) ? money(b.closing.abs()) : '',
    }));
  const totalDebit = balances.reduce((a, b) => (b.closing.gt(0) ? a.plus(b.closing) : a), d(0));
  const totalCredit = balances.reduce((a, b) => (b.closing.lt(0) ? a.plus(b.closing.abs()) : a), d(0));
  return {
    title: 'Trial Balance',
    asOf,
    rows,
    totals: { debit: money(totalDebit), credit: money(totalCredit) },
    balanced: totalDebit.equals(totalCredit),
  };
}

export interface PeriodOpts {
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
}

export async function profitAndLoss(db: Knex, companyId: string, opts: PeriodOpts) {
  const current = await accountBalances(db, companyId, { from: opts.from, to: opts.to });
  const compare =
    opts.compareFrom && opts.compareTo
      ? await accountBalances(db, companyId, { from: opts.compareFrom, to: opts.compareTo })
      : null;
  const compareById = compare ? new Map(compare.map((c) => [c.id, c])) : null;

  const section = (type: 'income' | 'expense') => {
    // income: credit-normal → negate movement; expense: debit-normal.
    const sign = type === 'income' ? -1 : 1;
    const rows = current
      .filter((b) => b.type === type)
      .map((b) => ({
        accountId: b.id,
        code: b.code,
        account: b.name,
        amount: b.movement.times(sign),
        compare: compareById ? (compareById.get(b.id)?.movement ?? d(0)).times(sign) : null,
      }))
      .filter((r) => !r.amount.isZero() || (r.compare && !r.compare.isZero()));
    const total = rows.reduce((a, r) => a.plus(r.amount), d(0));
    const compareTotal = compareById ? rows.reduce((a, r) => a.plus(r.compare ?? 0), d(0)) : null;
    return {
      rows: rows.map((r) => ({
        accountId: r.accountId,
        code: r.code,
        account: r.account,
        amount: money(r.amount),
        ...(r.compare !== null ? { compare: money(r.compare) } : {}),
      })),
      total,
      compareTotal,
    };
  };

  const income = section('income');
  const expenses = section('expense');
  const netIncome = income.total.minus(expenses.total);
  return {
    title: 'Profit & Loss',
    period: { from: opts.from, to: opts.to },
    comparePeriod: opts.compareFrom ? { from: opts.compareFrom, to: opts.compareTo } : null,
    income: { rows: income.rows, total: money(income.total), compareTotal: income.compareTotal !== null ? money(income.compareTotal) : null },
    expenses: { rows: expenses.rows, total: money(expenses.total), compareTotal: expenses.compareTotal !== null ? money(expenses.compareTotal) : null },
    netIncome: money(netIncome),
    compareNetIncome:
      income.compareTotal !== null && expenses.compareTotal !== null
        ? money(income.compareTotal.minus(expenses.compareTotal))
        : null,
  };
}

export async function balanceSheet(db: Knex, companyId: string, asOf: string, compareAsOf?: string) {
  const build = async (date: string) => {
    const balances = await accountBalances(db, companyId, { to: date });
    const bucket = (type: string, sign: 1 | -1) =>
      balances
        .filter((b) => b.type === type && !b.closing.isZero())
        .map((b) => ({ accountId: b.id, code: b.code, account: b.name, subtype: b.subtype, amount: b.closing.times(sign) }));
    // Net income to date rolls into equity as current earnings.
    const netIncome = balances
      .filter((b) => b.type === 'income' || b.type === 'expense')
      .reduce((a, b) => a.plus(b.closing), d(0))
      .times(-1);
    return { assets: bucket('asset', 1), liabilities: bucket('liability', -1), equity: bucket('equity', -1), netIncome };
  };

  const fmt = (b: Awaited<ReturnType<typeof build>>) => {
    const sum = (rows: Array<{ amount: Decimal }>) => rows.reduce((a, r) => a.plus(r.amount), d(0));
    const totalAssets = sum(b.assets);
    const totalLiabilities = sum(b.liabilities);
    const equityRows = [
      ...b.equity.map((r) => ({ accountId: r.accountId, code: r.code, account: r.account, amount: money(r.amount) })),
      { accountId: null, code: '', account: 'Current Earnings', amount: money(b.netIncome) },
    ];
    const totalEquity = sum(b.equity).plus(b.netIncome);
    const mapRows = (rows: any[]) =>
      rows.map((r) => ({ accountId: r.accountId, code: r.code, account: r.account, amount: money(r.amount) }));
    return {
      assets: { rows: mapRows(b.assets), total: money(totalAssets) },
      liabilities: { rows: mapRows(b.liabilities), total: money(totalLiabilities) },
      equity: { rows: equityRows, total: money(totalEquity) },
      totalLiabilitiesAndEquity: money(totalLiabilities.plus(totalEquity)),
      balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
    };
  };

  const current = fmt(await build(asOf));
  const compare = compareAsOf ? fmt(await build(compareAsOf)) : null;
  return { title: 'Balance Sheet', asOf, compareAsOf: compareAsOf ?? null, ...current, compare };
}

/**
 * Indirect cash flow. Every balance-sheet account belongs to exactly one
 * bucket, so Operating + Investing + Financing always reconciles to the
 * change in cash.
 */
export async function cashFlow(db: Knex, companyId: string, opts: { from: string; to: string }) {
  const balances = await accountBalances(db, companyId, { from: opts.from, to: opts.to });

  const netIncome = balances
    .filter((b) => b.type === 'income' || b.type === 'expense')
    .reduce((a, b) => a.plus(b.movement), d(0))
    .times(-1);

  const isCash = (b: any) => b.type === 'asset' && ['bank', 'cash'].includes(b.subtype);
  const cashDelta = balances.filter(isCash).reduce((a, b) => a.plus(b.movement), d(0));
  const cashOpening = balances.filter(isCash).reduce((a, b) => a.plus(b.opening), d(0));

  const operating: Array<{ label: string; amount: Decimal }> = [];
  const investing: Array<{ label: string; amount: Decimal }> = [];
  const financing: Array<{ label: string; amount: Decimal }> = [];

  for (const b of balances) {
    if (isCash(b) || b.type === 'income' || b.type === 'expense' || b.movement.isZero()) continue;
    if (b.type === 'asset') {
      const effect = b.movement.times(-1); // asset up = cash used
      if (b.subtype === 'fixed_asset') {
        investing.push({ label: b.name, amount: effect });
      } else if (b.subtype === 'accumulated_depreciation') {
        operating.push({ label: `Depreciation (${b.name})`, amount: effect });
      } else {
        operating.push({ label: `Change in ${b.name}`, amount: effect });
      }
    } else if (b.type === 'liability') {
      // movement is debit-positive; a liability increase is negative movement → cash source
      const eff = b.movement.times(-1);
      if (b.subtype === 'long_term_liability') financing.push({ label: b.name, amount: eff });
      else operating.push({ label: `Change in ${b.name}`, amount: eff });
    } else if (b.type === 'equity') {
      financing.push({ label: b.name, amount: b.movement.times(-1) });
    }
  }

  const sum = (rows: Array<{ amount: Decimal }>) => rows.reduce((a, r) => a.plus(r.amount), d(0));
  const operatingTotal = netIncome.plus(sum(operating));
  const investingTotal = sum(investing);
  const financingTotal = sum(financing);
  const netChange = operatingTotal.plus(investingTotal).plus(financingTotal);

  const fmtRows = (rows: Array<{ label: string; amount: Decimal }>) =>
    rows.map((r) => ({ label: r.label, amount: money(r.amount) }));

  return {
    title: 'Cash Flow Statement (Indirect)',
    period: { from: opts.from, to: opts.to },
    operating: {
      netIncome: money(netIncome),
      adjustments: fmtRows(operating),
      total: money(operatingTotal),
    },
    investing: { rows: fmtRows(investing), total: money(investingTotal) },
    financing: { rows: fmtRows(financing), total: money(financingTotal) },
    netChange: money(netChange),
    openingCash: money(cashOpening),
    closingCash: money(cashOpening.plus(cashDelta)),
    reconciles: netChange.equals(cashDelta),
  };
}

export async function generalLedger(
  db: Knex,
  companyId: string,
  opts: { from: string; to: string; accountId?: string },
) {
  const accounts = await db('accounts')
    .where({ company_id: companyId })
    .modify((q) => opts.accountId && q.andWhere('id', opts.accountId))
    .orderBy('code');

  const openings = await accountBalances(db, companyId, { from: opts.from, to: opts.to });
  const openingById = new Map(openings.map((o) => [o.id, o.opening]));

  const lines = await db('journal_lines as jl')
    .join('journal_entries as je', 'je.id', 'jl.entry_id')
    .where({ 'je.company_id': companyId, 'je.status': 'posted' })
    .andWhere('je.txn_date', '>=', opts.from)
    .andWhere('je.txn_date', '<=', opts.to)
    .modify((q) => opts.accountId && q.andWhere('jl.account_id', opts.accountId))
    .orderBy([{ column: 'je.txn_date' }, { column: 'je.entry_no' }, { column: 'jl.line_no' }])
    .select(
      'jl.account_id', 'jl.description', 'jl.base_debit', 'jl.base_credit',
      'je.id as entry_id', 'je.txn_date', 'je.entry_no', 'je.memo', 'je.source_type',
    );

  const byAccount = new Map<string, any[]>();
  for (const l of lines) {
    if (!byAccount.has(l.account_id)) byAccount.set(l.account_id, []);
    byAccount.get(l.account_id)!.push(l);
  }

  const sections = [];
  for (const a of accounts) {
    const accLines = byAccount.get(a.id) ?? [];
    const opening = openingById.get(a.id) ?? d(0);
    if (!accLines.length && opening.isZero()) continue;
    let running = opening;
    const rows = accLines.map((l) => {
      running = running.plus(d(l.base_debit)).minus(d(l.base_credit));
      return {
        date: l.txn_date,
        entryId: l.entry_id,
        entryNo: Number(l.entry_no),
        source: l.source_type,
        description: l.description ?? l.memo,
        debit: d(l.base_debit).isZero() ? '' : money(l.base_debit),
        credit: d(l.base_credit).isZero() ? '' : money(l.base_credit),
        balance: money(running),
      };
    });
    sections.push({
      accountId: a.id,
      accountCode: a.code,
      accountName: a.name,
      opening: money(opening),
      rows,
      closing: money(running),
    });
  }
  return { title: 'General Ledger', period: opts, sections };
}

const AGING_BUCKETS = [
  { label: 'Current', min: -100000, max: 0 },
  { label: '1–30 days', min: 1, max: 30 },
  { label: '31–60 days', min: 31, max: 60 },
  { label: '61–90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: 1000000 },
];

async function aging(
  db: Knex,
  companyId: string,
  asOf: string,
  side: 'ar' | 'ap',
) {
  const table = side === 'ar' ? 'invoices' : 'bills';
  const contactCol = side === 'ar' ? 'customer_id' : 'vendor_id';
  const docs = await db(`${table} as t`)
    .join('contacts as c', 'c.id', `t.${contactCol}`)
    .where({ 't.company_id': companyId, 't.status': 'open' })
    .andWhere('t.issue_date', '<=', asOf)
    .select('t.doc_no', 't.due_date', 't.currency', 't.exchange_rate', 't.balance_due', 'c.name as contact');

  const byContact = new Map<string, { contact: string; buckets: Decimal[]; total: Decimal }>();
  for (const doc of docs) {
    const baseBalance = d(doc.balance_due).times(d(doc.exchange_rate));
    const daysOverdue = Math.floor(
      (new Date(asOf + 'T00:00:00Z').getTime() - new Date(doc.due_date + 'T00:00:00Z').getTime()) / 86400000,
    );
    const idx = AGING_BUCKETS.findIndex((b) => daysOverdue >= b.min && daysOverdue <= b.max);
    if (!byContact.has(doc.contact)) {
      byContact.set(doc.contact, { contact: doc.contact, buckets: AGING_BUCKETS.map(() => d(0)), total: d(0) });
    }
    const entry = byContact.get(doc.contact)!;
    entry.buckets[idx === -1 ? 0 : idx] = entry.buckets[idx === -1 ? 0 : idx].plus(baseBalance);
    entry.total = entry.total.plus(baseBalance);
  }

  const rows = [...byContact.values()]
    .sort((a, b) => b.total.comparedTo(a.total))
    .map((r) => ({
      contact: r.contact,
      ...Object.fromEntries(AGING_BUCKETS.map((b, i) => [b.label, money(r.buckets[i])])),
      total: money(r.total),
    }));
  const totals = Object.fromEntries(
    AGING_BUCKETS.map((b, i) => [
      b.label,
      money([...byContact.values()].reduce((a, r) => a.plus(r.buckets[i]), d(0))),
    ]),
  );
  const grandTotal = money([...byContact.values()].reduce((a, r) => a.plus(r.total), d(0)));
  return {
    title: side === 'ar' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging',
    asOf,
    buckets: AGING_BUCKETS.map((b) => b.label),
    rows,
    totals: { ...totals, total: grandTotal },
  };
}

export const arAging = (db: Knex, companyId: string, asOf: string) => aging(db, companyId, asOf, 'ar');
export const apAging = (db: Knex, companyId: string, asOf: string) => aging(db, companyId, asOf, 'ap');

/** VAT/tax summary grouped by report category, from posted journal lines. */
export async function taxSummary(db: Knex, companyId: string, opts: { from: string; to: string }) {
  const rows = await db('journal_lines as jl')
    .join('journal_entries as je', 'je.id', 'jl.entry_id')
    .join('tax_codes as tc', 'tc.id', 'jl.tax_code_id')
    .join('accounts as a', 'a.id', 'jl.account_id')
    .where({ 'je.company_id': companyId, 'je.status': 'posted' })
    .andWhere('je.txn_date', '>=', opts.from)
    .andWhere('je.txn_date', '<=', opts.to)
    .whereNotNull('jl.tax_code_id')
    // Only lines that hit the tax control accounts (not revenue/expense lines tagged with a code)
    .whereIn('jl.account_id', function () {
      this.select('sales_account_id').from('tax_codes').where('company_id', companyId).whereNotNull('sales_account_id')
        .union(function (this: any) {
          this.select('purchase_account_id').from('tax_codes').where('company_id', companyId).whereNotNull('purchase_account_id');
        });
    })
    .groupBy('tc.code', 'tc.name', 'tc.rate', 'tc.report_category', 'a.type')
    .select(
      'tc.code', 'tc.name', 'tc.rate', 'tc.report_category', 'a.type as account_type',
      db.raw('sum(jl.base_credit) - sum(jl.base_debit) as net_credit'),
    );

  let outputVat = d(0);
  let inputVat = d(0);
  let vdsPayable = d(0);
  let aitNet = d(0);
  const detail = rows.map((r: any) => {
    const netCredit = d(r.net_credit);
    if (r.report_category?.startsWith('vat') || r.report_category === 'zero_rated') {
      // liability side (output) accumulates credit; asset side (input) accumulates debit
      if (r.account_type === 'liability') outputVat = outputVat.plus(netCredit);
      else inputVat = inputVat.plus(netCredit.times(-1));
    } else if (r.report_category === 'vds') {
      vdsPayable = vdsPayable.plus(netCredit);
    } else if (r.report_category === 'ait') {
      aitNet = aitNet.plus(netCredit);
    }
    return {
      code: r.code,
      name: r.name,
      rate: d(r.rate).toFixed(2),
      category: r.report_category,
      amount: money(netCredit.abs()),
      direction: netCredit.gte(0) ? 'payable' : 'receivable',
    };
  });

  return {
    title: 'VAT & Withholding Summary',
    period: opts,
    rows: detail,
    summary: {
      outputVat: money(outputVat),
      inputVat: money(inputVat),
      netVatPayable: money(outputVat.minus(inputVat)),
      vdsPayable: money(vdsPayable),
      aitNet: money(aitNet),
    },
  };
}

export async function stockOnHand(db: Knex, companyId: string) {
  const items = await db('items')
    .where({ company_id: companyId, type: 'inventory', archived: false })
    .orderBy('name');
  const rows = items.map((i: any) => ({
    name: i.name,
    sku: i.sku ?? '',
    qtyOnHand: d(i.qty_on_hand).toFixed(2),
    avgCost: d(i.avg_cost).toFixed(2),
    value: money(d(i.qty_on_hand).times(d(i.avg_cost))),
  }));
  return {
    title: 'Stock on Hand',
    rows,
    totalValue: money(rows.reduce((a, r) => a.plus(r.value), d(0))),
  };
}

/** Customer statement: documents and payments in period with running balance. */
export async function customerStatement(
  db: Knex,
  companyId: string,
  customerId: string,
  opts: { from: string; to: string },
) {
  const customer = await db('contacts').where({ id: customerId, company_id: companyId }).first();
  if (!customer) throw new Error('Customer not found');

  const arLines = await db('journal_lines as jl')
    .join('journal_entries as je', 'je.id', 'jl.entry_id')
    .join('company_accounts as ca', function () {
      this.on('ca.account_id', 'jl.account_id').andOnVal('ca.purpose', 'ar');
    })
    .where({ 'je.company_id': companyId, 'je.status': 'posted', 'jl.contact_id': customerId })
    .orderBy([{ column: 'je.txn_date' }, { column: 'je.entry_no' }])
    .select('je.txn_date', 'je.source_type', 'je.memo', 'jl.description', 'jl.base_debit', 'jl.base_credit');

  let opening = d(0);
  const rows: any[] = [];
  let running = d(0);
  for (const l of arLines) {
    const delta = d(l.base_debit).minus(d(l.base_credit));
    if (l.txn_date < opts.from) {
      opening = opening.plus(delta);
      continue;
    }
    if (l.txn_date > opts.to) continue;
    running = (rows.length ? running : opening).plus(delta);
    rows.push({
      date: l.txn_date,
      type: l.source_type,
      description: l.description ?? l.memo,
      charges: d(l.base_debit).isZero() ? '' : money(l.base_debit),
      payments: d(l.base_credit).isZero() ? '' : money(l.base_credit),
      balance: money(running),
    });
  }
  return {
    title: 'Customer Statement',
    customer: { name: customer.name, address: customer.address, email: customer.email },
    period: opts,
    opening: money(opening),
    rows,
    closing: money(rows.length ? running : opening),
  };
}
