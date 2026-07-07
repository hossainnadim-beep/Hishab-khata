import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, co, fmtMoney, today } from '../api';
import { ApiSelect, AsyncButton, Badge, EmptyState, ErrorMsg, Field, Modal, Spinner, useFetch } from '../components';

export type DocKind = 'invoice' | 'quote' | 'credit-note' | 'bill' | 'vendor-credit';

const CONFIG: Record<DocKind, {
  label: string;
  plural: string;
  base: string; // API base under company
  entityType: string; // audit_log entity_type
  contactKind: 'customer' | 'vendor';
  contactField: 'customerId' | 'vendorId';
  contactNameCol: string;
  hasDueDate: boolean;
  postable: boolean;
  pdf: string | null;
  applyTo: { kind: DocKind; label: string } | null;
  isQuote?: boolean;
  vendorRef?: boolean;
  discount?: boolean;
}> = {
  invoice: {
    label: 'Invoice', plural: 'Invoices', base: '/sales/invoices', entityType: 'invoice',
    contactKind: 'customer', contactField: 'customerId', contactNameCol: 'customer_name',
    hasDueDate: true, postable: true, pdf: 'invoice', applyTo: null, discount: true,
  },
  quote: {
    label: 'Quote', plural: 'Quotes', base: '/sales/quotes', entityType: 'quote',
    contactKind: 'customer', contactField: 'customerId', contactNameCol: 'customer_name',
    hasDueDate: false, postable: false, pdf: 'quote', applyTo: null, isQuote: true, discount: true,
  },
  'credit-note': {
    label: 'Credit Note', plural: 'Credit Notes', base: '/sales/credit-notes', entityType: 'credit_note',
    contactKind: 'customer', contactField: 'customerId', contactNameCol: 'customer_name',
    hasDueDate: false, postable: true, pdf: 'credit-note',
    applyTo: { kind: 'invoice', label: 'invoice' }, discount: true,
  },
  bill: {
    label: 'Bill', plural: 'Bills', base: '/purchases/bills', entityType: 'bill',
    contactKind: 'vendor', contactField: 'vendorId', contactNameCol: 'vendor_name',
    hasDueDate: true, postable: true, pdf: null, applyTo: null, vendorRef: true,
  },
  'vendor-credit': {
    label: 'Vendor Credit', plural: 'Vendor Credits', base: '/purchases/vendor-credits', entityType: 'vendor_credit',
    contactKind: 'vendor', contactField: 'vendorId', contactNameCol: 'vendor_name',
    hasDueDate: false, postable: true, pdf: null,
    applyTo: { kind: 'bill', label: 'bill' },
  },
};

// ---------------- List ----------------

