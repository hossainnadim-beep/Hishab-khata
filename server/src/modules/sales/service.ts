import type { Knex } from 'knex';
import { d, money, Decimal } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';
import { nextDocNo, computeDocTotals, type DocLineInput } from '../../lib/docs.ts';
import { postEntry, reverseEntry, type PostLine } from '../ledger/posting.ts';
import { purposeAccount } from '../companies/service.ts';
import { stockIn, stockOut } from '../inventory/service.ts';
import type { AmountsAre } from '../tax/calc.ts';

export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate?: string;
  currency?: string;
  exchangeRate?: string | number;
  amountsAre?: AmountsAre;
  memo?: string | null;
  lines: DocLineInput[];
}

async function resolveCompany(trx: Knex, companyId: string) {
  const company = await trx('companies').where({ id: companyId }).first();
  if (!company) throw badRequest('Unknown company');
  return company;
}

/** Fills line account/tax defaults from the item, and description from item name. */
async function applyItemDefaults(
  trx: Knex,
  companyId: string,
  lines: DocLineInput[],
  side: 'sales' | 'purchases',
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
      if (side === 'sales') {
        out.unitPrice ??= item.sale_price;
        out.accountId ??=
          item.income_account_id ?? (await purposeAccount(trx, companyId, 'sales'));
      } else {
        out.unitPrice ??= item.purchase_price;
        out.accountId ??=
          item.type === 'inventory'
            ? item.inventory_account_id ?? (await purposeAccount(trx, companyId, 'inventory'))
            : item.expense_account_id ?? null;
      }
      return out;
    }),
  );
}

// ---------------- Invoices ----------------

export async function createInvoice(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: InvoiceInput,
) {
  const company = await resolveCompany(trx, companyId);
  const customer = await trx('contacts')
    .where({ id: input.customerId, company_id: companyId, is_customer: true })
    .first();
  if (!customer) throw badRequest('Unknown customer');

  const currency = (input.currency ?? customer.currency ?? company.base_currency).toUpperCase();
  const amountsAre = input.amountsAre ?? 'exclusive';
  const lines = await applyItemDefaults(trx, companyId, input.lines, 'sales');
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);
  const dueDate =
    input.dueDate ??
    new Date(new Date(input.issueDate).getTime() + customer.payment_terms_days * 86400000)
      .toISOString()
      .slice(0, 10);

  const [invoice] = await trx('invoices')
    .insert({
      company_id: companyId,
      customer_id: input.customerId,
      doc_no: await nextDocNo(trx, companyId, 'invoice'),
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
  await trx('invoice_lines').insert(totals.lines.map((l) => ({ ...l, invoice_id: invoice.id })));
  return invoice;
}

export async function updateDraftInvoice(
  trx: Knex,
  companyId: string,
  invoiceId: string,
  input: InvoiceInput,
) {
  const invoice = await trx('invoices').where({ id: invoiceId, company_id: companyId }).first();
  if (!invoice) throw badRequest('Invoice not found');
  if (invoice.status !== 'draft') throw badRequest('Only draft invoices can be edited');

  const amountsAre = input.amountsAre ?? invoice.amounts_are;
  const lines = await applyItemDefaults(trx, companyId, input.lines, 'sales');
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);
  await trx('invoice_lines').where({ invoice_id: invoiceId }).delete();
  await trx('invoice_lines').insert(totals.lines.map((l) => ({ ...l, invoice_id: invoiceId })));
  const [updated] = await trx('invoices')
    .where({ id: invoiceId })
    .update({
      customer_id: input.customerId ?? invoice.customer_id,
      issue_date: input.issueDate ?? invoice.issue_date,
      due_date: input.dueDate ?? invoice.due_date,
      currency: (input.currency ?? invoice.currency).toUpperCase(),
      exchange_rate: d(input.exchangeRate ?? invoice.exchange_rate).toFixed(10),
      amounts_are: amountsAre,
      subtotal: totals.subtotal,
      tax_total: totals.taxTotal,
      total: totals.total,
      balance_due: totals.total,
      memo: input.memo === undefined ? invoice.memo : input.memo,
    })
    .returning('*');
  return updated;
}

