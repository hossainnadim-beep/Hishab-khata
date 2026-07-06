import { useState } from 'react';
import { api, co } from '../api';
import { AsyncButton, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Contacts({ kind }: { kind: 'customer' | 'vendor' }) {
  const label = kind === 'customer' ? 'Customer' : 'Vendor';
  const { data, error, loading, reload } = useFetch<any[]>(co(`/contacts?kind=${kind}`), [kind]);
  const [editing, setEditing] = useState<any | null>(null);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>{label}s</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setEditing({})}>+ New {label}</button>
      </div>
      <ErrorMsg error={error} />
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Phone</th><th>BIN</th><th>Terms</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td><td>{c.email}</td><td>{c.phone}</td>
                <td>{c.tax_reg_no}</td><td>{c.payment_terms_days} days</td>
                <td className="right">
                  <button className="btn secondary sm" onClick={() => setEditing(c)}>Edit</button>
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={6} className="muted">No {label.toLowerCase()}s yet.</td></tr>}
          </tbody>
        </table>
      )}
      {editing && (
        <ContactModal
          kind={kind}
          contact={editing.id ? editing : null}
          onClose={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function ContactModal({ kind, contact, onClose }: { kind: string; contact: any | null; onClose: () => void }) {
  const [form, setForm] = useState({
    name: contact?.name ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    address: contact?.address ?? '',
    taxRegNo: contact?.tax_reg_no ?? '',
    paymentTermsDays: contact?.payment_terms_days ?? 30,
    currency: contact?.currency ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const body: any = {
      name: form.name,
      email: form.email || null,
      phone: form.phone || null,
      address: form.address || null,
      taxRegNo: form.taxRegNo || null,
      paymentTermsDays: Number(form.paymentTermsDays),
      currency: form.currency || null,
      isCustomer: kind === 'customer' || contact?.is_customer || false,
      isVendor: kind === 'vendor' || contact?.is_vendor || false,
    };
    if (contact) await api.patch(co(`/contacts/${contact.id}`), body);
    else await api.post(co('/contacts'), body);
    onClose();
  }

  return (
    <Modal open title={contact ? `Edit ${contact.name}` : `New ${kind}`} onClose={onClose}>
      <ErrorMsg error={error} />
      <Field label="Name"><input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div className="row">
        <Field label="Email"><input value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Phone"><input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      </div>
      <Field label="Address"><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></Field>
      <div className="row">
        <Field label="BIN / tax reg no"><input value={form.taxRegNo} onChange={(e) => set('taxRegNo', e.target.value)} /></Field>
        <Field label="Payment terms (days)">
          <input className="num" value={form.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} style={{ width: 80 }} />
        </Field>
        <Field label="Currency (blank = base)">
          <input value={form.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} style={{ width: 64 }} />
        </Field>
      </div>
      <AsyncButton onClick={save} onError={setError}>Save</AsyncButton>
    </Modal>
  );
}
