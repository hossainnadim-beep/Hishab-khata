import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, co, today } from '../api';
import { AsyncButton, Badge, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Settings() {
  return (
    <div>
      <h1>Settings</h1>
      <div className="tabs">
        <NavLink to="/settings/company">Company</NavLink>
        <NavLink to="/settings/accounts">Chart of Accounts</NavLink>
        <NavLink to="/settings/tax">Tax Codes</NavLink>
        <NavLink to="/settings/periods">Periods</NavLink>
        <NavLink to="/settings/members">Users</NavLink>
        <NavLink to="/settings/activity">Activity Log</NavLink>
        <NavLink to="/settings/fx">FX Revaluation</NavLink>
      </div>
      <Routes>
        <Route index element={<Navigate to="company" replace />} />
        <Route path="company" element={<CompanyTab />} />
        <Route path="accounts" element={<AccountsTab />} />
        <Route path="tax" element={<TaxTab />} />
        <Route path="periods" element={<PeriodsTab />} />
        <Route path="members" element={<MembersTab />} />
        <Route path="activity" element={<ActivityTab />} />
        <Route path="fx" element={<FxTab />} />
      </Routes>
    </div>
  );
}

function CompanyTab() {
  const { data, loading, reload } = useFetch<any>(co(''));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<any | null>(null);
  if (loading || !data) return <Spinner />;
  const f = form ?? {
    name: data.name ?? '', legalName: data.legal_name ?? '', address: data.address ?? '',
    phone: data.phone ?? '', email: data.email ?? '', taxRegistrationNo: data.tax_registration_no ?? '',
    invoiceLogoText: data.invoice_logo_text ?? '', invoiceFooter: data.invoice_footer ?? '',
  };
  const set = (k: string, v: string) => { setForm({ ...f, [k]: v }); setSaved(false); };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <ErrorMsg error={error} />
      {saved && <div className="success">Saved.</div>}
      <div className="row">
        <Field label="Company name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Legal name"><input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} /></Field>
      </div>
      <Field label="Address"><textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
      <div className="row">
        <Field label="Phone"><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Email"><input value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="BIN / VAT reg no"><input value={f.taxRegistrationNo} onChange={(e) => set('taxRegistrationNo', e.target.value)} /></Field>
      </div>
      <div className="row">
        <Field label="Invoice header text (brand)"><input value={f.invoiceLogoText} onChange={(e) => set('invoiceLogoText', e.target.value)} /></Field>
        <Field label="Invoice footer"><input value={f.invoiceFooter} onChange={(e) => set('invoiceFooter', e.target.value)} /></Field>
      </div>
      <p className="muted">Base currency {data.base_currency} · fiscal year starts month {data.fiscal_year_start_month} (fixed after setup)</p>
      <AsyncButton onError={setError}
        onClick={async () => {
          await api.patch(co(''), {
            name: f.name, legalName: f.legalName, address: f.address || null,
            phone: f.phone || null, email: f.email || null,
            taxRegistrationNo: f.taxRegistrationNo || null,
            invoiceLogoText: f.invoiceLogoText || null, invoiceFooter: f.invoiceFooter || null,
          });
          setSaved(true);
          reload();
        }}>
        Save
      </AsyncButton>
    </div>
  );
}

