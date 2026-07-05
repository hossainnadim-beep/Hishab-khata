import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { db } from '../src/db.ts';
import { resetDb, makeCompany, trialBalanceDiff } from './helpers.ts';
import {
  createInvoice, postInvoice, voidInvoice, receivePayment,
  createCreditNote, postCreditNote, applyCreditNote, runRecurringInvoices,
} from '../src/modules/sales/service.ts';
import {
  createBill, postBill, payBill,
  createVendorCredit, postVendorCredit, applyVendorCredit,
  createExpenseClaim, approveExpenseClaim, reimburseExpenseClaim,
} from '../src/modules/purchases/service.ts';
import { d } from '../src/lib/money.ts';

let co: Awaited<ReturnType<typeof makeCompany>>;
let customer: any, vendor: any, widget: any, consulting: any;
let taxByCode: Record<string, any> = {};

async function accountBalance(companyId: string, accountId: string): Promise<string> {
  const [row] = await db('journal_lines as jl')
    .join('journal_entries as je', 'je.id', 'jl.entry_id')
    .where({ 'je.company_id': companyId, 'je.status': 'posted', 'jl.account_id': accountId })
    .select(db.raw('coalesce(sum(jl.base_debit) - sum(jl.base_credit),0) as bal'));
  return d(row.bal).toFixed(2);
}

beforeAll(async () => {
  await resetDb();
  co = await makeCompany();
  [customer] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Rahim Traders', is_customer: true, payment_terms_days: 30 })
    .returning('*');
  [vendor] = await db('contacts')
    .insert({ company_id: co.company.id, name: 'Karim Suppliers', is_vendor: true, payment_terms_days: 14 })
    .returning('*');
  const codes = await db('tax_codes').where({ company_id: co.company.id });
  for (const c of codes) taxByCode[c.code] = c;
  [widget] = await db('items')
    .insert({
      company_id: co.company.id, name: 'Widget', type: 'inventory',
      sale_price: '500', purchase_price: '300',
      inventory_account_id: co.byCode['1200'].id,
      expense_account_id: co.byCode['5000'].id,
      income_account_id: co.byCode['4000'].id,
      tax_code_id: taxByCode['VAT15'].id,
    })
    .returning('*');
  [consulting] = await db('items')
    .insert({
      company_id: co.company.id, name: 'Consulting', type: 'service',
      sale_price: '10000', income_account_id: co.byCode['4100'].id,
      tax_code_id: taxByCode['VAT15'].id,
    })
    .returning('*');
});

afterAll(async () => {
  await db.destroy();
});

