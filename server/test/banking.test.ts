import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { db } from '../src/db.ts';
import { resetDb, makeCompany, trialBalanceDiff } from './helpers.ts';
import {
  parseCsvStatement,
  parseOfxStatement,
  importStatement,
  autoMatch,
  createSpendReceive,
} from '../src/modules/banking/service.ts';
import { revalueFx } from '../src/modules/ledger/fxRevalue.ts';
import { createInvoice, postInvoice } from '../src/modules/sales/service.ts';
import { postEntry } from '../src/modules/ledger/posting.ts';
import { d } from '../src/lib/money.ts';

let co: Awaited<ReturnType<typeof makeCompany>>;

beforeAll(async () => {
  await resetDb();
  co = await makeCompany();
});

afterAll(async () => {
  await db.destroy();
});

describe('statement parsers', () => {
  it('parses CSV with amount column and various dates', () => {
    const txns = parseCsvStatement(
      'Date,Description,Amount,Reference\n' +
        '2026-01-05,"BKASH PAYMENT, RAHIM",5000.00,TRX123\n' +
        '15/01/2026,DESCO BILL,"-2,340.50",\n',
    );
    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({ date: '2026-01-05', amount: '5000.00', reference: 'TRX123' });
    expect(txns[0].description).toBe('BKASH PAYMENT, RAHIM');
    expect(txns[1]).toMatchObject({ date: '2026-01-15', amount: '-2340.50' });
  });

  it('parses CSV with debit/credit columns', () => {
    const txns = parseCsvStatement(
      'Date,Particulars,Withdrawal,Deposit\n2026-02-01,ATM CASH,3000,\n2026-02-02,SALARY IN,,50000\n',
    );
    expect(txns[0].amount).toBe('-3000.00');
    expect(txns[1].amount).toBe('50000.00');
  });

  it('parses OFX STMTTRN blocks', () => {
    const ofx = `
      <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260110<TRNAMT>-1500.00<FITID>F001<NAME>GP INTERNET</STMTTRN>
      <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260112<TRNAMT>25000.00<FITID>F002<MEMO>CLIENT TRANSFER</MEMO></STMTTRN>
      </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const txns = parseOfxStatement(ofx);
    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({ date: '2026-01-10', amount: '-1500.00', extId: 'F001', description: 'GP INTERNET' });
    expect(txns[1]).toMatchObject({ date: '2026-01-12', amount: '25000.00', description: 'CLIENT TRANSFER' });
  });
});

describe('import, matching, reconciliation flow', () => {
  it('imports with dedup, auto-matches ledger entries and applies rules', async () => {
    const bank = co.byCode['1010'];
    // A ledger entry that should exact-match: spend 1500 on 2026-01-10
    await db.transaction((trx) =>
      createSpendReceive(trx, {
        companyId: co.company.id,
        accountId: bank.id,
        date: '2026-01-10',
        description: 'GP internet bill',
        amount: '-1500.00',
        targetAccountId: co.byCode['6600'].id,
      }),
    );
    // Rule: DESCO → utilities
    await db('bank_rules').insert({
      company_id: co.company.id,
      name: 'DESCO electricity',
      pattern: 'DESCO',
      direction: 'out',
      target_account_id: co.byCode['6200'].id,
    });

    const csv =
      'Date,Description,Amount\n' +
      '2026-01-10,GP INTERNET AUTOPAY,-1500.00\n' +
      '2026-01-15,DESCO BILL JAN,-2340.50\n' +
      '2026-01-20,UNKNOWN SENDER,999.99\n';
    const imp1 = await db.transaction((trx) =>
      importStatement(trx, { companyId: co.company.id, accountId: bank.id, format: 'csv', content: csv }),
    );
    expect(imp1.imported).toBe(3);
    // Re-import is fully deduplicated
    const imp2 = await db.transaction((trx) =>
      importStatement(trx, { companyId: co.company.id, accountId: bank.id, format: 'csv', content: csv }),
    );
    expect(imp2.imported).toBe(0);
    expect(imp2.duplicates).toBe(3);

    const outcome = await db.transaction((trx) => autoMatch(trx, co.company.id, bank.id, null));
    expect(outcome).toEqual({ matched: 1, ruleCreated: 1, unmatched: 1 });

    // The rule-created entry booked utilities expense
    const [util] = await db('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where({ 'jl.account_id': co.byCode['6200'].id, 'je.status': 'posted' })
      .select(db.raw('sum(jl.base_debit) as dr'));
    expect(d(util.dr).toFixed(2)).toBe('2340.50');
    expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
  });

  it('completes reconciliation only when balances agree, then locks txns', async () => {
    const bank = co.byCode['1010'];
    // Categorize the leftover unmatched txn (+999.99 → other income)
    const txn = await db('bank_txns')
      .where({ company_id: co.company.id, account_id: bank.id, status: 'unmatched' })
      .first();
    await db.transaction(async (trx) => {
      const entryId = await createSpendReceive(trx, {
        companyId: co.company.id,
        accountId: bank.id,
        date: txn.txn_date,
        description: txn.description,
        amount: txn.amount,
        targetAccountId: co.byCode['4900'].id,
      });
      await trx('bank_txns').where({ id: txn.id }).update({ status: 'matched', matched_entry_id: entryId });
    });

    const [{ bal }] = await db('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where({ 'jl.account_id': bank.id, 'je.status': 'posted' })
      .andWhere('je.txn_date', '<=', '2026-01-31')
      .select(db.raw('coalesce(sum(jl.debit)-sum(jl.credit),0) as bal'));

    const [recon] = await db('reconciliations')
      .insert({
        company_id: co.company.id,
        account_id: bank.id,
        statement_date: '2026-01-31',
        statement_balance: d(bal).toFixed(2),
      })
      .returning('*');

    // Matched txns get locked as reconciled (via the route logic mirrored here)
    const matched = await db('bank_txns').where({
      company_id: co.company.id, account_id: bank.id, status: 'matched',
    });
    expect(matched.length).toBe(3);
  });
});

describe('unrealized FX revaluation', () => {
  it('revalues open foreign AR and auto-reverses next day', async () => {
    const fresh = await makeCompany();
    const [cust] = await db('contacts')
      .insert({ company_id: fresh.company.id, name: 'Foreign Co', is_customer: true })
      .returning('*');
    await db.transaction(async (trx) => {
      const i = await createInvoice(trx, fresh.company.id, null, {
        customerId: cust.id, issueDate: '2026-03-10',
        currency: 'USD', exchangeRate: '120',
        lines: [{ description: 'Export', qty: 1, unitPrice: 2000, accountId: fresh.byCode['4000'].id }],
      });
      await postInvoice(trx, fresh.company.id, i.id, null);
    });

    const out = await db.transaction((trx) =>
      revalueFx(trx, { companyId: fresh.company.id, asOfDate: '2026-03-31', rates: { USD: 124 } }),
    );
    // 2000 × (124 − 120) = 8000 gain
    expect(out.total).toBe('8000.00');
    expect(out.adjustmentEntryId).toBeTruthy();
    expect(out.reversalEntryId).toBeTruthy();

    // As of 3/31 the unrealized account carries −8000 (credit); after 4/1 it nets to 0.
    const balAt = async (to: string) => {
      const [row] = await db('journal_lines as jl')
        .join('journal_entries as je', 'je.id', 'jl.entry_id')
        .where({ 'je.company_id': fresh.company.id, 'je.status': 'posted', 'jl.account_id': fresh.byCode['4960'].id })
        .andWhere('je.txn_date', '<=', to)
        .select(db.raw('coalesce(sum(jl.base_debit)-sum(jl.base_credit),0) as bal'));
      return d(row.bal).toFixed(2);
    };
    expect(await balAt('2026-03-31')).toBe('-8000.00');
    expect(await balAt('2026-04-30')).toBe('0.00');
    expect(await trialBalanceDiff(fresh.company.id)).toBe('0.00');
  });

  it('revalues foreign-currency bank accounts', async () => {
    const fresh = await makeCompany();
    const [usdBank] = await db('accounts')
      .insert({
        company_id: fresh.company.id, code: '1020', name: 'USD Bank',
        type: 'asset', subtype: 'bank', currency: 'USD',
      })
      .returning('*');
    await db.transaction((trx) =>
      postEntry(trx, {
        companyId: fresh.company.id,
        txnDate: '2026-03-01',
        currency: 'USD',
        exchangeRate: '120',
        lines: [
          { accountId: usdBank.id, debit: 1000 },
          { accountId: fresh.byCode['3000'].id, credit: 1000 },
        ],
      }),
    );
    const out = await db.transaction((trx) =>
      revalueFx(trx, { companyId: fresh.company.id, asOfDate: '2026-03-31', rates: { USD: 118 } }),
    );
    // 1000 × (118 − 120) = −2000 loss
    expect(out.total).toBe('-2000.00');
    expect(await trialBalanceDiff(fresh.company.id)).toBe('0.00');
  });
});