export function DocList({ kind }: { kind: DocKind }) {
  const cfg = CONFIG[kind];
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const { data, error, loading } = useFetch<any[]>(
    co(`${cfg.base}${status ? `?status=${status}` : ''}`), [status],
  );
  const statuses = cfg.isQuote
    ? ['draft', 'sent', 'accepted', 'declined', 'invoiced']
    : ['draft', 'open', 'paid', 'applied', 'voided'];

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>{cfg.plural}</h1>
        <div className="grow" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Link className="btn" to={`/${kind}s/new`}>+ New {cfg.label}</Link>
      </div>
      <ErrorMsg error={error} />
      {loading ? <Spinner /> : !data?.length ? (
        <EmptyState
          message={`No ${cfg.plural.toLowerCase()} yet.`}
          action={<Link className="btn" to={`/${kind}s/new`}>Create your first {cfg.label.toLowerCase()}</Link>}
        />
      ) : (
        <>
          <table className="grid hide-mobile">
            <thead>
              <tr>
                <th>Number</th><th>{cfg.contactKind === 'customer' ? 'Customer' : 'Vendor'}</th>
                <th>Date</th>{cfg.hasDueDate && <th>Due</th>}
                <th>Status</th><th className="num">Total</th>
                {!cfg.isQuote && <th className="num">Balance</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => navigate(`/${kind}s/${d.id}`)}>
                  <td>{d.doc_no}</td>
                  <td>{d[cfg.contactNameCol]}</td>
                  <td>{d.issue_date}</td>
                  {cfg.hasDueDate && <td>{d.due_date}</td>}
                  <td><Badge status={d.status} /></td>
                  <td className="num">{d.currency} {fmtMoney(d.total)}</td>
                  {!cfg.isQuote && <td className="num">{fmtMoney(d.balance_due ?? d.balance)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mobile-cards">
            {data.map((d) => (
              <Link className="doc-card" key={d.id} to={`/${kind}s/${d.id}`}>
                <div className="dc-top">
                  <span className="dc-title">{d.doc_no}</span>
                  <span className="dc-amount">{d.currency} {fmtMoney(d.total)}</span>
                </div>
                <div className="dc-top">
                  <span className="dc-sub">
                    {d[cfg.contactNameCol]} · {d.issue_date}
                    {!cfg.isQuote && Number(d.balance_due ?? d.balance) > 0
                      ? ` · due ${fmtMoney(d.balance_due ?? d.balance)}`
                      : ''}
                  </span>
                  <Badge status={d.status} />
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------- Form (create / edit draft) ----------------

interface LineDraft {
  itemId: string; description: string; qty: string; unitPrice: string;
  discountPct: string; accountId: string; taxCodeId: string;
}

const emptyLine = (): LineDraft => ({
  itemId: '', description: '', qty: '1', unitPrice: '', discountPct: '', accountId: '', taxCodeId: '',
});

export function DocForm({ kind }: { kind: DocKind }) {
  const cfg = CONFIG[kind];
  const navigate = useNavigate();
  const { id } = useParams();
  const editing = !!id;

  const [contactId, setContactId] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [currency, setCurrency] = useState('');
  const [exchangeRate, setExchangeRate] = useState('1');
  const [amountsAre, setAmountsAre] = useState<'exclusive' | 'inclusive' | 'no_tax'>('exclusive');
  const [memo, setMemo] = useState('');
  const [vendorRef, setVendorRef] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const { data: items } = useFetch<any[]>(co('/items'));
  const { data: taxCodes } = useFetch<any[]>(co('/tax-codes'));
  const { data: companyData } = useFetch<any>(co(''));

  useEffect(() => {
    if (editing) {
      api.get(co(`${cfg.base}/${id}`)).then((d) => {
        setContactId(d.customer_id ?? d.vendor_id);
        setIssueDate(d.issue_date);
        setDueDate(d.due_date ?? '');
        setCurrency(d.currency);
        setExchangeRate(String(Number(d.exchange_rate)));
        setAmountsAre(d.amounts_are);
        setMemo(d.memo ?? '');
        setVendorRef(d.vendor_ref ?? '');
        setLines(d.lines.map((l: any) => ({
          itemId: l.item_id ?? '', description: l.description ?? '',
          qty: String(Number(l.qty)), unitPrice: String(Number(l.unit_price)),
          discountPct: Number(l.discount_pct) ? String(Number(l.discount_pct)) : '',
          accountId: l.account_id ?? '', taxCodeId: l.tax_code_id ?? '',
        })));
      }).catch((e) => setError(e.message));
    }
  }, [editing, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseCurrency = companyData?.base_currency ?? 'BDT';
  const docCurrency = currency || baseCurrency;
  const isForeign = docCurrency !== baseCurrency;

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickItem = (i: number, itemId: string) => {
    const item = (items ?? []).find((it) => it.id === itemId);
    setLine(i, {
      itemId,
      description: item?.name ?? '',
      unitPrice: item
        ? String(Number(cfg.contactKind === 'customer' ? item.sale_price : item.purchase_price))
        : '',
      taxCodeId: item?.tax_code_id ?? '',
      accountId: '',
    });
  };

  // Client-side preview of totals (server recomputes authoritatively).
  const totals = useMemo(() => {
    let subtotal = 0, tax = 0;
    for (const l of lines) {
      const gross = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - (Number(l.discountPct) || 0) / 100);
      const code = (taxCodes ?? []).find((t) => t.id === l.taxCodeId);
      const rate = code && !code.is_withholding ? Number(code.rate) : 0;
      if (amountsAre === 'inclusive' && rate) {
        const t = gross * rate / (100 + rate);
        subtotal += gross - t; tax += t;
      } else if (amountsAre === 'exclusive' && rate) {
        subtotal += gross; tax += gross * rate / 100;
      } else subtotal += gross;
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, taxCodes, amountsAre]);

  async function save() {
    setError(null);
    const body: any = {
      [cfg.contactField]: contactId,
      issueDate,
      currency: docCurrency,
      exchangeRate: isForeign ? exchangeRate : undefined,
      amountsAre,
      memo: memo || null,
      lines: lines
        .filter((l) => l.description || l.itemId || Number(l.unitPrice))
        .map((l) => ({
          itemId: l.itemId || null,
          description: l.description || null,
          qty: l.qty || 1,
          unitPrice: l.unitPrice || 0,
          ...(cfg.discount && l.discountPct ? { discountPct: l.discountPct } : {}),
          accountId: l.accountId || null,
          taxCodeId: amountsAre === 'no_tax' ? null : l.taxCodeId || null,
        })),
    };
    if (cfg.hasDueDate && dueDate) body.dueDate = dueDate;
    if (cfg.vendorRef && vendorRef) body.vendorRef = vendorRef;
    try {
      const doc = editing
        ? await api.patch(co(`${cfg.base}/${id}`), body)
        : await api.post(co(cfg.base), body);
      navigate(`/${kind}s/${doc.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div>
      <h1>{editing ? `Edit ${cfg.label}` : `New ${cfg.label}`}</h1>
      <ErrorMsg error={error} />
      <div className="card">
        <div className="row">
          <Field label={cfg.contactKind === 'customer' ? 'Customer' : 'Vendor'}>
            <ApiSelect
              path={co(`/contacts?kind=${cfg.contactKind}`)}
              value={contactId}
              onChange={setContactId}
            />
          </Field>
          <Field label="Issue date">
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </Field>
          {cfg.hasDueDate && (
            <Field label="Due date (blank = terms)">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}
          {cfg.vendorRef && (
            <Field label="Vendor invoice #">
              <input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} />
            </Field>
          )}
          <Field label="Currency">
            <input value={docCurrency} maxLength={3} style={{ width: 64 }}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </Field>
          {isForeign && (
            <Field label={`Rate (${baseCurrency} per ${docCurrency})`}>
              <input className="num" value={exchangeRate} style={{ width: 110 }}
                onChange={(e) => setExchangeRate(e.target.value)} />
            </Field>
          )}
          <Field label="Amounts are">
            <select value={amountsAre} onChange={(e) => setAmountsAre(e.target.value as any)}>
              <option value="exclusive">Tax exclusive</option>
              <option value="inclusive">Tax inclusive</option>
              <option value="no_tax">No tax</option>
            </select>
          </Field>
        </div>

        <table className="grid doc-lines">
          <thead>
            <tr>
              <th style={{ width: '16%' }}>Item</th>
              <th>Description</th>
              <th style={{ width: 64 }}>Qty</th>
              <th style={{ width: 100 }}>Unit price</th>
              {cfg.discount && <th style={{ width: 64 }}>Disc %</th>}
              <th style={{ width: '14%' }}>Account</th>
              <th style={{ width: '12%' }}>Tax</th>
              <th style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select value={l.itemId} onChange={(e) => pickItem(i, e.target.value)}>
                    <option value="">—</option>
                    {(items ?? []).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </select>
                </td>
                <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td><input className="num" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
                <td><input className="num" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></td>
                {cfg.discount && (
                  <td><input className="num" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} /></td>
                )}
                <td>
                  <ApiSelect
                    path={co('/accounts')}
                    value={l.accountId}
                    onChange={(v) => setLine(i, { accountId: v })}
                    placeholder={l.itemId ? 'item default' : '— account —'}
                    filter={(a) =>
                      cfg.contactKind === 'customer'
                        ? a.type === 'income'
                        : a.type === 'expense' || a.type === 'asset'}
                    format={(a) => `${a.code} ${a.name}`}
                  />
                </td>
                <td>
                  <select value={l.taxCodeId} disabled={amountsAre === 'no_tax'}
                    onChange={(e) => setLine(i, { taxCodeId: e.target.value })}>
                    <option value="">No tax</option>
                    {(taxCodes ?? []).filter((t) => !t.is_withholding).map((t) => (
                      <option key={t.id} value={t.id}>{t.code}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button className="btn secondary sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between' }}>
          <button className="btn secondary sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
          <div className="right" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <div>Subtotal: {fmtMoney(totals.subtotal)}</div>
            <div>Tax: {fmtMoney(totals.tax)}</div>
            <strong>Total: {docCurrency} {fmtMoney(totals.total)}</strong>
          </div>
        </div>
        <Field label="Notes">
          <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <div className="row">
          <AsyncButton onClick={save} onError={setError}>Save draft</AsyncButton>
          <button className="btn secondary" onClick={() => navigate(-1)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Detail ----------------

export function DocDetail({ kind }: { kind: DocKind }) {
  const cfg = CONFIG[kind];
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: doc, error, loading, reload } = useFetch<any>(co(`${cfg.base}/${id}`));
  const [actionError, setActionError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [tab, setTab] = useState<'details' | 'journal' | 'audit'>('details');

  if (loading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;
  if (!doc) return null;

  const contactName = doc[cfg.contactNameCol] ?? '';
  const post = () => api.post(co(`${cfg.base}/${id}/post`)).then(reload);
  const voidDoc = () => api.post(co(`${cfg.base}/${id}/void`)).then(reload);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>{cfg.label} {doc.doc_no}</h1>
        <Badge status={doc.status} />
        <div className="grow" />
        {doc.status === 'draft' && (
          <>
            <Link className="btn secondary" to={`/${kind}s/${id}/edit`}>Edit</Link>
            {cfg.postable && (
              <AsyncButton onClick={post} onError={setActionError}>
                {kind === 'bill' ? 'Approve & post' : 'Post'}
              </AsyncButton>
            )}
          </>
        )}
        {cfg.isQuote && doc.status !== 'invoiced' && (
          <>
            {doc.status === 'draft' && (
              <AsyncButton className="btn secondary" onError={setActionError}
                onClick={() => api.post(co(`${cfg.base}/${id}/status`), { status: 'sent' }).then(reload)}>
                Mark sent
              </AsyncButton>
            )}
            {doc.status === 'sent' && (
              <AsyncButton className="btn secondary" onError={setActionError}
                onClick={() => api.post(co(`${cfg.base}/${id}/status`), { status: 'accepted' }).then(reload)}>
                Mark accepted
              </AsyncButton>
            )}
            <AsyncButton onError={setActionError}
              onClick={() => api.post(co(`${cfg.base}/${id}/convert`)).then((inv) => navigate(`/invoices/${inv.id}`))}>
              Convert to invoice
            </AsyncButton>
          </>
        )}
        {doc.status === 'open' && kind === 'invoice' && (
          <button className="btn" onClick={() => setPayOpen(true)}>Receive payment</button>
        )}
        {doc.status === 'open' && kind === 'bill' && (
          <button className="btn" onClick={() => setPayOpen(true)}>Pay bill</button>
        )}
        {doc.status === 'open' && cfg.applyTo && (
          <button className="btn" onClick={() => setApplyOpen(true)}>Apply to {cfg.applyTo.label}</button>
        )}
        {['draft', 'open'].includes(doc.status) && cfg.postable && (
          <AsyncButton className="btn danger" onClick={voidDoc} onError={setActionError}
            confirm={`Void ${cfg.label.toLowerCase()} ${doc.doc_no}? A reversing entry will be posted.`}>
            Void
          </AsyncButton>
        )}
        {cfg.pdf && (
          <a className="btn secondary" target="_blank" rel="noreferrer"
            href={co(`/reports/document-pdf/${cfg.pdf}/${id}?format=pdf`)}
            onClick={(e) => { e.preventDefault(); openPdf(co(`/reports/document-pdf/${cfg.pdf}/${id}`)); }}>
            PDF
          </a>
        )}
      </div>
      <ErrorMsg error={actionError} />

      <div className="tabs">
        <button className={`tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`tab ${tab === 'journal' ? 'active' : ''}`} onClick={() => setTab('journal')}>Journal impact</button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>Audit</button>
      </div>

      {tab === 'journal' && <JournalImpact docId={doc.id} status={doc.status} />}
      {tab === 'audit' && <AuditTrail entityType={cfg.entityType} entityId={doc.id} />}

      <div className="card" style={{ display: tab === 'details' ? 'block' : 'none' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="muted">{cfg.contactKind === 'customer' ? 'Customer' : 'Vendor'}</div>
            <strong>{contactName}</strong>
            {doc.vendor_ref && <div className="muted">Ref: {doc.vendor_ref}</div>}
          </div>
          <div>
            <div className="muted">Issued {doc.issue_date}{doc.due_date ? ` · Due ${doc.due_date}` : ''}</div>
            <div className="muted">
              {doc.currency}
              {Number(doc.exchange_rate) !== 1 && ` @ ${Number(doc.exchange_rate)}`}
              {' · '}{doc.amounts_are.replace('_', ' ')}
            </div>
          </div>
        </div>
        <table className="grid" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Description</th><th className="num">Qty</th><th className="num">Unit price</th>
              <th className="num">Tax</th><th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{Number(l.qty)}</td>
                <td className="num">{fmtMoney(l.unit_price)}</td>
                <td className="num">{fmtMoney(l.tax_amount)}</td>
                <td className="num">{fmtMoney(l.net_amount)}</td>
              </tr>
            ))}
            <tr><td colSpan={4} className="num">Subtotal</td><td className="num">{fmtMoney(doc.subtotal)}</td></tr>
            <tr><td colSpan={4} className="num">Tax</td><td className="num">{fmtMoney(doc.tax_total)}</td></tr>
            <tr><td colSpan={4} className="num total">Total ({doc.currency})</td><td className="num total">{fmtMoney(doc.total)}</td></tr>
            {(doc.balance_due ?? doc.balance) !== undefined && doc.status !== 'draft' && (
              <tr><td colSpan={4} className="num total">Balance</td>
                <td className="num total">{fmtMoney(doc.balance_due ?? doc.balance)}</td></tr>
            )}
          </tbody>
        </table>
        {doc.memo && <p className="muted">Notes: {doc.memo}</p>}
        {!!doc.payments?.length && (
          <>
            <h2>Payments</h2>
            <table className="grid">
              <thead><tr><th>Receipt</th><th>Date</th><th className="num">Amount</th><th>Journal</th></tr></thead>
              <tbody>
                {doc.payments.map((p: any, i: number) => (
                  <tr key={i}>
                    <td>{p.doc_no}</td>
                    <td>{p.payment_date}</td>
                    <td className="num">{fmtMoney(p.amount)}</td>
                    <td>{p.journal_entry_id ? <Link to={`/journal/${p.journal_entry_id}`}>view entry</Link> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!!doc.credits?.length && (
          <>
            <h2>Credits applied</h2>
            <table className="grid">
              <thead><tr><th>Credit</th><th>Date</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {doc.credits.map((c: any, i: number) => (
                  <tr key={i}><td>{c.doc_no}</td><td>{c.applied_at?.slice(0, 10)}</td><td className="num">{fmtMoney(c.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {payOpen && kind === 'invoice' && (
        <PaymentModal doc={doc} onClose={() => { setPayOpen(false); reload(); }} side="receive" />
      )}
      {payOpen && kind === 'bill' && (
        <PaymentModal doc={doc} onClose={() => { setPayOpen(false); reload(); }} side="pay" />
      )}
      {applyOpen && cfg.applyTo && (
        <ApplyModal kind={kind} doc={doc} target={cfg.applyTo} onClose={() => { setApplyOpen(false); reload(); }} />
      )}
    </div>
  );
}

/** Journal impact: every posted entry backing this document, with full Dr/Cr breakup. */
function JournalImpact({ docId, status }: { docId: string; status: string }) {
  const { data, error, loading } = useFetch<any[]>(
    co(`/ledger/journal-for-source?source_id=${docId}`),
  );
  if (loading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;
  if (!data?.length) {
    return (
      <EmptyState
        message={
          status === 'draft'
            ? 'No journal entries yet — drafts post to the ledger when you post the document.'
            : 'No journal entries found for this document.'
        }
      />
    );
  }
  return (
    <>
      {data.map((je) => (
        <div className="je-panel" key={je.id}>
          <div className="je-head">
            <Link to={`/journal/${je.id}`}><strong>Entry #{je.entry_no}</strong></Link>
            <span>{je.txn_date}</span>
            <span>{je.source_type.replace(/_/g, ' ')}</span>
            <span>{je.currency}{Number(je.exchange_rate) !== 1 ? ` @ ${Number(je.exchange_rate)}` : ''}</span>
            {je.memo && <span className="muted">{je.memo}</span>}
          </div>
          <table className="grid" style={{ border: 'none' }}>
            <thead>
              <tr>
                <th>Account</th><th>Description</th>
                <th className="num">Debit</th><th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {je.lines.map((l: any) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/accounts/${l.account_id}/transactions`}>
                      {l.account_code} {l.account_name}
                    </Link>
                  </td>
                  <td>{l.description}</td>
                  <td className="num">{Number(l.debit) ? fmtMoney(l.debit) : Number(l.base_debit) ? fmtMoney(l.base_debit) : ''}</td>
                  <td className="num">{Number(l.credit) ? fmtMoney(l.credit) : Number(l.base_credit) ? fmtMoney(l.base_credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/** Immutable audit trail for one entity: who did what, when, with before/after. */
export function AuditTrail({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { data, error, loading } = useFetch<any[]>(
    co(`/activity?entity_type=${entityType}&entity_id=${entityId}&limit=100`),
  );
  if (loading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;
  if (!data?.length) return <EmptyState message="No audit records for this transaction." />;
  return (
    <div className="card">
      <p className="muted mb0">
        Complete immutable history — records cannot be edited or deleted, even by administrators.
      </p>
      <table className="grid" style={{ marginTop: 10 }}>
        <thead>
          <tr><th>When</th><th>Who</th><th>Action</th><th>Changes</th></tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{new Date(a.created_at).toLocaleString()}</td>
              <td>{a.user_name ?? 'system'}</td>
              <td>{a.action.replace(/[._]/g, ' ')}</td>
              <td>
                {a.details?.before ? (
                  <details>
                    <summary className="amount-link">before / after</summary>
                    <div className="row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
                      <pre style={{ fontSize: 11, margin: 0, flex: 1, overflow: 'auto' }}>
                        {JSON.stringify(a.details.before, null, 1)}
                      </pre>
                      <pre style={{ fontSize: 11, margin: 0, flex: 1, overflow: 'auto' }}>
                        {JSON.stringify(a.details.after, null, 1)}
                      </pre>
                    </div>
                  </details>
                ) : a.details ? (
                  <span className="muted" style={{ fontSize: 12 }}>{JSON.stringify(a.details)}</span>
                ) : (
                  ''
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function openPdf(path: string) {
  const res = await fetch(path, {
    headers: { authorization: `Bearer ${localStorage.getItem('token')}` },
  });
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
}

// ---------------- Payment modal (receive on invoice / pay on bill) ----------------

function PaymentModal({ doc, onClose, side }: { doc: any; onClose: () => void; side: 'receive' | 'pay' }) {
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(String(Number(doc.balance_due)));
  const [rate, setRate] = useState(String(Number(doc.exchange_rate)));
  const [reference, setReference] = useState('');
  const [withholdings, setWithholdings] = useState<Array<{ taxCodeId: string; amount: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const { data: taxCodes } = useFetch<any[]>(co('/tax-codes'));
  const { data: companyData } = useFetch<any>(co(''));
  const isForeign = companyData && doc.currency !== companyData.base_currency;

  const whCodes = (taxCodes ?? []).filter((t) =>
    t.is_withholding && (side === 'receive' ? t.sales_account_id : t.purchase_account_id));
  const whTotal = withholdings.reduce((a, w) => a + (Number(w.amount) || 0), 0);
  const cash = (Number(amount) || 0) - whTotal;

  async function submit() {
    setError(null);
    const body: any = {
      contactId: doc.customer_id ?? doc.vendor_id,
      paymentDate: date,
      currency: doc.currency,
      exchangeRate: isForeign ? rate : undefined,
      reference: reference || null,
      allocations: [side === 'receive' ? { invoiceId: doc.id, amount } : { billId: doc.id, amount }],
      withholdings: withholdings.filter((w) => w.taxCodeId && Number(w.amount) > 0),
    };
    if (side === 'receive') body.depositAccountId = accountId;
    else body.paymentAccountId = accountId;
    await api.post(co(side === 'receive' ? '/sales/payments' : '/purchases/payments'), body);
    onClose();
  }

  return (
    <Modal open title={side === 'receive' ? `Receive payment — ${doc.doc_no}` : `Pay bill — ${doc.doc_no}`} onClose={onClose}>
      <ErrorMsg error={error} />
      <div className="row">
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={side === 'receive' ? 'Deposit to' : 'Pay from'}>
          <ApiSelect
            path={co('/accounts')}
            value={accountId}
            onChange={setAccountId}
            filter={(a) => ['bank', 'cash', 'current_asset'].includes(a.subtype) && a.type === 'asset'}
            format={(a) => `${a.code} ${a.name}`}
          />
        </Field>
      </div>
      <div className="row">
        <Field label={`Amount settled (${doc.currency})`}>
          <input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {isForeign && (
          <Field label="Exchange rate today">
            <input className="num" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        )}
        <Field label="Reference"><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      {whCodes.length > 0 && (
        <>
          <h2 style={{ marginTop: 6 }}>Tax withheld at source</h2>
          {withholdings.map((w, i) => (
            <div className="row" key={i}>
              <Field label="Tax code">
                <select value={w.taxCodeId}
                  onChange={(e) => setWithholdings((ws) => ws.map((x, j) => j === i ? { ...x, taxCodeId: e.target.value } : x))}>
                  <option value="">—</option>
                  {whCodes.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate)}%)</option>)}
                </select>
              </Field>
              <Field label="Amount withheld">
                <input className="num" value={w.amount}
                  onChange={(e) => setWithholdings((ws) => ws.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
              </Field>
              <button className="btn secondary sm" style={{ marginBottom: 10 }}
                onClick={() => setWithholdings((ws) => ws.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn secondary sm" onClick={() => setWithholdings((ws) => [...ws, { taxCodeId: '', amount: '' }])}>
            + Add withholding
          </button>
        </>
      )}
      <p>
        <strong>{side === 'receive' ? 'Cash received' : 'Cash paid'}: {doc.currency} {fmtMoney(cash)}</strong>
        {whTotal > 0 && <span className="muted"> (after {fmtMoney(whTotal)} withheld)</span>}
      </p>
      <AsyncButton onClick={submit} onError={setError}>
        {side === 'receive' ? 'Record receipt' : 'Record payment'}
      </AsyncButton>
    </Modal>
  );
}

// ---------------- Apply credit modal ----------------

function ApplyModal({ kind, doc, target, onClose }: {
  kind: DocKind; doc: any; target: { kind: DocKind; label: string }; onClose: () => void;
}) {
  const cfg = CONFIG[kind];
  const targetCfg = CONFIG[target.kind];
  const [targetId, setTargetId] = useState('');
  const [amount, setAmount] = useState(String(Number(doc.balance)));
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body =
      target.kind === 'invoice' ? { invoiceId: targetId, amount } : { billId: targetId, amount };
    await api.post(co(`${cfg.base}/${doc.id}/apply`), body);
    onClose();
  }

  return (
    <Modal open title={`Apply ${doc.doc_no}`} onClose={onClose}>
      <ErrorMsg error={error} />
      <Field label={`Open ${target.label}`}>
        <ApiSelect
          path={co(`${targetCfg.base}?status=open`)}
          value={targetId}
          onChange={setTargetId}
          filter={(d) =>
            (d.customer_id ?? d.vendor_id) === (doc.customer_id ?? doc.vendor_id) &&
            d.currency === doc.currency}
          format={(d) => `${d.doc_no} — balance ${fmtMoney(d.balance_due)}`}
        />
      </Field>
      <Field label="Amount to apply">
        <input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <AsyncButton onClick={submit} onError={setError}>Apply credit</AsyncButton>
    </Modal>
  );
}
