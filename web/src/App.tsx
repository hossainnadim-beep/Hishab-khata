import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, hasToken, getCompanyId, setCompanyId, setToken } from './api';
import Login from './pages/Login';
import Companies from './pages/Companies';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Items from './pages/Items';
import { DocList, DocForm, DocDetail } from './pages/Documents';
import Payments from './pages/Payments';
import Recurring from './pages/Recurring';
import ExpenseClaims from './pages/ExpenseClaims';
import Banking from './pages/Banking';
import Journal from './pages/Journal';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [company, setCompany] = useState<any>(null);
  useEffect(() => {
    api.get(`/api/companies/${getCompanyId()}`).then(setCompany).catch(() => navigate('/companies'));
  }, [navigate]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">Khata Books</div>
        <nav>
          <NavLink to="/">Dashboard</NavLink>
          <div className="section">Sales</div>
          <NavLink to="/invoices">Invoices</NavLink>
          <NavLink to="/quotes">Quotes</NavLink>
          <NavLink to="/credit-notes">Credit Notes</NavLink>
          <NavLink to="/recurring">Recurring</NavLink>
          <NavLink to="/customers">Customers</NavLink>
          <div className="section">Purchases</div>
          <NavLink to="/bills">Bills</NavLink>
          <NavLink to="/vendor-credits">Vendor Credits</NavLink>
          <NavLink to="/expense-claims">Expense Claims</NavLink>
          <NavLink to="/vendors">Vendors</NavLink>
          <div className="section">Money & Stock</div>
          <NavLink to="/banking">Banking</NavLink>
          <NavLink to="/payments">Payments</NavLink>
          <NavLink to="/items">Items</NavLink>
          <div className="section">Accounting</div>
          <NavLink to="/journal">Journal</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <div className="spacer" />
          <a
            href="/companies"
            onClick={(e) => {
              e.preventDefault();
              navigate('/companies');
            }}
          >
            ⇄ Switch company
          </a>
          <a
            href="/login"
            onClick={(e) => {
              e.preventDefault();
              setToken(null);
              setCompanyId(null);
              navigate('/login');
            }}
          >
            Sign out
          </a>
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="company">{company?.name ?? ''}</span>
          <span className="muted">{company ? `${company.base_currency} · ${company.role}` : ''}</span>
        </div>
        {children}
      </main>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  if (!hasToken()) return <Navigate to="/login" replace />;
  if (!getCompanyId()) return <Navigate to="/companies" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/companies" element={<Companies />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/customers" element={<Protected><Contacts kind="customer" /></Protected>} />
      <Route path="/vendors" element={<Protected><Contacts kind="vendor" /></Protected>} />
      <Route path="/items" element={<Protected><Items /></Protected>} />
      {(['invoice', 'quote', 'credit-note', 'bill', 'vendor-credit'] as const).map((kind) => (
        <Route key={kind} path={`/${kind}s`}>
          <Route index element={<Protected><DocList kind={kind} /></Protected>} />
          <Route path="new" element={<Protected><DocForm kind={kind} /></Protected>} />
          <Route path=":id" element={<Protected><DocDetail kind={kind} /></Protected>} />
          <Route path=":id/edit" element={<Protected><DocForm kind={kind} /></Protected>} />
        </Route>
      ))}
      <Route path="/payments" element={<Protected><Payments /></Protected>} />
      <Route path="/recurring" element={<Protected><Recurring /></Protected>} />
      <Route path="/expense-claims" element={<Protected><ExpenseClaims /></Protected>} />
      <Route path="/banking/*" element={<Protected><Banking /></Protected>} />
      <Route path="/journal/*" element={<Protected><Journal /></Protected>} />
      <Route path="/reports/*" element={<Protected><Reports /></Protected>} />
      <Route path="/settings/*" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
