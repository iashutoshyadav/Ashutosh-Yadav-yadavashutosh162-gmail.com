import React from 'react';
import { api, allowed, when } from '../api.js';
import { Gate, Problem, Done, useLoad, useAction } from './common.jsx';

// Sessions are records. A session keeps the authority it started with until it ends or
// expires, so a row can be `active` while that device's Control button is gone — they
// answer different questions, and this view does not try to reconcile them.
export default function Sessions({ me, goTo }) {
  const org = me.org;
  const { data, error, reload } = useLoad(() => api.get(`/orgs/${org.id}/sessions`), org.id);
  const action = useAction(reload);

  // Your own session can always be stopped; someone else's needs session:terminate.
  const stopEntry = (s) => (s.user_id === me.user.id
    ? { effect: 'allow', source: 'your own session' }
    : me.permissions['session:terminate']);

  return (
    <section>
      <div className="toolbar">
        <Gate permission="session:start" entry={me.permissions['session:start']} testid="new-session"
              kind="primary" onClick={() => goTo('devices')}>
          Start a session
        </Gate>
        {allowed(me.permissions['session:start']) && <span className="muted">— choose a device and a mode</span>}
      </div>

      <Problem error={action.error ?? error} testid="sessions-error" onClose={action.clear} />
      <Done text={action.done} onClose={action.clear} />

      {!data ? <p className="muted">Loading sessions…</p> : data.sessions.length === 0 ? (
        <div className="empty">No sessions in {org.name} yet.</div>
      ) : (
        <table data-testid="sessions-table">
          <thead><tr><th>Device</th><th>Who</th><th>Mode</th><th>State</th><th>Started</th><th>Ends / ended</th><th /></tr></thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id} data-testid="session-row" data-session-id={s.id} data-mode={s.mode} data-session-state={s.state}>
                <td className="strong">{s.device_name}</td>
                <td>{s.user_name}</td>
                <td><span className="tag">{s.mode}</span></td>
                <td><span className={`tag ${s.state === 'active' ? 'good' : ''}`}>{s.state}</span></td>
                <td className="sub">{when(s.started_at)}</td>
                <td className="sub">
                  {s.state === 'active' ? `expires ${when(s.expires_at)}` : `${when(s.ended_at)} · ${s.end_reason ?? ''}`}
                </td>
                <td>
                  {s.state === 'active' && (
                    <Gate permission={s.user_id === me.user.id ? 'own-session' : 'session:terminate'}
                          entry={stopEntry(s)} testid="stop-session" kind="danger"
                          onClick={() => action.run(() => api.del(`/sessions/${s.id}`), 'Session ended.')}>
                      Stop
                    </Gate>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
