import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.ts';
import { db } from '../src/db.ts';
import { signToken } from '../src/lib/auth.ts';
import { resetDb, makeUser } from './helpers.ts';
import { createCompany } from '../src/modules/companies/service.ts';

const app = createApp();
let token: string;
let companyId: string;
let byCode: Record<string, any>;
let customerId: string;

beforeAll(async () => {
  await resetDb();
  const user = await makeUser();
  token = signToken(user.id);
  const company = await db.transaction((trx) =>
    createCompany(trx, { name: 'Audit Co', baseCurrency: 'BDT', ownerUserId: user.id }),
  );
  companyId = company.id;
  const accounts = await db('accounts').where({ company_id: companyId });
  byCode = Object.fromEntries(accounts.map((a: any) => [a.code, a]));
  const [cust] = await db('contacts')
    .insert({ company_id: companyId, name: 'Audit Customer', is_customer: true })
    .returning('*');
  customerId = cust.id;
});

afterAll(async () => {
  await db.destroy();
});

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

describe('per-transaction audit trail (route layer)', () => {
  it('records created and posted events for an invoice, queryable by entity', async () => {
    const create = await auth(
      request(app).post(`/api/companies/${companyId}/sales/invoices`).send({
        customerId,
        issueDate: '2026-05-01',
        lines: [{ description: 'Audit test', qty: 1, unitPrice: 1000, accountId: byCode['4100'].id }],
      }),
    );
    expect(create.status).toBe(201);
    const invoiceId = create.body.id;

    const posted = await auth(
      request(app).post(`/api/companies/${companyId}/sales/invoices/${invoiceId}/post`),
    );
    expect(posted.status).toBe(200);

    const activity = await auth(
      request(app).get(
        `/api/companies/${companyId}/activity?entity_type=invoice&entity_id=${invoiceId}`,
      ),
    );
    expect(activity.status).toBe(200);
    const actions = activity.body.map((a: any) => a.action);
    expect(actions).toContain('invoice.created');
    expect(actions).toContain('invoice.posted');
    // the person who acted is recorded
    expect(activity.body[0].user_name).toBeTruthy();
  });

  it('captures before/after values when a draft invoice is edited', async () => {
    const create = await auth(
      request(app).post(`/api/companies/${companyId}/sales/invoices`).send({
        customerId,
        issueDate: '2026-05-02',
        lines: [{ description: 'Original', qty: 1, unitPrice: 500, accountId: byCode['4100'].id }],
      }),
    );
    const invoiceId = create.body.id;
    await auth(
      request(app).patch(`/api/companies/${companyId}/sales/invoices/${invoiceId}`).send({
        customerId,
        issueDate: '2026-05-02',
        lines: [{ description: 'Revised', qty: 2, unitPrice: 500, accountId: byCode['4100'].id }],
      }),
    );
    const activity = await auth(
      request(app).get(
        `/api/companies/${companyId}/activity?entity_type=invoice&entity_id=${invoiceId}`,
      ),
    );
    const updated = activity.body.find((a: any) => a.action === 'invoice.updated');
    expect(updated).toBeTruthy();
    expect(updated.details.before.total).toBe('500.00');
    expect(updated.details.after.total).toBe('1000.00');
  });
});
