import React, { useState } from 'react';
import { api } from '../api.js';
import { Gate, Problem, Done, useLoad, useAction } from './common.jsx';

const MODES = [
  { mode: 'view', label: 'View' },
  { mode: 'control', label: 'Control' },
  { mode: 'terminal', label: 'Terminal' },
];
const KINDS = ['linux', 'macos', 'windows', 'android', 'ios'];

// Every row arrives with the caller's permission set FOR THAT DEVICE, resolved by the server.
// This component reads `device.permissions` and nothing else: the same person can have
// Control on one row and not on the next, and a device they cannot view is not in the list.
export default function Devices({ me }) {
  const org = me.org;
  const { data, error, reload } = useLoad(() => api.get(`/orgs/${org.id}/devices`), org.id);
  const action = useAction(reload);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', kind: 'linux' });

  const start = (device, mode) => action.run(
    () => api.post(`/orgs/${org.id}/sessions`, { deviceId: device.id, mode }),
    (s) => `Started a ${mode} session on ${device.name} (${s.id}). See Sessions.`,
  );
  const rename = (device) => {
    const name = window.prompt(`New name for ${device.name}`, device.name);
    if (name && name.trim() !== device.name) {
      action.run(() => api.patch(`/orgs/${org.id}/devices/${device.id}`, { name: name.trim() }), 'Device renamed.');
    }
  };
  const decommission = (device) => {
    if (window.confirm(`Decommission ${device.name}? Its live sessions end.`)) {
      action.run(() => api.del(`/orgs/${org.id}/devices/${device.id}`), `${device.name} decommissioned.`);
    }
  };
  const create = async (e) => {
    e.preventDefault();
    const ok = await action.run(() => api.post(`/orgs/${org.id}/devices`, { ...draft, name: draft.name.trim() }), 'Device added.');
    if (ok) { setAdding(false); setDraft({ name: '', kind: 'linux' }); }
  };

  return (
    <section>
      <div className="toolbar">
        <Gate permission="device:provision" entry={me.permissions['device:provision']} testid="add-device"
              kind="primary" onClick={() => setAdding((a) => !a)}>
          Add device
        </Gate>
      </div>

      {adding && (
        <form className="inline-form" onSubmit={create}>
          <input placeholder="device name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <button className="btn primary" type="submit" disabled={action.busy}>Add</button>
        </form>
      )}

      <Problem error={action.error ?? error} testid="devices-error" onClose={action.clear} />
      <Done text={action.done} onClose={action.clear} />

      {!data ? <p className="muted">Loading devices…</p> : data.devices.length === 0 ? (
        <div className="empty" data-testid="devices-empty">No devices you can see in {org.name} yet.</div>
      ) : (
        <table data-testid="device-table">
          <thead><tr><th>Device</th><th>Status</th><th>Open a session</th><th>Manage</th></tr></thead>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.id} data-testid="device-row" data-device-id={d.id}>
                <td>
                  <div className="strong">{d.name}</div>
                  <div className="sub">{d.kind} · {d.id}</div>
                </td>
                <td><span className={`tag ${d.online ? 'good' : ''}`}>{d.online ? 'online' : 'offline'}</span></td>
                <td>
                  <div className="row-actions">
                    {MODES.map(({ mode, label }) => (
                      <Gate key={mode} permission={`device:${mode}`} entry={d.permissions[`device:${mode}`]}
                            testid={`start-${mode}`} busy={action.busy} onClick={() => start(d, mode)}>
                        {label}
                      </Gate>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="row-actions">
                    <Gate permission="device:file_transfer" entry={d.permissions['device:file_transfer']}
                          testid="transfer-files"
                          onClick={() => window.alert('Sessions are records only — no files are moved.')}>
                      Transfer files
                    </Gate>
                    <Gate permission="device:update" entry={d.permissions['device:update']}
                          testid="rename-device" onClick={() => rename(d)}>
                      Rename
                    </Gate>
                    <Gate permission="device:provision" entry={d.permissions['device:provision']}
                          testid="decommission-device" kind="danger" onClick={() => decommission(d)}>
                      Decommission
                    </Gate>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
