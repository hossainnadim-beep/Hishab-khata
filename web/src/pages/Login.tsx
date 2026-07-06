import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';
import { ErrorMsg, Field } from '../components';

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'login' ? { email, password } : { email, password, name };
      const res = await api.post(`/api/auth/${mode}`, body);
      setToken(res.token);
      navigate('/companies');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brandmark">Khata Books</div>
        <p className="muted" style={{ textAlign: 'center', marginTop: 0 }}>
          Simple accounting for your business
        </p>
        <ErrorMsg error={error} />
        {mode === 'register' && (
          <Field label="Your name">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        )}
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </Field>
        <button className="btn" style={{ width: '100%', marginTop: 8 }} disabled={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <p style={{ textAlign: 'center' }}>
          {mode === 'login' ? (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode('register'); }}>
              New here? Create an account
            </a>
          ) : (
            <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); }}>
              Already registered? Sign in
            </a>
          )}
        </p>
      </form>
    </div>
  );
}
