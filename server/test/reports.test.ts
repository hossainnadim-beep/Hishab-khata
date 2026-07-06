import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { db } from '../src/db.ts';
import { resetDb, makeCompany } from './helpers.ts';
import { createInvoice, postInvoice, receivePayment } from '../src/modules/sales/service.ts';
import { createBill, postBill } from '../src/modules/purchases/service.ts';
import { postEntry } from '../src/modules/ledger/posting.ts';
import {
  trialBalance, profitAndLoss, balanceSheet, cashFlow,
  arAging, taxSummary, customerStatement,
} from '../src/modules/reports/service.ts';
import { toXlsx, toPdf } from '../src/modules/reports/render.ts';
import { documentPdf } from '../src/modules/sales/pdf.ts';
import { d } from '../src/lib/money.ts';

let co: Awaited<ReturnType<typeof makeCompany>>;
let customer: any, vendor: any, vat15: any;
let invoiceA: any;

beforeAll(async () => {
  await resetDb();
  co = await makeCompany();
  [customer] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Meghna Retail', is_customer: true, payment_terms_days: 30 })
    .returning('*');
  [vendor] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Padma Wholesale', is_vendor: true })
    .returning('*');
  vat15 = await db('tax_codes').where({ company_id: co.company.id, code: 'VAT15' }).first();

  // Capital: owner puts in 500,000 on Jan 1
  await db.transaction((trx) =>
    postEntry(trx, {
      companyId: co.company.id, txnDate: '2026-01-01', memo: 'Opening capital',
      lines: [
        { accountId: co.byCode['1010'].id, debit: 500000 },
        { accountId: co.byCode['3000'].id, credit: 500000 },
      ],
    }),
  );
  // Bill: rent 20,000 + VAT (posted Jan 5, unpaid → AP)
  await db.transaction(async (trx) => {
    const b = await createBill(trx, co.company.id, null, {
      vendorId: vendor.id, issueDate: '2026-01-05',
      lines: [{ description: 'Office rent Jan', qty: 1, unitPrice: 20000, accountId: co.byCode['6100'].id, taxCodeId: vat15.id }],
    });
    await postBill(trx, co.company.id, b.id, null);
  });
  // Invoice A: services 100,000 + VAT, Jan 10, HALF paid Feb 1
  invoiceA = await db.transaction(async (trx) => {
    const i = await createInvoice(trx, co.company.id, null, {
      customerId: customer.id, issueDate: '2026-01-10',
      lines: [{ description: 'Consulting', qty: 1, unitPrice: 100000, accountId: co.byCode['4100'].id, taxCodeId: vat15.id }],
    });
    await postInvoice(trx, co.company.id, i.id, null);
    return i;
  });
  await db.transaction((trx) =>
    receivePayment(trx, co.company.id, null, {
      contactId: customer.id, paymentDate: '2026-02-01',
      depositAccountId: co.byCode['1010'].id,
      allocations: [{ invoiceId: invoiceA.id, amount: 57500 }],
    }),
  );
  // Invoice B: overdue since 2025-11-15 (issued 2025-10-15)
  await db.transaction(async (trx) => {
    const i = await createInvoice(trx, co.company.id, null, {
      customerId: customer.id, issueDate: '2025-10-15', dueDate: '2025-11-15',
      lines: [{ description: 'Old project', qty: 1, unitPrice: 30000, accountId: co.byCode['4100'].id, taxCodeId: vat15.id }],
    });
    await postInvoice(trx, co.company.id, i.id, null);
  });
});

afterAll(async () => {
  await db.destroy();
});

