import { useState } from 'react';
import { co, fmtMoney, today } from '../api';
import { ApiSelect, ErrorMsg, Spinner, useFetch } from '../components';

const REPORTS = [
  { key: 'trial-balance', label: 'Trial Balance', params: 'asOf' },
  { key: 'profit-loss', label: 'Profit & Loss', params: 'period' },
  { key: 'balance-sheet', label: 'Balance Sheet', params: 'asOf' },
  { key: 'cash-flow', label: 'Cash Flow', params: 'period' },
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
  const [customerId, setCustomerId] = useState('');

  let query = '';
  if (report.params === 'period' || report.params === 'statement') {
    query = `?from=${from}&to=${to}${compare ? `&compare=${compare}` : ''}`;
  } else if (report.params === 'asOf') {
    query = `?as_of=${asOf}`;
  } else {
    query = '?';
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
          <a key={r.key} href="#" className={r.key === report.key ? 'active' : ''}
            onClick={(e) => { e.preventDefault(); setReport(r); }}>
            {r.label}
          </a>
        ))}
      </div>
      <div className="toolbar">
        {(report.params === 'period' || report.params === 'statement') && (
          <>
            <label className="muted">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label className="muted">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            {report.params === 'period' && ['profit-loss'].includes(report.key) && (
              <select value={compare} onChange={(e) => setCompare(e.target.value)}>
                <option value="">No comparison</option>
                <option value="previous_period">vs previous period</option>
                <option value="previous_year">vs previous year</option>
              </select>
            )}
          </>
        )}
        {report.params === 'asOf' && (
          <>
            <label className="muted">As of</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </>
        )}
        {report.params === 'statement' && (
          <ApiSelect path={co('/contacts?kind=customer')} value={customerId} onChange={setCustomerId}
            placeholder="— choose customer —" />
        )}
        <div className="grow" />
        <button className="btn secondary" onClick={() => download('xlsx')}>Export XLSX</button>
        <button className="btn secondary" onClick={() => download('pdf')}>Export PDF</button>
      </div>
      <ErrorMsg error={error} />
      {loading && path ? <Spinner /> : data && <ReportBody report={report.key} data={data} />}
    </div>
  );
}

