import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { api, bumpData, getCompanyId, getToken, hasToken, setCompanyId, setToken } from './api';
import { useFetch } from './components';
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
import AccountTransactions from './pages/AccountTransactions';

const NAV = [
  { section: null, items: [{ to: '/', label: 'Dashboard', icon: '⌂' }] },
  {
    section: 'Sales',
    items: [
      { to: '/invoices', label: 'Invoices', icon: '▤' },
      { to: '/quotes', label: 'Quotes', icon: '✎' },
      { to: '/credit-notes', label: 'Credit Notes', icon: '↩' },
      { to: '/recurring', label: 'Recurring', icon: '⟳' },
      { to: '/customers', label: 'Customers', icon: '☺' },
    ],
  },
  {
    section: 'Purchases',
    items: [
      { to: '/bills', label: 'Bills', icon: '▥' },
      { to: '/vendor-credits', label: 'Vendor Credits', icon: '↪' },
      { to: '/expense-claims', label: 'Expense Claims', icon: '✈' },
      { to: '/vendors', label: 'Vendors', icon: '⚒' },
    ],
  },
  {
    section: 'Money & Stock',
    items: [
      { to: '/banking', label: 'Banking', icon: '⛁' },
      { to: '/payments', label: 'Payments', icon: '⇄' },
      { to: '/items', label: 'Items', icon: '◫' },
    ],
  },
  {
    section: 'Accounting',
    items: [
      { to: '/journal', label: 'Journal', icon: '≡' },
      { to: '/reports', label: 'Reports', icon: '◔' },
      { to: '/settings', label: 'Settings', icon: '⚙' },
    ],
  },
];

const QUICK_CREATE = [
  { label: 'Invoice', to: '/invoices/new' },
  { label: 'Quote', to: '/quotes/new' },
  { label: 'Credit note', to: '/credit-notes/new' },
  { label: 'Bill', to: '/bills/new' },
  { label: 'Vendor credit', to: '/vendor-credits/new' },
];

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.get(`/api/companies/${getCompanyId()}/search?q=${encodeURIComponent(q)}`)
        .then((r) => { setResults(r); setOpen(true); })
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, []);

  return (
    <div className="global-search" ref={boxRef}>
      <input
        ref={inputRef}
        placeholder="Search ( / )  — invoices, contacts, accounts…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
      />
      {open && results && (
        <div className="search-results">
          {results.length === 0 && <div className="search-empty">No matches</div>}
          {results.map((r, i) => (
            <button
              key={i}
              className="search-result"
              onClick={() => {
                setOpen(false);
                setQ('');
                navigate(r.route);
              }}
            >
              <span className="search-type">{r.type}</span>
              <span>{r.label}</span>
              <span className="muted">{r.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuickCreate() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);
  return (
    <div className="quick-create" ref={ref}>
      <button className="btn qc-btn" onClick={() => setOpen(!open)} title="Quick create">
        ＋<span className="qc-label"> New</span>
      </button>
      {open && (
        <div className="qc-menu">
          {QUICK_CREATE.map((item) => (
            <button key={item.to} onClick={() => { setOpen(false); navigate(item.to); }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { data: company } = useFetch<any>(`/api/companies/${getCompanyId()}`);
  const [collapsed, setCollapsed] = useState(localStorage.getItem('navCollapsed') === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Live updates: any posting in this company (any session) bumps the data bus.
  useEffect(() => {
    const es = new EventSource(
      `/api/companies/${getCompanyId()}/events?token=${encodeURIComponent(getToken() ?? '')}`,
    );
    es.onmessage = () => bumpData();
    return () => es.close();
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('navCollapsed', next ? '1' : '0');
  };

  const nav = (
    <nav onClick={() => setDrawerOpen(false)}>
      {NAV.map((group, gi) => (
        <div key={gi}>
          {group.section && <div className="section">{group.section}</div>}
          {group.items.map((item) => (
            <NavLink key={item.to} to={item.to} title={item.label} end={item.to === '/'}>
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
      <div className="spacer" />
      <a href="/companies" onClick={(e) => { e.preventDefault(); navigate('/companies'); }}>
        <span className="nav-icon">⇆</span><span className="nav-label">Switch company</span>
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
        <span className="nav-icon">⏻</span><span className="nav-label">Sign out</span>
      </a>
    </nav>
  );

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <header className="topbar">
        <button className="icon-btn hamburger" onClick={() => setDrawerOpen(true)} aria-label="Menu">☰</button>
        <button className="icon-btn rail-toggle" onClick={toggleCollapsed} aria-label="Collapse menu">☰</button>
        <span className="brand">Khata Books</span>
        <GlobalSearch />
        <QuickCreate />
        <span className="topbar-company" title={company?.role}>
          {company?.name ?? ''}
        </span>
      </header>
      <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
        <div className="sidebar-head">
          <span className="brand">Khata Books</span>
          <button className="icon-btn hamburger" onClick={() => setDrawerOpen(false)} aria-label="Close">✕</button>
        </div>
        {nav}
      </aside>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <main className="main">{children}</main>
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
      <Route path="/accounts/:id/transactions" element={<Protected><AccountTransactions /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
