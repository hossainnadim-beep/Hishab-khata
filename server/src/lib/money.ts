import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function d(v: string | number | Decimal | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(v);
}

/** Round to 2 decimal places (money), returned as fixed string for NUMERIC columns. */
export function money(v: string | number | Decimal): string {
  return d(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function isZero(v: string | number | Decimal): boolean {
  return d(v).isZero();
}

export function sum(values: Array<string | number | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(d(v)), new Decimal(0));
}