describe('financial reports', () => {
  it('trial balance balances and shows expected accounts', async () => {
    const tb = await trialBalance(db, co.company.id, '2026-03-31');
    expect(tb.balanced).toBe(true);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const ar = tb.rows.find((r) => r.account === 'Accounts Receivable');
    // AR: 115000 − 57500 + 34500 = 92000
    expect(ar?.debit).toBe('92000.00');
  });

  it('P&L reports income/expense for period with comparative', async () => {
    const pl = await profitAndLoss(db, co.company.id, {
      from: '2026-01-01', to: '2026-03-31',
      compareFrom: '2025-10-01', compareTo: '2025-12-31',
    });
    expect(pl.income.total).toBe('100000.00'); // current period revenue only
    expect(pl.expenses.total).toBe('20000.00');
    expect(pl.netIncome).toBe('80000.00');
    expect(pl.compareNetIncome).toBe('30000.00'); // old project revenue
  });

  it('balance sheet balances with current earnings in equity', async () => {
    const bs = await balanceSheet(db, co.company.id, '2026-03-31');
    expect(bs.balanced).toBe(true);
    const earnings = bs.equity.rows.find((r: any) => r.account === 'Current Earnings');
    expect(earnings?.amount).toBe('110000.00'); // 130000 revenue − 20000 rent, all time
  });

  it('cash flow (indirect) reconciles to the change in cash', async () => {
    const cf = await cashFlow(db, co.company.id, { from: '2026-01-01', to: '2026-03-31' });
    expect(cf.reconciles).toBe(true);
    // cash: 500000 capital + 57500 collected
    expect(cf.closingCash).toBe('557500.00');
    expect(cf.operating.netIncome).toBe('80000.00');
  });

  it('AR aging buckets overdue balances by days outstanding', async () => {
    const report = await arAging(db, co.company.id, '2026-02-15');
    const row = report.rows.find((r: any) => r.contact === 'Meghna Retail');
    expect(row?.['90+ days']).toBe('34500.00'); // due 2025-11-15, 92 days overdue
    expect(row?.['1–30 days']).toBe('57500.00'); // due 2026-02-09, 6 days overdue
    expect(report.totals.total).toBe('92000.00');
  });

  it('VAT summary nets output against input', async () => {
    const ts = await taxSummary(db, co.company.id, { from: '2026-01-01', to: '2026-03-31' });
    expect(ts.summary.outputVat).toBe('15000.00'); // on 100k invoice (old one outside period)
    expect(ts.summary.inputVat).toBe('3000.00'); // on 20k rent
    expect(ts.summary.netVatPayable).toBe('12000.00');
  });

  it('customer statement running balance matches AR', async () => {
    const st = await customerStatement(db, co.company.id, customer.id, {
      from: '2026-01-01', to: '2026-03-31',
    });
    expect(st.opening).toBe('34500.00');
    expect(st.closing).toBe('92000.00');
  });
});

describe('exports', () => {
  it('renders XLSX and PDF for the trial balance', async () => {
    const tb = await trialBalance(db, co.company.id, '2026-03-31');
    const flat = {
      title: 'Trial Balance',
      subtitle: 'As of 2026-03-31',
      sections: [{
        columns: [
          { label: 'Code' }, { label: 'Account' },
          { label: 'Debit', align: 'right' as const }, { label: 'Credit', align: 'right' as const },
        ],
        rows: tb.rows.map((r) => [r.code, r.account, r.debit, r.credit]),
        footer: ['', 'Total', tb.totals.debit, tb.totals.credit],
      }],
    };
    const xlsx = await toXlsx(flat);
    expect(xlsx.length).toBeGreaterThan(1000);
    expect(xlsx.subarray(0, 2).toString()).toBe('PK'); // zip magic
    const pdf = await toPdf(flat);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a branded invoice PDF', async () => {
    const company = await db('companies').where({ id: co.company.id }).first();
    const lines = await db('invoice_lines').where({ invoice_id: invoiceA.id }).orderBy('line_no');
    const invoice = await db('invoices').where({ id: invoiceA.id }).first();
    const buf = await documentPdf({
      kind: 'INVOICE', company, contact: customer, doc: invoice, lines,
    });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(2000);
  });
});
