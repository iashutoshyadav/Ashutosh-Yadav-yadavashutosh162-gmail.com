import React, { useCallback, useEffect, useState } from 'react';
import { allowed, explain } from '../api.js';

// A permission-gated control. PRESENT or ABSENT, never disabled:
// if the server's entry for this permission is not `allow`, nothing is rendered at all.
// `entry` always comes from a server response — there is no role logic in web/.
export function Gate({ permission, entry, testid, onClick, children, busy = false, kind = 'ghost' }) {
  if (!allowed(entry)) return null;
  return (
    <button type="button" className={`btn ${kind}`} data-testid={testid}
            data-permission={permission} data-state="unlocked"
            title={`allowed by ${entry.source}`} disabled={busy} onClick={onClick}>
      {children}
    </button>
  );
}

// A failure, said on screen: the code, and a sentence a person can act on.
// `error` is either a thrown error or an already-explained { code, message }.
export function Problem({ error, testid, onClose }) {
  if (!error) return null;
  const { code, message } = error instanceof Error ? explain(error) : error;
  return (
    <div className="problem" role="alert" data-testid={testid} data-error-code={code}>
      <strong>{code}</strong> {message}
      {onClose && <button type="button" className="x" onClick={onClose} aria-label="dismiss">×</button>}
    </div>
  );
}

// A short success line.
export function Done({ text, onClose }) {
  if (!text) return null;
  return (
    <div className="done" role="status">
      {text}
      <button type="button" className="x" onClick={onClose} aria-label="dismiss">×</button>
    </div>
  );
}

// Load something from the API when the card mounts (and whenever `key` changes).
// Every card refetches on mount, so the console never shows a cached permission.
export function useLoad(fetcher, key) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      setData(await fetcher());
      setError(null);
    } catch (err) {
      setError(err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { setData(null); reload(); }, [reload]);
  return { data, error, reload };
}

// Run a mutation, then refresh; failures and successes land in the card's own state.
export function useAction(after) {
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(fn, successText) {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const out = await fn();
      if (successText) setDone(typeof successText === 'function' ? successText(out) : successText);
      await after?.();
      return out;
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, error, done, clear: () => { setError(null); setDone(null); } };
}
