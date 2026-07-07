import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { createCompany } from './service.ts';

export const companiesRouter = Router();

const createSchema = z.object({
  name: z.string().min(1),
  legalName: z.string().optional(),
  country: z.string().length(2).default('BD'),
  baseCurrency: z.string().length(3).default('BDT'),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(7),
  taxRegistrationNo: z.string().optional(),
});

/** Creates a company: COA from template, system account wiring, tax codes, current fiscal year. */
companiesRouter.post('/', async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(createSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const company = await createCompany(trx, {
        name: body.name,
        legalName: body.legalName,
        country: body.country,
        baseCurrency: body.baseCurrency,
        fiscalYearStartMonth: body.fiscalYearStartMonth,
        taxRegistrationNo: body.taxRegistrationNo,
        ownerUserId: req.userId!,
      });
      await audit(trx, {
        companyId: company.id,
        userId: req.userId,
        action: 'company.created',
        entityType: 'company',
        entityId: company.id,
      });
      return company;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// --- routes below are mounted with companyContext (see app.ts) ---

export const companyRouter = Router({ mergeParams: true });

companyRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const company = await db('companies').where({ id: req.companyId }).first();
    if (!company) throw notFound('Company not found');
    res.json({ ...company, role: req.role });
  } catch (e) {
    next(e);
  }
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  legalName: z.string().optional(),
  taxRegistrationNo: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  invoiceLogoText: z.string().nullable().optional(),
  invoiceFooter: z.string().nullable().optional(),
});

companyRouter.patch('/', requireRole('owner'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(updateSchema, req.body);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.legalName !== undefined) patch.legal_name = body.legalName;
    if (body.taxRegistrationNo !== undefined) patch.tax_registration_no = body.taxRegistrationNo;
    if (body.address !== undefined) patch.address = body.address;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.email !== undefined) patch.email = body.email;
    if (body.invoiceLogoText !== undefined) patch.invoice_logo_text = body.invoiceLogoText;
    if (body.invoiceFooter !== undefined) patch.invoice_footer = body.invoiceFooter;
    await db.transaction(async (trx) => {
      const [company] = await trx('companies').where({ id: req.companyId }).update(patch).returning('*');
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'company.updated',
        entityType: 'company',
        entityId: req.companyId,
        details: patch,
      });
      res.json(company);
    });
  } catch (e) {
    next(e);
  }
});

// Member management (owner only)
companyRouter.get('/members', async (req: AuthedRequest, res, next) => {
  try {
    const members = await db('memberships as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.company_id', req.companyId)
      .select('u.id', 'u.email', 'u.name', 'm.role', 'm.created_at');
    res.json(members);
  } catch (e) {
    next(e);
  }
});

const memberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'accountant', 'data_entry', 'read_only']),
});

companyRouter.post('/members', requireRole('owner'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(memberSchema, req.body);
    const user = await db('users').where({ email: body.email.toLowerCase() }).first();
    if (!user) throw badRequest('No user with that email — they must register first');
    await db.transaction(async (trx) => {
      await trx('memberships')
        .insert({ user_id: user.id, company_id: req.companyId, role: body.role })
        .onConflict(['user_id', 'company_id'])
        .merge({ role: body.role });
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'member.upserted',
        entityType: 'membership',
        entityId: user.id,
        details: { email: body.email, role: body.role },
      });
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

companyRouter.delete('/members/:userId', requireRole('owner'), async (req: AuthedRequest, res, next) => {
  try {
    if (req.params.userId === req.userId) throw badRequest('Cannot remove yourself');
    await db.transaction(async (trx) => {
      await trx('memberships')
        .where({ user_id: req.params.userId, company_id: req.companyId })
        .delete();
      await audit(trx, {
        companyId: req.companyId!,
        userId: req.userId,
        action: 'member.removed',
        entityType: 'membership',
        entityId: req.params.userId,
      });
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Activity log (immutable audit trail). Filter by entity for per-transaction audit.
companyRouter.get('/activity', async (req: AuthedRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const { entity_type, entity_id } = req.query as Record<string, string>;
    const q = db('audit_log as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .where('a.company_id', req.companyId)
      .orderBy('a.created_at', 'desc')
      .limit(limit)
      .select('a.id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.details', 'a.created_at', 'u.name as user_name');
    if (entity_type) q.andWhere('a.entity_type', entity_type);
    if (entity_id) q.andWhere('a.entity_id', entity_id);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});
