# Lessons from bugs caught during the build

One-line: rounding, SQL date-guards, and React stale-data races were the real bug sources.

- **Inclusive tax rounding**: round the TAX first, derive net = gross − rounded
  tax. Rounding net and tax independently can reassemble to gross ± 0.01.
  Caught by a fast-check property (net + tax === gross), which was flaky until
  fixed — flaky property tests are signal, not noise.
- **Nullable SQL date filters**: `(?::date is null OR txn_date < ?)` with a null
  `from` made "opening" match every row while "movement" matched them again —
  double-counted balances. Guard must be `? is not null AND txn_date < ?`.
  Caught because report tests asserted exact figures, not just "balanced".
- **React stale-data crash**: a shared `useFetch(path)` returns the PREVIOUS
  path's data during the render right after `path` changes (effects run after
  render). Renderers switching on report type crashed on the old shape. Fix:
  reset data synchronously in render when path changes (setState-during-render
  of the same component is legal React).
- **COGS on foreign-currency invoices**: COGS/inventory legs are base-currency;
  revenue JE is doc-currency. Post them as TWO journal entries
  (`invoice` + `invoice_cogs`) rather than mixing currencies in one.
- **Realized FX needs per-line base overrides**: AR/AP must be relieved at the
  document's historical rate while cash converts at the payment-date rate, so
  postEntry accepts baseDebit/baseCredit overrides and base-only lines
  (txn 0.00 both sides) for the FX gain/loss leg. The DB CHECK allows a line
  when txn+base amounts sum > 0.
- **bill_lines/vendor_credit_lines needed discount_pct** because the shared
  computeDocTotals emits it — when adding a column to one doc-lines table,
  check all siblings that share the line math.
