import { useState } from 'react';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, Badge, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Banking() {
  const { data: accounts, error, loading, reload } = useFetch<any[]>(co('/banking/accounts'));
  const [selected, setSelected] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const account = (accounts ?? []).find((a) => a.id === selected);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Banking</h1>
        <div className="grow" />
        {selected && (
          <>
            <button className="btn secondary" onClick={() => setImporting(true)}>Import statement</button>
            <AsyncButton className="btn secondary" onError={setActionError}
              onClick={async () => {
                const r = await api.post(co('/banking/txns/auto-match'), { accountId: selected });
                setMsg(`Auto-match: ${r.matched} matched to existing entries, ${r.ruleCreated} created by rules, ${r.unmatched} left.`);
                reload();
              }}>
              Auto-match
            </AsyncButton>
            <button className="btn secondary" onClick={() => setReconciling(true)}>Reconcile</button>
          </>
        )}
      </div>
      <ErrorMsg error={error ?? actionError} />
      {msg && <div className="success">{msg}</div>}
      {loading ? <Spinner /> : (
        <div className="kpis">
          {(accounts ?? []).map((a) => (
            <div key={a.id} className="kpi" style={{ cursor: 'pointer', outline: selected === a.id ? '2px solid var(--brand)' : 'none' }}
              onClick={() => setSelected(a.id)}>
              <div className="label">{a.name}{a.currency ? ` (${a.currency})` : ''}</div>
              <div className="value">{fmtMoney(a.balance)}</div>
              {a.unmatched_count > 0 && <span className="badge unmatched">{a.unmatched_count} to review</span>}
            </div>
          ))}
        </div>
      )}
      {account && <TxnList accountId={account.id} key={account.id} />}
      {importing && <ImportModal accountId={selected} onClose={() => { setImporting(false); reload(); }} />}
      {reconciling && <ReconcileModal accountId={selected} onClose={() => { setReconciling(false); reload(); }} />}
      <Rules />
    </div>
  );
}

function TxnList({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState('unmatched');
  const { data, loading, reload } = useFetch<any[]>(
    co(`/banking/txns?account_id=${accountId}${status ? `&status=${status}` : ''}`), [status],
  );
  const [categorizing, setCategorizing] = useState<any | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="toolbar mb0">
        <h2 style={{ margin: 0 }}>Statement lines</h2>
        <div className="grow" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['unmatched', 'matched', 'reconciled', 'excluded'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <ErrorMsg error={actionError} />
      {loading ? <Spinner /> : (
        <table className="grid" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Date</th><th>Description</th><th>Ref</th><th className="num">Amount</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id}>
                <td>{t.txn_date}</td><td>{t.description}</td><td>{t.reference}</td>
                <td className="num" style={{ color: Number(t.amount) < 0 ? 'var(--danger)' : 'inherit' }}>
                  {fmtMoney(t.amount)}
                </td>
                <td><Badge status={t.status} /></td>
                <td className="right">
                  {t.status === 'unmatched' && (
                    <>
                      <button className="btn sm" onClick={() => setCategorizing(t)}>Categorize</button>{' '}
                      <AsyncButton className="btn secondary sm" onError={setActionError}
                        onClick={() => api.post(co(`/banking/txns/${t.id}/exclude`)).then(reload)}>
                        Exclude
                      </AsyncButton>
                    </>
                  )}
                  {['matched', 'excluded'].includes(t.status) && (
                    <AsyncButton className="btn secondary sm" onError={setActionError}
                      onClick={() => api.post(co(`/banking/txns/${t.id}/unmatch`)).then(reload)}>
                      Undo
                    </AsyncButton>
                  )}
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={6} className="muted">No lines.</td></tr>}
          </tbody>
        </table>
      )}
      {categorizing && (
        <CategorizeModal txn={categorizing} onClose={() => { setCategorizing(null); reload(); }} />
      )}
    </div>
  );
}

function CategorizeModal({ txn, onClose }: { txn: any; onClose: () => void }) {
  const isOut = Number(txn.amount) < 0;
  const [accountId, setAccountId] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [contactId, setContactId] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open title={`Categorize: ${txn.description} (${fmtMoney(txn.amount)})`} onClose={onClose}>
      <ErrorMsg error={error} />
      <Field label={isOut ? 'Spent on (account)' : 'Received as (account)'}>
        <ApiSelect path={co('/accounts')} value={accountId} onChange={setAccountId}
          filter={(a) => (isOut ? ['expense', 'asset', 'liability'].includes(a.type) : ['income', 'liability', 'equity', 'asset'].includes(a.type))}
          format={(a) => `${a.code} ${a.name}`} />
      </Field>
      <div className="row">
        <Field label="Tax (inclusive)">
          <ApiSelect path={co('/tax-codes')} value={taxCodeId} onChange={setTaxCodeId}
            filter={(t) => !t.is_withholding} labelKey="code" placeholder="No tax" />
        </Field>
        <Field label="Contact (optional)">
          <ApiSelect path={co('/contacts')} value={contactId} onChange={setContactId} placeholder="—" />
        </Field>
      </div>
      <AsyncButton onError={setError}
        onClick={() =>
          api.post(co(`/banking/txns/${txn.id}/categorize`), {
            targetAccountId: accountId,
            taxCodeId: taxCodeId || null,
            contactId: contactId || null,
          }).then(onClose)}>
        Create entry & match
      </AsyncButton>
    </Modal>
  );
}

function ImportModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'ofx'>('csv');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  return (
    <Modal open title="Import bank statement" onClose={onClose}>
      <ErrorMsg error={error} />
      {result && <div className="success">{result}</div>}
      <div className="row">
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value as any)}>
            <option value="csv">CSV</option>
            <option value="ofx">OFX / QFX</option>
          </select>
        </Field>
        <Field label="File">
          <input type="file" accept={format === 'csv' ? '.csv' : '.ofx,.qfx'}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFilename(f.name);
                setContent(await f.text());
              }
            }} />
        </Field>
      </div>
      <p className="muted">
        CSV needs a header with date, description and amount (or debit/credit) columns.
      </p>
      <AsyncButton onError={setError}
        onClick={async () => {
          const r = await api.post(co('/banking/import'), { accountId, format, content, filename });
          setResult(`Imported ${r.imported} lines (${r.duplicates} duplicates skipped).`);
        }}>
        Import
      </AsyncButton>
    </Modal>
  );
}

function ReconcileModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [statementDate, setStatementDate] = useState(today());
  const [statementBalance, setStatementBalance] = useState('');
  const [recon, setRecon] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open title="Reconcile account" onClose={onClose}>
      <ErrorMsg error={error} />
      {!recon ? (
        <>
          <div className="row">
            <Field label="Statement date">
              <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
            </Field>
            <Field label="Statement closing balance">
              <input className="num" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} />
            </Field>
          </div>
          <AsyncButton onError={setError}
            onClick={async () => {
              const r = await api.post(co('/banking/reconciliations'), { accountId, statementDate, statementBalance });
              setRecon(await api.get(co(`/banking/reconciliations/${r.id}`)));
            }}>
            Start reconciliation
          </AsyncButton>
        </>
      ) : (
        <>
          <p>
            Ledger balance to {recon.statement_date}: <strong>{fmtMoney(recon.ledger_balance)}</strong><br />
            Statement balance: <strong>{fmtMoney(recon.statement_balance)}</strong><br />
            Difference: <strong style={{ color: Number(recon.difference) === 0 ? 'green' : 'var(--danger)' }}>
              {fmtMoney(recon.difference)}
            </strong>
          </p>
          {Number(recon.difference) !== 0 && (
            <p className="muted">
              Categorize or match the remaining statement lines until the difference is zero, then complete.
            </p>
          )}
          <AsyncButton onError={setError}
            onClick={() => api.post(co(`/banking/reconciliations/${recon.id}/complete`)).then(onClose)}>
            Complete reconciliation
          </AsyncButton>
        </>
      )}
    </Modal>
  );
}

function Rules() {
  const { data, reload } = useFetch<any[]>(co('/banking/rules'));
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="toolbar mb0">
        <h2 style={{ margin: 0 }}>Bank rules</h2>
        <div className="grow" />
        <button className="btn secondary sm" onClick={() => setAdding(true)}>+ Add rule</button>
      </div>
      <ErrorMsg error={actionError} />
      <table className="grid" style={{ marginTop: 10 }}>
        <thead>
          <tr><th>Name</th><th>When description contains</th><th>Direction</th><th></th></tr>
        </thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td><td><code>{r.pattern}</code> ({r.match_type})</td><td>{r.direction}</td>
              <td className="right">
                <AsyncButton className="btn secondary sm" onError={setActionError}
                  onClick={() => api.delete(co(`/banking/rules/${r.id}`)).then(reload)}>
                  Remove
                </AsyncButton>
              </td>
            </tr>
          ))}
          {!data?.length && <tr><td colSpan={4} className="muted">No rules yet.</td></tr>}
        </tbody>
      </table>
      {adding && <NewRuleModal onClose={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function NewRuleModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [direction, setDirection] = useState<'in' | 'out' | 'any'>('any');
  const [targetAccountId, setTargetAccountId] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open title="New bank rule" onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Rule name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description contains"><input value={pattern} onChange={(e) => setPattern(e.target.value)} /></Field>
        <Field label="Direction">
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="any">Any</option><option value="out">Money out</option><option value="in">Money in</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Post to account">
          <ApiSelect path={co('/accounts')} value={targetAccountId} onChange={setTargetAccountId}
            filter={(a) => ['expense', 'income', 'asset', 'liability'].includes(a.type)}
            format={(a) => `${a.code} ${a.name}`} />
        </Field>
        <Field label="Tax (inclusive)">
          <ApiSelect path={co('/tax-codes')} value={taxCodeId} onChange={setTaxCodeId}
            filter={(t) => !t.is_withholding} labelKey="code" placeholder="No tax" />
        </Field>
      </div>
      <AsyncButton onError={setError}
        onClick={() =>
          api.post(co('/banking/rules'), {
            name, pattern, direction, targetAccountId, taxCodeId: taxCodeId || null,
          }).then(onClose)}>
        Save rule
      </AsyncButton>
    </Modal>
  );
}