describe('purchase → inventory → sale cycle', () => {
  it('bill stock-in sets weighted average cost', async () => {
    // Buy 10 @ 300
    const bill1 = await db.transaction(async (trx) => {
      const b = await createBill(trx, co.company.id, null, {
        vendorId: vendor.id, issueDate: '2026-01-05',
        lines: [{ itemId: widget.id, qty: 10, unitPrice: 300, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postBill(trx, co.company.id, b.id, null);
    });
    expect(bill1.total).toBe('3450.00'); // 3000 + 15% VAT
    // Buy 10 @ 360 → avg (3000+3600)/20 = 330
    await db.transaction(async (trx) => {
      const b = await createBill(trx, co.company.id, null, {
        vendorId: vendor.id, issueDate: '2026-01-10',
        lines: [{ itemId: widget.id, qty: 10, unitPrice: 360, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postBill(trx, co.company.id, b.id, null);
    });
    const item = await db('items').where({ id: widget.id }).first();
    expect(d(item.qty_on_hand).toFixed(0)).toBe('20');
    expect(d(item.avg_cost).toFixed(2)).toBe('330.00');
    // Input VAT accumulated: 450 + 540 = 990
    expect(await accountBalance(co.company.id, co.byCode['1310'].id)).toBe('990.00');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });

  it('invoice posts revenue, output VAT, AR, and COGS at weighted average', async () => {
    const { invoice } = await db.transaction(async (trx) => {
      const inv = await createInvoice(trx, co.company.id, null, {
        customerId: customer.id, issueDate: '2026-01-15',
        lines: [{ itemId: widget.id, qty: 5, unitPrice: 500, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postInvoice(trx, co.company.id, inv.id, null);
    });
    expect(invoice.total).toBe('2875.00'); // 2500 + 375
    const item = await db('items').where({ id: widget.id }).first();
    expect(d(item.qty_on_hand).toFixed(0)).toBe('15');
    expect(await accountBalance(co.company.id, co.byCode['5000'].id)).toBe('1650.00'); // 5×330
    expect(await accountBalance(co.company.id, co.byCode['1200'].id)).toBe('4950.00'); // 6600−1650
    expect(await accountBalance(co.company.id, co.byCode['4000'].id)).toBe('-2500.00');
    expect(await accountBalance(co.company.id, co.byCode['2100'].id)).toBe('-375.00');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });

  it('receive payment with AIT withheld by customer', async () => {
    const inv = await db.transaction(async (trx) => {
      const i = await createInvoice(trx, co.company.id, null, {
        customerId: customer.id, issueDate: '2026-01-20',
        lines: [{ itemId: consulting.id, qty: 1, unitPrice: 20000, taxCodeId: taxByCode['VAT15'].id }],
      });
      await postInvoice(trx, co.company.id, i.id, null);
      return i;
    });
    // total 23000; customer withholds AIT 5% of net (1000); pays 22000 cash
    await db.transaction((trx) =>
      receivePayment(trx, co.company.id, null, {
        contactId: customer.id, paymentDate: '2026-02-01',
        depositAccountId: co.byCode['1010'].id,
        allocations: [{ invoiceId: inv.id, amount: 23000 }],
        withholdings: [{ taxCodeId: taxByCode['AIT5'].id, baseAmount: 20000, amount: 1000 }],
      }),
    );
    const updated = await db('invoices').where({ id: inv.id }).first();
    expect(updated.status).toBe('paid');
    expect(updated.balance_due).toBe('0.00');
    expect(await accountBalance(co.company.id, co.byCode['1300'].id)).toBe('1000.00'); // AIT receivable
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });

  it('pay bill withholding VDS and AIT at source', async () => {
    const bill = await db.transaction(async (trx) => {
      const b = await createBill(trx, co.company.id, null, {
        vendorId: vendor.id, issueDate: '2026-02-05',
        lines: [{ description: 'Office renovation', qty: 1, unitPrice: 10000, accountId: co.byCode['6800'].id, taxCodeId: taxByCode['VAT15'].id }],
      });
      await postBill(trx, co.company.id, b.id, null);
      return b;
    });
    // total 11500; withhold VDS 1500 (15% of 10000) + AIT 500 (5%); cash 9500
    const payment = await db.transaction((trx) =>
      payBill(trx, co.company.id, null, {
        contactId: vendor.id, paymentDate: '2026-02-10',
        paymentAccountId: co.byCode['1010'].id,
        allocations: [{ billId: bill.id, amount: 11500 }],
        withholdings: [
          { taxCodeId: taxByCode['VDS15'].id, baseAmount: 10000, amount: 1500 },
          { taxCodeId: taxByCode['AIT5'].id, baseAmount: 10000, amount: 500 },
        ],
      }),
    );
    expect(payment.amount).toBe('9500.00');
    expect(await accountBalance(co.company.id, co.byCode['2110'].id)).toBe('-1500.00'); // VDS payable
    expect(await accountBalance(co.company.id, co.byCode['2120'].id)).toBe('-500.00'); // AIT payable
    const paid = await db('bills').where({ id: bill.id }).first();
    expect(paid.status).toBe('paid');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});

describe('multi-currency realized FX', () => {
  it('USD invoice paid at a higher rate books an FX gain', async () => {
    const fresh = await makeCompany();
    const [cust] = await db('contacts')
      .insert({ company_id: fresh.company.id, name: 'US Buyer', is_customer: true })
      .returning('*');
    const inv = await db.transaction(async (trx) => {
      const i = await createInvoice(trx, fresh.company.id, null, {
        customerId: cust.id, issueDate: '2026-01-10',
        currency: 'USD', exchangeRate: '120',
        lines: [{ description: 'Export', qty: 1, unitPrice: 1000, accountId: fresh.byCode['4000'].id }],
      });
      await postInvoice(trx, fresh.company.id, i.id, null);
      return i;
    });
    await db.transaction((trx) =>
      receivePayment(trx, fresh.company.id, null, {
        contactId: cust.id, paymentDate: '2026-02-15',
        currency: 'USD', exchangeRate: '125',
        depositAccountId: fresh.byCode['1010'].id,
        allocations: [{ invoiceId: inv.id, amount: 1000 }],
      }),
    );
    // gain = 1000 × (125 − 120) = 5000 BDT (credit balance on 4950)
    expect(await accountBalance(fresh.company.id, fresh.byCode['4950'].id)).toBe('-5000.00');
    // AR fully relieved in base: 1000×120 debited, 1000×120 credited
    expect(await accountBalance(fresh.company.id, fresh.byCode['1100'].id)).toBe('0.00');
    expect(await trialBalanceDiff(fresh.company.id)).toBe('0.00');
  });
});

describe('credit notes', () => {
  it('credit note reverses revenue and applies against an invoice', async () => {
    const inv = await db.transaction(async (trx) => {
      const i = await createInvoice(trx, co.company.id, null, {
        customerId: customer.id, issueDate: '2026-02-12',
        lines: [{ description: 'Services', qty: 1, unitPrice: 5000, accountId: co.byCode['4100'].id, taxCodeId: taxByCode['VAT15'].id }],
      });
      await postInvoice(trx, co.company.id, i.id, null);
      return i;
    });
    const cn = await db.transaction(async (trx) => {
      const c = await createCreditNote(trx, co.company.id, null, {
        customerId: customer.id, issueDate: '2026-02-14',
        lines: [{ description: 'Partial refund', qty: 1, unitPrice: 1000, accountId: co.byCode['4100'].id, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postCreditNote(trx, co.company.id, c.id, null);
    });
    expect(cn.total).toBe('1150.00');
    await db.transaction((trx) =>
      applyCreditNote(trx, co.company.id, null, { creditNoteId: cn.id, invoiceId: inv.id, amount: 1150 }),
    );
    const [updatedInv, updatedCn] = await Promise.all([
      db('invoices').where({ id: inv.id }).first(),
      db('credit_notes').where({ id: cn.id }).first(),
    ]);
    expect(updatedInv.balance_due).toBe('4600.00'); // 5750 − 1150
    expect(updatedCn.status).toBe('applied');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});

describe('vendor credits', () => {
  it('vendor credit for returned goods reduces AP and stock', async () => {
    const bill = await db.transaction(async (trx) => {
      const b = await createBill(trx, co.company.id, null, {
        vendorId: vendor.id, issueDate: '2026-02-16',
        lines: [{ itemId: widget.id, qty: 4, unitPrice: 330, taxCodeId: taxByCode['VAT15'].id }],
      });
      await postBill(trx, co.company.id, b.id, null);
      return b;
    });
    const before = await db('items').where({ id: widget.id }).first();
    const vc = await db.transaction(async (trx) => {
      const v = await createVendorCredit(trx, co.company.id, null, {
        vendorId: vendor.id, issueDate: '2026-02-18',
        lines: [{ itemId: widget.id, qty: 2, unitPrice: 330, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postVendorCredit(trx, co.company.id, v.id, null);
    });
    const after = await db('items').where({ id: widget.id }).first();
    expect(d(before.qty_on_hand).minus(after.qty_on_hand).toFixed(0)).toBe('2');
    await db.transaction((trx) =>
      applyVendorCredit(trx, co.company.id, null, { vendorCreditId: vc.id, billId: bill.id, amount: vc.total }),
    );
    const updatedBill = await db('bills').where({ id: bill.id }).first();
    expect(updatedBill.balance_due).toBe(d(bill.total).minus(vc.total).toFixed(2));
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});

describe('expense claims', () => {
  it('approve books expense + liability, reimburse clears it', async () => {
    const claim = await db.transaction(async (trx) => {
      const c = await createExpenseClaim(trx, co.company.id, null, {
        claimant: 'Sara Ahmed', claimDate: '2026-02-20',
        lines: [
          { expenseDate: '2026-02-18', accountId: co.byCode['6700'].id, description: 'CNG fare', amount: 500 },
          { expenseDate: '2026-02-19', accountId: co.byCode['6300'].id, description: 'Stationery (VAT incl.)', amount: 1150, taxCodeId: taxByCode['VAT15'].id },
        ],
      });
      return approveExpenseClaim(trx, co.company.id, c.id, null);
    });
    expect(claim.total).toBe('1650.00');
    expect(await accountBalance(co.company.id, co.byCode['2210'].id)).toBe('-1650.00');
    await db.transaction((trx) =>
      reimburseExpenseClaim(trx, co.company.id, claim.id, null, {
        paymentDate: '2026-02-25', paymentAccountId: co.byCode['1010'].id,
      }),
    );
    expect(await accountBalance(co.company.id, co.byCode['2210'].id)).toBe('0.00');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});

describe('recurring invoices', () => {
  it('materializes catch-up invoices and advances the schedule', async () => {
    await db('recurring_invoices').insert({
      company_id: co.company.id,
      customer_id: customer.id,
      name: 'Monthly retainer',
      template: JSON.stringify({
        lines: [{ description: 'Retainer', qty: 1, unitPrice: 15000, accountId: co.byCode['4100'].id, taxCodeId: taxByCode['VAT15'].id }],
      }),
      frequency: 'monthly',
      every_n: 1,
      next_run_date: '2026-01-01',
      auto_post: true,
    });
    const created = await db.transaction((trx) =>
      runRecurringInvoices(trx, co.company.id, '2026-03-05', null),
    );
    expect(created.length).toBe(3); // Jan, Feb, Mar
    const posted = await db('invoices')
      .where({ company_id: co.company.id })
      .whereNotNull('recurring_id');
    expect(posted.every((i: any) => i.status === 'open')).toBe(true);
    const rec = await db('recurring_invoices').where({ company_id: co.company.id }).first();
    expect(rec.next_run_date).toBe('2026-04-01');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});

describe('void invoice', () => {
  it('void reverses JEs and restores stock at removed cost', async () => {
    const itemBefore = await db('items').where({ id: widget.id }).first();
    const { invoice } = await db.transaction(async (trx) => {
      const i = await createInvoice(trx, co.company.id, null, {
        customerId: customer.id, issueDate: '2026-03-01',
        lines: [{ itemId: widget.id, qty: 3, unitPrice: 500, taxCodeId: taxByCode['VAT15'].id }],
      });
      return postInvoice(trx, co.company.id, i.id, null);
    });
    await db.transaction((trx) => voidInvoice(trx, co.company.id, invoice.id, null));
    const itemAfter = await db('items').where({ id: widget.id }).first();
    expect(d(itemAfter.qty_on_hand).toFixed(4)).toBe(d(itemBefore.qty_on_hand).toFixed(4));
    const voided = await db('invoices').where({ id: invoice.id }).first();
    expect(voided.status).toBe('voided');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });
});
