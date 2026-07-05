import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { nextDocNo, computeDocTotals } from '../../lib/docs.ts';
import { d } from '../../lib/money.ts';
import {
  createInvoice,
  updateDraftInvoice,
  postInvoice,
  voidInvoice,
  receivePayment,
  createCreditNote,
  postCreditNote,
  applyCreditNote,
  runRecurringInvoices,
} from './service.ts';

export const salesRouter = Router({ mergeParams: true });

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const docLineSchema = z.object({
  itemId: z.string().uuid().nullable().optional(),
  description: z.string().nullable().optional(),
  qty: z.union([z.string(), z.number()]).optional(),
  unitPrice: z.union([z.string(), z.number()]).optional(),
  discountPct: z.union([z.string(), z.number()]).optional(),
  accountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
});

const invoiceSchema = z.object({
  customerId: z.string().uuid(),
  issueDate: dateStr,
  dueDate: dateStr.optional(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  amountsAre: z.enum(['exclusive', 'inclusive', 'no_tax']).optional(),
  memo: z.string().nullable().optional(),
  lines: z.array(docLineSchema).min(1),
});

// ---------- Quotes ----------

salesRouter.get('/quotes', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('quotes as d')
      .join('contacts as c', 'c.id', 'd.customer_id')
      .where('d.company_id', req.companyId)
      .orderBy('d.issue_date', 'desc')
      .select('d.*', 'c.name as customer_name');
    if (req.query.status) q.andWhere('d.status', req.query.status as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

const quoteSchema = invoiceSchema.omit({ dueDate: true }).extend({ expiryDate: dateStr.optional() });

salesRouter.post('/quotes', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(quoteSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const company = await trx('companies').where({ id: req.companyId }).first();
      const totals = await computeDocTotals(trx, req.companyId!, body.lines, body.amountsAre ?? 'exclusive');
      const [quote] = await trx('quotes')
        .insert({
          company_id: req.companyId,
          customer_id: body.customerId,
          doc_no: await nextDocNo(trx, req.companyId!, 'quote'),
          issue_date: body.issueDate,
          expiry_date: body.expiryDate ?? null,
          currency: (body.currency ?? company.base_currency).toUpperCase(),
          exchange_rate: d(body.exchangeRate ?? 1).toFixed(10),
          amounts_are: body.amountsAre ?? 'exclusive',
          subtotal: totals.subtotal,
          tax_total: totals.taxTotal,
          total: totals.total,
          memo: body.memo ?? null,
          created_by: req.userId,
        })
        .returning('*');
      await trx('quote_lines').insert(totals.lines.map((l) => ({ ...l, quote_id: quote.id })));
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'quote.created', entityType: 'quote', entityId: quote.id,
        details: { docNo: quote.doc_no, total: quote.total },
      });
      return quote;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/quotes/:id', async (req: AuthedRequest, res, next) => {
  try {
    const quote = await db('quotes').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!quote) throw notFound('Quote not found');
    const lines = await db('quote_lines').where({ quote_id: quote.id }).orderBy('line_no');
    res.json({ ...quote, lines });
  } catch (e) {
    next(e);
  }
});

const quoteStatusSchema = z.object({ status: z.enum(['sent', 'accepted', 'declined']) });

salesRouter.post('/quotes/:id/status', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(quoteStatusSchema, req.body);
    const [quote] = await db('quotes')
      .where({ id: req.params.id, company_id: req.companyId })
      .whereNot('status', 'invoiced')
      .update({ status: body.status })
      .returning('*');
    if (!quote) throw notFound('Quote not found or already invoiced');
    res.json(quote);
  } catch (e) {
    next(e);
  }
});

/** Converts a quote to a draft invoice. */
salesRouter.post('/quotes/:id/convert', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const quote = await trx('quotes')
        .where({ id: req.params.id, company_id: req.companyId })
        .forUpdate()
        .first();
      if (!quote) throw notFound('Quote not found');
      if (quote.status === 'invoiced') throw badRequest('Quote already invoiced');
      const lines = await trx('quote_lines').where({ quote_id: quote.id }).orderBy('line_no');
      const invoice = await createInvoice(trx, req.companyId!, req.userId!, {
        customerId: quote.customer_id,
        issueDate: new Date().toISOString().slice(0, 10),
        currency: quote.currency,
        exchangeRate: quote.exchange_rate,
        amountsAre: quote.amounts_are,
        memo: quote.memo,
        lines: lines.map((l: any) => ({
          itemId: l.item_id,
          description: l.description,
          qty: l.qty,
          unitPrice: l.unit_price,
          discountPct: l.discount_pct,
          accountId: l.account_id,
          taxCodeId: l.tax_code_id,
        })),
      });
      await trx('invoices').where({ id: invoice.id }).update({ quote_id: quote.id });
      await trx('quotes').where({ id: quote.id }).update({ status: 'invoiced' });
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'quote.converted', entityType: 'quote', entityId: quote.id,
        details: { invoiceId: invoice.id },
      });
      return invoice;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Invoices ----------

