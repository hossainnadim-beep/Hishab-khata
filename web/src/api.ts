let token: string | null = localStorage.getItem('token');
let companyId: string | null = localStorage.getItem('companyId');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export function setCompanyId(id: string | null) {
  companyId = id;
  if (id) localStorage.setItem('companyId', id);
  else localStorage.removeItem('companyId');
}

export function getCompanyId() {
  return companyId;
}

export function hasToken() {
  return !!token;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---- data change bus: any successful mutation (or SSE posting event from
// another session) notifies subscribers so mounted views refetch instantly ----
const changeListeners = new Set<() => void>();
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

export function onDataChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function bumpData() {
  if (bumpTimer) clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => {
    for (const l of changeListeners) l();
  }, 150);
}

export function getToken() {
  return token;
}

async function request(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new ApiError(401, 'Session expired');
  }
  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? 'Request failed');
  if (method !== 'GET') bumpData();
  return data;
}

export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body?: unknown) => request('POST', path, body),
  patch: (path: string, body?: unknown) => request('PATCH', path, body),
  delete: (path: string) => request('DELETE', path),
};

/** Company-scoped path helper. */
export function co(path: string): string {
  return `/api/companies/${companyId}${path}`;
}

export function fmtMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
