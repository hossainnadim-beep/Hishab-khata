import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calcLineTax, calcWithholding } from '../src/modules/tax/calc.ts';
import { d } from '../src/lib/money.ts';

const vat15 = { id: 't', rate: '15.0000', is_withholding: false };
const ait5 = { id: 't2', rate: '5.0000', is_withholding: true };

describe('tax calculation', () => {
  it('exclusive: 15% on 1000 is 150', () => {
    expect(calcLineTax('1000', vat15, 'exclusive')).toEqual({ net: '1000.00', tax: '150.00' });
  });

  it('inclusive: backs 15% out of 1150 giving net 1000', () => {
    expect(calcLineTax('1150', vat15, 'inclusive')).toEqual({ net: '1000.00', tax: '150.00' });
  });

  it('no_tax and withholding codes contribute zero document tax', () => {
    expect(calcLineTax('1000', vat15, 'no_tax').tax).toBe('0.00');
    expect(calcLineTax('1000', ait5, 'exclusive').tax).toBe('0.00');
  });

  it('withholding: 5% AIT on 20000 is 1000', () => {
    expect(calcWithholding('20000', ait5)).toBe('1000.00');
  });

  it('property: inclusive net + tax always reassembles the gross to the penny', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000_00 }).map((c) => (c / 100).toFixed(2)),
        fc.integer({ min: 0, max: 3000 }).map((bp) => (bp / 100).toFixed(2)), // 0..30%
        (gross, rate) => {
          const { net, tax } = calcLineTax(gross, { id: 'x', rate, is_withholding: false }, 'inclusive');
          expect(d(net).plus(tax).toFixed(2)).toBe(d(gross).toFixed(2));
        },
      ),
      { numRuns: 200 },
    );
  });
});