salesRouter.get('/invoices', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('invoices as d')
      .join('contacts as c', 'c.id', 'd.customer_id')
      .where('d.company_id', req.companyId)
      .orderBy([{ column: 'd.issue_date', order: 'desc' }, { column: 'd.doc_no', order: 'desc' }])
      .select('d.*', 'c.name as customer_name');
    if (req.query.status) q.andWhere('d.status', req.query.status as string);
    if (req.query.customer_id) q.andWhere('d.customer_id', req.query.customer_id as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/invoices/:id', async (req: AuthedRequest, res, next) => {
  try {
    const invoice = await db('invoices as d')
      .join('contacts as c', 'c.id', 'd.customer_id')
      .where({ 'd.id': req.params.id, 'd.company_id': req.companyId })
      .select('d.*', 'c.name as customer_name', 'c.address as customer_address', 'c.email as customer_email')
      .first();
    if (!invoice) throw notFound('Invoice not found');
    const lines = await db('invoice_lines').where({ invoice_id: invoice.id }).orderBy('line_no');
    const allocations = await db('payment_allocations as pa')
      .join('payments as p', 'p.id', 'pa.payment_id')
      .where({ 'pa.doc_type': 'invoice', 'pa.doc_id': invoice.id, 'p.status': 'active' })
      .select('pa.amount', 'p.doc_no', 'p.payment_date', 'p.id as payment_id');
    const credits = await db('credit_note_applications as ca')
      .join('credit_notes as cn', 'cn.id', 'ca.credit_note_id')
      .where('ca.invoice_id', invoice.id)
      .select('ca.amount', 'cn.doc_no', 'ca.applied_at');
    res.json({ ...invoice, lines, payments: allocations, credits });
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/invoices', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(invoiceSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const invoice = await createInvoice(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'invoice.created', entityType: 'invoice', entityId: invoice.id,
        details: { docNo: invoice.doc_no, total: invoice.total },
      });
      return invoice;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.patch('/invoices/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(invoiceSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const invoice = await updateDraftInvoice(trx, req.companyId!, req.params.id, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'invoice.updated', entityType: 'invoice', entityId: invoice.id,
        details: { docNo: invoice.doc_no, total: invoice.total },
      });
      return invoice;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/invoices/:id/post', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const out = await postInvoice(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'invoice.posted', entityType: 'invoice', entityId: req.params.id,
        details: { journalEntryId: out.journalEntryId },
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/invoices/:id/void', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const out = await voidInvoice(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'invoice.voided', entityType: 'invoice', entityId: req.params.id,
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Payments (receive) ----------

const receiveSchema = z.object({
  contactId: z.string().uuid(),
  paymentDate: dateStr,
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  depositAccountId: z.string().uuid(),
  reference: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.union([z.string(), z.number()]) })).min(1),
  withholdings: z
    .array(z.object({
      taxCodeId: z.string().uuid(),
      baseAmount: z.union([z.string(), z.number()]).optional(),
      amount: z.union([z.string(), z.number()]),
    }))
    .optional(),
});