/**
 * Posts an invoice:
 *   JE 1 (doc currency): DR AR total / CR income nets / CR output-tax per code.
 *   JE 2 (base currency, inventory only): DR COGS / CR Inventory at weighted-avg cost.
 */
export async function postInvoice(
  trx: Knex,
  companyId: string,
  invoiceId: string,
  userId: string | null,
) {
  const invoice = await trx('invoices')
    .where({ id: invoiceId, company_id: companyId })
    .forUpdate()
    .first();
  if (!invoice) throw badRequest('Invoice not found');
  if (invoice.status !== 'draft') throw badRequest('Invoice is already posted');
  if (d(invoice.total).lte(0)) throw badRequest('Invoice total must be positive');

  const lines = await trx('invoice_lines').where({ invoice_id: invoiceId }).orderBy('line_no');
  const arAccount = await purposeAccount(trx, companyId, 'ar');

  const jeLines: PostLine[] = [
    {
      accountId: arAccount,
      debit: invoice.total,
      contactId: invoice.customer_id,
      description: `Invoice ${invoice.doc_no}`,
    },
  ];
  for (const l of lines) {
    if (d(l.net_amount).isZero()) continue;
    if (!l.account_id) throw badRequest(`Line ${l.line_no} has no income account`);
    jeLines.push({
      accountId: l.account_id,
      credit: l.net_amount,
      description: l.description,
      taxCodeId: l.tax_code_id,
    });
  }
  // Output tax grouped by code
  const taxGroups = new Map<string, Decimal>();
  for (const l of lines) {
    if (l.tax_code_id && d(l.tax_amount).gt(0)) {
      taxGroups.set(l.tax_code_id, (taxGroups.get(l.tax_code_id) ?? d(0)).plus(l.tax_amount));
    }
  }
  for (const [taxCodeId, amount] of taxGroups) {
    const code = await trx('tax_codes').where({ id: taxCodeId }).first();
    if (!code?.sales_account_id) throw badRequest(`Tax code ${code?.code} has no sales account`);
    jeLines.push({
      accountId: code.sales_account_id,
      credit: money(amount),
      description: `${code.code} on ${invoice.doc_no}`,
      taxCodeId,
    });
  }

  const je = await postEntry(trx, {
    companyId,
    txnDate: invoice.issue_date,
    currency: invoice.currency,
    exchangeRate: invoice.exchange_rate,
    memo: `Invoice ${invoice.doc_no}`,
    sourceType: 'invoice',
    sourceId: invoice.id,
    userId,
    lines: jeLines,
  });

  // COGS for inventory items — separate base-currency entry.
  const cogsLines: PostLine[] = [];
  for (const l of lines) {
    if (!l.item_id) continue;
    const item = await trx('items').where({ id: l.item_id }).first();
    if (item?.type !== 'inventory') continue;
    const { cogs } = await stockOut(trx, {
      companyId,
      itemId: l.item_id,
      date: invoice.issue_date,
      qty: l.qty,
      sourceType: 'invoice',
      sourceId: invoice.id,
    });
    if (d(cogs).isZero()) continue;
    const cogsAccount =
      item.expense_account_id ?? (await purposeAccount(trx, companyId, 'cogs'));
    const invAccount =
      item.inventory_account_id ?? (await purposeAccount(trx, companyId, 'inventory'));
    cogsLines.push({ accountId: cogsAccount, debit: cogs, description: `COGS ${item.name}` });
    cogsLines.push({ accountId: invAccount, credit: cogs, description: `COGS ${item.name}` });
  }
  let cogsJeId: string | null = null;
  if (cogsLines.length) {
    const cogsJe = await postEntry(trx, {
      companyId,
      txnDate: invoice.issue_date,
      memo: `COGS for invoice ${invoice.doc_no}`,
      sourceType: 'invoice_cogs',
      sourceId: invoice.id,
      userId,
      lines: cogsLines,
    });
    cogsJeId = cogsJe.id;
  }

  const [updated] = await trx('invoices')
    .where({ id: invoiceId })
    .update({ status: 'open', journal_entry_id: je.id })
    .returning('*');
  return { invoice: updated, journalEntryId: je.id, cogsJournalEntryId: cogsJeId };
}

