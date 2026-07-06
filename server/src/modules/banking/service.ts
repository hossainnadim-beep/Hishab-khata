import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { d, money } from '../../lib/money.ts';
import { badRequest } from '../../lib/errors.ts';
import { postEntry } from '../ledger/posting.ts';
import { calcLineTax } from '../tax/calc.ts';

export interface ParsedTxn {
  date: string; // YYYY-MM-DD
  description: string;
  reference?: string | null;
  amount: string; // signed 2dp
  extId?: string; // OFX FITID
}

/**
 * CSV statement parser. Expects a header row containing (case-insensitive)
 * date, description, amount — extra columns ignored. Also accepts
 * debit/withdrawal + credit/deposit column pairs instead of amount.
 * Dates: YYYY-MM-DD or DD/MM/YYYY.
 */
export function parseCsvStatement(text: string): ParsedTxn[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw badRequest('CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const dateIdx = col('date');
  const descIdx = col('description', 'narration', 'particular', 'details', 'memo');
  const amountIdx = col('amount');
  const debitIdx = col('debit', 'withdrawal');
  const creditIdx = col('credit', 'deposit');
  const refIdx = col('reference', 'ref', 'cheque');
  if (dateIdx < 0) throw badRequest('CSV must have a date column');
  if (amountIdx < 0 && (debitIdx < 0 || creditIdx < 0)) {
    throw badRequest('CSV must have an amount column, or debit and credit columns');
  }

  const txns: ParsedTxn[] = [];
  for (const row of rows.slice(1)) {
    if (row.every((c) => !c.trim())) continue;
    const rawDate = row[dateIdx]?.trim();
    if (!rawDate) continue;
    const date = normalizeDate(rawDate);
    let amount: string;
    if (amountIdx >= 0) {
      amount = cleanNumber(row[amountIdx]);
    } else {
      const debit = d(cleanNumber(row[debitIdx] || '0'));
      const credit = d(cleanNumber(row[creditIdx] || '0'));
      amount = credit.minus(debit).toFixed(2);
    }
    if (d(amount).isZero()) continue;
    txns.push({
      date,
      description: (descIdx >= 0 ? row[descIdx] : '').trim(),
      reference: refIdx >= 0 ? row[refIdx]?.trim() || null : null,
      amount: money(amount),
    });
  }
  return txns;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim());
}

function cleanNumber(s: string): string {
  const cleaned = (s ?? '').replace(/[",\s]/g, '').replace(/^\((.+)\)$/, '-$1');
  return cleaned || '0';
}

function normalizeDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  throw badRequest(`Unrecognized date format: ${s}`);
}

/** Minimal OFX/QFX parser: pulls STMTTRN blocks (SGML or XML flavor). */
export function parseOfxStatement(text: string): ParsedTxn[] {
  const txns: ParsedTxn[] = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi) ?? [];
  for (const block of blocks) {
    const tag = (name: string) => {
      const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
      return m ? m[1].trim() : '';
    };
    const rawDate = tag('DTPOSTED');
    const amount = tag('TRNAMT');
    if (!rawDate || !amount) continue;
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    txns.push({
      date,
      description: tag('NAME') || tag('MEMO'),
      reference: tag('CHECKNUM') || null,
      amount: money(cleanNumber(amount)),
      extId: tag('FITID') || undefined,
    });
  }
  if (!txns.length) throw badRequest('No transactions found in OFX file');
  return txns;
}

export async function importStatement(
  trx: Knex,
  opts: {
    companyId: string;
    accountId: string;
    format: 'csv' | 'ofx';
    content: string;
    filename?: string;
    userId?: string | null;
  },
): Promise<{ importId: string; imported: number; duplicates: number }> {
  const account = await trx('accounts')
    .where({ id: opts.accountId, company_id: opts.companyId })
    .first();
  if (!account) throw badRequest('Bank account not found');

  const txns =
    opts.format === 'csv' ? parseCsvStatement(opts.content) : parseOfxStatement(opts.content);

  const [imp] = await trx('bank_imports')
    .insert({
      company_id: opts.companyId,
      account_id: opts.accountId,
      filename: opts.filename ?? null,
      format: opts.format,
      line_count: txns.length,
      imported_by: opts.userId ?? null,
    })
    .returning(['id']);

  let imported = 0;
  let duplicates = 0;
  for (const t of txns) {
    const extId =
      t.extId ??
      createHash('sha256')
        .update(`${t.date}|${t.amount}|${t.description}|${t.reference ?? ''}`)
        .digest('hex')
        .slice(0, 32);
    const inserted = await trx('bank_txns')
      .insert({
        company_id: opts.companyId,
        account_id: opts.accountId,
        import_id: imp.id,
        txn_date: t.date,
        description: t.description,
        reference: t.reference ?? null,
        amount: t.amount,
        ext_id: extId,
      })
      .onConflict(['account_id', 'ext_id'])
      .ignore()
      .returning(['id']);
    if (inserted.length) imported++;
    else duplicates++;
  }
  return { importId: imp.id, imported, duplicates };
}

/**
 * Auto-matching:
 * 1. Exact ledger match — a posted journal line on this account with the same
 *    amount on the right side within ±5 days → matched.
 * 2. Bank rules — first matching active rule creates a spend/receive entry.
 * Returns per-txn outcomes.
 */
