import { co, fmtMoney } from '../api';
import { Badge, ErrorMsg, Spinner, useFetch } from '../components';

export default function Payments() {
  const { data, error, loading } = useFetch<any[]>(co('/sales/payments'));
  return (
    <div>
      <h1>Payments</h1>
      <ErrorMsg error={error} />
      {loading ? <Spinner /> : (
        <table className="grid">
          <thead>
            <tr>
              <th>Number</th><th>Direction</th><th>Contact</th><th>Date</th>
              <th>Reference</th><th className="num">Cash amount</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.doc_no}</td>
                <td>{p.kind === 'receive' ? 'Received' : 'Paid'}</td>
                <td>{p.contact_name}</td>
                <td>{p.payment_date}</td>
                <td>{p.reference}</td>
                <td className="num">{p.currency} {fmtMoney(p.amount)}</td>
                <td><Badge status={p.status} /></td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={7} className="muted">No payments yet.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}
