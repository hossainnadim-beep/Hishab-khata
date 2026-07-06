import { d, money, Decimal } from '../../lib/money.ts';

export type AmountsAre = 'exclusive' | 'inclusive' | 'no_tax';

export interface TaxCode {
  id: string;
  rate: string; // numeric percent as string
  is_withholding: boolean;
}

/**
 * Computes net + tax for one document line.
 * - exclusive: tax = amount × rate%
 * - inclusive: tax is backed out of the amount (amount × r / (100 + r))
 * - Withholding codes never change document totals; they are applied at
 *   payment time, so here they contribute zero tax.
 */
export function calcLineTax(
  amount: string | number | Decimal,
  taxCode: TaxCode | null | undefined,
  amountsAre: AmountsAre,
): { net: string; tax: string } {
  const amt = d(amount);
  if (!taxCode || amountsAre === 'no_tax' || taxCode.is_withholding) {
    return { net: money(amt), tax: '0.00' };
  }
  const rate = d(taxCode.rate);
  if (rate.isZero()) return { net: money(amt), tax: '0.00' };

  if (amountsAre === 'inclusive') {
    // Round the tax first, then derive net from the rounded tax so
    // net + tax always reassembles the gross exactly.
    const tax = money(amt.times(rate).div(rate.plus(100)));
    return { net: money(amt.minus(tax)), tax };
  }
  return { net: money(amt), tax: money(amt.times(rate).div(100)) };
}

/** Withholding amount deducted at source from a payment against `baseAmount`. */
export function calcWithholding(
  baseAmount: string | number | Decimal,
  taxCode: TaxCode,
): string {
  return money(d(baseAmount).times(d(taxCode.rate)).div(100));
}