export async function autoMatch(
  trx: Knex,
  companyId: string,
  accountId: string,
  userId: string | null,
): Promise<{ matched: number; ruleCreated: number; unmatched: number }> {
  const txns = await trx('bank_txns')
    .where({ company_id: companyId, account_id: accountId, status: 'unmatched' })
    .orderBy('txn_date');
  const rules = await trx('bank_rules')
    .where({ company_id: companyId, active: true })
    .andWhere((q) => q.where({ account_id: accountId }).orWhereNull('account_id'))
    .orderBy('priority');

  let matched = 0;
  let ruleCreated = 0;
  let unmatched = 0;

  for (const txn of txns) {
    const amt = d(txn.amount);
    const side = amt.gt(0) ? 'debit' : 'credit';
    const target = amt.abs().toFixed(2);

    // already-matched entries excluded so two identical bank txns don't share one JE
    const line = await trx('journal_lines as jl')
      .join('journal_entries as je', 'je.id', 'jl.entry_id')
      .where('jl.account_id', accountId)
      .andWhere('je.status', 'posted')
      .andWhere('je.company_id', companyId)
      .andWhere(`jl.${side}`, target)
      .andWhereRaw(`je.txn_date BETWEEN ?::date - 5 AND ?::date + 5`, [txn.txn_date, txn.txn_date])
      .whereNotIn('je.id', trx('bank_txns').select('matched_entry_id').whereNotNull('matched_entry_id'))
      .select('je.id as entry_id')
      .first();

    if (line) {
      await trx('bank_txns')
        .where({ id: txn.id })
        .update({ status: 'matched', matched_entry_id: line.entry_id });
      matched++;
      continue;
    }

    const rule = rules.find((r: any) => {
      if (r.direction === 'in' && amt.lte(0)) return false;
      if (r.direction === 'out' && amt.gte(0)) return false;
      if (r.match_type === 'regex') {
        try {
          return new RegExp(r.pattern, 'i').test(txn.description);
        } catch {
          return false;
        }
      }
      return txn.description.toLowerCase().includes(r.pattern.toLowerCase());
    });

    if (rule) {
      const entryId = await createSpendReceive(trx, {
        companyId,
        accountId,
        date: txn.txn_date,
        description: txn.description || rule.name,
        amount: txn.amount,
        targetAccountId: rule.target_account_id,
        taxCodeId: rule.tax_code_id,
        contactId: rule.contact_id,
        userId,
        sourceType: 'bank_rule',
      });
      await trx('bank_txns')
        .where({ id: txn.id })
        .update({ status: 'matched', matched_entry_id: entryId });
      ruleCreated++;
      continue;
    }
    unmatched++;
  }
  return { matched, ruleCreated, unmatched };
}

/** Direct money-in/out entry from a bank line (base or account currency). */
export async function createSpendReceive(
  trx: Knex,
  opts: {
    companyId: string;
    accountId: string;
    date: string;
    description: string;
    amount: string | number; // signed: + in, − out
    targetAccountId: string;
    taxCodeId?: string | null;
    contactId?: string | null;
    userId?: string | null;
    sourceType?: string;
    exchangeRate?: string | number;
    currency?: string;
  },
): Promise<string> {
  const amt = d(opts.amount);
  if (amt.isZero()) throw badRequest('Amount cannot be zero');
  const abs = amt.abs();

  // Tax portion (receipts are inclusive) splits to the VAT account.
  let net = abs;
  let tax = d(0);
  let taxAccountId: string | null = null;
  if (opts.taxCodeId) {
    const code = await trx('tax_codes')
      .where({ id: opts.taxCodeId, company_id: opts.companyId })
      .first();
    if (code && !code.is_withholding && d(code.rate).gt(0)) {
      const r = calcLineTax(abs, code, 'inclusive');
      net = d(r.net);
      tax = d(r.tax);
      taxAccountId = amt.gt(0) ? code.sales_account_id : code.purchase_account_id;
    }
  }

  const lines = [];
  if (amt.gt(0)) {
    lines.push({ accountId: opts.accountId, debit: money(abs), description: opts.description });
    lines.push({
      accountId: opts.targetAccountId,
      credit: money(net),
      description: opts.description,
      contactId: opts.contactId ?? null,
      taxCodeId: opts.taxCodeId ?? null,
    });
    if (tax.gt(0) && taxAccountId) {
      lines.push({ accountId: taxAccountId, credit: money(tax), description: `Tax on ${opts.description}`, taxCodeId: opts.taxCodeId });
    }
  } else {
    lines.push({
      accountId: opts.targetAccountId,
      debit: money(net),
      description: opts.description,
      contactId: opts.contactId ?? null,
      taxCodeId: opts.taxCodeId ?? null,
    });
    if (tax.gt(0) && taxAccountId) {
      lines.push({ accountId: taxAccountId, debit: money(tax), description: `Tax on ${opts.description}`, taxCodeId: opts.taxCodeId });
    }
    lines.push({ accountId: opts.accountId, credit: money(abs), description: opts.description });
  }

  const je = await postEntry(trx, {
    companyId: opts.companyId,
    txnDate: opts.date,
    currency: opts.currency,
    exchangeRate: opts.exchangeRate,
    memo: opts.description,
    sourceType: opts.sourceType ?? 'bank_txn',
    userId: opts.userId,
    lines,
  });
  return je.id;
}
