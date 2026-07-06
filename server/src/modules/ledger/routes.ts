import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { notFound } from '../../lib/errors.ts';
import { postEntry, reverseEntry } from './posting.ts';
import { setPeriodStatus, setFiscalYearStatus } from './periods.ts';
import { revalueFx } from './fxRevalue.ts';

export const ledgerRouter = Router({ mergeParams: true });

// ---- Journal entries ----

ledgerRouter.get('/journal', async (req: AuthedRequest, res, next) => {
  try {
    const { from, to, account_id } = req.query as Record<string, string>;
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const offset = Number(req.query.offset ?? 0);
    let q = db('journal_entries as je')
      .where('je.company_id', req.companyId)
      .andWhere('je.status', 'posted')
      .orderBy([{ column: 'je.txn_date', order: 'desc' }, { column: 'je.entry_no', order: 'desc' }])
      .limit(limit)
      .offset(offset)
      .select('je.*');
    if (from) q = q.andWhere('je.txn_date', '>=', from);
    if (to) q = q.andWhere('je.txn_date', '<=', to);
    if (account_id) {
      q = q.whereIn('je.id', db('journal_lines').select('entry_id').where({ account_id }));
    }
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

ledgerRouter.get('/journal/:id', async (req: AuthedRequest, res, next) => {
  try {
    const entry = await db('journal_entries')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!entry) throw notFound('Journal entry not found');
    const lines = await db('journal_lines as jl')
      .join('accounts as a', 'a.id', 'jl.account_id')
      .where('jl.entry_id', entry.id)
      .orderBy('jl.line_no')
      .select('jl.*', 'a.code as account_code', 'a.name as account_name');
    const reversal = await db('journal_entries')
      .where({ reverses_entry_id: entry.id })
      .first(['id', 'entry_no']);
    res.json({ ...entry, lines, reversed_by: reversal ?? null });
  } catch (e) {
    next(e);
  }
});

const manualJournalSchema = z.object({
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
  memo: z.string().optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.union([z.string(), z.number()]).optional(),
        credit: z.union([z.string(), z.number()]).optional(),
        description: z.string().optional(),
        contactId: z.string().uuid().optional(),
      }),
    )
    .min(2),
});

ledgerRouter.post('/journal', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(manualJournalSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const posted = await postEntry(trx, {
        companyId: req.companyId!,
        txnDate: body.txnDate,
        currency: body.currency,
        exchangeRate: body.exchangeRate,
        memo: body.memo,
        sourceType: 'manual',
        userId: req.userId,
        lines: body.lines,
      });
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'journal.posted',
        entityType: 'journal_entry',
        entityId: posted.id,
        details: { entryNo: posted.entryNo, memo: body.memo },
      });
      return posted;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

const reverseSchema = z.object({
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().optional(),
});

ledgerRouter.post(
  '/journal/:id/reverse',
  requireRole('accountant'),
  async (req: AuthedRequest, res, next) => {
    try {
      const body = parse(reverseSchema, req.body);
      const result = await db.transaction(async (trx) => {
        const posted = await reverseEntry(trx, {
          companyId: req.companyId!,
          entryId: req.params.id,
          txnDate: body.txnDate,
          memo: body.memo,
          userId: req.userId,
        });
        await audit(trx, {
          companyId: req.companyId!,
          userId: req.userId,
          action: 'journal.reversed',
          entityType: 'journal_entry',
          entityId: req.params.id,
          details: { reversalEntryNo: posted.entryNo },
        });
        return posted;
      });
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  },
);

// ---- Unrealized FX revaluation ----

const revalueSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rates: z.record(z.string().length(3), z.union([z.string(), z.number()])),
});

ledgerRouter.post('/fx-revalue', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(revalueSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const out = await revalueFx(trx, {
        companyId: req.companyId!,
        asOfDate: body.asOfDate,
        rates: body.rates,
        userId: req.userId,
      });
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'fx.revalued',
        entityType: 'journal_entry',
        entityId: out.adjustmentEntryId,
        details: { asOfDate: body.asOfDate, rates: body.rates, total: out.total },
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---- Fiscal years & periods ----

ledgerRouter.get('/periods', async (req: AuthedRequest, res, next) => {
  try {
    const years = await db('fiscal_years')
      .where({ company_id: req.companyId })
      .orderBy('start_date', 'desc');
    const periods = await db('accounting_periods')
      .where({ company_id: req.companyId })
      .orderBy('start_date');
    res.json(
      years.map((y: any) => ({
        ...y,
        periods: periods.filter((p: any) => p.fiscal_year_id === y.id),
      })),
    );
  } catch (e) {
    next(e);
  }
});

const statusSchema = z.object({ status: z.enum(['open', 'closed']) });

ledgerRouter.post(
  '/periods/:id/status',
  requireRole('accountant'),
  async (req: AuthedRequest, res, next) => {
    try {
      const body = parse(statusSchema, req.body);
      await db.transaction(async (trx) => {
        await setPeriodStatus(trx, req.companyId!, req.params.id, body.status);
        await audit(trx, {
          companyId: req.companyId!,
          userId: req.userId,
          action: `period.${body.status}`,
          entityType: 'accounting_period',
          entityId: req.params.id,
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

ledgerRouter.post(
  '/fiscal-years/:id/status',
  requireRole('accountant'),
  async (req: AuthedRequest, res, next) => {
    try {
      const body = parse(statusSchema, req.body);
      await db.transaction(async (trx) => {
        await setFiscalYearStatus(trx, req.companyId!, req.params.id, body.status);
        await audit(trx, {
          companyId: req.companyId!,
          userId: req.userId,
          action: `fiscal_year.${body.status}`,
          entityType: 'fiscal_year',
          entityId: req.params.id,
        });
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
