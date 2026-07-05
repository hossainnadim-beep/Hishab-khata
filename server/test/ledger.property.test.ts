import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fc from 'fast-check';
import { db } from '../src/db.ts';
import { postEntry, reverseEntry } from '../src/modules/ledger/posting.ts';
import { d, money } from '../src/lib/money.ts';
import { resetDb, makeCompany, trialBalanceDiff } from './helpers.ts';

let co: Awaited<ReturnType<typeof makeCompany>>;

beforeAll(async () => {
  await resetDb();
  co = await makeCompany();
});

afterAll(async () => {
  await db.destroy();
});

/** 2dp money amount between 0.01 and ~1,000,000. */
const amountArb = fc
  .integer({ min: 1, max: 100_000_000 })
  .map((cents) => (cents / 100).toFixed(2));

/** A balanced set of lines: n debit amounts, mirrored across random credit splits. */
const balancedLinesArb = fc
  .array(amountArb, { minLength: 1, maxLength: 5 })
  .map((debits) => {
    const total = debits.reduce((a, b) => a.plus(b), d(0));
    return { debits, credits: [money(total)] };
  });

function toLines(
  debits: string[],
  credits: string[],
  debitAccount: string,
  creditAccount: string,
) {
  return [
    ...debits.map((amt) => ({ accountId: debitAccount, debit: amt })),
    ...credits.map((amt) => ({ accountId: creditAccount, credit: amt })),
  ];
}

describe('ledger invariants (property tests)', () => {
  it('any balanced entry posts and the trial balance stays exactly balanced', async () => {
    await fc.assert(
      fc.asyncProperty(balancedLinesArb, async ({ debits, credits }) => {
        await db.transaction((trx) =>
          postEntry(trx, {
            companyId: co.company.id,
            txnDate: '2026-01-15',
            lines: toLines(debits, credits, co.byCode['1000'].id, co.byCode['3000'].id),
          }),
        );
        expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
      }),
      { numRuns: 30 },
    );
  });

  it('any unbalanced entry is rejected and persists nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        amountArb,
        fc.integer({ min: 1, max: 10_000 }), // perturbation in cents
        async (amt, cents) => {
          const before = await db('journal_entries')
            .where({ company_id: co.company.id })
            .count('* as n');
          const bad = money(d(amt).plus(cents / 100));
          await expect(
            db.transaction((trx) =>
              postEntry(trx, {
                companyId: co.company.id,
                txnDate: '2026-01-15',
                lines: [
                  { accountId: co.byCode['1000'].id, debit: amt },
                  { accountId: co.byCode['3000'].id, credit: bad },
                ],
              }),
            ),
          ).rejects.toThrow(/does not balance/);
          const after = await db('journal_entries')
            .where({ company_id: co.company.id })
            .count('* as n');
          expect(after[0].n).toBe(before[0].n);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('foreign-currency entries balance exactly in base currency at any rate', async () => {
    const rateArb = fc
      .integer({ min: 1, max: 2_000_000_000 })
      .map((n) => (n / 10_000_000).toFixed(7)); // 0.0000001 .. 200, 7dp
    await fc.assert(
      fc.asyncProperty(balancedLinesArb, rateArb, async ({ debits, credits }, rate) => {
        await db.transaction((trx) =>
          postEntry(trx, {
            companyId: co.company.id,
            txnDate: '2026-02-10',
            currency: 'USD',
            exchangeRate: rate,
            lines: toLines(debits, credits, co.byCode['1000'].id, co.byCode['3000'].id),
          }),
        );
        expect(await trialBalanceDiff(co.company.id)).toBe('0.00');
      }),
      { numRuns: 30 },
    );
  });

  it('posted entries and their lines reject any UPDATE or DELETE', async () => {
    const { id } = await db.transaction((trx) =>
      postEntry(trx, {
        companyId: co.company.id,
        txnDate: '2026-03-01',
        lines: [
          { accountId: co.byCode['1000'].id, debit: '42.00' },
          { accountId: co.byCode['3000'].id, credit: '42.00' },
        ],
      }),
    );
    await expect(
      db('journal_entries').where({ id }).update({ memo: 'tampered' }),
    ).rejects.toThrow(/immutable/);
    await expect(db('journal_entries').where({ id }).delete()).rejects.toThrow(/immutable/);
    await expect(
      db('journal_lines').where({ entry_id: id }).update({ debit: '1.00' }),
    ).rejects.toThrow(/immutable/);
    await expect(db('journal_lines').where({ entry_id: id }).delete()).rejects.toThrow(
      /immutable/,
    );
    // Sneaking an extra line into a posted entry must also fail.
    await expect(
      db('journal_lines').insert({
        entry_id: id,
        line_no: 99,
        account_id: co.byCode['1000'].id,
        debit: '1.00',
        credit: '0.00',
        base_debit: '1.00',
        base_credit: '0.00',
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('reversal nets every account to zero and cannot be applied twice', async () => {
    const fresh = await makeCompany();
    const { id } = await db.transaction((trx) =>
      postEntry(trx, {
        companyId: fresh.company.id,
        txnDate: '2026-03-05',
        currency: 'EUR',
        exchangeRate: '131.7719',
        lines: [
          { accountId: fresh.byCode['1000'].id, debit: '123.45' },
          { accountId: fresh.byCode['1010'].id, debit: '0.55' },
          { accountId: fresh.byCode['3000'].id, credit: '124.00' },
        ],
      }),
    );
    await db.transaction((trx) =>
      reverseEntry(trx, {
        companyId: fresh.company.id,
        entryId: id,
        txnDate: '2026-03-06',
      }),
    );
    const perAccount = await db('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where('je.company_id', fresh.company.id)
      .groupBy('jl.account_id')
      .select(
        'jl.account_id',
        db.raw('sum(jl.base_debit) - sum(jl.base_credit) as net'),
        db.raw('sum(jl.debit) - sum(jl.credit) as net_txn'),
      );
    for (const row of perAccount) {
      expect(row.net).toBe('0.00');
      expect(row.net_txn).toBe('0.00');
    }
    await expect(
      db.transaction((trx) =>
        reverseEntry(trx, {
          companyId: fresh.company.id,
          entryId: id,
          txnDate: '2026-03-07',
        }),
      ),
    ).rejects.toThrow(/already reversed/);
  });

  it('posting into a closed period is rejected at the database level', async () => {
    const fresh = await makeCompany();
    // ensure periods exist for the date, then close that period
    await db.transaction((trx) =>
      postEntry(trx, {
        companyId: fresh.company.id,
        txnDate: '2026-04-01',
        lines: [
          { accountId: fresh.byCode['1000'].id, debit: '1.00' },
          { accountId: fresh.byCode['3000'].id, credit: '1.00' },
        ],
      }),
    );
    await db('accounting_periods')
      .where({ company_id: fresh.company.id })
      .andWhere('start_date', '<=', '2026-04-15')
      .andWhere('end_date', '>=', '2026-04-15')
      .update({ status: 'closed' });
    await expect(
      db.transaction((trx) =>
        postEntry(trx, {
          companyId: fresh.company.id,
          txnDate: '2026-04-15',
          lines: [
            { accountId: fresh.byCode['1000'].id, debit: '5.00' },
            { accountId: fresh.byCode['3000'].id, credit: '5.00' },
          ],
        }),
      ),
    ).rejects.toThrow(/closed period/);
  });
});
