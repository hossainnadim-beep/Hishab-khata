import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { notFound } from '../../lib/errors.ts';

export const contactsRouter = Router({ mergeParams: true });

const contactSchema = z.object({
  name: z.string().min(1),
  isCustomer: z.boolean().default(false),
  isVendor: z.boolean().default(false),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  taxRegNo: z.string().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});

function toRow(body: z.infer<typeof contactSchema>) {
  return {
    name: body.name,
    is_customer: body.isCustomer,
    is_vendor: body.isVendor,
    email: body.email ?? null,
    phone: body.phone ?? null,
    address: body.address ?? null,
    tax_reg_no: body.taxRegNo ?? null,
    currency: body.currency?.toUpperCase() ?? null,
    payment_terms_days: body.paymentTermsDays,
  };
}

contactsRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('contacts')
      .where({ company_id: req.companyId, archived: false })
      .orderBy('name');
    if (req.query.kind === 'customer') q.andWhere({ is_customer: true });
    if (req.query.kind === 'vendor') q.andWhere({ is_vendor: true });
    if (req.query.search) q.andWhereILike('name', `%${req.query.search}%`);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

contactsRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const contact = await db('contacts')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!contact) throw notFound('Contact not found');
    res.json(contact);
  } catch (e) {
    next(e);
  }
});

contactsRouter.post('/', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(contactSchema, req.body);
    await db.transaction(async (trx) => {
      const [row] = await trx('contacts')
        .insert({ ...toRow(body), company_id: req.companyId })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'contact.created',
        entityType: 'contact',
        entityId: row.id,
        details: { name: body.name },
      });
      res.status(201).json(row);
    });
  } catch (e) {
    next(e);
  }
});

contactsRouter.patch('/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(contactSchema.partial(), req.body);
    const existing = await db('contacts')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!existing) throw notFound('Contact not found');
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.isCustomer !== undefined) patch.is_customer = body.isCustomer;
    if (body.isVendor !== undefined) patch.is_vendor = body.isVendor;
    if (body.email !== undefined) patch.email = body.email;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.address !== undefined) patch.address = body.address;
    if (body.taxRegNo !== undefined) patch.tax_reg_no = body.taxRegNo;
    if (body.currency !== undefined) patch.currency = body.currency?.toUpperCase() ?? null;
    if (body.paymentTermsDays !== undefined) patch.payment_terms_days = body.paymentTermsDays;
    await db.transaction(async (trx) => {
      const [row] = await trx('contacts').where({ id: existing.id }).update(patch).returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'contact.updated',
        entityType: 'contact',
        entityId: existing.id,
        details: patch,
      });
      res.json(row);
    });
  } catch (e) {
    next(e);
  }
});

contactsRouter.delete('/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    await db.transaction(async (trx) => {
      const [row] = await trx('contacts')
        .where({ id: req.params.id, company_id: req.companyId })
        .update({ archived: true })
        .returning(['id']);
      if (!row) throw notFound('Contact not found');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'contact.archived',
        entityType: 'contact',
        entityId: row.id,
      });
      res.json({ ok: true });
    });
  } catch (e) {
    next(e);
  }
});
