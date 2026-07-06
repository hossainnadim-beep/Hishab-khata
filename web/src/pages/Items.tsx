import { useState } from 'react';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export default function Items() {
  const { data, error, loading, reload } = useFetch<any[]>(co('/items'));
  const [editing, setEditing] = useState<any | null>(null);
  const [adjusting, setAdjusting] = useState<any | null>(null);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>Items & Services</h1>
        <div className="grow" />
        <button className="btn" onClick={() => setEditing({})}>+ New item</button>
      </div>
      <ErrorMsg error={error} />
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th className="num">Sale price</th>
              <th className="num">Purchase price</th><th className="num">On hand</th>
              <th className="num">Avg cost</th><th className="num">Stock value</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((i) => (
              <tr key={i.id}>
                <td>{i.name}{i.sku ? <span className="muted"> · {i.sku}</span> : ''}</td>
                <td>{i.type}</td>
                <td className="num">{fmtMoney(i.sale_price)}</td>
                <td className="num">{fmtMoney(i.purchase_price)}</td>
                <td className="num">{i.type === 'inventory' ? Number(i.qty_on_hand) : '—'}</td>
                <td className="num">{i.type === 'inventory' ? fmtMoney(i.avg_cost) : '—'}</td>
                <td className="num">{i.type === 'inventory' ? fmtMoney(Number(i.qty_on_hand) * Number(i.avg_cost)) : '—'}</td>
                <td className="right">
                  {i.type === 'inventory' && (
                    <button className="btn secondary sm" onClick={() => setAdjusting(i)}>Adjust</button>
                  )}{' '}
                  <button className="btn secondary sm" onClick={() => setEditing(i)}>Edit</button>
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={8} className="muted">No items yet.</td></tr>}
          </tbody>
        </table>
      )}
      {editing && <ItemModal item={editing.id ? editing : null} onClose={() => { setEditing(null); reload(); }} />}
      {adjusting && <AdjustModal item={adjusting} onClose={() => { setAdjusting(null); reload(); }} />}
    </div>
  );
}

function ItemModal({ item, onClose }: { item: any | null; onClose: () => void }) {
  const [form, setForm] = useState({
    name: item?.name ?? '',
    sku: item?.sku ?? '',
    type: item?.type ?? 'service',
    salePrice: item ? String(Number(item.sale_price)) : '',
    purchasePrice: item ? String(Number(item.purchase_price)) : '',
    taxCodeId: item?.tax_code_id ?? '',
    incomeAccountId: item?.income_account_id ?? '',
    expenseAccountId: item?.expense_account_id ?? '',
    inventoryAccountId: item?.inventory_account_id ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const body = {
      name: form.name,
      sku: form.sku || null,
      type: form.type,
      salePrice: form.salePrice || 0,
      purchasePrice: form.purchasePrice || 0,
      taxCodeId: form.taxCodeId || null,
      incomeAccountId: form.incomeAccountId || null,
      expenseAccountId: form.expenseAccountId || null,
      inventoryAccountId: form.inventoryAccountId || null,
    };
    if (item) await api.patch(co(`/items/${item.id}`), body);
    else await api.post(co('/items'), body);
    onClose();
  }

  return (
    <Modal open title={item ? `Edit ${item.name}` : 'New item'} onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Name"><input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="SKU"><input value={form.sku} onChange={(e) => set('sku', e.target.value)} style={{ width: 100 }} /></Field>
        <Field label="Type">
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="service">Service</option>
            <option value="inventory">Inventory (tracked)</option>
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Sale price"><input className="num" value={form.salePrice} onChange={(e) => set('salePrice', e.target.value)} /></Field>
        <Field label="Purchase price"><input className="num" value={form.purchasePrice} onChange={(e) => set('purchasePrice', e.target.value)} /></Field>
        <Field label="Default tax">
          <ApiSelect path={co('/tax-codes')} value={form.taxCodeId} onChange={(v) => set('taxCodeId', v)}
            filter={(t) => !t.is_withholding} labelKey="code" placeholder="No tax" />
        </Field>
      </div>
      <div className="row">
        <Field label="Income account (default)">
          <ApiSelect path={co('/accounts')} value={form.incomeAccountId} onChange={(v) => set('incomeAccountId', v)}
            filter={(a) => a.type === 'income'} format={(a) => `${a.code} ${a.name}`} placeholder="Sales default" />
        </Field>
        {form.type === 'inventory' && (
          <>
            <Field label="COGS account">
              <ApiSelect path={co('/accounts')} value={form.expenseAccountId} onChange={(v) => set('expenseAccountId', v)}
                filter={(a) => a.type === 'expense'} format={(a) => `${a.code} ${a.name}`} placeholder="COGS default" />
            </Field>
            <Field label="Inventory asset account">
              <ApiSelect path={co('/accounts')} value={form.inventoryAccountId} onChange={(v) => set('inventoryAccountId', v)}
                filter={(a) => a.type === 'asset'} format={(a) => `${a.code} ${a.name}`} placeholder="Inventory default" />
            </Field>
          </>
        )}
      </div>
      <AsyncButton onClick={save} onError={setError}>Save</AsyncButton>
    </Modal>
  );
}

function AdjustModal({ item, onClose }: { item: any; onClose: () => void }) {
  const [qtyDelta, setQtyDelta] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    await api.post(co(`/items/${item.id}/adjust`), {
      date: today(),
      qtyDelta,
      unitCost: unitCost || undefined,
      adjustmentAccountId: accountId,
      memo: memo || undefined,
    });
    onClose();
  }

  return (
    <Modal open title={`Adjust stock — ${item.name}`} onClose={onClose}>
      <ErrorMsg error={error} />
      <p className="muted">On hand: {Number(item.qty_on_hand)} @ avg {fmtMoney(item.avg_cost)}</p>
      <div className="row">
        <Field label="Qty change (+ in / − out)">
          <input className="num" value={qtyDelta} onChange={(e) => setQtyDelta(e.target.value)} />
        </Field>
        <Field label="Unit cost (for stock-in)">
          <input className="num" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        </Field>
      </div>
      <Field label="Adjustment account (write-off / gain)">
        <ApiSelect path={co('/accounts')} value={accountId} onChange={setAccountId}
          filter={(a) => a.type === 'expense' || a.type === 'income'} format={(a) => `${a.code} ${a.name}`} />
      </Field>
      <Field label="Memo"><input value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
      <AsyncButton onClick={save} onError={setError}>Adjust</AsyncButton>
    </Modal>
  );
}
