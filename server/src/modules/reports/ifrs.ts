import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { accountBalances } from './service.ts';

/**
 * IFRS-presentation statements, derived strictly from posted journal lines
 * (the same accountBalances aggregation the trial balance uses), so every
 * figure reconciles to the trial balance by construction. Each line carries
 * its account ids for drill-down.
 */

type Bal = Awaited<ReturnType<typeof accountBalances>>[number];

interface StatementLine {
  label: string;
  accounts: Array<{ id: string; code: string; name: string }>;
  amount: string;
  compare: string | null;
}

function line(
  label: string,
  rows: Bal[],
  compareRows: Bal[] | null,
  pick: (b: Bal) => Decimal,
  sign: 1 | -1,
): StatementLine {
  const amount = rows.reduce((a, b) => a.plus(pick(b)), d(0)).times(sign);
  const compare = compareRows
    ? compareRows.reduce((a, b) => a.plus(pick(b)), d(0)).times(sign)
    : null;
  return {
    label,
    accounts: rows.map((r) => ({ id: r.id, code: r.code, name: r.name })),
    amount: money(amount),
    compare: compare !== null ? money(compare) : null,
  };
}

const bySubtype = (rows: Bal[], type: string, subtypes: string[] | null, invert = false) =>
  rows.filter(
    (b) =>
      b.type === type &&
      (subtypes === null || subtypes.includes(b.subtype ?? '') !== invert),
  );

// ---------------------------------------------------------------------------
// Statement of Profit or Loss and Other Comprehensive Income
// ---------------------------------------------------------------------------

export async function statementProfitOrLoss(
  db: Knex,
  companyId: string,
  opts: { from: string; to: string; compareFrom?: string; compareTo?: string },
) {
  const rows = await accountBalances(db, companyId, { from: opts.from, to: opts.to });
  const cmp =
    opts.compareFrom && opts.compareTo
      ? await accountBalances(db, companyId, { from: opts.compareFrom, to: opts.compareTo })
      : null;
  const mv = (b: Bal) => b.movement;
  const cmpFor = (rows2: Bal[]) =>
    cmp ? rows2.map((r) => cmp.find((c) => c.id === r.id)!).filter(Boolean) : null;

  const active = (list: Bal[]) => {
    const ids = new Set(list.map((r) => r.id));
    const current = list.filter((r) => !r.movement.isZero());
    const inCompare = cmp ? cmp.filter((c) => ids.has(c.id) && !c.movement.isZero()) : [];
    const keep = new Set([...current.map((r) => r.id), ...inCompare.map((r) => r.id)]);
    return list.filter((r) => keep.has(r.id));
  };

  const revenueRows = active(bySubtype(rows, 'income', ['operating_revenue']));
  const cogsRows = active(bySubtype(rows, 'expense', ['cogs']));
  const otherIncomeRows = active(bySubtype(rows, 'income', ['operating_revenue'], true));
  const opexRows = active(bySubtype(rows, 'expense', ['cogs'], true));

  const revenue = line('Revenue', revenueRows, cmpFor(revenueRows), mv, -1);
  const costOfSales = line('Cost of sales', cogsRows, cmpFor(cogsRows), mv, 1);
  const otherIncome = line('Other income (incl. FX gains/losses)', otherIncomeRows, cmpFor(otherIncomeRows), mv, -1);
  const opex = line('Operating and administrative expenses', opexRows, cmpFor(opexRows), mv, 1);

  const gross = (a: string, b: string) => money(d(a).minus(b));
  const grossProfit = gross(revenue.amount, costOfSales.amount);
  const grossProfitCmp =
    revenue.compare !== null ? gross(revenue.compare, costOfSales.compare!) : null;
  const profit = money(d(grossProfit).plus(otherIncome.amount).minus(opex.amount));
  const profitCmp =
    grossProfitCmp !== null
      ? money(d(grossProfitCmp).plus(otherIncome.compare!).minus(opex.compare!))
      : null;

  return {
    title: 'Statement of Profit or Loss and Other Comprehensive Income',
    period: { from: opts.from, to: opts.to },
    comparePeriod: opts.compareFrom ? { from: opts.compareFrom, to: opts.compareTo } : null,
    lines: [revenue, costOfSales],
    grossProfit: { amount: grossProfit, compare: grossProfitCmp },
    lines2: [otherIncome, opex],
    profitForPeriod: { amount: profit, compare: profitCmp },
    // No revaluation/translation reserves in scope → OCI is nil; disclosed explicitly.
    otherComprehensiveIncome: { amount: '0.00', compare: profitCmp !== null ? '0.00' : null },
    totalComprehensiveIncome: { amount: profit, compare: profitCmp },
  };
}

// ---------------------------------------------------------------------------
// Statement of Financial Position
// ---------------------------------------------------------------------------

