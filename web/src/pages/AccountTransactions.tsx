import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { co, fmtMoney } from '../api';
import { EmptyState, ErrorMsg, Spinner, useFetch } from '../components';

/** Drill-down target: one account's ledger with running balance and source links. */
export default function AccountTransactions() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');

  const qs = new URLSearchParams();
  if (params.get('from')) qs.set('from', params.get('from')!);
  if (params.get('to')) qs.set('to', params.get('to')!);
  const { data, error, loading } = useFetch<any>(
    co(`/ledger/account-transactions/${id}?${qs}`),
  );

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>
          {data ? `${data.account.code} — ${data.account.name}` : 'Account transactions'}
        </h1>
        <div className="grow" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <button
          className="btn secondary"
          onClick={() => {
            const next = new URLSearchParams();
            if (from) next.set('from', from);
            if (to) next.set('to', to);
            setParams(next);
          }}
        >
          Apply
        </button>
      </div>
      <ErrorMsg error={error} />
      {loading ? (
        <Spinner />
      ) : !data ? null : (
        <div className="card">
          <p className="muted">
            {params.get('from') ? `Opening balance ${fmtMoney(data.opening)} · ` : ''}
            Closing balance <strong>{fmtMoney(data.closing)}</strong> · every line links to its
            journal entry and source document
          </p>
          {!data.rows.length ? (
            <EmptyState message="No transactions on this account in the selected period." />
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Date</th><th>Entry</th><th>Source</th><th>Description</th>
                  <th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.date}</td>
                    <td><Link to={`/journal/${r.entryId}`}>#{r.entryNo}</Link></td>
                    <td>
                      {r.sourceRoute ? <Link to={r.sourceRoute}>{r.source}</Link> : r.source}
                    </td>
                    <td>{r.description}</td>
                    <td className="num">{fmtMoney(r.debit)}</td>
                    <td className="num">{fmtMoney(r.credit)}</td>
                    <td className="num">{fmtMoney(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
