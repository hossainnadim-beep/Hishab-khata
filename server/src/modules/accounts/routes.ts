import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { badRequest, notFound } from '../../lib/errors.ts';

export const accountsRouter = Router({ mergeParams: true });

accountsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const includeArchived = req.query.archived === 'true';
    const q = db('accounts').where({ company_id: req.companyId }).orderBy('code');
    if (!includeArchived) q.andWhere({ archived: false });
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

const accountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  subtype: z.string().optional(),
  currency: z.string().length(3).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

accountsRouter.post('/', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(accountSchema, req.body);
    await db.transaction(async (trx) => {
      const [row] = await trx('accounts')
        .insert({
          company_id: req.companyId,
          code: body.code,
          name: body.name,
          type: body.type,
          subtype: body.subtype ?? null,
          currency: body.currency?.toUpperCase() ?? null,
          parent_id: body.parentId ?? null,
        })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'account.created',
        entityType: 'account',
        entityId: row.id,
        details: { code: body.code, name: body.name, type: body.type },
      });
      res.status(201).json(row);
    });
  } catch (e: any) {
    if (e.code === '23505') return next(badRequest('Account code already in use'));
    next(e);
  }
});

accountsRouter.patch('/:id', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(accountSchema.partial(), req.body);
    const existing = await db('accounts')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!existing) throw notFound('Account not found');
    // Type changes on used accounts would misstate history.
    if (body.type && body.type !== existing.type) {
      const used = await db('journal_lines').where({ account_id: existing.id }).first();
      if (used) throw badRequest('Cannot change type of an account with transactions');
    }
    const patch: Record<string, unknown> = {};
    if (body.code !== undefined) patch.code = body.code;
    if (body.name !== undefined) patch.name = body.name;
    if (body.type !== undefined) patch.type = body.type;
    if (body.subtype !== undefined) patch.subtype = body.subtype;
    if (body.currency !== undefined) patch.currency = body.currency?.toUpperCase() ?? null;
    if (body.parentId !== undefined) patch.parent_id = body.parentId;
    await db.transaction(async (trx) => {
      const [row] = await trx('accounts').where({ id: existing.id }).update(patch).returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'account.updated',
        entityType: 'account',
        entityId: existing.id,
        details: patch,
      });
      res.json(row);
    });
  } catch (e: any) {
    if (e.code === '23505') return next(badRequest('Account code already in use'));
    next(e);
  }
});

/** Archive (never delete — history references accounts). */
accountsRouter.delete('/:id', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const existing = await db('accounts')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!existing) throw notFound('Account not found');
    if (existing.is_system) throw badRequest('System accounts cannot be archived');
    await db.transaction(async (trx) => {
      await trx('accounts').where({ id: existing.id }).update({ archived: true });
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'account.archived',
        entityType: 'account',
        entityId: existing.id,
      });
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
