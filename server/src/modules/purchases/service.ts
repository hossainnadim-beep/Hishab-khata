import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';
import { nextDocNo, computeDocTotals, type DocLineInput } from '../../lib/docs.ts';
import { postEntry, reverseEntry, type PostLine } from '../ledger/posting.ts';
import { purposeAccount } from '../companies/service.ts';
import { stockIn, stockOut } from '../inventory/service.ts';
import type { AmountsAre } from '../tax/calc.ts';

export interface BillInput {
  vendorId: string;
  issueDate: string;
  dueDate?: string;
  vendorRef?: string | null;
  currency?: string;
  exchangeRate?: string | number;
  amountsAre?: AmountsAre;
  memo?: string | null;
  lines: DocLineInput[];
}

async function fillPurchaseLineDefaults(
  trx: Knex,
  companyId: string,
  lines: DocLineInput[],
): Promise<DocLineInput[]> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))] as string[];
  const items = itemIds.length
    ? await trx('items').whereIn('id', itemIds).andWhere({ company_id: companyId })
    : [];
  const byId = new Map(items.map((i: any) => [i.id, i]));
  return Promise.all(
    lines.map(async (l) => {
      if (!l.itemId) return l;
      const item = byId.get(l.itemId);
      if (!item) throw badRequest('Unknown item on line');
      const out = { ...l };
      out.description ??= item.name;
      out.taxCodeId ??= item.tax_code_id;
      out.unitPrice ??= item.purchase_price;
      out.accountId ??=
        item.type === 'inventory'
          ? item.inventory_account_id ?? (await purposeAccount(trx, companyId, 'inventory'))
          : item.expense_account_id ?? null;
      return out;
    }),
  );
}

export async function createBill(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: BillInput,
) {
  const company = await trx('companies').where({ id: companyId }).first();
  const vendor = await trx('contacts')
    .where({ id: input.vendorId, company_id: companyId, is_vendor: true })
    .first();
  if (!vendor) throw badRequest('Unknown vendor');

  const currency = (input.currency ?? vendor.currency ?? company.base_currency).toUpperCase();
  const amountsAre = input.amountsAre ?? 'exclusive';
  const lines = await fillPurchaseLineDefaults(trx, companyId, input.lines);
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);
  const dueDate =
    input.dueDate ??
    new Date(new Date(input.issueDate).getTime() + vendor.payment_terms_days * 86400000)
      .toISOString()
      .slice(0, 10);

  const [bill] = await trx('bills')
    .insert({
      company_id: companyId,
      vendor_id: input.vendorId,
      doc_no: await nextDocNo(trx, companyId, 'bill'),
      vendor_ref: input.vendorRef ?? null,
      status: 'draft',
      issue_date: input.issueDate,
      due_date: dueDate,
      currency,
      exchange_rate: d(input.exchangeRate ?? 1).toFixed(10),
      amounts_are: amountsAre,
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      balance_due: totals.total,
      memo: input.memo ?? null,
      created_by: userId,
    })
    .returning('*');
  await trx('bill_lines').insert(totals.lines.map((l) => ({ ...l, bill_id: bill.id })));
  return bill;
}

export async function updateDraftBill(
  trx: Knex,
  companyId: string,
  billId: string,
  input: BillInput,
) {
  const bill = await trx('bills').where({ id: billId, company_id: companyId }).first();
  if (!bill) throw badRequest('Bill not found');
  if (bill.status !== 'draft') throw badRequest('Only draft bills can be edited');
  const amountsAre = input.amountsAre ?? bill.amounts_are;
  const lines = await fillPurchaseLineDefaults(trx, companyId, input.lines);
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);
  await trx('bill_lines').where({ bill_id: billId }).delete();
  await trx('bill_lines').insert(totals.lines.map((l) => ({ ...l, bill_id: billId })));
  const [updated] = await trx('bills')
    .where({ id: billId })
    .update({
      vendor_id: input.vendorId ?? bill.vendor_id,
      vendor_ref: input.vendorRef === undefined ? bill.vendor_ref : input.vendorRef,
      issue_date: input.issueDate ?? bill.issue_date,
      due_date: input.dueDate ?? bill.due_date,
      currency: (input.currency ?? bill.currency).toUpperCase(),
      exchange_rate: d(input.exchangeRate ?? bill.exchange_rate).toFixed(10),
      amounts_are: amountsAre,
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      balance_due: totals.total,
      memo: input.memo === undefined ? bill.memo : input.memo,
    })
    .returning('*');
  return updated;
}

