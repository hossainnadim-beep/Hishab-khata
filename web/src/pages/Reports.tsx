import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { co, fmtMoney, today } from '../api';
import { ApiSelect, ErrorMsg, Spinner, useFetch } from '../components';

const REPORTS = [
  { key: 'statement-profit-loss', label: 'Profit or Loss (IFRS)', params: 'period' },
  { key: 'statement-financial-position', label: 'Financial Position (IFRS)', params: 'asOfCompare' },
  { key: 'statement-changes-equity', label: 'Changes in Equity (IFRS)', params: 'period' },
  { key: 'cash-flow', label: 'Cash Flows', params: 'period' },
  { key: 'trial-balance', label: 'Trial Balance', params: 'asOf' },
  { key: 'profit-loss', label: 'P&L (detail)', params: 'period' },
  { key: 'balance-sheet', label: 'Balance Sheet (detail)', params: 'asOf' },
  { key: 'general-ledger', label: 'General Ledger', params: 'period' },
  { key: 'ar-aging', label: 'AR Aging', params: 'asOf' },
  { key: 'ap-aging', label: 'AP Aging', params: 'asOf' },
  { key: 'tax-summary', label: 'VAT Summary', params: 'period' },
  { key: 'stock-on-hand', label: 'Stock on Hand', params: 'none' },
  { key: 'customer-statement', label: 'Customer Statement', params: 'statement' },
] as const;

