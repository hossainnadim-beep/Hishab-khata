import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

/** Fetch-on-mount hook with manual reload. */
export function useFetch<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Reset synchronously when the path changes so consumers never see the
  // previous path's data shape during the render before the fetch effect runs.
  const [lastPath, setLastPath] = useState(path);
  if (path !== lastPath) {
    setLastPath(path);
    setData(null);
    setLoading(true);
  }
  const reload = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api
      .get(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [path, ...deps]);
  return { data, error, loading, reload };
}

export function ErrorMsg({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="error">{error}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace(/_/g, ' ')}</span>;
}

export function Spinner() {
  return <p className="muted">Loading…</p>;
}

/** Async submit button that surfaces API errors to the parent. */
export function AsyncButton({
  onClick,
  children,
  className = 'btn',
  onError,
  confirm,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  onError?: (msg: string) => void;
  confirm?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onClick();
        } catch (e: any) {
          onError?.(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <dialog className="modal" open>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <strong style={{ fontSize: 16 }}>{title}</strong>
        <button className="btn secondary sm" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}

/** Select fed from an API list. */
export function ApiSelect({
  path,
  value,
  onChange,
  labelKey = 'name',
  valueKey = 'id',
  filter,
  placeholder = '— select —',
  format,
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
  labelKey?: string;
  valueKey?: string;
  filter?: (row: any) => boolean;
  placeholder?: string;
  format?: (row: any) => string;
}) {
  const { data } = useFetch<any[]>(path);
  const rows = (data ?? []).filter(filter ?? (() => true));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {rows.map((r) => (
        <option key={r[valueKey]} value={r[valueKey]}>
          {format ? format(r) : r[labelKey]}
        </option>
      ))}
    </select>
  );
}