/**
 * Posts a bill: DR expense/inventory nets, DR input VAT, CR AP total.
 * Inventory lines also stock in at base-currency unit cost.
 */
export async function postBill(trx: Knex, companyId: string, billId: string, userId: string | null) {
  const bill = await trx('bills')
    .where({ id: billId, company_id: companyId })
    .forUpdate()
    .first();
  if (!bill) throw badRequest('Bill not found');
  if (bill.status !== 'draft') throw badRequest('Bill is already posted');
  if (d(bill.total).lte(0)) throw badRequest('Bill total must be positive');

  const lines = await trx('bill_lines').where({ bill_id: billId }).orderBy('line_no');
  const apAccount = await purposeAccount(trx, companyId, 'ap');
  const rate = d(bill.exchange_rate);

  const jeLines: PostLine[] = [];
  for (const l of lines) {
    if (d(l.net_amount).isZero()) continue;
    if (!l.account_id) throw badRequest(`Line ${l.line_no} has no account`);
    jeLines.push({
      accountId: l.account_id,
      debit: l.net_amount,
      description: l.description,
      taxCodeId: l.tax_code_id,
    });
    if (l.item_id) {
      const item = await trx('items').where({ id: l.item_id }).first();
      if (item?.type === 'inventory' && d(l.qty).gt(0)) {
        await stockIn(trx, {
          companyId,
          itemId: l.item_id,
          date: bill.issue_date,
          qty: l.qty,
          unitCost: d(l.net_amount).times(rate).div(d(l.qty)), // base cost per unit
          sourceType: 'bill',
          sourceId: bill.id,
        });
      }
    }
  }
  const taxGroups = new Map<string, Decimal>();
  for (const l of lines) {
    if (l.tax_code_id && d(l.tax_amount).gt(0)) {
      taxGroups.set(l.tax_code_id, (taxGroups.get(l.tax_code_id) ?? d(0)).plus(l.tax_amount));
    }
  }
  for (const [taxCodeId, amount] of taxGroups) {
    const code = await trx('tax_codes').where({ id: taxCodeId }).first();
    if (!code?.purchase_account_id) {
      throw badRequest(`Tax code ${code?.code} has no purchase account`);
    }
    jeLines.push({
      accountId: code.purchase_account_id,
      debit: money(amount),
      description: `${code.code} on ${bill.doc_no}`,
      taxCodeId,
    });
  }
  jeLines.push({
    accountId: apAccount,
    credit: bill.total,
    contactId: bill.vendor_id,
    description: `Bill ${bill.doc_no}${bill.vendor_ref ? ` (${bill.vendor_ref})` : ''}`,
  });

  const je = await postEntry(trx, {
    companyId,
    txnDate: bill.issue_date,
    currency: bill.currency,
    exchangeRate: bill.exchange_rate,
    memo: `Bill ${bill.doc_no}`,
    sourceType: 'bill',
    sourceId: bill.id,
    userId,
    lines: jeLines,
  });

  const [updated] = await trx('bills')
    .where({ id: billId })
    .update({ status: 'open', journal_entry_id: je.id })
    .returning('*');
  return updated;
}

