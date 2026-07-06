import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, hasToken, setCompanyId } from '../api';
import { ErrorMsg, Field, Spinner, useFetch } from '../components';

export default function Companies() {
  const navigate = useNavigate();
  const { data, loading } = useFetch<any>('/api/auth/me');
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('BDT');
  const [fyMonth, setFyMonth] = useState(7);
  const [country, setCountry] = useState('BD');
  const [error, setError] = useState<string | null>(null);

  if (!hasToken()) return <Navigate to="/login" replace />;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const company = await api.post('/api/companies', {
        name,
        baseCurrency: currency,
        fiscalYearStartMonth: Number(fyMonth),
        country,
      });
      setCompanyId(company.id);
      navigate('/');
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ width: 460 }}>
        <div className="brandmark">Khata Books</div>
        <h1 style={{ fontSize: 16 }}>Choose a company</h1>
        {loading ? (
          <Spinner />
        ) : (
          <>
            {(data?.companies ?? []).map((c: any) => (
              <button
                key={c.id}
                className="btn secondary"
                style={{ width: '100%', marginBottom: 8, textAlign: 'left' }}
                onClick={() => {
                  setCompanyId(c.id);
                  navigate('/');
                }}
              >
                <strong>{c.name}</strong>
                <span className="muted"> — {c.base_currency} · {c.role}</span>
              </button>
            ))}
            {!data?.companies?.length && <p className="muted">No companies yet.</p>}
          </>
        )}
        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
        {!showNew ? (
          <button className="btn" style={{ width: '100%' }} onClick={() => setShowNew(true)}>
            + Create a new company
          </button>
        ) : (
          <form onSubmit={create}>
            <ErrorMsg error={error} />
            <Field label="Company name">
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <div className="row">
              <Field label="Country">
                <select value={country} onChange={(e) => setCountry(e.target.value)}>
                  <option value="BD">Bangladesh</option>
                  <option value="XX">Other</option>
                </select>
              </Field>
              <Field label="Base currency">
                <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} style={{ width: 70 }} />
              </Field>
              <Field label="Fiscal year starts">
                <select value={fyMonth} onChange={(e) => setFyMonth(Number(e.target.value))}>
                  {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="btn" style={{ width: '100%' }}>Create company</button>
          </form>
        )}
      </div>
    </div>
  );
}
