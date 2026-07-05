import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { notFound } from '../../lib/errors.ts';

export const taxRouter = Router({ mergeParams: true });

taxRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('tax_codes')
      .where({ company_id: req.companyId, archived: false })
      .orderBy('code');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

const taxCodeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  rate: z.number().min(0).max(100),
  appliesTo: z.enum(['sales', 'purchases', 'both']).default('both'),
  isWithholding: z.boolean().default(false),
  salesAccountId: z.string().uuid().nullable().optional(),
  purchaseAccountId: z.string().uuid().nullable().optional(),
  reportCategory: z.string().optional(),
  jurisdiction: z.string().default('BD'),
});

taxRouter.post('/', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(taxCodeSchema, req.body);
    await db.transaction(async (trx) => {
      const [row] = await trx('tax_codes')
        .insert({
          company_id: req.companyId,
          code: body.code,
          name: body.name,
          rate: body.rate,
          applies_to: body.appliesTo,
          is_withholding: body.isWithholding,
          sales_account_id: body.salesAccountId ?? null,
          purchase_account_id: body.purchaseAccountId ?? null,
          report_category: body.reportCategory ?? null,
          jurisdiction: body.jurisdiction,
        })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'tax_code.created',
        entityType: 'tax_code',
        entityId: row.id,
        details: { code: body.code, rate: body.rate },
      });
      res.status(201).json(row);
    });
  } catch (e) {
    next(e);
  }
});

taxRouter.patch('/:id', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(taxCodeSchema.partial(), req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.rate !== undefined) patch.rate = body.rate;
    if (body.appliesTo !== undefined) patch.applies_to = body.appliesTo;
    if (body.salesAccountId !== undefined) patch.sales_account_id = body.salesAccountId;
    if (body.purchaseAccountId !== undefined) patch.purchase_account_id = body.purchaseAccountId;
    if (body.reportCategory !== undefined) patch.report_category = body.reportCategory;
    await db.transaction(async (trx) => {
      const [row] = await trx('tax_codes')
        .where({ id: req.params.id, company_id: req.companyId })
        .update(patch)
        .returning('*');
      if (!row) throw notFound('Tax code not found');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'tax_code.updated',
        entityType: 'tax_code',
        entityId: row.id,
        details: patch,
      });
      res.json(row);
    });
  } catch (e) {
    next(e);
  }
});

taxRouter.delete('/:id', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    await db.transaction(async (trx) => {
      const [row] = await trx('tax_codes')
        .where({ id: req.params.id, company_id: req.companyId })
        .update({ archived: true })
        .returning(['id']);
      if (!row) throw notFound('Tax code not found');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'tax_code.archived',
        entityType: 'tax_code',
        entityId: row.id,
      });
      res.json({ ok: true });
    });
  } catch (e) {
    next(e);
  }
});
