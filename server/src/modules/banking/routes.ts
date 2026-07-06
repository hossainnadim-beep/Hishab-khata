import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db.ts';
import { parse } from '../../lib/validate.ts';
import { requireRole, type AuthedRequest } from '../../lib/auth.ts';
import { audit } from '../../lib/audit.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { d, money } from '../../lib/money.ts';
import { importStatement, autoMatch, createSpendReceive } from './service.ts';

export const bankingRouter = Router({ mergeParams: true });

/** Bank/cash accounts with ledger balances (base currency). */
bankingRouter.get('/accounts', async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db('accounts as a')
      .leftJoin(
        db('journal_lines as jl')
          .join('journal_entries as je', 'je.id', 'jl.entry_id')
          .where('je.status', 'posted')
          .groupBy('jl.account_id')
          .select('jl.account_id')
          .select(db.raw('sum(jl.base_debit) - sum(jl.base_credit) as balance'))
          .select(db.raw('sum(jl.debit) - sum(jl.credit) as txn_balance'))
          .as('b'),
        'b.account_id',
        'a.id',
      )
      .where({ 'a.company_id': req.companyId, 'a.archived': false })
      .whereIn('a.subtype', ['bank', 'cash'])
      .orderBy('a.code')
      .select('a.*', db.raw("coalesce(b.balance, 0) as balance"), db.raw("coalesce(b.txn_balance, 0) as txn_balance"));
    const unmatchedCounts = await db('bank_txns')
      .where({ company_id: req.companyId, status: 'unmatched' })
      .groupBy('account_id')
      .select('account_id')
      .count('* as n');
    const byAccount = new Map(unmatchedCounts.map((r: any) => [r.account_id, Number(r.n)]));
    res.json(rows.map((r: any) => ({ ...r, unmatched_count: byAccount.get(r.id) ?? 0 })));
  } catch (e) {
    next(e);
  }
});

const importSchema = z.object({
  accountId: z.string().uuid(),
  format: z.enum(['csv', 'ofx']),
  content: z.string().min(1),
  filename: z.string().optional(),
});

bankingRouter.post('/import', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(importSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const out = await importStatement(trx, {
        companyId: req.companyId!,
        accountId: body.accountId,
        format: body.format,
        content: body.content,
        filename: body.filename,
        userId: req.userId,
      });
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bank.imported', entityType: 'bank_import', entityId: out.importId,
        details: { imported: out.imported, duplicates: out.duplicates },
      });
      return out;
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