export async function voidBill(trx: Knex, companyId: string, billId: string, userId: string | null) {
  const bill = await trx('bills')
    .where({ id: billId, company_id: companyId })
    .forUpdate()
    .first();
  if (!bill) throw badRequest('Bill not found');
  if (bill.status === 'draft') {
    await trx('bill_lines').where({ bill_id: billId }).delete();
    await trx('bills').where({ id: billId }).update({ status: 'voided', balance_due: 0 });
    return { voided: true };
  }
  if (bill.status !== 'open') throw badRequest(`Cannot void a ${bill.status} bill`);
  if (d(bill.balance_due).lt(d(bill.total))) {
    throw badRequest('Bill has payments or credits applied — unapply them first');
  }
  const rev = await reverseEntry(trx, {
    companyId,
    entryId: bill.journal_entry_id,
    txnDate: bill.issue_date,
    memo: `Void bill ${bill.doc_no}`,
    userId,
  });
  // Undo any stock-in from this bill at the recorded cost.
  const movements = await trx('item_movements').where({ source_type: 'bill', source_id: bill.id });
  for (const m of movements) {
    const item = await trx('items').where({ id: m.item_id }).forUpdate().first();
    await trx('items')
      .where({ id: m.item_id })
      .update({ qty_on_hand: d(item.qty_on_hand).minus(d(m.qty_delta)).toFixed(4) });
    await trx('item_movements').insert({
      company_id: companyId,
      item_id: m.item_id,
      movement_date: bill.issue_date,
      qty_delta: d(m.qty_delta).negated().toFixed(4),
      unit_cost: m.unit_cost,
      source_type: 'bill_void',
      source_id: bill.id,
    });
  }
  const [updated] = await trx('bills')
    .where({ id: billId })
    .update({ status: 'voided', balance_due: 0, void_journal_entry_id: rev.id })
    .returning('*');
  return { voided: true, bill: updated };
}

// ---------------- Bill payments ----------------

export interface PayBillInput {
  contactId: string;
  paymentDate: string;
  currency?: string;
  exchangeRate?: string | number;
  paymentAccountId: string; // bank/cash account paying from
  reference?: string | null;
  memo?: string | null;
  allocations: Array<{ billId: string; amount: string | number }>;
  /** VDS / AIT deducted at source before paying the vendor. */
  withholdings?: Array<{ taxCodeId: string; baseAmount?: string | number; amount: string | number }>;
}

