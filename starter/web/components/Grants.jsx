import React, { useState } from 'react';
import { api, when } from '../api.js';
import { Gate, Problem, Done, useLoad, useAction } from './common.jsx';

// Grants: per-person changes to what their role gives them. `allow` adds, `deny` removes,
// and a deny always wins. The permission checklist is the server's catalogue (the keys of
// the resolved set in `me`), so a permission added to the database appears here with no edit.
export default function Grants({ me, onChanged }) {
  const org = me.org;
  const load = () => Promise.all([
    api.get(`/orgs/${org.id}/grants`),
    api.get(`/orgs/${org.id}/members`),
    api.get(`/orgs/${org.id}/devices`).catch(() => ({ devices: [] })),   // device:list may be missing
  ]).then(([g, m, d]) => ({ grants: g.grants, members: m.members, devices: d.devices }));

  const { data, error, reload } = useLoad(load, org.id);
  const action = useAction(async () => { await reload(); await onChanged(); });
  const [open, setOpen] = useState(false);
  const blank = { userId: '', deviceId: '', effect: 'allow', permissions: [], expiresAt: '' };
  const [form, setForm] = useState(blank);

  const catalogue = Object.keys(me.permissions).sort();
  const toggle = (key) => setForm((f) => ({
    ...f, permissions: f.permissions.includes(key) ? f.permissions.filter((p) => p !== key) : [...f.permissions, key],
  }));

  const submit = async (e) => {
    e.preventDefault();
    const out = await action.run(() => api.post(`/orgs/${org.id}/grants`, {
      userId: form.userId,
      deviceId: form.deviceId || null,
      effect: form.effect,
      permissions: form.permissions,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    }), 'Grant created. It applies on that person\'s next request.');
    if (out) { setForm(blank); setOpen(false); }
  };

  const personName = (id) => data?.members.find((m) => m.id === id)?.name ?? id;
  const deviceName = (id) => (id ? data?.devices.find((d) => d.id === id)?.name ?? id : 'whole organization');

  return (
    <section>
      <div className="toolbar">
        <Gate permission="grant:create" entry={me.permissions['grant:create']} testid="new-grant"
              kind="primary" onClick={() => setOpen((v) => !v)}>
          New grant
        </Gate>
      </div>

      {open && data && (
        <form className="panel grant-form" onSubmit={submit} data-testid="grant-form">
          <div className="grid2">
            <div>
              <label htmlFor="g-user">Person</label>
              <select id="g-user" data-testid="grant-user" value={form.userId}
                      onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                <option value="">choose…</option>
                {data.members.filter((m) => m.status === 'active' && m.id !== me.user.id).map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="g-device">Where</label>
              <select id="g-device" data-testid="grant-device" value={form.deviceId}
                      onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
                <option value="">whole organization</option>
                {data.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="g-effect">Effect</label>
              <select id="g-effect" data-testid="grant-effect" value={form.effect}
                      onChange={(e) => setForm({ ...form, effect: e.target.value })}>
                <option value="allow">allow — add to their role</option>
                <option value="deny">deny — take away (always wins)</option>
              </select>
            </div>
            <div>
              <label htmlFor="g-exp">Expires (optional)</label>
              <input id="g-exp" type="datetime-local" value={form.expiresAt}
                     onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </div>
          </div>

          <label>Permissions</label>
          <div className="checks">
            {catalogue.map((key) => (
              <label key={key} className="check">
                <input type="checkbox" data-testid="grant-permission" data-permission-key={key}
                       checked={form.permissions.includes(key)} onChange={() => toggle(key)} />
                <code>{key}</code>
              </label>
            ))}
          </div>
          <button className="btn primary" type="submit" data-testid="grant-submit" disabled={action.busy}>
            Create grant
          </button>
        </form>
      )}

      <Problem error={action.error ?? error} testid="grants-error" onClose={action.clear} />
      <Done text={action.done} onClose={action.clear} />

      {!data ? <p className="muted">Loading grants…</p> : data.grants.length === 0 ? (
        <div className="empty">No grants in {org.name}. Everyone has exactly what their role gives them.</div>
      ) : (
        <table data-testid="grants-table">
          <thead><tr><th>Person</th><th>Where</th><th>Effect</th><th>Permissions</th><th>Window</th><th /></tr></thead>
          <tbody>
            {data.grants.map((g) => (
              <tr key={g.id} data-testid="grant-row" data-grant-id={g.id} data-effect={g.effect}>
                <td>{personName(g.user_id)}</td>
                <td className="sub">{deviceName(g.device_id)}</td>
                <td><span className={`tag ${g.effect === 'allow' ? 'good' : 'bad'}`}>{g.effect}</span></td>
                <td>{g.permissions.map((p) => <code key={p} className="chip">{p}</code>)}</td>
                <td className="sub">
                  {g.starts_at ? `from ${when(g.starts_at)} ` : ''}{g.expires_at ? `until ${when(g.expires_at)}` : 'no expiry'}
                </td>
                <td>
                  <Gate permission="grant:revoke" entry={me.permissions['grant:revoke']} testid="revoke-grant" kind="danger"
                        onClick={() => action.run(() => api.del(`/orgs/${org.id}/grants/${g.id}`), 'Grant revoked.')}>
                    Revoke
                  </Gate>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