export async function voidInvoice(
  trx: Knex,
  companyId: string,
  invoiceId: string,
  userId: string | null,
) {
  const invoice = await trx('invoices')
    .where({ id: invoiceId, company_id: companyId })
    .forUpdate()
    .first();
  if (!invoice) throw badRequest('Invoice not found');
  if (invoice.status === 'draft') {
    await trx('invoice_lines').where({ invoice_id: invoiceId }).delete();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'voided', balance_due: 0 });
    return { voided: true };
  }
  if (invoice.status !== 'open') throw badRequest(`Cannot void a ${invoice.status} invoice`);
  if (d(invoice.balance_due).lt(d(invoice.total))) {
    throw badRequest('Invoice has payments or credits applied — unapply them first');
  }

  const today = invoice.issue_date;
  const rev = await reverseEntry(trx, {
    companyId,
    entryId: invoice.journal_entry_id,
    txnDate: today,
    memo: `Void invoice ${invoice.doc_no}`,
    userId,
  });
  // Reverse COGS entry and restore stock at the exact cost removed.
  const cogsJe = await trx('journal_entries')
    .where({ source_type: 'invoice_cogs', source_id: invoice.id, company_id: companyId })
    .whereNull('reverses_entry_id')
    .first();
  if (cogsJe) {
    await reverseEntry(trx, {
      companyId,
      entryId: cogsJe.id,
      txnDate: today,
      memo: `Void invoice ${invoice.doc_no} (COGS)`,
      userId,
    });
  }
  const movements = await trx('item_movements').where({
    source_type: 'invoice',
    source_id: invoice.id,
  });
  for (const m of movements) {
    await stockIn(trx, {
      companyId,
      itemId: m.item_id,
      date: today,
      qty: d(m.qty_delta).abs(),
      unitCost: m.unit_cost,
      sourceType: 'invoice_void',
      sourceId: invoice.id,
    });
  }
  const [updated] = await trx('invoices')
    .where({ id: invoiceId })
    .update({ status: 'voided', balance_due: 0, void_journal_entry_id: rev.id })
    .returning('*');
  return { voided: true, invoice: updated };
}

// ---------------- Payments (receive) ----------------

export interface ReceivePaymentInput {
  contactId: string;
  paymentDate: string;
  currency?: string;
  exchangeRate?: string | number;
  depositAccountId: string;
  reference?: string | null;
  memo?: string | null;
  allocations: Array<{ invoiceId: string; amount: string | number }>;
  /** Withholding certificates received (customer withheld VAT/AIT at source). */
  withholdings?: Array<{ taxCodeId: string; baseAmount?: string | number; amount: string | number }>;
}

