import { Link, useNavigate } from 'react-router-dom';
import { co, fmtMoney, today } from '../api';
import { Spinner, useFetch } from '../components';

export default function Dashboard() {
  const monthStart = today().slice(0, 8) + '01';
  const { data: pl } = useFetch<any>(co(`/reports/profit-loss?from=${monthStart}&to=${today()}`));
  const { data: banks } = useFetch<any[]>(co('/banking/accounts'));
  const { data: ar } = useFetch<any>(co(`/reports/ar-aging?as_of=${today()}`));
  const { data: ap } = useFetch<any>(co(`/reports/ap-aging?as_of=${today()}`));
  const { data: activity } = useFetch<any[]>(co('/activity?limit=12'));

  const cash = (banks ?? []).reduce((a, b) => a + Number(b.balance), 0);
  const navigate = useNavigate();

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="kpis">
        <div className="kpi clickable" onClick={() => navigate('/banking')}>
          <div className="label">Cash & bank</div>
          <div className="value">{fmtMoney(cash)}</div>
        </div>
        <div className="kpi clickable" onClick={() => navigate('/invoices?status=open')}>
          <div className="label">Owed to you (AR)</div>
          <div className="value">{fmtMoney(ar?.totals?.total ?? 0)}</div>
        </div>
        <div className="kpi clickable" onClick={() => navigate('/bills?status=open')}>
          <div className="label">You owe (AP)</div>
          <div className="value">{fmtMoney(ap?.totals?.total ?? 0)}</div>
        </div>
        <div className="kpi clickable" onClick={() => navigate('/reports')}>
          <div className="label">Profit this month</div>
          <div className="value">{fmtMoney(pl?.netIncome ?? 0)}</div>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Quick actions</h2>
            <div className="row">
              <Link className="btn" to="/invoices/new">+ Invoice</Link>
              <Link className="btn secondary" to="/bills/new">+ Bill</Link>
              <Link className="btn secondary" to="/quotes/new">+ Quote</Link>
              <Link className="btn secondary" to="/banking">Bank import</Link>
              <Link className="btn secondary" to="/reports">Reports</Link>
            </div>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Bank accounts</h2>
            {!banks ? <Spinner /> : (
              <table className="grid">
                <tbody>
                  {banks.map((b) => (
                    <tr key={b.id}>
                      <td><Link to={`/accounts/${b.id}/transactions`}>{b.name}{b.currency ? ` (${b.currency})` : ''}</Link></td>
                      <td className="num">{fmtMoney(b.balance)}</td>
                      <td className="right">
                        {b.unmatched_count > 0 && (
                          <Link to="/banking" className="badge unmatched">{b.unmatched_count} to review</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Recent activity</h2>
            {!activity ? <Spinner /> : (
              <table className="grid">
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td>{a.action.replace(/[._]/g, ' ')}</td>
                      <td className="muted">{a.user_name ?? ''}</td>
                      <td className="muted right">{new Date(a.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {!activity.length && <tr><td className="muted">No activity yet.</td></tr>}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
