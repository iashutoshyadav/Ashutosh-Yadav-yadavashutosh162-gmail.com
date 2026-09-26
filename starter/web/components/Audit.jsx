import React, { useState } from 'react';
import { api, when } from '../api.js';
import { Problem, useLoad } from './common.jsx';

const PAGE = 50;

// Append-only: there is nothing to edit or delete here because there is no route for it.
// Refused attempts are listed alongside successful ones, with the reason code.
export default function Audit({ me }) {
  const org = me.org;
  const [offset, setOffset] = useState(0);
  const [only, setOnly] = useState('all');
  const { data, error } = useLoad(() => api.get(`/orgs/${org.id}/audit?limit=${PAGE}&offset=${offset}`), `${org.id}:${offset}`);

  const events = data?.events.filter((e) => only === 'all' || e.result === only) ?? [];

  return (
    <section>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="filter">
          {['all', 'allow', 'deny'].map((k) => (
            <button key={k} type="button" className={only === k ? 'on' : ''} aria-pressed={only === k}
                    data-testid={`audit-filter-${k}`} onClick={() => setOnly(k)}>{k}</button>
          ))}
        </div>
      </div>
      <Problem error={error} testid="audit-error" />

      {!data ? <p className="muted">Loading audit log…</p> : (
        <>
          <table data-testid="audit-table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th><th>Reason</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-testid="audit-row" data-result={e.result} data-action={e.action}>
                  <td className="sub">{when(e.at)}</td>
                  <td className="sub">{e.actor_id ?? '—'}</td>
                  <td><code>{e.action}</code></td>
                  <td className="sub">{e.target_type ? `${e.target_type} ${e.target_id ?? ''}` : '—'}</td>
                  <td><span className={`tag ${e.result === 'allow' ? 'good' : 'bad'}`}>{e.result}</span></td>
                  <td className="sub">{e.reason_code ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && <div className="empty">Nothing on this page.</div>}
          <div className="pager">
            <button type="button" className="btn ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
            <span className="muted">{offset + 1}–{offset + data.events.length}</span>
            <button type="button" className="btn ghost" disabled={data.events.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</button>
          </div>
        </>
      )}
    </section>
  );
}
