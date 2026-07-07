import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { db } from '../src/db.ts';
import { resetDb, makeCompany } from './helpers.ts';
import { createInvoice, postInvoice, receivePayment } from '../src/modules/sales/service.ts';
import { createBill, postBill } from '../src/modules/purchases/service.ts';
import { postEntry } from '../src/modules/ledger/posting.ts';
import { trialBalance, profitAndLoss } from '../src/modules/reports/service.ts';
import {
  statementProfitOrLoss,
  statementFinancialPosition,
  statementChangesInEquity,
} from '../src/modules/reports/ifrs.ts';
import { d } from '../src/lib/money.ts';

let co: Awaited<ReturnType<typeof makeCompany>>;
let customer: any, vendor: any, vat15: any;

beforeAll(async () => {
  await resetDb();
  co = await makeCompany();
  [customer] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Customer A', is_customer: true })
    .returning('*');
  [vendor] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Vendor B', is_vendor: true })
    .returning('*');
  vat15 = await db('tax_codes').where({ company_id: co.company.id, code: 'VAT15' }).first();

  // Capital 200k (equity), loan 100k (non-current liability)
  await db.transaction((trx) =>
    postEntry(trx, {
      companyId: co.company.id, txnDate: '2026-01-05', memo: 'Capital + loan',
      lines: [
        { accountId: co.byCode['1010'].id, debit: 300000 },
        { accountId: co.byCode['3000'].id, credit: 200000 },
        { accountId: co.byCode['2300'].id, credit: 100000 },
      ],
    }),
  );
  // Revenue 50k + VAT (paid), rent bill 10k + VAT (open)
  await db.transaction(async (trx) => {
    const inv = await createInvoice(trx, co.company.id, null, {
      customerId: customer.id, issueDate: '2026-02-01',
      lines: [{ description: 'Services', qty: 1, unitPrice: 50000, accountId: co.byCode['4100'].id, taxCodeId: vat15.id }],
    });
    await postInvoice(trx, co.company.id, inv.id, null);
    await receivePayment(trx, co.company.id, null, {
      contactId: customer.id, paymentDate: '2026-02-15',
      depositAccountId: co.byCode['1010'].id,
      allocations: [{ invoiceId: inv.id, amount: 57500 }],
    });
    const bill = await createBill(trx, co.company.id, null, {
      vendorId: vendor.id, issueDate: '2026-02-10',
      lines: [{ description: 'Rent', qty: 1, unitPrice: 10000, accountId: co.byCode['6100'].id, taxCodeId: vat15.id }],
    });
    await postBill(trx, co.company.id, bill.id, null);
  });
});

afterAll(async () => {
  await db.destroy();
});

describe('IFRS statements reconcile to the trial balance', () => {
  it('SPL profit equals P&L net income and revenue/expense classification is right', async () => {
    const spl = await statementProfitOrLoss(db, co.company.id, {
      from: '2026-01-01', to: '2026-03-31',
      compareFrom: '2025-01-01', compareTo: '2025-12-31',
    });
    const pl = await profitAndLoss(db, co.company.id, { from: '2026-01-01', to: '2026-03-31' });
    expect(spl.profitForPeriod.amount).toBe(pl.netIncome); // 40000.00
    expect(spl.profitForPeriod.amount).toBe('40000.00');
    expect(spl.totalComprehensiveIncome.amount).toBe(spl.profitForPeriod.amount); // OCI nil
    expect(spl.profitForPeriod.compare).toBe('0.00');
    // every line exposes account ids for drill-down
    for (const l of [...spl.lines, ...spl.lines2]) {
      for (const a of l.accounts) expect(a.id).toBeTruthy();
    }
  });

  it('SFP balances, classifies current vs non-current, and ties to the TB', async () => {
    const sfp = await statementFinancialPosition(db, co.company.id, '2026-03-31');
    expect(sfp.balanced).toBe(true);
    expect(sfp.totalAssets.amount).toBe(sfp.totalEquityAndLiabilities.amount);
    // Loan (2300, long_term_liability) sits in non-current liabilities
    expect(sfp.nonCurrentLiabilities.total).toBe('100000.00');
    // AP (bill open 11500) + VAT output-input (7500-1500=6000) in current liabilities... AP 11500 + net VAT accounts
    const tb = await trialBalance(db, co.company.id, '2026-03-31');
    expect(tb.balanced).toBe(true);
    // Total assets equals TB debit-side asset closing sum: cross-check via TB totals
    // (TB total debits include assets + expenses; direct tie: SFP assets = TB asset rows)
    const tbAssets = tb.rows
      .filter((r) => r.type === 'asset')
      .reduce((a, r) => a.plus(r.debit || 0).minus(r.credit || 0), d(0));
    expect(sfp.totalAssets.amount).toBe(tbAssets.toFixed(2));
  });

  it('SOCE rows roll: opening + profit + owner moves = closing = SFP equity', async () => {
    const soce = await statementChangesInEquity(db, co.company.id, {
      from: '2026-01-01', to: '2026-03-31',
    });
    const [opening, profit, moves, closing] = soce.rows;
    const total = (r: any) => d(r.total);
    expect(total(opening).plus(total(profit)).plus(total(moves)).toFixed(2)).toBe(
      total(closing).toFixed(2),
    );
    expect(total(profit).toFixed(2)).toBe('40000.00');
    const sfp = await statementFinancialPosition(db, co.company.id, '2026-03-31');
    expect(total(closing).toFixed(2)).toBe(sfp.equity.total);
  });
});

describe('audit immutability (phase 2)', () => {
  it('audit_log rejects UPDATE and DELETE at the database level', async () => {
    await db('audit_log').insert({
      company_id: co.company.id, action: 'test.event', entity_type: 'test', entity_id: 'x',
    });
    const row = await db('audit_log').where({ company_id: co.company.id }).first();
    await expect(db('audit_log').where({ id: row.id }).update({ action: 'tampered' }))
      .rejects.toThrow(/immutable/);
    await expect(db('audit_log').where({ id: row.id }).delete()).rejects.toThrow(/immutable/);
  });
});