export async function payBill(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: PayBillInput,
) {
  const company = await trx('companies').where({ id: companyId }).first();
  if (!input.allocations.length) throw badRequest('Payment must allocate to at least one bill');

  const apAccount = await purposeAccount(trx, companyId, 'ap');
  const payRate = d(input.exchangeRate ?? 1);
  const currency = (input.currency ?? company.base_currency).toUpperCase();

  let totalAllocated = d(0);
  const jeLines: PostLine[] = [];
  let fxBase = d(0); // + = AP relieved at more base than cash paid → gain

  for (const alloc of input.allocations) {
    const bill = await trx('bills')
      .where({ id: alloc.billId, company_id: companyId })
      .forUpdate()
      .first();
    if (!bill) throw badRequest('Bill not found');
    if (bill.status !== 'open') throw badRequest(`Bill ${bill.doc_no} is not open`);
    if (bill.currency !== currency) {
      throw badRequest(`Bill ${bill.doc_no} is in ${bill.currency}, payment is ${currency}`);
    }
    const amt = d(alloc.amount);
    if (amt.lte(0)) throw badRequest('Allocation must be positive');
    if (amt.gt(d(bill.balance_due))) throw badRequest(`Allocation exceeds balance on ${bill.doc_no}`);
    totalAllocated = totalAllocated.plus(amt);
    const baseRelieved = amt.times(d(bill.exchange_rate));
    const basePaid = amt.times(payRate);
    fxBase = fxBase.plus(baseRelieved.minus(basePaid));
    jeLines.push({
      accountId: apAccount,
      debit: money(amt),
      baseDebit: money(baseRelieved),
      contactId: bill.vendor_id,
      description: `Payment for ${bill.doc_no}`,
    });
    const newBalance = money(d(bill.balance_due).minus(amt));
    await trx('bills')
      .where({ id: bill.id })
      .update({ status: d(newBalance).isZero() ? 'paid' : 'open', balance_due: newBalance });
  }

  let totalWithheld = d(0);
  const whRows: Array<{ tax_code_id: string; base_amount: string; amount: string }> = [];
  for (const wh of input.withholdings ?? []) {
    const code = await trx('tax_codes').where({ id: wh.taxCodeId, company_id: companyId }).first();
    if (!code?.is_withholding) throw badRequest('Withholding line must use a withholding tax code');
    if (!code.purchase_account_id) throw badRequest(`Tax code ${code.code} has no purchase-side account`);
    const amt = d(wh.amount);
    if (amt.lte(0)) throw badRequest('Withholding amount must be positive');
    totalWithheld = totalWithheld.plus(amt);
    // We owe the withheld tax to the government, not the vendor.
    jeLines.push({
      accountId: code.purchase_account_id,
      credit: money(amt),
      description: `${code.code} withheld at source`,
      taxCodeId: code.id,
    });
    whRows.push({ tax_code_id: code.id, base_amount: money(d(wh.baseAmount ?? 0)), amount: money(amt) });
  }

  const cash = totalAllocated.minus(totalWithheld);
  if (cash.lt(0)) throw badRequest('Withholding exceeds allocated amount');
  if (cash.gt(0)) {
    jeLines.push({
      accountId: input.paymentAccountId,
      credit: money(cash),
      description: input.reference ?? 'Bill payment',
    });
  }
  if (!fxBase.toDecimalPlaces(2).isZero()) {
    const fxAccount = await purposeAccount(trx, companyId, 'fx_gain_loss');
    if (fxBase.gt(0)) {
      jeLines.push({ accountId: fxAccount, credit: 0, baseCredit: money(fxBase), description: 'Realized FX gain' });
    } else {
      jeLines.push({ accountId: fxAccount, debit: 0, baseDebit: money(fxBase.abs()), description: 'Realized FX loss' });
    }
  }

  const je = await postEntry(trx, {
    companyId,
    txnDate: input.paymentDate,
    currency,
    exchangeRate: payRate.toString(),
    memo: input.memo ?? 'Bill payment',
    sourceType: 'bill_payment',
    userId,
    lines: jeLines,
  });

  const [payment] = await trx('payments')
    .insert({
      company_id: companyId,
      kind: 'pay',
      contact_id: input.contactId,
      doc_no: await nextDocNo(trx, companyId, 'payment_pay'),
      payment_date: input.paymentDate,
      currency,
      exchange_rate: payRate.toFixed(10),
      amount: money(cash),
      deposit_account_id: input.paymentAccountId,
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      journal_entry_id: je.id,
      created_by: userId,
    })
    .returning('*');
  await trx('payment_allocations').insert(
    input.allocations.map((a) => ({
      payment_id: payment.id,
      doc_type: 'bill',
      doc_id: a.billId,
      amount: money(d(a.amount)),
    })),
  );
  if (whRows.length) {
    await trx('payment_withholdings').insert(whRows.map((w) => ({ ...w, payment_id: payment.id })));
  }
  return payment;
}

// ---------------- Vendor credits ----------------

export async function createVendorCredit(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: BillInput,
) {
  const company = await trx('companies').where({ id: companyId }).first();
  const vendor = await trx('contacts')
    .where({ id: input.vendorId, company_id: companyId, is_vendor: true })
    .first();
  if (!vendor) throw badRequest('Unknown vendor');
  const currency = (input.currency ?? vendor.currency ?? company.base_currency).toUpperCase();
  const amountsAre = input.amountsAre ?? 'exclusive';
  const lines = await fillPurchaseLineDefaults(trx, companyId, input.lines);
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);

  const [vc] = await trx('vendor_credits')
    .insert({
      company_id: companyId,
      vendor_id: input.vendorId,
      doc_no: await nextDocNo(trx, companyId, 'vendor_credit'),
      status: 'draft',
      issue_date: input.issueDate,
      currency,
      exchange_rate: d(input.exchangeRate ?? 1).toFixed(10),
      amounts_are: amountsAre,
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      balance: totals.total,
      memo: input.memo ?? null,
      created_by: userId,
    })
    .returning('*');
  await trx('vendor_credit_lines').insert(
    totals.lines.map((l) => ({ ...l, vendor_credit_id: vc.id })),
  );
  return vc;
}