function Rows({ rows, cols, numFrom = 1 }: { rows: any[][]; cols: string[]; numFrom?: number }) {
  return (
    <table className="grid">
      <thead>
        <tr>{cols.map((c, i) => <th key={i} className={i >= numFrom ? 'num' : ''}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => <td key={j} className={j >= numFrom ? 'num' : ''}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportBody({ report, data }: { report: string; data: any }) {
  const m = fmtMoney;
  switch (report) {
    case 'trial-balance':
      return (
        <>
          <Rows cols={['Code', 'Account', 'Debit', 'Credit']} numFrom={2}
            rows={[...data.rows.map((r: any) => [r.code, r.account, m(r.debit), m(r.credit)]),
              ['', 'TOTAL', m(data.totals.debit), m(data.totals.credit)]]} />
          <p className={data.balanced ? 'success' : 'error'} style={{ marginTop: 10 }}>
            {data.balanced ? '✓ Trial balance is balanced.' : '✗ OUT OF BALANCE'}
          </p>
        </>
      );
    case 'profit-loss': {
      const hasCmp = !!data.comparePeriod;
      const cols = ['Account', 'Amount', ...(hasCmp ? ['Comparative'] : [])];
      const section = (label: string, s: any) => [
        ...s.rows.map((r: any) => [r.account, m(r.amount), ...(hasCmp ? [m(r.compare)] : [])]),
        [`Total ${label}`, m(s.total), ...(hasCmp ? [m(s.compareTotal)] : [])],
      ];
      return (
        <>
          <h2>Income</h2>
          <Rows cols={cols} rows={section('Income', data.income)} />
          <h2>Expenses</h2>
          <Rows cols={cols} rows={section('Expenses', data.expenses)} />
          <h2>Net Income: {m(data.netIncome)}{hasCmp ? ` (comparative ${m(data.compareNetIncome)})` : ''}</h2>
        </>
      );
    }
    case 'balance-sheet':
      return (
        <>
          {(['assets', 'liabilities', 'equity'] as const).map((k) => (
            <div className="report-section" key={k}>
              <h2 style={{ textTransform: 'capitalize' }}>{k}</h2>
              <Rows cols={['Account', 'Amount']}
                rows={[...data[k].rows.map((r: any) => [r.account, m(r.amount)]), [`Total ${k}`, m(data[k].total)]]} />
            </div>
          ))}
          <p className={data.balanced ? 'success' : 'error'}>
            Assets {m(data.assets.total)} = Liabilities + Equity {m(data.totalLiabilitiesAndEquity)}
            {data.balanced ? ' ✓' : ' ✗ OUT OF BALANCE'}
          </p>
        </>
      );
    case 'cash-flow':
      return (
        <>
          <h2>Operating</h2>
          <Rows cols={['Item', 'Amount']} rows={[
            ['Net income', m(data.operating.netIncome)],
            ...data.operating.adjustments.map((r: any) => [r.label, m(r.amount)]),
            ['Net cash from operating', m(data.operating.total)],
          ]} />
          <h2>Investing</h2>
          <Rows cols={['Item', 'Amount']} rows={[
            ...data.investing.rows.map((r: any) => [r.label, m(r.amount)]),
            ['Net cash from investing', m(data.investing.total)],
          ]} />
          <h2>Financing</h2>
          <Rows cols={['Item', 'Amount']} rows={[
            ...data.financing.rows.map((r: any) => [r.label, m(r.amount)]),
            ['Net cash from financing', m(data.financing.total)],
          ]} />
          <Rows cols={['', '']} rows={[
            ['Net change in cash', m(data.netChange)],
            ['Opening cash', m(data.openingCash)],
            ['Closing cash', m(data.closingCash)],
          ]} />
          {!data.reconciles && <p className="error">✗ Does not reconcile to cash movement</p>}
        </>
      );
    case 'general-ledger':
      return (
        <>
          {data.sections.map((s: any) => (
            <div className="report-section" key={s.accountCode}>
              <h2>{s.accountCode} — {s.accountName} <span className="muted">(opening {m(s.opening)})</span></h2>
              <Rows cols={['Date', 'Entry', 'Description', 'Debit', 'Credit', 'Balance']} numFrom={3}
                rows={[...s.rows.map((r: any) => [r.date, `#${r.entryNo}`, r.description, m(r.debit), m(r.credit), m(r.balance)]),
                  ['', '', 'Closing', '', '', m(s.closing)]]} />
            </div>
          ))}
        </>
      );
    case 'ar-aging':
    case 'ap-aging':
      return (
        <Rows cols={['Contact', ...data.buckets, 'Total']}
          rows={[...data.rows.map((r: any) => [r.contact, ...data.buckets.map((b: string) => m(r[b])), m(r.total)]),
            ['TOTAL', ...data.buckets.map((b: string) => m(data.totals[b])), m(data.totals.total)]]} />
      );
    case 'tax-summary':
      return (
        <>
          <Rows cols={['Code', 'Name', 'Rate %', 'Category', 'Amount', 'Direction']} numFrom={4}
            rows={data.rows.map((r: any) => [r.code, r.name, r.rate, r.category, m(r.amount), r.direction])} />
          <h2>Summary</h2>
          <Rows cols={['Item', 'Amount']} rows={[
            ['Output VAT (on sales)', m(data.summary.outputVat)],
            ['Input VAT (rebatable)', m(data.summary.inputVat)],
            ['Net VAT payable', m(data.summary.netVatPayable)],
            ['VDS withheld (payable to NBR)', m(data.summary.vdsPayable)],
            ['AIT net', m(data.summary.aitNet)],
          ]} />
        </>
      );
    case 'stock-on-hand':
      return (
        <Rows cols={['Item', 'SKU', 'Qty', 'Avg cost', 'Value']} numFrom={2}
          rows={[...data.rows.map((r: any) => [r.name, r.sku, r.qtyOnHand, m(r.avgCost), m(r.value)]),
            ['TOTAL', '', '', '', m(data.totalValue)]]} />
      );
    case 'customer-statement':
      return (
        <>
          <h2>{data.customer.name}</h2>
          <Rows cols={['Date', 'Type', 'Description', 'Charges', 'Payments', 'Balance']} numFrom={3}
            rows={[
              ['', '', 'Opening balance', '', '', m(data.opening)],
              ...data.rows.map((r: any) => [r.date, r.type, r.description, m(r.charges), m(r.payments), m(r.balance)]),
              ['', '', 'Closing balance', '', '', m(data.closing)],
            ]} />
        </>
      );
    default:
      return <pre>{JSON.stringify(data, null, 2)}</pre>;
  }
}
