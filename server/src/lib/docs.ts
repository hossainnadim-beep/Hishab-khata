import type { Knex } from 'knex';
import { d, money, Decimal } from './money.ts';
import { calcLineTax, type AmountsAre } from '../modules/tax/calc.ts';

const PREFIXES: Record<string, string> = {
  invoice: 'INV-',
  quote: 'QUO-',
  credit_note: 'CN-',
  bill: 'BILL-',
  vendor_credit: 'VCR-',
  payment_receive: 'RCPT-',
  payment_pay: 'PAY-',
  expense_claim: 'EXP-',
};

export async function nextDocNo(trx: Knex, companyId: string, docType: string): Promise<string> {
  const [row] = await trx('doc_sequences')
    .insert({ company_id: companyId, doc_type: docType, next_no: 2 })
    .onConflict(['company_id', 'doc_type'])
    .merge({ next_no: trx.raw('doc_sequences.next_no + 1') })
    .returning(['next_no']);
  const n = Number(row.next_no) - 1;
  return `${PREFIXES[docType] ?? ''}${String(n).padStart(4, '0')}`;
}

export interface DocLineInput {
  itemId?: string | null;
  description?: string | null;
  qty?: string | number;
  unitPrice?: string | number;
  discountPct?: string | number;
  accountId?: string | null;
  taxCodeId?: string | null;
}

export interface ComputedLine {
  line_no: number;
  item_id: string | null;
  description: string | null;
  qty: string;
  unit_price: string;
  discount_pct: string;
  account_id: string | null;
  tax_code_id: string | null;
  net_amount: string;
  tax_amount: string;
}

export interface DocTotals {
  lines: ComputedLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  /** tax grouped by (tax_code_id, side account) for JE building */
  taxByCode: Map<string, Decimal>;
}

/**
 * Computes per-line net/tax and document totals from qty × unit price with
 * line discount, honoring exclusive/inclusive/no_tax pricing.
 */
export async function computeDocTotals(
  trx: Knex,
  companyId: string,
  lines: DocLineInput[],
  amountsAre: AmountsAre,
  opts: { discountAllowed?: boolean } = {},
): Promise<DocTotals> {
  const taxCodeIds = [...new Set(lines.map((l) => l.taxCodeId).filter(Boolean))] as string[];
  const taxCodes = taxCodeIds.length
    ? await trx('tax_codes').whereIn('id', taxCodeIds).andWhere({ company_id: companyId })
    : [];
  const byId = new Map(taxCodes.map((t: any) => [t.id, t]));

  const computed: ComputedLine[] = [];
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  const taxByCode = new Map<string, Decimal>();

  lines.forEach((l, i) => {
    const qty = d(l.qty ?? 1);
    const price = d(l.unitPrice ?? 0);
    const disc = opts.discountAllowed === false ? d(0) : d(l.discountPct ?? 0);
    const gross = qty.times(price).times(d(100).minus(disc).div(100));
    const taxCode = l.taxCodeId ? byId.get(l.taxCodeId) : null;
    if (l.taxCodeId && !taxCode) throw new Error('Unknown tax code on line');
    const { net, tax } = calcLineTax(gross, taxCode ?? null, amountsAre);
    subtotal = subtotal.plus(net);
    taxTotal = taxTotal.plus(tax);
    if (taxCode && d(tax).gt(0)) {
      taxByCode.set(taxCode.id, (taxByCode.get(taxCode.id) ?? new Decimal(0)).plus(tax));
    }
    computed.push({
      line_no: i + 1,
      item_id: l.itemId ?? null,
      description: l.description ?? null,
      qty: qty.toFixed(4),
      unit_price: price.toFixed(6),
      discount_pct: disc.toFixed(2),
      account_id: l.accountId ?? null,
      tax_code_id: l.taxCodeId ?? null,
      net_amount: money(net),
      tax_amount: money(tax),
    });
  });

  return {
    lines: computed,
    subtotal: money(subtotal),
    taxTotal: money(taxTotal),
    total: money(subtotal.plus(taxTotal)),
    taxByCode,
  };
}
