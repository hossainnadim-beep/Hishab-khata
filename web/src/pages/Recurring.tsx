import { useState } from 'react';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Recurring() {
  const { data, error, loading, reload } = useFetch<any[]>(co('/sales/recurring-invoices'));
  const [creating, setCreating] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Recurring Invoices</h1>
        <div className="grow" />
        <AsyncButton className="btn secondary" onError={setActionError}
          onClick={async () => {
            const r = await api.post(co('/sales/recurring-invoices/run'), {});
            setRunResult(`Created ${r.created} invoice(s).`);
            reload();
          }}>
          Run due now
        </AsyncButton>
        <button className="btn" onClick={() => setCreating(true)}>+ New schedule</button>
      </div>
      <ErrorMsg error={error ?? actionError} />
      {runResult && <div className="success">{runResult}</div>}
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th><th>Customer</th><th>Frequency</th><th>Next run</th>
              <th>Auto-post</th><th>Active</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.customer_name}</td>
                <td>Every {r.every_n} {r.frequency === 'monthly' ? 'month(s)' : 'week(s)'}</td>
                <td>{r.next_run_date}</td>
                <td>{r.auto_post ? 'Yes' : 'Draft only'}</td>
                <td>{r.active ? 'Yes' : 'No'}</td>
                <td className="right">
                  <AsyncButton className="btn secondary sm" onError={setActionError}
                    onClick={() => api.patch(co(`/sales/recurring-invoices/${r.id}`), { active: !r.active }).then(reload)}>
                    {r.active ? 'Pause' : 'Resume'}
                  </AsyncButton>
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={7} className="muted">No recurring schedules.</td></tr>}
          </tbody>
        </table>
      )}
      {creating && <NewRecurringModal onClose={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function NewRecurringModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [frequency, setFrequency] = useState<'monthly' | 'weekly'>('monthly');
  const [everyN, setEveryN] = useState('1');
  const [nextRunDate, setNextRunDate] = useState(today());
  const [autoPost, setAutoPost] = useState(false);
  const [description, setDescription] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [accountId, setAccountId] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    await api.post(co('/sales/recurring-invoices'), {
      customerId, name, frequency, everyN: Number(everyN), nextRunDate, autoPost,
      template: {
        lines: [{ description, qty: 1, unitPrice, accountId: accountId || null, taxCodeId: taxCodeId || null }],
      },
    });
    onClose();
  }

  return (
    <Modal open title="New recurring invoice" onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Schedule name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Customer">
          <ApiSelect path={co('/contacts?kind=customer')} value={customerId} onChange={setCustomerId} />
        </Field>
      </div>
      <div className="row">
        <Field label="Repeats">
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as any)}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
          </select>
        </Field>
        <Field label="Every N"><input className="num" value={everyN} onChange={(e) => setEveryN(e.target.value)} style={{ width: 60 }} /></Field>
        <Field label="First run"><input type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} /></Field>
        <Field label="Post automatically">
          <select value={autoPost ? '1' : '0'} onChange={(e) => setAutoPost(e.target.value === '1')}>
            <option value="0">Create as draft</option>
            <option value="1">Post immediately</option>
          </select>
        </Field>
      </div>
      <h2>Invoice line</h2>
      <div className="row">
        <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Amount"><input className="num" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} /></Field>
      </div>
      <div className="row">
        <Field label="Income account">
          <ApiSelect path={co('/accounts')} value={accountId} onChange={setAccountId}
            filter={(a) => a.type === 'income'} format={(a) => `${a.code} ${a.name}`} />
        </Field>
        <Field label="Tax">
          <ApiSelect path={co('/tax-codes')} value={taxCodeId} onChange={setTaxCodeId}
            filter={(t) => !t.is_withholding} labelKey="code" placeholder="No tax" />
        </Field>
      </div>
      <AsyncButton onClick={save} onError={setError}>Create schedule</AsyncButton>
    </Modal>
  );
}