export async function statementFinancialPosition(
  db: Knex,
  companyId: string,
  asOf: string,
  compareAsOf?: string,
) {
  const rows = await accountBalances(db, companyId, { to: asOf });
  const cmp = compareAsOf ? await accountBalances(db, companyId, { to: compareAsOf }) : null;
  const cl = (b: Bal) => b.closing;
  const cmpFor = (rows2: Bal[]) =>
    cmp ? rows2.map((r) => cmp.find((c) => c.id === r.id)!).filter(Boolean) : null;

  const nonZero = (list: Bal[]) =>
    list.filter((r) => {
      const c = cmp?.find((x) => x.id === r.id);
      return !r.closing.isZero() || (c && !c.closing.isZero());
    });

  const NC_ASSETS = ['fixed_asset', 'accumulated_depreciation'];
  const ncaRows = nonZero(bySubtype(rows, 'asset', NC_ASSETS));
  const caRows = nonZero(bySubtype(rows, 'asset', NC_ASSETS, true));
  const nclRows = nonZero(bySubtype(rows, 'liability', ['long_term_liability']));
  const clRows = nonZero(bySubtype(rows, 'liability', ['long_term_liability'], true));
  const equityRows = nonZero(rows.filter((b) => b.type === 'equity'));

  const perAccountLines = (list: Bal[], sign: 1 | -1) =>
    list.map((b) => line(`${b.code} ${b.name}`, [b], cmpFor([b]), cl, sign));

  // Retained earnings presented including accumulated profit (income+expense
  // accounts never physically close to RE).
  const plRows = rows.filter((b) => b.type === 'income' || b.type === 'expense');
  const accumulatedProfit = line('Retained earnings (incl. accumulated profit)', plRows, cmpFor(plRows), cl, -1);

  const sum = (lines: StatementLine[], key: 'amount' | 'compare') =>
    lines.reduce((a, l) => a.plus(key === 'amount' ? l.amount : l.compare ?? 0), d(0));

  const nca = perAccountLines(ncaRows, 1);
  const ca = perAccountLines(caRows, 1);
  const ncl = perAccountLines(nclRows, -1);
  const clbs = perAccountLines(clRows, -1);
  const eq = [...perAccountLines(equityRows, -1), accumulatedProfit];

  const totalAssets = money(sum(nca, 'amount').plus(sum(ca, 'amount')));
  const totalLiabilities = money(sum(ncl, 'amount').plus(sum(clbs, 'amount')));
  const totalEquity = money(sum(eq, 'amount'));
  const hasCmp = !!cmp;
  const totalAssetsCmp = hasCmp ? money(sum(nca, 'compare').plus(sum(ca, 'compare'))) : null;
  const totalLiabilitiesCmp = hasCmp ? money(sum(ncl, 'compare').plus(sum(clbs, 'compare'))) : null;
  const totalEquityCmp = hasCmp ? money(sum(eq, 'compare')) : null;

  return {
    title: 'Statement of Financial Position',
    asOf,
    compareAsOf: compareAsOf ?? null,
    nonCurrentAssets: { lines: nca, total: money(sum(nca, 'amount')), compareTotal: hasCmp ? money(sum(nca, 'compare')) : null },
    currentAssets: { lines: ca, total: money(sum(ca, 'amount')), compareTotal: hasCmp ? money(sum(ca, 'compare')) : null },
    totalAssets: { amount: totalAssets, compare: totalAssetsCmp },
    equity: { lines: eq, total: totalEquity, compareTotal: totalEquityCmp },
    nonCurrentLiabilities: { lines: ncl, total: money(sum(ncl, 'amount')), compareTotal: hasCmp ? money(sum(ncl, 'compare')) : null },
    currentLiabilities: { lines: clbs, total: money(sum(clbs, 'amount')), compareTotal: hasCmp ? money(sum(clbs, 'compare')) : null },
    totalEquityAndLiabilities: {
      amount: money(d(totalEquity).plus(totalLiabilities)),
      compare: hasCmp ? money(d(totalEquityCmp!).plus(totalLiabilitiesCmp!)) : null,
    },
    balanced: d(totalAssets).equals(d(totalEquity).plus(totalLiabilities)),
  };
}

// ---------------------------------------------------------------------------
// Statement of Changes in Equity
// ---------------------------------------------------------------------------

export async function statementChangesInEquity(
  db: Knex,
  companyId: string,
  opts: { from: string; to: string },
) {
  const rows = await accountBalances(db, companyId, { from: opts.from, to: opts.to });
  const equityAccounts = rows.filter((b) => b.type === 'equity');
  const plRows = rows.filter((b) => b.type === 'income' || b.type === 'expense');

  // Columns: each equity account + retained earnings (accumulated P&L) + total.
  const columns = [
    ...equityAccounts.map((a) => ({ id: a.id, label: a.name })),
    { id: 'retained', label: 'Retained earnings (accumulated profit)' },
  ];

  const opening = [
    ...equityAccounts.map((a) => a.opening.times(-1)),
    plRows.reduce((s, b) => s.plus(b.opening), d(0)).times(-1),
  ];
  const profitForPeriod = plRows.reduce((s, b) => s.plus(b.movement), d(0)).times(-1);
  const profitRow = [...equityAccounts.map(() => d(0)), profitForPeriod];
  const ownerMoves = [...equityAccounts.map((a) => a.movement.times(-1)), d(0)];
  const closing = opening.map((o, i) => o.plus(profitRow[i]).plus(ownerMoves[i]));

  const fmtRow = (vals: Decimal[]) => {
    const total = vals.reduce((a, v) => a.plus(v), d(0));
    return { cells: vals.map((v) => money(v)), total: money(total) };
  };

  return {
    title: 'Statement of Changes in Equity',
    period: { from: opts.from, to: opts.to },
    columns,
    rows: [
      { label: `Balance at ${opts.from}`, ...fmtRow(opening) },
      { label: 'Profit for the period', ...fmtRow(profitRow) },
      { label: 'Owner contributions / movements', ...fmtRow(ownerMoves) },
      { label: `Balance at ${opts.to}`, ...fmtRow(closing) },
    ],
    equityAccountIds: equityAccounts.map((a) => a.id),
  };
}