/** DR AP total / CR expense-inventory nets / CR input VAT. Returned stock goes out at avg cost. */
export async function postVendorCredit(
  trx: Knex,
  companyId: string,
  vendorCreditId: string,
  userId: string | null,
) {
  const vc = await trx('vendor_credits')
    .where({ id: vendorCreditId, company_id: companyId })
    .forUpdate()
    .first();
  if (!vc) throw badRequest('Vendor credit not found');
  if (vc.status !== 'draft') throw badRequest('Vendor credit is already posted');

  const lines = await trx('vendor_credit_lines')
    .where({ vendor_credit_id: vc.id })
    .orderBy('line_no');
  const apAccount = await purposeAccount(trx, companyId, 'ap');

  const jeLines: PostLine[] = [
    {
      accountId: apAccount,
      debit: vc.total,
      contactId: vc.vendor_id,
      description: `Vendor credit ${vc.doc_no}`,
    },
  ];
  for (const l of lines) {
    if (d(l.net_amount).isZero()) continue;
    if (!l.account_id) throw badRequest(`Line ${l.line_no} has no account`);
    jeLines.push({ accountId: l.account_id, credit: l.net_amount, description: l.description, taxCodeId: l.tax_code_id });
    if (l.item_id) {
      const item = await trx('items').where({ id: l.item_id }).first();
      if (item?.type === 'inventory' && d(l.qty).gt(0)) {
        // Returned goods leave stock at the documented credit price (base),
        // matching the GL credit to this line's inventory account.
        await stockOut(trx, {
          companyId,
          itemId: l.item_id,
          date: vc.issue_date,
          qty: l.qty,
          sourceType: 'vendor_credit',
          sourceId: vc.id,
          unitCostOverride: d(l.net_amount).times(d(vc.exchange_rate)).div(d(l.qty)),
        });
      }
    }
  }
  const taxGroups = new Map<string, Decimal>();
  for (const l of lines) {
    if (l.tax_code_id && d(l.tax_amount).gt(0)) {
      taxGroups.set(l.tax_code_id, (taxGroups.get(l.tax_code_id) ?? d(0)).plus(l.tax_amount));
    }
  }
  for (const [taxCodeId, amount] of taxGroups) {
    const code = await trx('tax_codes').where({ id: taxCodeId }).first();
    if (!code?.purchase_account_id) throw badRequest(`Tax code ${code?.code} has no purchase account`);
    jeLines.push({ accountId: code.purchase_account_id, credit: money(amount), taxCodeId, description: `${code.code} on ${vc.doc_no}` });
  }

  const je = await postEntry(trx, {
    companyId,
    txnDate: vc.issue_date,
    currency: vc.currency,
    exchangeRate: vc.exchange_rate,
    memo: `Vendor credit ${vc.doc_no}`,
    sourceType: 'vendor_credit',
    sourceId: vc.id,
    userId,
    lines: jeLines,
  });
  const [updated] = await trx('vendor_credits')
    .where({ id: vc.id })
    .update({ status: 'open', journal_entry_id: je.id })
    .returning('*');
  return updated;
}