export async function receivePayment(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: ReceivePaymentInput,
) {
  const company = await resolveCompany(trx, companyId);
  if (!input.allocations.length) throw badRequest('Payment must allocate to at least one invoice');

  const arAccount = await purposeAccount(trx, companyId, 'ar');
  const payRate = d(input.exchangeRate ?? 1);
  const currency = (input.currency ?? company.base_currency).toUpperCase();

  let totalAllocated = d(0);
  const jeLines: PostLine[] = [];
  let fxBase = d(0); // + = gain (payment base exceeds AR relieved)

  for (const alloc of input.allocations) {
    const invoice = await trx('invoices')
      .where({ id: alloc.invoiceId, company_id: companyId })
      .forUpdate()
      .first();
    if (!invoice) throw badRequest('Invoice not found');
    if (invoice.status !== 'open') throw badRequest(`Invoice ${invoice.doc_no} is not open`);
    if (invoice.currency !== currency) {
      throw badRequest(`Invoice ${invoice.doc_no} is in ${invoice.currency}, payment is ${currency}`);
    }
    const amt = d(alloc.amount);
    if (amt.lte(0)) throw badRequest('Allocation must be positive');
    if (amt.gt(d(invoice.balance_due))) {
      throw badRequest(`Allocation exceeds balance due on ${invoice.doc_no}`);
    }
    totalAllocated = totalAllocated.plus(amt);
    const baseRelieved = amt.times(d(invoice.exchange_rate));
    const basePaid = amt.times(payRate);
    fxBase = fxBase.plus(basePaid.minus(baseRelieved));
    jeLines.push({
      accountId: arAccount,
      credit: money(amt),
      baseCredit: money(baseRelieved),
      contactId: invoice.customer_id,
      description: `Payment for ${invoice.doc_no}`,
    });

    const newBalance = money(d(invoice.balance_due).minus(amt));
    await trx('invoices')
      .where({ id: invoice.id })
      .update({ status: d(newBalance).isZero() ? 'paid' : 'open', balance_due: newBalance });
  }

  let totalWithheld = d(0);
  const whRows: Array<{ tax_code_id: string; base_amount: string; amount: string }> = [];
  for (const wh of input.withholdings ?? []) {
    const code = await trx('tax_codes').where({ id: wh.taxCodeId, company_id: companyId }).first();
    if (!code?.is_withholding) throw badRequest('Withholding line must use a withholding tax code');
    if (!code.sales_account_id) throw badRequest(`Tax code ${code.code} has no sales-side account`);
    const amt = d(wh.amount);
    if (amt.lte(0)) throw badRequest('Withholding amount must be positive');
    totalWithheld = totalWithheld.plus(amt);
    // Customer withheld tax we can claim/offset later — an asset.
    jeLines.push({
      accountId: code.sales_account_id,
      debit: money(amt),
      description: `${code.code} withheld by customer`,
      taxCodeId: code.id,
    });
    whRows.push({
      tax_code_id: code.id,
      base_amount: money(d(wh.baseAmount ?? 0)),
      amount: money(amt),
    });
  }

  const cash = totalAllocated.minus(totalWithheld);
  if (cash.lt(0)) throw badRequest('Withholding exceeds allocated amount');
  if (cash.gt(0)) {
    jeLines.unshift({
      accountId: input.depositAccountId,
      debit: money(cash),
      description: input.reference ?? 'Customer payment',
    });
  }
  // Realized FX gain/loss (base-currency-only line).
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
    memo: input.memo ?? 'Customer payment',
    sourceType: 'payment',
    userId,
    lines: jeLines,
  });

  const [payment] = await trx('payments')
    .insert({
      company_id: companyId,
      kind: 'receive',
      contact_id: input.contactId,
      doc_no: await nextDocNo(trx, companyId, 'payment_receive'),
      payment_date: input.paymentDate,
      currency,
      exchange_rate: payRate.toFixed(10),
      amount: money(cash),
      deposit_account_id: input.depositAccountId,
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      journal_entry_id: je.id,
      created_by: userId,
    })
    .returning('*');
  await trx('payment_allocations').insert(
    input.allocations.map((a) => ({
      payment_id: payment.id,
      doc_type: 'invoice',
      doc_id: a.invoiceId,
      amount: money(d(a.amount)),
    })),
  );
  if (whRows.length) {
    await trx('payment_withholdings').insert(
      whRows.map((w) => ({ ...w, payment_id: payment.id })),
    );
  }
  return payment;
}

// ---------------- Credit notes ----------------

