import React, { useState } from 'react';
import { api, allowed, when } from '../api.js';
import { Gate, Problem, Done, useLoad, useAction } from './common.jsx';

// Members, invites, role changes, suspension, removal.
// Which buttons exist comes from the org-level permissions in `me`; whether a particular
// change is allowed (rank rules, last owner) is decided by the server, and its refusal is
// shown here in its own words.
export default function People({ me, onChanged }) {
  const org = me.org;
  const canInvite = allowed(me.permissions['user:invite']);
  const members = useLoad(() => api.get(`/orgs/${org.id}/members`), org.id);
  const roles = useLoad(() => api.get('/roles'), 'roles');
  const invites = useLoad(() => (canInvite ? api.get(`/orgs/${org.id}/invites`) : Promise.resolve({ invites: [] })),
    `${org.id}:${canInvite}`);
  const action = useAction(async () => { await members.reload(); await invites.reload(); await onChanged(); });

  const [inviting, setInviting] = useState(false);
  const [draft, setDraft] = useState({ email: '', role: '' });
  const [link, setLink] = useState(null);

  const roleKeys = roles.data?.roles.map((r) => r.key) ?? [];
  const path = (m, suffix = '') => `/orgs/${org.id}/members/${m.id}${suffix}`;

  const sendInvite = async (e) => {
    e.preventDefault();
    const out = await action.run(() => api.post(`/orgs/${org.id}/invites`, {
      email: draft.email.trim(), role: draft.role || roleKeys[roleKeys.length - 1],
    }), 'Invite created.');
    if (out) {
      // Shown once: the server keeps only a hash of this token.
      setLink(`${window.location.origin}/invite/${out.inviteToken}`);
      setDraft({ email: '', role: '' });
      setInviting(false);
    }
  };

  return (
    <section>
      <div className="toolbar">
        <Gate permission="user:invite" entry={me.permissions['user:invite']} testid="invite-user"
              kind="primary" onClick={() => setInviting((v) => !v)}>
          Invite someone
        </Gate>
      </div>

      {inviting && (
        <form className="inline-form" onSubmit={sendInvite}>
          <input placeholder="email address" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          <select value={draft.role || roleKeys[roleKeys.length - 1] || ''} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
            {roleKeys.map((r) => <option key={r}>{r}</option>)}
          </select>
          <button className="btn primary" type="submit" disabled={action.busy}>Send invite</button>
        </form>
      )}

      {link && (
        <div className="done" role="status">
          Invite link — copy it now, it is shown only once:<br /><code className="wrap">{link}</code>
          <button type="button" className="x" onClick={() => setLink(null)} aria-label="dismiss">×</button>
        </div>
      )}
      <Problem error={action.error ?? members.error} testid="people-error" onClose={action.clear} />
      <Done text={action.done} onClose={action.clear} />

      {!members.data ? <p className="muted">Loading people…</p> : (
        <table data-testid="people-table">
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Manage</th></tr></thead>
          <tbody>
            {members.data.members.map((m) => {
              const self = m.id === me.user.id;
              return (
                <tr key={m.id} data-testid="user-row" data-user-id={m.id}>
                  <td>
                    <div className="strong">{m.name}{self && <span className="tag">you</span>}</div>
                    <div className="sub">{m.email}</div>
                  </td>
                  <td>
                    {!self && allowed(me.permissions['user:role:update']) ? (
                      <select value={m.role} data-testid="role-select" data-permission="user:role:update"
                              data-state="unlocked" disabled={action.busy}
                              onChange={(e) => action.run(() => api.patch(path(m), { role: e.target.value }),
                                `${m.name} is now ${e.target.value}.`)}>
                        {(roleKeys.includes(m.role) ? roleKeys : [m.role, ...roleKeys]).map((r) => <option key={r}>{r}</option>)}
                      </select>
                    ) : m.role}
                  </td>
                  <td><span className={`tag ${m.status === 'active' ? 'good' : 'bad'}`}>{m.status}</span></td>
                  <td>
                    {!self && (
                      <div className="row-actions">
                        {m.status === 'active' ? (
                          <Gate permission="user:remove" entry={me.permissions['user:remove']} testid="suspend-user"
                                onClick={() => action.run(() => api.post(path(m, '/suspend')), `${m.name} suspended.`)}>
                            Suspend
                          </Gate>
                        ) : (
                          <Gate permission="user:remove" entry={me.permissions['user:remove']} testid="suspend-user"
                                onClick={() => action.run(() => api.del(path(m, '/suspend')), `${m.name} reinstated.`)}>
                            Reinstate
                          </Gate>
                        )}
                        <Gate permission="user:remove" entry={me.permissions['user:remove']} testid="remove-user" kind="danger"
                              onClick={() => window.confirm(`Remove ${m.name} from ${org.name}?`)
                                && action.run(() => api.del(path(m)), `${m.name} removed.`)}>
                          Remove
                        </Gate>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {canInvite && invites.data?.invites.length > 0 && (
        <>
          <h3>Pending invites</h3>
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {invites.data.invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td><td>{i.role}</td><td className="sub">{when(i.expires_at)}</td>
                  <td>
                    <Gate permission="user:invite" entry={me.permissions['user:invite']} testid="cancel-invite"
                          onClick={() => action.run(() => api.del(`/orgs/${org.id}/invites/${i.id}`), 'Invite cancelled.')}>
                      Cancel
                    </Gate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