export async function applyVendorCredit(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: { vendorCreditId: string; billId: string; amount: string | number },
) {
  const vc = await trx('vendor_credits')
    .where({ id: input.vendorCreditId, company_id: companyId })
    .forUpdate()
    .first();
  const bill = await trx('bills')
    .where({ id: input.billId, company_id: companyId })
    .forUpdate()
    .first();
  if (!vc || vc.status !== 'open') throw badRequest('Vendor credit is not open');
  if (!bill || bill.status !== 'open') throw badRequest('Bill is not open');
  if (vc.vendor_id !== bill.vendor_id) throw badRequest('Different vendors');
  if (vc.currency !== bill.currency) throw badRequest('Different currencies');
  const amt = d(input.amount);
  if (amt.lte(0)) throw badRequest('Amount must be positive');
  if (amt.gt(d(vc.balance)) || amt.gt(d(bill.balance_due))) {
    throw badRequest('Amount exceeds vendor credit balance or bill balance');
  }
  await trx('vendor_credit_applications').insert({
    vendor_credit_id: vc.id,
    bill_id: bill.id,
    amount: money(amt),
  });
  const newVcBalance = money(d(vc.balance).minus(amt));
  const newBillBalance = money(d(bill.balance_due).minus(amt));
  await trx('vendor_credits')
    .where({ id: vc.id })
    .update({ balance: newVcBalance, status: d(newVcBalance).isZero() ? 'applied' : 'open' });
  await trx('bills')
    .where({ id: bill.id })
    .update({ balance_due: newBillBalance, status: d(newBillBalance).isZero() ? 'paid' : 'open' });

  const vcRate = d(vc.exchange_rate);
  const billRate = d(bill.exchange_rate);
  if (!vcRate.equals(billRate)) {
    const apAccount = await purposeAccount(trx, companyId, 'ap');
    const fxAccount = await purposeAccount(trx, companyId, 'fx_gain_loss');
    const diff = amt.times(billRate).minus(amt.times(vcRate)); // AP relieved minus credit consumed
    const lines: PostLine[] = [
      {
        accountId: apAccount,
        debit: money(amt),
        baseDebit: money(amt.times(billRate)),
        contactId: bill.vendor_id,
        description: `Apply to ${bill.doc_no}`,
      },
      {
        accountId: apAccount,
        credit: money(amt),
        baseCredit: money(amt.times(vcRate)),
        contactId: bill.vendor_id,
        description: `Apply ${vc.doc_no} (credit consumed)`,
      },
    ];
    if (diff.gt(0)) {
      lines.push({ accountId: fxAccount, credit: 0, baseCredit: money(diff), description: 'Realized FX on credit application' });
    } else {
      lines.push({ accountId: fxAccount, debit: 0, baseDebit: money(diff.abs()), description: 'Realized FX on credit application' });
    }
    await postEntry(trx, {
      companyId,
      txnDate: new Date().toISOString().slice(0, 10),
      currency: vc.currency,
      exchangeRate: vcRate.toString(),
      memo: `Apply vendor credit ${vc.doc_no} to ${bill.doc_no}`,
      sourceType: 'credit_application',
      sourceId: vc.id,
      userId,
      lines,
    });
  }
  return { applied: money(amt) };
}

// ---------------- Expense claims ----------------

export interface ExpenseClaimInput {
  claimant: string;
  claimDate: string;
  currency?: string;
  exchangeRate?: string | number;
  memo?: string | null;
  lines: Array<{
    expenseDate: string;
    accountId: string;
    description?: string | null;
    amount: string | number; // gross
    taxCodeId?: string | null;
  }>;
}

export async function createExpenseClaim(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: ExpenseClaimInput,
) {
  const company = await trx('companies').where({ id: companyId }).first();
  if (!input.lines.length) throw badRequest('Claim needs at least one line');
  const currency = (input.currency ?? company.base_currency).toUpperCase();

  const taxCodeIds = [...new Set(input.lines.map((l) => l.taxCodeId).filter(Boolean))] as string[];
  const codes = taxCodeIds.length
    ? await trx('tax_codes').whereIn('id', taxCodeIds).andWhere({ company_id: companyId })
    : [];
  const byId = new Map(codes.map((c: any) => [c.id, c]));

  let total = d(0);
  const rows = input.lines.map((l, i) => {
    const gross = d(l.amount);
    if (gross.lte(0)) throw badRequest('Line amount must be positive');
    const code = l.taxCodeId ? byId.get(l.taxCodeId) : null;
    // Receipts are tax-inclusive by nature.
    let tax = d(0);
    if (code && !code.is_withholding && d(code.rate).gt(0)) {
      tax = gross.times(d(code.rate)).div(d(code.rate).plus(100));
    }
    total = total.plus(gross);
    return {
      line_no: i + 1,
      expense_date: l.expenseDate,
      account_id: l.accountId,
      description: l.description ?? null,
      amount: money(gross),
      tax_code_id: l.taxCodeId ?? null,
      net_amount: money(gross.minus(tax)),
      tax_amount: money(tax),
    };
  });

  const [claim] = await trx('expense_claims')
    .insert({
      company_id: companyId,
      claimant: input.claimant,
      doc_no: await nextDocNo(trx, companyId, 'expense_claim'),
      status: 'draft',
      claim_date: input.claimDate,
      currency,
      exchange_rate: d(input.exchangeRate ?? 1).toFixed(10),
      total: money(total),
      memo: input.memo ?? null,
      created_by: userId,
    })
    .returning('*');
  await trx('expense_claim_lines').insert(rows.map((r) => ({ ...r, claim_id: claim.id })));
  return claim;
}