export async function createCreditNote(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: InvoiceInput,
) {
  const company = await resolveCompany(trx, companyId);
  const customer = await trx('contacts')
    .where({ id: input.customerId, company_id: companyId, is_customer: true })
    .first();
  if (!customer) throw badRequest('Unknown customer');
  const currency = (input.currency ?? customer.currency ?? company.base_currency).toUpperCase();
  const amountsAre = input.amountsAre ?? 'exclusive';
  const lines = await applyItemDefaults(trx, companyId, input.lines, 'sales');
  const totals = await computeDocTotals(trx, companyId, lines, amountsAre);

  const [cn] = await trx('credit_notes')
    .insert({
      company_id: companyId,
      customer_id: input.customerId,
      doc_no: await nextDocNo(trx, companyId, 'credit_note'),
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
  await trx('credit_note_lines').insert(
    totals.lines.map((l) => ({ ...l, credit_note_id: cn.id })),
  );
  return cn;
}

/** Mirror image of invoice posting; restocks returned inventory at current avg cost. */
export async function postCreditNote(
  trx: Knex,
  companyId: string,
  creditNoteId: string,
  userId: string | null,
) {
  const cn = await trx('credit_notes')
    .where({ id: creditNoteId, company_id: companyId })
    .forUpdate()
    .first();
  if (!cn) throw badRequest('Credit note not found');
  if (cn.status !== 'draft') throw badRequest('Credit note is already posted');

  const lines = await trx('credit_note_lines').where({ credit_note_id: cn.id }).orderBy('line_no');
  const arAccount = await purposeAccount(trx, companyId, 'ar');

  const jeLines: PostLine[] = [];
  for (const l of lines) {
    if (d(l.net_amount).isZero()) continue;
    if (!l.account_id) throw badRequest(`Line ${l.line_no} has no income account`);
    jeLines.push({ accountId: l.account_id, debit: l.net_amount, description: l.description, taxCodeId: l.tax_code_id });
  }
  const taxGroups = new Map<string, Decimal>();
  for (const l of lines) {
    if (l.tax_code_id && d(l.tax_amount).gt(0)) {
      taxGroups.set(l.tax_code_id, (taxGroups.get(l.tax_code_id) ?? d(0)).plus(l.tax_amount));
    }
  }
  for (const [taxCodeId, amount] of taxGroups) {
    const code = await trx('tax_codes').where({ id: taxCodeId }).first();
    if (!code?.sales_account_id) throw badRequest(`Tax code ${code?.code} has no sales account`);
    jeLines.push({ accountId: code.sales_account_id, debit: money(amount), taxCodeId, description: `${code.code} on ${cn.doc_no}` });
  }
  jeLines.push({
    accountId: arAccount,
    credit: cn.total,
    contactId: cn.customer_id,
    description: `Credit note ${cn.doc_no}`,
  });

  const je = await postEntry(trx, {
    companyId,
    txnDate: cn.issue_date,
    currency: cn.currency,
    exchangeRate: cn.exchange_rate,
    memo: `Credit note ${cn.doc_no}`,
    sourceType: 'credit_note',
    sourceId: cn.id,
    userId,
    lines: jeLines,
  });

  // Returned inventory back into stock at current average cost.
  const restockLines: PostLine[] = [];
  for (const l of lines) {
    if (!l.item_id) continue;
    const item = await trx('items').where({ id: l.item_id }).first();
    if (item?.type !== 'inventory') continue;
    const unitCost = d(item.avg_cost);
    await stockIn(trx, {
      companyId,
      itemId: l.item_id,
      date: cn.issue_date,
      qty: l.qty,
      unitCost,
      sourceType: 'credit_note',
      sourceId: cn.id,
    });
    const value = money(unitCost.times(d(l.qty)));
    if (d(value).isZero()) continue;
    const cogsAccount = item.expense_account_id ?? (await purposeAccount(trx, companyId, 'cogs'));
    const invAccount = item.inventory_account_id ?? (await purposeAccount(trx, companyId, 'inventory'));
    restockLines.push({ accountId: invAccount, debit: value, description: `Restock ${item.name}` });
    restockLines.push({ accountId: cogsAccount, credit: value, description: `Restock ${item.name}` });
  }
  if (restockLines.length) {
    await postEntry(trx, {
      companyId,
      txnDate: cn.issue_date,
      memo: `Restock for credit note ${cn.doc_no}`,
      sourceType: 'credit_note_cogs',
      sourceId: cn.id,
      userId,
      lines: restockLines,
    });
  }

  const [updated] = await trx('credit_notes')
    .where({ id: cn.id })
    .update({ status: 'open', journal_entry_id: je.id })
    .returning('*');
  return updated;
}

/** Applies an open credit note against an open invoice (same customer & currency). */
export async function applyCreditNote(
  trx: Knex,
  companyId: string,
  userId: string | null,
  input: { creditNoteId: string; invoiceId: string; amount: string | number },
) {
  const cn = await trx('credit_notes')
    .where({ id: input.creditNoteId, company_id: companyId })
    .forUpdate()
    .first();
  const invoice = await trx('invoices')
    .where({ id: input.invoiceId, company_id: companyId })
    .forUpdate()
    .first();
  if (!cn || cn.status !== 'open') throw badRequest('Credit note is not open');
  if (!invoice || invoice.status !== 'open') throw badRequest('Invoice is not open');
  if (cn.customer_id !== invoice.customer_id) throw badRequest('Different customers');
  if (cn.currency !== invoice.currency) throw badRequest('Different currencies');

  const amt = d(input.amount);
  if (amt.lte(0)) throw badRequest('Amount must be positive');
  if (amt.gt(d(cn.balance)) || amt.gt(d(invoice.balance_due))) {
    throw badRequest('Amount exceeds credit note balance or invoice balance');
  }

  await trx('credit_note_applications').insert({
    credit_note_id: cn.id,
    invoice_id: invoice.id,
    amount: money(amt),
  });
  const newCnBalance = money(d(cn.balance).minus(amt));
  const newInvBalance = money(d(invoice.balance_due).minus(amt));
  await trx('credit_notes')
    .where({ id: cn.id })
    .update({ balance: newCnBalance, status: d(newCnBalance).isZero() ? 'applied' : 'open' });
  await trx('invoices')
    .where({ id: invoice.id })
    .update({ balance_due: newInvBalance, status: d(newInvBalance).isZero() ? 'paid' : 'open' });

  // If the two documents carried different FX rates, the base-currency AR
  // relieved differs — realize the difference.
  const cnRate = d(cn.exchange_rate);
  const invRate = d(invoice.exchange_rate);
  if (!cnRate.equals(invRate)) {
    const arAccount = await purposeAccount(trx, companyId, 'ar');
    const fxAccount = await purposeAccount(trx, companyId, 'fx_gain_loss');
    const diff = amt.times(cnRate).minus(amt.times(invRate)); // + → less AR relieved than credit consumed → gain? see below
    const lines: PostLine[] = [
      {
        accountId: arAccount,
        debit: money(amt),
        baseDebit: money(amt.times(cnRate)),
        contactId: cn.customer_id,
        description: `Apply ${cn.doc_no} (credit consumed)`,
      },
      {
        accountId: arAccount,
        credit: money(amt),
        baseCredit: money(amt.times(invRate)),
        contactId: cn.customer_id,
        description: `Apply to ${invoice.doc_no}`,
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
      currency: cn.currency,
      exchangeRate: cnRate.toString(),
      memo: `Apply credit note ${cn.doc_no} to ${invoice.doc_no}`,
      sourceType: 'credit_application',
      sourceId: cn.id,
      userId,
      lines,
    });
  }
  return { applied: money(amt) };
}

// ---------------- Recurring invoices ----------------

function advance(dateStr: string, frequency: 'weekly' | 'monthly', everyN: number): string {
  const dt = new Date(dateStr + 'T00:00:00Z');
  if (frequency === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7 * everyN);
  else dt.setUTCMonth(dt.getUTCMonth() + everyN);
  return dt.toISOString().slice(0, 10);
}

/** Materializes all due recurring invoices up to `today`. Returns created invoices. */
export async function runRecurringInvoices(
  trx: Knex,
  companyId: string,
  today: string,
  userId: string | null,
) {
  const due = await trx('recurring_invoices')
    .where({ company_id: companyId, active: true })
    .andWhere('next_run_date', '<=', today)
    .forUpdate();
  const created: any[] = [];
  for (const r of due) {
    let runDate = r.next_run_date;
    let guard = 0;
    while (runDate <= today && guard++ < 100) {
      if (r.end_date && runDate > r.end_date) break;
      const tpl = r.template;
      const invoice = await createInvoice(trx, companyId, userId, {
        customerId: r.customer_id,
        issueDate: runDate,
        currency: tpl.currency,
        exchangeRate: tpl.exchangeRate,
        amountsAre: tpl.amountsAre,
        memo: tpl.memo ?? `Recurring: ${r.name}`,
        lines: tpl.lines,
      });
      await trx('invoices').where({ id: invoice.id }).update({ recurring_id: r.id });
      if (r.auto_post) await postInvoice(trx, companyId, invoice.id, userId);
      created.push(invoice);
      runDate = advance(runDate, r.frequency, r.every_n);
    }
    const stillActive = !(r.end_date && runDate > r.end_date);
    await trx('recurring_invoices')
      .where({ id: r.id })
      .update({ next_run_date: runDate, last_run_date: today, active: stillActive });
  }
  return created;
}
