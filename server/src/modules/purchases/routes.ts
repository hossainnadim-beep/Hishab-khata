import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { notFound } from '../../lib/errors.ts';
import {
  createBill,
  updateDraftBill,
  postBill,
  voidBill,
  payBill,
  createVendorCredit,
  postVendorCredit,
  applyVendorCredit,
  createExpenseClaim,
  approveExpenseClaim,
  reimburseExpenseClaim,
} from './service.ts';

export const purchasesRouter = Router({ mergeParams: true });

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const docLineSchema = z.object({
  itemId: z.string().uuid().nullable().optional(),
  description: z.string().nullable().optional(),
  qty: z.union([z.string(), z.number()]).optional(),
  unitPrice: z.union([z.string(), z.number()]).optional(),
  accountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
});

const billSchema = z.object({
  vendorId: z.string().uuid(),
  issueDate: dateStr,
  dueDate: dateStr.optional(),
  vendorRef: z.string().nullable().optional(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  amountsAre: z.enum(['exclusive', 'inclusive', 'no_tax']).optional(),
  memo: z.string().nullable().optional(),
  lines: z.array(docLineSchema).min(1),
});

// ---------- Bills ----------

purchasesRouter.get('/bills', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('bills as d')
      .join('contacts as c', 'c.id', 'd.vendor_id')
      .where('d.company_id', req.companyId)
      .orderBy([{ column: 'd.issue_date', order: 'desc' }, { column: 'd.doc_no', order: 'desc' }])
      .select('d.*', 'c.name as vendor_name');
    if (req.query.status) q.andWhere('d.status', req.query.status as string);
    if (req.query.vendor_id) q.andWhere('d.vendor_id', req.query.vendor_id as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/bills/:id', async (req: AuthedRequest, res, next) => {
  try {
    const bill = await db('bills as d')
      .join('contacts as c', 'c.id', 'd.vendor_id')
      .where({ 'd.id': req.params.id, 'd.company_id': req.companyId })
      .select('d.*', 'c.name as vendor_name')
      .first();
    if (!bill) throw notFound('Bill not found');
    const lines = await db('bill_lines').where({ bill_id: bill.id }).orderBy('line_no');
    const allocations = await db('payment_allocations as pa')
      .join('payments as p', 'p.id', 'pa.payment_id')
      .where({ 'pa.doc_type': 'bill', 'pa.doc_id': bill.id, 'p.status': 'active' })
      .select('pa.amount', 'p.doc_no', 'p.payment_date');
    const credits = await db('vendor_credit_applications as va')
      .join('vendor_credits as vc', 'vc.id', 'va.vendor_credit_id')
      .where('va.bill_id', bill.id)
      .select('va.amount', 'vc.doc_no', 'va.applied_at');
    res.json({ ...bill, lines, payments: allocations, credits });
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/bills', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(billSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const bill = await createBill(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bill.created', entityType: 'bill', entityId: bill.id,
        details: { docNo: bill.doc_no, total: bill.total },
      });
      return bill;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.patch('/bills/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(billSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const before = await trx('bills')
        .where({ id: req.params.id, company_id: req.companyId })
        .first(['vendor_id', 'vendor_ref', 'issue_date', 'due_date', 'currency', 'subtotal', 'tax_total', 'total', 'memo']);
      const bill = await updateDraftBill(trx, req.companyId!, req.params.id, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bill.updated', entityType: 'bill', entityId: bill.id,
        details: {
          docNo: bill.doc_no,
          before,
          after: {
            vendor_id: bill.vendor_id, vendor_ref: bill.vendor_ref,
            issue_date: bill.issue_date, due_date: bill.due_date, currency: bill.currency,
            subtotal: bill.subtotal, tax_total: bill.tax_total, total: bill.total, memo: bill.memo,
          },
        },
      });
      return bill;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/bills/:id/post', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const bill = await postBill(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bill.posted', entityType: 'bill', entityId: bill.id,
        details: { journalEntryId: bill.journal_entry_id },
      });
      return bill;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/bills/:id/void', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const out = await voidBill(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bill.voided', entityType: 'bill', entityId: req.params.id,
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Bill payments ----------

