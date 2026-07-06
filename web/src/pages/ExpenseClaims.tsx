import { useState } from 'react';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, Badge, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function ExpenseClaims() {
  const { data, error, loading, reload } = useFetch<any[]>(co('/purchases/expense-claims'));
  const [creating, setCreating] = useState(false);
  const [reimbursing, setReimbursing] = useState<any | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Expense Claims</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setCreating(true)}>+ New claim</button>
      </div>
      <ErrorMsg error={error ?? actionError} />
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr><th>Number</th><th>Claimant</th><th>Date</th><th className="num">Total</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.doc_no}</td><td>{c.claimant}</td><td>{c.claim_date}</td>
                <td className="num">{fmtMoney(c.total)}</td>
                <td><Badge status={c.status} /></td>
                <td className="right">
                  {c.status === 'draft' && (
                    <AsyncButton className="btn sm" onError={setActionError}
                      onClick={() => api.post(co(`/purchases/expense-claims/${c.id}/approve`)).then(reload)}>
                      Approve
                    </AsyncButton>
                  )}
                  {c.status === 'approved' && (
                    <button className="btn sm" onClick={() => setReimbursing(c)}>Reimburse</button>
                  )}
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={6} className="muted">No claims yet.</td></tr>}
          </tbody>
        </table>
      )}
      {creating && <NewClaimModal onClose={() => { setCreating(false); reload(); }} />}
      {reimbursing && <ReimburseModal claim={reimbursing} onClose={() => { setReimbursing(null); reload(); }} />}
    </div>
  );
}

interface ClaimLine { expenseDate: string; accountId: string; description: string; amount: string; taxCodeId: string }
const emptyLine = (): ClaimLine => ({ expenseDate: today(), accountId: '', description: '', amount: '', taxCodeId: '' });

function NewClaimModal({ onClose }: { onClose: () => void }) {
  const [claimant, setClaimant] = useState('');
  const [lines, setLines] = useState<ClaimLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const setLine = (i: number, patch: Partial<ClaimLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    await api.post(co('/purchases/expense-claims'), {
      claimant,
      claimDate: today(),
      lines: lines
        .filter((l) => l.accountId && Number(l.amount) > 0)
        .map((l) => ({
          expenseDate: l.expenseDate,
          accountId: l.accountId,
          description: l.description || null,
          amount: l.amount,
          taxCodeId: l.taxCodeId || null,
        })),
    });
    onClose();
  }

  return (
    <Modal open title="New expense claim" onClose={onClose}>
      <ErrorMsg error={error} />
      <Field label="Claimant (employee name)">
        <input value={claimant} onChange={(e) => setClaimant(e.target.value)} />
      </Field>
      {lines.map((l, i) => (
        <div className="row" key={i}>
          <Field label="Date"><input type="date" value={l.expenseDate} onChange={(e) => setLine(i, { expenseDate: e.target.value })} /></Field>
          <Field label="Expense account">
            <ApiSelect path={co('/accounts')} value={l.accountId} onChange={(v) => setLine(i, { accountId: v })}
              filter={(a) => a.type === 'expense'} format={(a) => `${a.code} ${a.name}`} />
          </Field>
          <Field label="Description"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
          <Field label="Amount (incl. tax)"><input className="num" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} style={{ width: 90 }} /></Field>
          <Field label="Tax">
            <ApiSelect path={co('/tax-codes')} value={l.taxCodeId} onChange={(v) => setLine(i, { taxCodeId: v })}
              filter={(t) => !t.is_withholding} labelKey="code" placeholder="None" />
          </Field>
        </div>
      ))}
      <button className="btn secondary sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Add line</button>
      <div style={{ marginTop: 12 }}>
        <AsyncButton onClick={save} onError={setError}>Save claim</AsyncButton>
      </div>
    </Modal>
  );
}

function ReimburseModal({ claim, onClose }: { claim: any; onClose: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open title={`Reimburse ${claim.claimant} — ${fmtMoney(claim.total)}`} onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Pay from">
          <ApiSelect path={co('/accounts')} value={accountId} onChange={setAccountId}
            filter={(a) => ['bank', 'cash'].includes(a.subtype)} format={(a) => `${a.code} ${a.name}`} />
        </Field>
      </div>
      <AsyncButton onError={setError}
        onClick={() =>
          api.post(co(`/purchases/expense-claims/${claim.id}/reimburse`), {
            paymentDate: date,
            paymentAccountId: accountId,
          }).then(onClose)}>
        Record reimbursement
      </AsyncButton>
    </Modal>
  );
}