export default function Reports() {
  const [report, setReport] = useState<(typeof REPORTS)[number]>(REPORTS[0]);
  const yearStart = today().slice(0, 4) + '-01-01';
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today());
  const [asOf, setAsOf] = useState(today());
  const [compare, setCompare] = useState('');
  const [compareAsOf, setCompareAsOf] = useState('');
  const [customerId, setCustomerId] = useState('');

  const usesPeriod = report.params === 'period' || report.params === 'statement';
  let query = '?';
  if (usesPeriod) {
    query = `?from=${from}&to=${to}${compare ? `&compare=${compare}` : ''}`;
  } else if (report.params === 'asOf' || report.params === 'asOfCompare') {
    query = `?as_of=${asOf}${compareAsOf && report.params === 'asOfCompare' ? `&compare_as_of=${compareAsOf}` : ''}`;
  }
  const path =
    report.key === 'customer-statement'
      ? customerId ? co(`/reports/customer-statement/${customerId}${query}`) : null
      : co(`/reports/${report.key}${query}`);

  const { data, error, loading } = useFetch<any>(path, [path]);

  async function download(format: 'xlsx' | 'pdf') {
    if (!path) return;
    const res = await fetch(`${path}&format=${format}`, {
      headers: { authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (format === 'pdf') window.open(url, '_blank');
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report.key}.xlsx`;
      a.click();
    }
  }

  return (
    <div>
      <h1>Reports</h1>
      <div className="tabs">
        {REPORTS.map((r) => (
          <button key={r.key} className={`tab ${r.key === report.key ? 'active' : ''}`}
            onClick={() => setReport(r)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        {usesPeriod && (
          <>
            <label className="muted">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label className="muted">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            {['profit-loss', 'statement-profit-loss'].includes(report.key) && (
              <select value={compare} onChange={(e) => setCompare(e.target.value)}>
                <option value="">No comparison</option>
                <option value="previous_period">vs previous period</option>
                <option value="previous_year">vs previous year</option>
              </select>
            )}
          </>
        )}
        {(report.params === 'asOf' || report.params === 'asOfCompare') && (
          <>
            <label className="muted">As of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            {report.params === 'asOfCompare' && (
              <>
                <label className="muted">Compare</label>
                <input type="date" value={compareAsOf} onChange={(e) => setCompareAsOf(e.target.value)} />
              </>
            )}
          </>
        )}
        {report.params === 'statement' && (
          <ApiSelect path={co('/contacts?kind=customer')} value={customerId} onChange={setCustomerId}
            placeholder="— choose customer —" />
        )}
        <div className="grow" />
        <button className="btn secondary" onClick={() => download('xlsx')}>XLSX</button>
        <button className="btn secondary" onClick={() => download('pdf')}>PDF</button>
      </div>
      <ErrorMsg error={error} />
      <p className="muted" style={{ marginTop: -6 }}>
        Every amount is clickable — drill from a statement line to the contributing transactions
        to the journal entry behind them. Figures update live as documents post.
      </p>
      {loading && path ? <Spinner /> : data && (
        <ReportBody report={report.key} data={data} from={usesPeriod ? from : undefined} to={usesPeriod ? to : asOf} />
      )}
    </div>
  );
}

/** Amount cell that drills into an account's transactions for the period. */
function Amt({ accountId, from, to, children }: { accountId?: string | null; from?: string; to?: string; children: ReactNode }) {
  if (!accountId) return <>{children}</>;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  return (
    <Link className="amount-link" to={`/accounts/${accountId}/transactions?${qs}`}>
      {children}
    </Link>
  );
}

/** Multi-account statement line: value plus account chips to drill into. */
function MultiAmt({ accounts, from, to, value }: { accounts: Array<{ id: string; code: string; name: string }>; from?: string; to?: string; value: string }) {
  if (accounts.length === 1) {
    return <Amt accountId={accounts[0].id} from={from} to={to}>{value}</Amt>;
  }
  return (
    <details style={{ display: 'inline-block' }}>
      <summary className="amount-link" style={{ listStyle: 'none', cursor: 'pointer' }}>{value}</summary>
      <div style={{ textAlign: 'right', fontSize: 12, paddingTop: 4 }}>
        {accounts.map((a) => (
          <div key={a.id}>
            <Amt accountId={a.id} from={from} to={to}>{a.code} {a.name}</Amt>
          </div>
        ))}
      </div>
    </details>
  );
}

function Grid({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="grid">
      <thead>
        <tr>{head.map((c, i) => <th key={i} className={i >= 1 ? 'num' : ''}>{c}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function ReportBody({ report, data, from, to }: { report: string; data: any; from?: string; to?: string }) {
  const m = fmtMoney;
  switch (report) {
    case 'statement-profit-loss': {
      const hasCmp = !!data.comparePeriod;
      const head = ['', 'Amount', ...(hasCmp ? ['Comparative'] : [])];
      const line = (l: any, i: number) => (
        <tr key={i}>
          <td>{l.label}</td>
          <td className="num"><MultiAmt accounts={l.accounts} from={from} to={to} value={m(l.amount)} /></td>
          {hasCmp && <td className="num">{m(l.compare)}</td>}
        </tr>
      );
      const totalRow = (label: string, v: any) => (
        <tr>
          <td className="total">{label}</td>
          <td className="num total">{m(v.amount)}</td>
          {hasCmp && <td className="num total">{m(v.compare)}</td>}
        </tr>
      );
      return (
        <Grid head={head}>
          {data.lines.map(line)}
          {totalRow('Gross profit', data.grossProfit)}
          {data.lines2.map(line)}
          {totalRow('Profit for the period', data.profitForPeriod)}
          <tr><td>Other comprehensive income</td><td className="num">{m(data.otherComprehensiveIncome.amount)}</td>{hasCmp && <td className="num">{m(data.otherComprehensiveIncome.compare)}</td>}</tr>
          {totalRow('Total comprehensive income', data.totalComprehensiveIncome)}
        </Grid>
      );
    }
    case 'statement-financial-position': {
      const hasCmp = !!data.compareAsOf;
      const head = ['', 'Amount', ...(hasCmp ? ['Comparative'] : [])];
      const section = (label: string, s: any) => (
        <>
          <tr><td colSpan={hasCmp ? 3 : 2} style={{ fontWeight: 700, background: '#fafbfa' }}>{label}</td></tr>
          {s.lines.map((l: any, i: number) => (
            <tr key={`${label}${i}`}>
              <td style={{ paddingLeft: 24 }}>{l.label}</td>
              <td className="num"><MultiAmt accounts={l.accounts} to={to} value={m(l.amount)} /></td>
              {hasCmp && <td className="num">{m(l.compare)}</td>}
            </tr>
          ))}
          <tr>
            <td className="total" style={{ paddingLeft: 24 }}>Total {label.toLowerCase()}</td>
            <td className="num total">{m(s.total)}</td>
            {hasCmp && <td className="num total">{m(s.compareTotal)}</td>}
          </tr>
        </>
      );
      return (
        <>
          <Grid head={head}>
            {section('Non-current assets', data.nonCurrentAssets)}
            {section('Current assets', data.currentAssets)}
            <tr><td className="total">TOTAL ASSETS</td><td className="num total">{m(data.totalAssets.amount)}</td>{hasCmp && <td className="num total">{m(data.totalAssets.compare)}</td>}</tr>
            {section('Equity', data.equity)}
            {section('Non-current liabilities', data.nonCurrentLiabilities)}
            {section('Current liabilities', data.currentLiabilities)}
            <tr><td className="total">TOTAL EQUITY AND LIABILITIES</td><td className="num total">{m(data.totalEquityAndLiabilities.amount)}</td>{hasCmp && <td className="num total">{m(data.totalEquityAndLiabilities.compare)}</td>}</tr>
          </Grid>
          <p className={data.balanced ? 'success' : 'error'} style={{ marginTop: 10 }}>
            {data.balanced ? '✓ Statement balances and ties to the trial balance.' : '✗ OUT OF BALANCE'}
          </p>
        </>
      );
    }
    case 'statement-changes-equity':
      return (
        <Grid head={['', ...data.columns.map((c: any) => c.label), 'Total']}>
          {data.rows.map((r: any, i: number) => (
            <tr key={i}>
              <td className={i === 0 || i === data.rows.length - 1 ? 'total' : ''}>{r.label}</td>
              {r.cells.map((cell: string, j: number) => (
                <td key={j} className={`num ${i === data.rows.length - 1 ? 'total' : ''}`}>
                  {data.columns[j].id !== 'retained' ? (
                    <Amt accountId={data.columns[j].id} from={from} to={to}>{m(cell)}</Amt>
                  ) : (
                    m(cell)
                  )}
                </td>
              ))}
              <td className={`num ${i === data.rows.length - 1 ? 'total' : ''}`}>{m(r.total)}</td>
            </tr>
          ))}
        </Grid>
      );
    case 'trial-balance':
      return (
        <>
          <Grid head={['Code', 'Account', 'Debit', 'Credit']}>
            {data.rows.map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.code}</td>
                <td><Amt accountId={r.accountId} to={to}>{r.account}</Amt></td>
                <td className="num"><Amt accountId={r.accountId} to={to}>{m(r.debit)}</Amt></td>
                <td className="num"><Amt accountId={r.accountId} to={to}>{m(r.credit)}</Amt></td>
              </tr>
            ))}
            <tr><td /><td className="total">TOTAL</td><td className="num total">{m(data.totals.debit)}</td><td className="num total">{m(data.totals.credit)}</td></tr>
          </Grid>
          <p className={data.balanced ? 'success' : 'error'} style={{ marginTop: 10 }}>
            {data.balanced ? '✓ Trial balance is balanced.' : '✗ OUT OF BALANCE'}
          </p>
        </>
      );
    case 'profit-loss': {
      const hasCmp = !!data.comparePeriod;
      const head = ['Account', 'Amount', ...(hasCmp ? ['Comparative'] : [])];
      const section = (label: string, s: any) => (
        <>
          {s.rows.map((r: any, i: number) => (
            <tr key={`${label}${i}`}>
              <td>{r.account}</td>
              <td className="num"><Amt accountId={r.accountId} from={from} to={to}>{m(r.amount)}</Amt></td>
              {hasCmp && <td className="num">{m(r.compare)}</td>}
            </tr>
          ))}
          <tr><td className="total">Total {label}</td><td className="num total">{m(s.total)}</td>{hasCmp && <td className="num total">{m(s.compareTotal)}</td>}</tr>
        </>
      );
      return (
        <Grid head={head}>
          {section('Income', data.income)}
          {section('Expenses', data.expenses)}
          <tr><td className="total">Net Income</td><td className="num total">{m(data.netIncome)}</td>{hasCmp && <td className="num total">{m(data.compareNetIncome)}</td>}</tr>
        </Grid>
      );
    }
    case 'balance-sheet':
      return (
        <>
          {(['assets', 'liabilities', 'equity'] as const).map((k) => (
            <div className="report-section" key={k}>
              <h2 style={{ textTransform: 'capitalize' }}>{k}</h2>
              <Grid head={['Account', 'Amount']}>
                {data[k].rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.account}</td>
                    <td className="num"><Amt accountId={r.accountId} to={to}>{m(r.amount)}</Amt></td>
                  </tr>
                ))}
                <tr><td className="total">Total {k}</td><td className="num total">{m(data[k].total)}</td></tr>
              </Grid>
            </div>
          ))}
          <p className={data.balanced ? 'success' : 'error'}>
            Assets {m(data.assets.total)} = Liabilities + Equity {m(data.totalLiabilitiesAndEquity)}
            {data.balanced ? ' ✓' : ' ✗ OUT OF BALANCE'}
          </p>
        </>
      );
    case 'cash-flow': {
      const cfRow = (r: any, i: number) => (
        <tr key={i}>
          <td>{r.label}</td>
          <td className="num"><Amt accountId={r.accountId} from={from} to={to}>{m(r.amount)}</Amt></td>
        </tr>
      );
      return (
        <>
          <h2>Operating activities</h2>
          <Grid head={['Item', 'Amount']}>
            <tr><td>Net income</td><td className="num">{m(data.operating.netIncome)}</td></tr>
            {data.operating.adjustments.map(cfRow)}
            <tr><td className="total">Net cash from operating</td><td className="num total">{m(data.operating.total)}</td></tr>
          </Grid>
          <h2>Investing activities</h2>
          <Grid head={['Item', 'Amount']}>
            {data.investing.rows.map(cfRow)}
            <tr><td className="total">Net cash from investing</td><td className="num total">{m(data.investing.total)}</td></tr>
          </Grid>
          <h2>Financing activities</h2>
          <Grid head={['Item', 'Amount']}>
            {data.financing.rows.map(cfRow)}
            <tr><td className="total">Net cash from financing</td><td className="num total">{m(data.financing.total)}</td></tr>
          </Grid>
          <Grid head={['', '']}>
            <tr><td>Net change in cash</td><td className="num">{m(data.netChange)}</td></tr>
            <tr><td>Opening cash</td><td className="num">{m(data.openingCash)}</td></tr>
            <tr><td className="total">Closing cash</td><td className="num total">{m(data.closingCash)}</td></tr>
          </Grid>
          {!data.reconciles && <p className="error">✗ Does not reconcile to cash movement</p>}
        </>
      );
    }
    case 'general-ledger':
      return (
        <>
          {data.sections.map((s: any) => (
            <div className="report-section" key={s.accountCode}>
              <h2>
                <Link to={`/accounts/${s.accountId}/transactions?from=${from}&to=${to}`}>
                  {s.accountCode} — {s.accountName}
                </Link>{' '}
                <span className="muted">(opening {m(s.opening)})</span>
              </h2>
              <Grid head={['Date', 'Entry', 'Description', 'Debit', 'Credit', 'Balance']}>
                {s.rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.date}</td>
                    <td><Link to={`/journal/${r.entryId}`}>#{r.entryNo}</Link></td>
                    <td>{r.description}</td>
                    <td className="num">{m(r.debit)}</td>
                    <td className="num">{m(r.credit)}</td>
                    <td className="num">{m(r.balance)}</td>
                  </tr>
                ))}
                <tr><td colSpan={3} className="total">Closing</td><td /><td /><td className="num total">{m(s.closing)}</td></tr>
              </Grid>
            </div>
          ))}
        </>
      );
    case 'ar-aging':
    case 'ap-aging': {
      const listRoute = report === 'ar-aging' ? '/invoices' : '/bills';
      return (
        <Grid head={['Contact', ...data.buckets, 'Total']}>
          {data.rows.map((r: any, i: number) => (
            <tr key={i}>
              <td><Link to={listRoute}>{r.contact}</Link></td>
              {data.buckets.map((b: string) => <td key={b} className="num">{m(r[b])}</td>)}
              <td className="num">{m(r.total)}</td>
            </tr>
          ))}
          <tr>
            <td className="total">TOTAL</td>
            {data.buckets.map((b: string) => <td key={b} className="num total">{m(data.totals[b])}</td>)}
            <td className="num total">{m(data.totals.total)}</td>
          </tr>
        </Grid>
      );
    }
    case 'tax-summary':
      return (
        <>
          <Grid head={['Code', 'Name', 'Rate %', 'Category', 'Amount', 'Direction']}>
            {data.rows.map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.code}</td><td>{r.name}</td>
                <td className="num">{r.rate}</td><td>{r.category}</td>
                <td className="num"><Amt accountId={r.accountId} from={from} to={to}>{m(r.amount)}</Amt></td>
                <td>{r.direction}</td>
              </tr>
            ))}
          </Grid>
          <h2>Summary</h2>
          <Grid head={['Item', 'Amount']}>
            <tr><td>Output VAT (on sales)</td><td className="num">{m(data.summary.outputVat)}</td></tr>
            <tr><td>Input VAT (rebatable)</td><td className="num">{m(data.summary.inputVat)}</td></tr>
            <tr><td className="total">Net VAT payable</td><td className="num total">{m(data.summary.netVatPayable)}</td></tr>
            <tr><td>VDS withheld (payable to NBR)</td><td className="num">{m(data.summary.vdsPayable)}</td></tr>
            <tr><td>AIT net</td><td className="num">{m(data.summary.aitNet)}</td></tr>
          </Grid>
        </>
      );
    case 'stock-on-hand':
      return (
        <Grid head={['Item', 'SKU', 'Qty', 'Avg cost', 'Value']}>
          {data.rows.map((r: any, i: number) => (
            <tr key={i}>
              <td><Link to="/items">{r.name}</Link></td><td>{r.sku}</td>
              <td className="num">{r.qtyOnHand}</td>
              <td className="num">{m(r.avgCost)}</td>
              <td className="num">{m(r.value)}</td>
            </tr>
          ))}
          <tr><td className="total">TOTAL</td><td /><td /><td /><td className="num total">{m(data.totalValue)}</td></tr>
        </Grid>
      );
    case 'customer-statement':
      return (
        <>
          <h2>{data.customer.name}</h2>
          <Grid head={['Date', 'Type', 'Description', 'Charges', 'Payments', 'Balance']}>
            <tr><td /><td /><td>Opening balance</td><td /><td /><td className="num">{m(data.opening)}</td></tr>
            {data.rows.map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.date}</td>
                <td>{r.entryId ? <Link to={`/journal/${r.entryId}`}>{r.type}</Link> : r.type}</td>
                <td>{r.description}</td>
                <td className="num">{m(r.charges)}</td>
                <td className="num">{m(r.payments)}</td>
                <td className="num">{m(r.balance)}</td>
              </tr>
            ))}
            <tr><td /><td /><td className="total">Closing balance</td><td /><td /><td className="num total">{m(data.closing)}</td></tr>
          </Grid>
        </>
      );
    default:
      return <pre>{JSON.stringify(data, null, 2)}</pre>;
  }
}