bankingRouter.get('/txns', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('bank_txns')
      .where({ company_id: req.companyId })
      .orderBy([{ column: 'txn_date', order: 'desc' }, { column: 'created_at', order: 'desc' }])
      .limit(Math.min(Number(req.query.limit ?? 200), 1000));
    if (req.query.account_id) q.andWhere('account_id', req.query.account_id as string);
    if (req.query.status) q.andWhere('status', req.query.status as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

bankingRouter.post('/txns/auto-match', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(z.object({ accountId: z.string().uuid() }), req.body);
    const result = await db.transaction(async (trx) => {
      const out = await autoMatch(trx, req.companyId!, body.accountId, req.userId!);
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bank.auto_matched', entityType: 'account', entityId: body.accountId,
        details: out,
      });
      return out;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/** Manually match a bank txn to an existing posted journal entry. */
bankingRouter.post('/txns/:id/match', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(z.object({ journalEntryId: z.string().uuid() }), req.body);
    const txn = await db('bank_txns').where({ id: req.params.id, company_id: req.companyId }).first();
    if (!txn) throw notFound('Bank transaction not found');
    if (txn.status === 'reconciled') throw badRequest('Transaction is reconciled');
    const je = await db('journal_entries')
      .where({ id: body.journalEntryId, company_id: req.companyId, status: 'posted' })
      .first();
    if (!je) throw badRequest('Journal entry not found or not posted');
    const [row] = await db('bank_txns')
      .where({ id: txn.id })
      .update({ status: 'matched', matched_entry_id: je.id })
      .returning('*');
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/** Create a spend/receive entry directly from an unmatched bank txn. */
const categorizeSchema = z.object({
  targetAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
});

bankingRouter.post('/txns/:id/categorize', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(categorizeSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const txn = await trx('bank_txns')
        .where({ id: req.params.id, company_id: req.companyId })
        .forUpdate()
        .first();
      if (!txn) throw notFound('Bank transaction not found');
      if (txn.status !== 'unmatched') throw badRequest('Transaction is not unmatched');
      const account = await trx('accounts').where({ id: txn.account_id }).first();
      const company = await trx('companies').where({ id: req.companyId }).first();
      const isForeign = account.currency && account.currency !== company.base_currency;
      if (isForeign) throw badRequest('Foreign-currency txns need an explicit rate — use the spend-receive endpoint');
      const entryId = await createSpendReceive(trx, {
        companyId: req.companyId!,
        accountId: txn.account_id,
        date: txn.txn_date,
        description: body.description ?? txn.description,
        amount: txn.amount,
        targetAccountId: body.targetAccountId,
        taxCodeId: body.taxCodeId,
        contactId: body.contactId,
        userId: req.userId,
      });
      const [row] = await trx('bank_txns')
        .where({ id: txn.id })
        .update({ status: 'matched', matched_entry_id: entryId })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bank.categorized', entityType: 'bank_txn', entityId: txn.id,
        details: { entryId },
      });
      return row;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

bankingRouter.post('/txns/:id/exclude', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db('bank_txns')
      .where({ id: req.params.id, company_id: req.companyId, status: 'unmatched' })
      .update({ status: 'excluded' })
      .returning('*');
    if (!row) throw badRequest('Transaction not found or not unmatched');
    res.json(row);
  } catch (e) {
    next(e);
  }
});

bankingRouter.post('/txns/:id/unmatch', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db('bank_txns')
      .where({ id: req.params.id, company_id: req.companyId })
      .whereIn('status', ['matched', 'excluded'])
      .update({ status: 'unmatched', matched_entry_id: null })
      .returning('*');
    if (!row) throw badRequest('Transaction not found or not unmatchable');
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/** Direct spend/receive money (no imported statement line). */
const spendReceiveSchema = z.object({
  accountId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1),
  amount: z.union([z.string(), z.number()]), // signed
  targetAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  exchangeRate: z.union([z.string(), z.number()]).optional(),
});

bankingRouter.post('/spend-receive', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(spendReceiveSchema, req.body);
    const result = await db.transaction(async (trx) => {
      const entryId = await createSpendReceive(trx, {
        companyId: req.companyId!,
        accountId: body.accountId,
        date: body.date,
        description: body.description,
        amount: body.amount,
        targetAccountId: body.targetAccountId,
        taxCodeId: body.taxCodeId,
        contactId: body.contactId,
        currency: body.currency,
        exchangeRate: body.exchangeRate,
        userId: req.userId,
      });
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bank.spend_receive', entityType: 'journal_entry', entityId: entryId,
        details: { amount: body.amount, description: body.description },
      });
      return { journalEntryId: entryId };
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- Rules ----------

const ruleSchema = z.object({
  name: z.string().min(1),
  accountId: z.string().uuid().nullable().optional(),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  pattern: z.string().min(1),
  direction: z.enum(['in', 'out', 'any']).default('any'),
  contactId: z.string().uuid().nullable().optional(),
  targetAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().nullable().optional(),
  priority: z.number().int().default(100),
});

bankingRouter.get('/rules', async (req: AuthedRequest, res, next) => {
  try {
    res.json(
      await db('bank_rules')
        .where({ company_id: req.companyId, active: true })
        .orderBy('priority'),
    );
  } catch (e) {
    next(e);
  }
});

bankingRouter.post('/rules', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(ruleSchema, req.body);
    const [row] = await db('bank_rules')
      .insert({
        company_id: req.companyId,
        name: body.name,
        account_id: body.accountId ?? null,
        match_type: body.matchType,
        pattern: body.pattern,
        direction: body.direction,
        contact_id: body.contactId ?? null,
        target_account_id: body.targetAccountId,
        tax_code_id: body.taxCodeId ?? null,
        priority: body.priority,
      })
      .returning('*');
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

bankingRouter.delete('/rules/:id', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db('bank_rules')
      .where({ id: req.params.id, company_id: req.companyId })
      .update({ active: false })
      .returning(['id']);
    if (!row) throw notFound('Rule not found');
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------- Reconciliation ----------

const reconSchema = z.object({
  accountId: z.string().uuid(),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementBalance: z.union([z.string(), z.number()]),
});

bankingRouter.get('/reconciliations', async (req: AuthedRequest, res, next) => {
  try {
    const q = db('reconciliations')
      .where({ company_id: req.companyId })
      .orderBy('statement_date', 'desc');
    if (req.query.account_id) q.andWhere('account_id', req.query.account_id as string);
    res.json(await q);
  } catch (e) {
    next(e);
  }
});

bankingRouter.post('/reconciliations', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const body = parse(reconSchema, req.body);
    const existing = await db('reconciliations')
      .where({ company_id: req.companyId, account_id: body.accountId, status: 'in_progress' })
      .first();
    if (existing) throw badRequest('A reconciliation is already in progress for this account');
    const [row] = await db('reconciliations')
      .insert({
        company_id: req.companyId,
        account_id: body.accountId,
        statement_date: body.statementDate,
        statement_balance: money(d(body.statementBalance)),
        created_by: req.userId,
      })
      .returning('*');
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

/**
 * Reconciliation status: ledger balance up to statement date vs statement
 * balance, and the matched-but-unreconciled txns that would be locked in.
 */
bankingRouter.get('/reconciliations/:id', async (req: AuthedRequest, res, next) => {
  try {
    const recon = await db('reconciliations')
      .where({ id: req.params.id, company_id: req.companyId })
      .first();
    if (!recon) throw notFound('Reconciliation not found');
    const account = await db('accounts').where({ id: recon.account_id }).first();
    const [ledger] = await db('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where({ 'je.company_id': req.companyId, 'je.status': 'posted', 'jl.account_id': recon.account_id })
      .andWhere('je.txn_date', '<=', recon.statement_date)
      .select(db.raw('coalesce(sum(jl.debit) - sum(jl.credit),0) as bal'));
    const candidates = await db('bank_txns')
      .where({ company_id: req.companyId, account_id: recon.account_id, status: 'matched' })
      .andWhere('txn_date', '<=', recon.statement_date)
      .orderBy('txn_date');
    const ledgerBalance = money(d(ledger.bal));
    res.json({
      ...recon,
      account_name: account?.name,
      ledger_balance: ledgerBalance,
      difference: money(d(recon.statement_balance).minus(ledgerBalance)),
      candidates,
    });
  } catch (e) {
    next(e);
  }
});

/** Completes when ledger balance equals statement balance; locks matched txns. */
bankingRouter.post('/reconciliations/:id/complete', requireRole('data_entry'), async (req: AuthedRequest, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const recon = await trx('reconciliations')
        .where({ id: req.params.id, company_id: req.companyId })
        .forUpdate()
        .first();
      if (!recon) throw notFound('Reconciliation not found');
      if (recon.status !== 'in_progress') throw badRequest('Reconciliation already completed');
      const [ledger] = await trx('journal_lines as jl')
        .join('journal_entries as je', 'je.id', 'jl.entry_id')
        .where({ 'je.company_id': req.companyId, 'je.status': 'posted', 'jl.account_id': recon.account_id })
        .andWhere('je.txn_date', '<=', recon.statement_date)
        .select(trx.raw('coalesce(sum(jl.debit) - sum(jl.credit),0) as bal'));
      const diff = d(recon.statement_balance).minus(d(ledger.bal));
      if (!diff.toDecimalPlaces(2).isZero()) {
        throw badRequest(
          `Cannot complete: ledger balance ${money(d(ledger.bal))} differs from statement by ${money(diff)}`,
        );
      }
      await trx('bank_txns')
        .where({ company_id: req.companyId, account_id: recon.account_id, status: 'matched' })
        .andWhere('txn_date', '<=', recon.statement_date)
        .update({ status: 'reconciled', reconciliation_id: recon.id });
      const [row] = await trx('reconciliations')
        .where({ id: recon.id })
        .update({ status: 'completed', completed_at: trx.fn.now() })
        .returning('*');
      await audit(trx, {
        companyId: req.companyId!, userId: req.userId,
        action: 'bank.reconciled', entityType: 'reconciliation', entityId: recon.id,
        details: { statementDate: recon.statement_date, balance: recon.statement_balance },
      });
      return row;
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});
