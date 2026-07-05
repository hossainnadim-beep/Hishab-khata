import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { postEntry } from '../ledger/posting.ts';
import { purposeAccount } from '../companies/service.ts';
import { stockIn, stockOut } from './service.ts';
import { d, money } from '../../lib/money.ts';

export const itemsRouter = Router({ mergeParams: true });

const itemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().nullable().optional(),
  type: z.enum(['inventory', 'service']).default('service'),
  description: z.string().nullable().optional(),
  salePrice: z.union([z.string(), z.number()]).default(0),
  purchasePrice: z.union([z.string(), z.number()]).default(0),
  incomeAccountId: z.string().uuid().nullable().optional(),
  expenseAccountId: z.string().uuid().nullable().optional(),
  inventoryAccountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
});

itemsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('items').where({ company_id: req.companyId, archived: false }).orderBy('name');
    if (req.query.search) q.andWhereILike('name', `%${req.query.search}%`);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

itemsRouter.get('/:id/movements', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('item_movements')
      .where({ company_id: req.companyId, item_id: req.params.id })
      .orderBy('created_at', 'desc')
      .limit(200);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

itemsRouter.post('/', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(itemSchema, req.body);
    await db.transaction(async (trx) => {
      const [row] = await trx('items')
        .insert({
          company_id: req.companyId,
          name: body.name,
          sku: body.sku ?? null,
          type: body.type,
          description: body.description ?? null,
          sale_price: d(body.salePrice).toFixed(6),
          purchase_price: d(body.purchasePrice).toFixed(6),
          income_account_id: body.incomeAccountId ?? null,
          expense_account_id: body.expenseAccountId ?? null,
          inventory_account_id: body.inventoryAccountId ?? null,
          tax_code_id: body.taxCodeId ?? null,
        })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'item.created',
        entityType: 'item',
        entityId: row.id,
        details: { name: body.name, type: body.type },
      });
      res.status(201).json(row);
    });
  } catch (e: any) {
    if (e.code === '23505') return next(badRequest('An item with this name already exists'));
    next(e);
  }
});

itemsRouter.patch('/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(itemSchema.partial(), req.body);
    const existing = await db('items')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!existing) throw notFound('Item not found');
    if (body.type && body.type !== existing.type && !d(existing.qty_on_hand).isZero()) {
      throw badRequest('Cannot change type of an item with stock on hand');
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.sku !== undefined) patch.sku = body.sku;
    if (body.type !== undefined) patch.type = body.type;
    if (body.description !== undefined) patch.description = body.description;
    if (body.salePrice !== undefined) patch.sale_price = d(body.salePrice).toFixed(6);
    if (body.purchasePrice !== undefined) patch.purchase_price = d(body.purchasePrice).toFixed(6);
    if (body.incomeAccountId !== undefined) patch.income_account_id = body.incomeAccountId;
    if (body.expenseAccountId !== undefined) patch.expense_account_id = body.expenseAccountId;
    if (body.inventoryAccountId !== undefined) patch.inventory_account_id = body.inventoryAccountId;
    if (body.taxCodeId !== undefined) patch.tax_code_id = body.taxCodeId;
    await db.transaction(async (trx) => {
      const [row] = await trx('items').where({ id: existing.id }).update(patch).returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'item.updated',
        entityType: 'item',
        entityId: existing.id,
        details: patch,
      });
      res.json(row);
    });
  } catch (e) {
    next(e);
  }
});

itemsRouter.delete('/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    await db.transaction(async (trx) => {
      const [row] = await trx('items')
        .where({ id: req.params.id, company_id: req.companyId })
        .update({ archived: true })
        .returning(['id']);
      if (!row) throw notFound('Item not found');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'item.archived',
        entityType: 'item',
        entityId: row.id,
      });
      res.json({ ok: true });
    });
  } catch (e) {
    next(e);
  }
});

/** Manual stock adjustment: qty in/out with a balancing JE against the adjustment account. */
const adjustSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  qtyDelta: z.union([z.string(), z.number()]), // + in, - out
  unitCost: z.union([z.string(), z.number()]).optional(), // required for stock-in
  adjustmentAccountId: z.string().uuid(), // usually COGS or an adjustment expense
  memo: z.string().optional(),
});

itemsRouter.post('/:id/adjust', requireRole('accountant'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(adjustSchema, req.body);
    const qty = d(body.qtyDelta);
    if (qty.isZero()) throw badRequest('qtyDelta cannot be zero');
    const result = await db.transaction(async (trx) => {
      const item = await trx('items')
        .where({ id: req.params.id, company_id: req.companyId })
        .first();
      if (!item) throw notFound('Item not found');
      if (item.type !== 'inventory') throw badRequest('Only inventory items can be adjusted');
      const invAccount =
        item.inventory_account_id ?? (await purposeAccount(trx, req.companyId!, 'inventory'));

      let value: string;
      if (qty.gt(0)) {
        const unitCost = body.unitCost !== undefined ? d(body.unitCost) : d(item.avg_cost);
        await stockIn(trx, {
          companyId: req.companyId!,
          itemId: item.id,
          date: body.date,
          qty,
          unitCost,
          sourceType: 'adjustment',
        });
        value = money(qty.times(unitCost));
        if (d(value).gt(0)) {
          await postEntry(trx, {
            companyId: req.companyId!,
            txnDate: body.date,
            memo: body.memo ?? `Stock adjustment: ${item.name}`,
            sourceType: 'inventory_adjustment',
            sourceId: item.id,
            userId: req.userId,
            lines: [
              { accountId: invAccount, debit: value, description: `Adjust ${item.name}` },
              { accountId: body.adjustmentAccountId, credit: value, description: `Adjust ${item.name}` },
            ],
          });
        }
      } else {
        const out = await stockOut(trx, {
          companyId: req.companyId!,
          itemId: item.id,
          date: body.date,
          qty: qty.abs(),
          sourceType: 'adjustment',
        });
        value = out.cogs;
        if (d(value).gt(0)) {
          await postEntry(trx, {
            companyId: req.companyId!,
            txnDate: body.date,
            memo: body.memo ?? `Stock adjustment: ${item.name}`,
            sourceType: 'inventory_adjustment',
            sourceId: item.id,
            userId: req.userId,
            lines: [
              { accountId: body.adjustmentAccountId, debit: value, description: `Adjust ${item.name}` },
              { accountId: invAccount, credit: value, description: `Adjust ${item.name}` },
            ],
          });
        }
      }
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'item.adjusted',
        entityType: 'item',
        entityId: item.id,
        details: { qtyDelta: qty.toString(), value },
      });
      return trx('items').where({ id: item.id }).first();
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
