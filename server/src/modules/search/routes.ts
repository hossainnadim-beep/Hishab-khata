import { Router } from 'express';
import { db } from '../../db.ts';
import type { AuthedRequest } from '../../lib/auth.ts';

export const searchRouter = Router({ mergeParams: true });

/** Global search across documents, contacts, items, and accounts. */
searchRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;
    const companyId = req.companyId;

    const [invoices, bills, quotes, creditNotes, contacts, items, accounts, payments] =
      await Promise.all([
        db('invoices as d').join('contacts as c', 'c.id', 'd.customer_id')
          .where('d.company_id', companyId)
          .andWhere((w) => w.whereILike('d.doc_no', like).orWhereILike('c.name', like))
          .orderBy('d.issue_date', 'desc').limit(5)
          .select('d.id', 'd.doc_no', 'd.total', 'd.status', 'c.name as contact'),
        db('bills as d').join('contacts as c', 'c.id', 'd.vendor_id')
          .where('d.company_id', companyId)
          .andWhere((w) => w.whereILike('d.doc_no', like).orWhereILike('d.vendor_ref', like).orWhereILike('c.name', like))
          .orderBy('d.issue_date', 'desc').limit(5)
          .select('d.id', 'd.doc_no', 'd.total', 'd.status', 'c.name as contact'),
        db('quotes as d').join('contacts as c', 'c.id', 'd.customer_id')
          .where('d.company_id', companyId)
          .andWhere((w) => w.whereILike('d.doc_no', like).orWhereILike('c.name', like))
          .limit(3).select('d.id', 'd.doc_no', 'd.total', 'd.status', 'c.name as contact'),
        db('credit_notes as d').join('contacts as c', 'c.id', 'd.customer_id')
          .where('d.company_id', companyId)
          .andWhere((w) => w.whereILike('d.doc_no', like).orWhereILike('c.name', like))
          .limit(3).select('d.id', 'd.doc_no', 'd.total', 'd.status', 'c.name as contact'),
        db('contacts').where({ company_id: companyId, archived: false })
          .whereILike('name', like).limit(5)
          .select('id', 'name', 'is_customer', 'is_vendor'),
        db('items').where({ company_id: companyId, archived: false })
          .where((w) => w.whereILike('name', like).orWhereILike('sku', like))
          .limit(5).select('id', 'name', 'sku', 'type'),
        db('accounts').where({ company_id: companyId, archived: false })
          .where((w) => w.whereILike('name', like).orWhereILike('code', like))
          .limit(5).select('id', 'code', 'name', 'type'),
        db('payments as p').join('contacts as c', 'c.id', 'p.contact_id')
          .where('p.company_id', companyId)
          .andWhere((w) => w.whereILike('p.doc_no', like).orWhereILike('p.reference', like))
          .limit(3).select('p.id', 'p.doc_no', 'p.amount', 'p.kind', 'c.name as contact'),
      ]);

    const results = [
      ...invoices.map((d: any) => ({ type: 'Invoice', label: `${d.doc_no} — ${d.contact}`, detail: `${d.status} · ${d.total}`, route: `/invoices/${d.id}` })),
      ...bills.map((d: any) => ({ type: 'Bill', label: `${d.doc_no} — ${d.contact}`, detail: `${d.status} · ${d.total}`, route: `/bills/${d.id}` })),
      ...quotes.map((d: any) => ({ type: 'Quote', label: `${d.doc_no} — ${d.contact}`, detail: d.status, route: `/quotes/${d.id}` })),
      ...creditNotes.map((d: any) => ({ type: 'Credit note', label: `${d.doc_no} — ${d.contact}`, detail: d.status, route: `/credit-notes/${d.id}` })),
      ...contacts.map((c: any) => ({
        type: c.is_customer ? 'Customer' : 'Vendor',
        label: c.name,
        detail: '',
        route: c.is_customer ? '/customers' : '/vendors',
      })),
      ...items.map((i: any) => ({ type: 'Item', label: i.name, detail: i.sku ?? i.type, route: '/items' })),
      ...accounts.map((a: any) => ({ type: 'Account', label: `${a.code} ${a.name}`, detail: a.type, route: `/accounts/${a.id}/transactions` })),
      ...payments.map((p: any) => ({ type: 'Payment', label: `${p.doc_no} — ${p.contact}`, detail: p.amount, route: '/payments' })),
    ];
    res.json(results.slice(0, 20));
  } catch (e) {
    next(e);
  }
});