/** Approving posts: DR expenses (net) + DR input VAT, CR Employee Reimbursements Payable. */
export async function approveExpenseClaim(
  trx: Knex,
  companyId: string,
  claimId: string,
  userId: string | null,
) {
  const claim = await trx('expense_claims')
    .where({ id: claimId, company_id: companyId })
    .forUpdate()
    .first();
  if (!claim) throw badRequest('Claim not found');
  if (claim.status !== 'draft') throw badRequest('Only draft claims can be approved');

  const lines = await trx('expense_claim_lines').where({ claim_id: claimId }).orderBy('line_no');
  const reimbAccount = await purposeAccount(trx, companyId, 'employee_reimb');

  const jeLines: PostLine[] = [];
  for (const l of lines) {
    jeLines.push({
      accountId: l.account_id,
      debit: l.net_amount,
      description: l.description ?? `Expense claim ${claim.doc_no}`,
      taxCodeId: l.tax_code_id,
    });
    if (d(l.tax_amount).gt(0)) {
      const code = await trx('tax_codes').where({ id: l.tax_code_id }).first();
      if (code?.purchase_account_id) {
        jeLines.push({
          accountId: code.purchase_account_id,
          debit: l.tax_amount,
          description: `${code.code} on ${claim.doc_no}`,
          taxCodeId: code.id,
        });
      } else {
        // Non-rebatable: keep the tax in the expense line's account.
        jeLines.push({ accountId: l.account_id, debit: l.tax_amount, description: l.description });
      }
    }
  }
  jeLines.push({
    accountId: reimbAccount,
    credit: claim.total,
    description: `Owed to ${claim.claimant} (${claim.doc_no})`,
  });

  const je = await postEntry(trx, {
    companyId,
    txnDate: claim.claim_date,
    currency: claim.currency,
    exchangeRate: claim.exchange_rate,
    memo: `Expense claim ${claim.doc_no} — ${claim.claimant}`,
    sourceType: 'expense_claim',
    sourceId: claim.id,
    userId,
    lines: jeLines,
  });
  const [updated] = await trx('expense_claims')
    .where({ id: claimId })
    .update({ status: 'approved', journal_entry_id: je.id })
    .returning('*');
  return updated;
}

/** Reimbursing pays the employee: DR Reimbursements Payable, CR bank. */
export async function reimburseExpenseClaim(
  trx: Knex,
  companyId: string,
  claimId: string,
  userId: string | null,
  input: { paymentDate: string; paymentAccountId: string },
) {
  const claim = await trx('expense_claims')
    .where({ id: claimId, company_id: companyId })
    .forUpdate()
    .first();
  if (!claim) throw badRequest('Claim not found');
  if (claim.status !== 'approved') throw badRequest('Only approved claims can be reimbursed');

  const reimbAccount = await purposeAccount(trx, companyId, 'employee_reimb');
  const je = await postEntry(trx, {
    companyId,
    txnDate: input.paymentDate,
    currency: claim.currency,
    exchangeRate: claim.exchange_rate, // claim rate → nets the liability exactly
    memo: `Reimburse ${claim.claimant} (${claim.doc_no})`,
    sourceType: 'expense_reimbursement',
    sourceId: claim.id,
    userId,
    lines: [
      { accountId: reimbAccount, debit: claim.total, description: `Reimburse ${claim.doc_no}` },
      { accountId: input.paymentAccountId, credit: claim.total, description: `Reimburse ${claim.doc_no}` },
    ],
  });
  const [updated] = await trx('expense_claims')
    .where({ id: claimId })
    .update({ status: 'reimbursed', reimburse_journal_entry_id: je.id })
    .returning('*');
  return updated;
}