salesRouter.post('/payments', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(receiveSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const payment = await receivePayment(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'payment.received', entityType: 'payment', entityId: payment.id,
        details: { docNo: payment.doc_no, amount: payment.amount },
      });
      return payment;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/payments', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('payments as p')
      .join('contacts as c', 'c.id', 'p.contact_id')
      .where({ 'p.company_id': req.companyId })
      .orderBy('p.payment_date', 'desc')
      .select('p.*', 'c.name as contact_name');
    if (req.query.kind) q.andWhere('p.kind', req.query.kind as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

// ---------- Credit notes ----------

salesRouter.get('/credit-notes', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('credit_notes as d')
      .join('contacts as c', 'c.id', 'd.customer_id')
      .where('d.company_id', req.companyId)
      .orderBy('d.issue_date', 'desc')
      .select('d.*', 'c.name as customer_name');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

salesRouter.get('/credit-notes/:id', async (req: AuthedRequest, res, next) => {
  try {
    const cn = await db('credit_notes').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!cn) throw notFound('Credit note not found');
    const lines = await db('credit_note_lines').where({ credit_note_id: cn.id }).orderBy('line_no');
    const applications = await db('credit_note_applications as ca')
      .join('invoices as i', 'i.id', 'ca.invoice_id')
      .where('ca.credit_note_id', cn.id)
      .select('ca.amount', 'i.doc_no', 'ca.applied_at');
    res.json({ ...cn, lines, applications });
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/credit-notes', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(invoiceSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const cn = await createCreditNote(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'credit_note.created', entityType: 'credit_note', entityId: cn.id,
        details: { docNo: cn.doc_no, total: cn.total },
      });
      return cn;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/credit-notes/:id/post', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const cn = await postCreditNote(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'credit_note.posted', entityType: 'credit_note', entityId: cn.id,
      });
      return cn;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

const applySchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.union([z.string(), z.number()]),
});

salesRouter.post('/credit-notes/:id/apply', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(applySchema, req.body);
    const result = await db.transaction(async (trx) => {
      const out = await applyCreditNote(trx, req.companyId!, req.userId!, {
        creditNoteId: req.params.id,
        invoiceId: body.invoiceId,
        amount: body.amount,
      });
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'credit_note.applied', entityType: 'credit_note', entityId: req.params.id,
        details: { invoiceId: body.invoiceId, amount: out.applied },
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Recurring invoices ----------

const recurringSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(1),
  frequency: z.enum(['weekly', 'monthly']),
  everyN: z.number().int().min(1).default(1),
  nextRunDate: dateStr,
  endDate: dateStr.nullable().optional(),
  autoPost: z.boolean().default(false),
  template: z.object({
    currency: z.string().length(3).optional(),
    exchangeRate: z.union([z.string(), z.number()]).optional(),
    amountsAre: z.enum(['exclusive', 'inclusive', 'no_tax']).optional(),
    memo: z.string().nullable().optional(),
    lines: z.array(docLineSchema).min(1),
  }),
});

salesRouter.get('/recurring-invoices', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('recurring_invoices as r')
      .join('contacts as c', 'c.id', 'r.customer_id')
      .where('r.company_id', req.companyId)
      .orderBy('r.created_at', 'desc')
      .select('r.*', 'c.name as customer_name');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

salesRouter.post('/recurring-invoices', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(recurringSchema, req.body);
    const [row] = await db('recurring_invoices')
      .insert({
        company_id: req.companyId,
        customer_id: body.customerId,
        name: body.name,
        template: JSON.stringify(body.template),
        frequency: body.frequency,
        every_n: body.everyN,
        next_run_date: body.nextRunDate,
        end_date: body.endDate ?? null,
        auto_post: body.autoPost,
      })
      .returning('*');
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

salesRouter.patch('/recurring-invoices/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(recurringSchema.partial(), req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.frequency !== undefined) patch.frequency = body.frequency;
    if (body.everyN !== undefined) patch.every_n = body.everyN;
    if (body.nextRunDate !== undefined) patch.next_run_date = body.nextRunDate;
    if (body.endDate !== undefined) patch.end_date = body.endDate;
    if (body.autoPost !== undefined) patch.auto_post = body.autoPost;
    if (body.template !== undefined) patch.template = JSON.stringify(body.template);
    if ((req.body as any).active !== undefined) patch.active = Boolean((req.body as any).active);
    const [row] = await db('recurring_invoices')
      .where({ id: req.params.id, company_id: req.companyId })
      .update(patch)
      .returning('*');
    if (!row) throw notFound('Recurring invoice not found');
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/** Materializes all due recurring invoices (idempotent per schedule). */
salesRouter.post('/recurring-invoices/run', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const today = (req.body?.asOf as string) ?? new Date().toISOString().slice(0, 10);
    const created = await db.transaction(async (trx) => {
      const out = await runRecurringInvoices(trx, req.companyId!, today, req.userId!);
      if (out.length) {
        await audit(trx, {
          companyId: req.companyId!, userId: req.userId,
          action: 'recurring.ran', entityType: 'recurring_invoice',
          details: { created: out.length, asOf: today },
        });
      }
      return out;
    });
    res.json({ created: created.length, invoices: created });
  } catch (e) {
    next(e);
  }
});