const paySchema = z.object({
  contactId: z.string().uuid(),
  paymentDate: dateStr,
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  paymentAccountId: z.string().uuid(),
  reference: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  allocations: z.array(z.object({ billId: z.string().uuid(), amount: z.union([z.string(), z.number()]) })).min(1),
  withholdings: z
    .array(z.object({
      taxCodeId: z.string().uuid(),
      baseAmount: z.union([z.string(), z.number()]).optional(),
      amount: z.union([z.string(), z.number()]),
    }))
    .optional(),
});

purchasesRouter.post('/payments', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(paySchema, req.body);
    const result = await db.transaction(async (trx) => {
      const payment = await payBill(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'payment.paid', entityType: 'payment', entityId: payment.id,
        details: { docNo: payment.doc_no, amount: payment.amount },
      });
      return payment;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Vendor credits ----------

purchasesRouter.get('/vendor-credits', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('vendor_credits as d')
      .join('contacts as c', 'c.id', 'd.vendor_id')
      .where('d.company_id', req.companyId)
      .orderBy('d.issue_date', 'desc')
      .select('d.*', 'c.name as vendor_name');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/vendor-credits', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(billSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const vc = await createVendorCredit(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'vendor_credit.created', entityType: 'vendor_credit', entityId: vc.id,
        details: { docNo: vc.doc_no, total: vc.total },
      });
      return vc;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/vendor-credits/:id/post', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const vc = await postVendorCredit(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'vendor_credit.posted', entityType: 'vendor_credit', entityId: vc.id,
      });
      return vc;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

const applySchema = z.object({ billId: z.string().uuid(), amount: z.union([z.string(), z.number()]) });

purchasesRouter.post('/vendor-credits/:id/apply', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(applySchema, req.body);
    const result = await db.transaction(async (trx) => {
      const out = await applyVendorCredit(trx, req.companyId!, req.userId!, {
        vendorCreditId: req.params.id,
        billId: body.billId,
        amount: body.amount,
      });
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'vendor_credit.applied', entityType: 'vendor_credit', entityId: req.params.id,
        details: { billId: body.billId, amount: out.applied },
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Expense claims ----------

const claimSchema = z.object({
  claimant: z.string().min(1),
  claimDate: dateStr,
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  memo: z.string().nullable().optional(),
  lines: z
    .array(z.object({
      expenseDate: dateStr,
      accountId: z.string().uuid(),
      description: z.string().nullable().optional(),
      amount: z.union([z.string(), z.number()]),
      taxCodeId: z.string().uuid().nullable().optional(),
    }))
    .min(1),
});

purchasesRouter.get('/expense-claims', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('expense_claims')
      .where({ company_id: req.companyId })
      .orderBy('claim_date', 'desc');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.get('/expense-claims/:id', async (req: AuthedRequest, res, next) => {
  try {
    const claim = await db('expense_claims')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!claim) throw notFound('Claim not found');
    const lines = await db('expense_claim_lines').where({ claim_id: claim.id }).orderBy('line_no');
    res.json({ ...claim, lines });
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/expense-claims', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(claimSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const claim = await createExpenseClaim(trx, req.companyId!, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'expense_claim.created', entityType: 'expense_claim', entityId: claim.id,
        details: { docNo: claim.doc_no, total: claim.total },
      });
      return claim;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

purchasesRouter.post('/expense-claims/:id/approve', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const claim = await approveExpenseClaim(trx, req.companyId!, req.params.id, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'expense_claim.approved', entityType: 'expense_claim', entityId: claim.id,
      });
      return claim;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

const reimburseSchema = z.object({ paymentDate: dateStr, paymentAccountId: z.string().uuid() });

purchasesRouter.post('/expense-claims/:id/reimburse', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(reimburseSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const claim = await reimburseExpenseClaim(trx, req.companyId!, req.params.id, req.userId!, body);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'expense_claim.reimbursed', entityType: 'expense_claim', entityId: claim.id,
      });
      return claim;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
