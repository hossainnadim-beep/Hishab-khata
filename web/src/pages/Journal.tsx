import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Journal() {
  return (
    <Routes>
      <Route index element={<JournalList />} />
      <Route path=":id" element={<EntryDetail />} />
    </Routes>
  );
}

function JournalList() {
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, loading, reload } = useFetch<any[]>(
    co(`/ledger/journal?limit=100${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`),
    [from, to],
  );
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Journal</h1>
        <div className="grow" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn" onClick={() => setCreating(true)}>+ Manual journal</button>
      </div>
      <ErrorMsg error={error} />
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr><th>#</th><th>Date</th><th>Source</th><th>Memo</th><th>Currency</th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((e) => (
              <tr key={e.id} className="clickable" onClick={() => navigate(`/journal/${e.id}`)}>
                <td>{e.entry_no}</td>
                <td>{e.txn_date}</td>
                <td>{e.source_ref ?? e.source_type.replace(/_/g, ' ')}</td>
                <td>{e.memo}</td>
                <td>{e.currency}{Number(e.exchange_rate) !== 1 ? ` @ ${Number(e.exchange_rate)}` : ''}</td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={5} className="muted">No entries.</td></tr>}
          </tbody>
        </table>
      )}
      {creating && <ManualJournalModal onClose={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function EntryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: entry, error, loading, reload } = useFetch<any>(co(`/ledger/journal/${id}`));
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;
  if (!entry) return null;

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Journal entry #{entry.entry_no}</h1>
        <div className="grow" />
        {!entry.reversed_by && entry.status === 'posted' && (
          <AsyncButton className="btn danger" onError={setActionError}
            confirm="Post a reversing entry? The original stays immutable."
            onClick={() =>
              api.post(co(`/ledger/journal/${id}/reverse`), { txnDate: today() })
                .then((r) => navigate(`/journal/${r.id}`))}>
            Reverse
          </AsyncButton>
        )}
        <button className="btn secondary" onClick={() => navigate(-1)}>Back</button>
      </div>
      <ErrorMsg error={actionError} />
      <div className="card">
        <p className="muted">
          {entry.txn_date} ·{' '}
          {entry.source_route ? (
            <Link to={entry.source_route}>{entry.source_ref}</Link>
          ) : (
            entry.source_ref ?? entry.source_type.replace(/_/g, ' ')
          )}
          {' · '}{entry.currency}
          {Number(entry.exchange_rate) !== 1 && ` @ ${Number(entry.exchange_rate)}`}
          {entry.memo && ` — ${entry.memo}`}
          {entry.reverses_entry_id && (
            <> · <Link to={`/journal/${entry.reverses_entry_id}`}>reverses an earlier entry</Link></>
          )}
          {entry.reversed_by && (
            <> · <span className="badge voided">reversed by <Link to={`/journal/${entry.reversed_by.id}`}>#{entry.reversed_by.entry_no}</Link></span></>
          )}
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>Account</th><th>Description</th>
              <th className="num">Debit</th><th className="num">Credit</th>
              <th className="num">Debit (base)</th><th className="num">Credit (base)</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l: any) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/accounts/${l.account_id}/transactions`}>
                    {l.account_code} {l.account_name}
                  </Link>
                </td>
                <td>{l.description}</td>
                <td className="num">{Number(l.debit) ? fmtMoney(l.debit) : ''}</td>
                <td className="num">{Number(l.credit) ? fmtMoney(l.credit) : ''}</td>
                <td className="num">{Number(l.base_debit) ? fmtMoney(l.base_debit) : ''}</td>
                <td className="num">{Number(l.base_credit) ? fmtMoney(l.base_credit) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface JLine { accountId: string; debit: string; credit: string; description: string }

function ManualJournalModal({ onClose }: { onClose: () => void }) {
  const [txnDate, setTxnDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('1');
  const [lines, setLines] = useState<JLine[]>([
    { accountId: '', debit: '', credit: '', description: '' },
    { accountId: '', debit: '', credit: '', description: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const setLine = (i: number, patch: Partial<JLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totalDr = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const totalCr = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);

  async function save() {
    await api.post(co('/ledger/journal'), {
      txnDate,
      memo: memo || undefined,
      currency: currency || undefined,
      exchangeRate: currency ? rate : undefined,
      lines: lines
        .filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)))
        .map((l) => ({
          accountId: l.accountId,
          debit: l.debit || undefined,
          credit: l.credit || undefined,
          description: l.description || undefined,
        })),
    });
    onClose();
  }

  return (
    <Modal open title="Manual journal entry" onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Date"><input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} /></Field>
        <Field label="Memo"><input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        <Field label="Currency (blank = base)">
          <input value={currency} maxLength={3} style={{ width: 64 }}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
        {currency && (
          <Field label="Rate"><input className="num" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 90 }} /></Field>
        )}
      </div>
      <table className="grid doc-lines">
        <thead>
          <tr><th>Account</th><th>Description</th><th style={{ width: 100 }}>Debit</th><th style={{ width: 100 }}>Credit</th><th style={{ width: 30 }} /></tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <ApiSelect path={co('/accounts')} value={l.accountId} onChange={(v) => setLine(i, { accountId: v })}
                  format={(a) => `${a.code} ${a.name}`} />
              </td>
              <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input className="num" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} /></td>
              <td><input className="num" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} /></td>
              <td><button className="btn secondary sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <button className="btn secondary sm" onClick={() => setLines((ls) => [...ls, { accountId: '', debit: '', credit: '', description: '' }])}>
          + Line
        </button>
        <span style={{ color: totalDr === totalCr ? 'green' : 'var(--danger)' }}>
          Dr {fmtMoney(totalDr)} / Cr {fmtMoney(totalCr)}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <AsyncButton onClick={save} onError={setError}>Post entry</AsyncButton>
      </div>
    </Modal>
  );
}