function AccountsTab() {
  const { data, loading, reload } = useFetch<any[]>(co('/accounts'));
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (loading) return <Spinner />;
  return (
    <div>
      <div className="toolbar">
        <div className="grow" />
        <button className="btn" onClick={() => setEditing({})}>+ New account</button>
      </div>
      <ErrorMsg error={error} />
      <table className="grid">
        <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Subtype</th><th>Currency</th><th></th></tr></thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.code}</td>
              <td>
                <Link to={`/accounts/${a.id}/transactions`}>{a.name}</Link>
                {a.is_system && <span className="muted"> · system</span>}
              </td>
              <td>{a.type}</td><td>{a.subtype}</td><td>{a.currency}</td>
              <td className="right">
                <button className="btn secondary sm" onClick={() => setEditing(a)}>Edit</button>{' '}
                {!a.is_system && (
                  <AsyncButton className="btn secondary sm" onError={setError}
                    onClick={() => api.delete(co(`/accounts/${a.id}`)).then(reload)}>
                    Archive
                  </AsyncButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <AccountModal account={editing.id ? editing : null} onClose={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function AccountModal({ account, onClose }: { account: any | null; onClose: () => void }) {
  const [form, setForm] = useState({
    code: account?.code ?? '', name: account?.name ?? '',
    type: account?.type ?? 'expense', subtype: account?.subtype ?? '',
    currency: account?.currency ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal open title={account ? `Edit ${account.name}` : 'New account'} onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Code"><input value={form.code} onChange={(e) => set('code', e.target.value)} style={{ width: 80 }} /></Field>
        <Field label="Name"><input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      </div>
      <div className="row">
        <Field label="Type">
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {['asset', 'liability', 'equity', 'income', 'expense'].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Subtype">
          <select value={form.subtype} onChange={(e) => set('subtype', e.target.value)}>
            <option value="">—</option>
            {['bank', 'cash', 'current_asset', 'inventory', 'fixed_asset', 'accumulated_depreciation',
              'accounts_receivable', 'accounts_payable', 'current_liability', 'long_term_liability',
              'equity', 'retained_earnings', 'operating_revenue', 'other_income', 'cogs', 'operating_expense',
            ].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Currency (banks)">
          <input value={form.currency ?? ''} maxLength={3} style={{ width: 64 }}
            onChange={(e) => set('currency', e.target.value.toUpperCase())} />
        </Field>
      </div>
      <AsyncButton onError={setError}
        onClick={async () => {
          const body = {
            code: form.code, name: form.name, type: form.type,
            subtype: form.subtype || undefined, currency: form.currency || null,
          };
          if (account) await api.patch(co(`/accounts/${account.id}`), body);
          else await api.post(co('/accounts'), body);
          onClose();
        }}>
        Save
      </AsyncButton>
    </Modal>
  );
}

function TaxTab() {
  const { data, loading, reload } = useFetch<any[]>(co('/tax-codes'));
  const [error, setError] = useState<string | null>(null);
  if (loading) return <Spinner />;
  return (
    <div>
      <ErrorMsg error={error} />
      <p className="muted">
        Tax is configuration: rates, sides, and posting accounts. Bangladesh VAT (Mushak),
        VDS and AIT ship as defaults; add codes for other jurisdictions here.
      </p>
      <table className="grid">
        <thead>
          <tr><th>Code</th><th>Name</th><th className="num">Rate %</th><th>Applies to</th><th>Withholding</th><th>Category</th><th></th></tr>
        </thead>
        <tbody>
          {(data ?? []).map((t) => (
            <tr key={t.id}>
              <td>{t.code}</td><td>{t.name}</td>
              <td className="num">{Number(t.rate)}</td>
              <td>{t.applies_to}</td>
              <td>{t.is_withholding ? 'Yes — deducted at source' : ''}</td>
              <td>{t.report_category}</td>
              <td className="right">
                <AsyncButton className="btn secondary sm" onError={setError}
                  onClick={() => api.delete(co(`/tax-codes/${t.id}`)).then(reload)}>
                  Archive
                </AsyncButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PeriodsTab() {
  const { data, loading, reload } = useFetch<any[]>(co('/ledger/periods'));
  const [error, setError] = useState<string | null>(null);
  if (loading) return <Spinner />;
  return (
    <div>
      <ErrorMsg error={error} />
      <p className="muted">Closing a period blocks any posting dated inside it. Corrections use reversing entries in an open period.</p>
      {(data ?? []).map((fy) => (
        <div className="card" key={fy.id}>
          <div className="toolbar mb0">
            <h2 style={{ margin: 0 }}>FY {fy.start_date} → {fy.end_date}</h2>
            <Badge status={fy.status} />
            <div className="grow" />
            <AsyncButton className="btn secondary sm" onError={setError}
              confirm={fy.status === 'open' ? 'Close the whole fiscal year? All periods will be locked.' : undefined}
              onClick={() =>
                api.post(co(`/ledger/fiscal-years/${fy.id}/status`), { status: fy.status === 'open' ? 'closed' : 'open' }).then(reload)}>
              {fy.status === 'open' ? 'Close year' : 'Reopen year'}
            </AsyncButton>
          </div>
          <table className="grid" style={{ marginTop: 10 }}>
            <tbody>
              {fy.periods.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.start_date} → {p.end_date}</td>
                  <td><Badge status={p.status} /></td>
                  <td className="right">
                    <AsyncButton className="btn secondary sm" onError={setError}
                      onClick={() =>
                        api.post(co(`/ledger/periods/${p.id}/status`), { status: p.status === 'open' ? 'closed' : 'open' }).then(reload)}>
                      {p.status === 'open' ? 'Close' : 'Reopen'}
                    </AsyncButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function MembersTab() {
  const { data, loading, reload } = useFetch<any[]>(co('/members'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('data_entry');
  const [error, setError] = useState<string | null>(null);
  if (loading) return <Spinner />;
  return (
    <div>
      <ErrorMsg error={error} />
      <div className="card">
        <div className="row">
          <Field label="User email (must be registered)">
            <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 240 }} />
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {['owner', 'accountant', 'data_entry', 'read_only'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <AsyncButton onError={setError}
            onClick={async () => {
              await api.post(co('/members'), { email, role });
              setEmail('');
              reload();
            }}>
            Add / update member
          </AsyncButton>
        </div>
      </div>
      <table className="grid">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>
          {(data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td><td>{m.email}</td><td><Badge status={m.role} /></td>
              <td className="right">
                <AsyncButton className="btn secondary sm" onError={setError}
                  onClick={() => api.delete(co(`/members/${m.id}`)).then(reload)}>
                  Remove
                </AsyncButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTab() {
  const { data, loading } = useFetch<any[]>(co('/activity?limit=200'));
  if (loading) return <Spinner />;
  return (
    <table className="grid">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
      <tbody>
        {(data ?? []).map((a) => (
          <tr key={a.id}>
            <td>{new Date(a.created_at).toLocaleString()}</td>
            <td>{a.user_name}</td>
            <td>{a.action}</td>
            <td className="muted">{a.entity_type}</td>
            <td className="muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.details ? JSON.stringify(a.details) : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FxTab() {
  const [asOfDate, setAsOfDate] = useState(today());
  const [pairs, setPairs] = useState<Array<{ ccy: string; rate: string }>>([{ ccy: 'USD', rate: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <p className="muted">
        Revalues open foreign-currency invoices, bills and bank accounts at closing rates,
        posts an unrealized gain/loss entry, and auto-reverses it the next day.
      </p>
      <ErrorMsg error={error} />
      {result && <div className="success">{result}</div>}
      <Field label="As of date"><input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></Field>
      {pairs.map((p, i) => (
        <div className="row" key={i}>
          <Field label="Currency">
            <input value={p.ccy} maxLength={3} style={{ width: 64 }}
              onChange={(e) => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, ccy: e.target.value.toUpperCase() } : x))} />
          </Field>
          <Field label="Closing rate (base per unit)">
            <input className="num" value={p.rate}
              onChange={(e) => setPairs((ps) => ps.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} />
          </Field>
        </div>
      ))}
      <button className="btn secondary sm" onClick={() => setPairs((ps) => [...ps, { ccy: '', rate: '' }])}>+ Currency</button>
      <div style={{ marginTop: 12 }}>
        <AsyncButton onError={setError}
          onClick={async () => {
            const rates = Object.fromEntries(pairs.filter((p) => p.ccy && p.rate).map((p) => [p.ccy, p.rate]));
            const r = await api.post(co('/ledger/fx-revalue'), { asOfDate, rates });
            setResult(r.adjustmentEntryId
              ? `Posted unrealized FX adjustment of ${r.total} (auto-reversing next day).`
              : 'Nothing to revalue at these rates.');
          }}>
          Run revaluation
        </AsyncButton>
      </div>
    </div>
  );
}
