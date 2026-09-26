import React from 'react';
import { api } from '../api.js';
import { Gate, Problem, Done, useAction } from './common.jsx';

// Present for org:update OR org:delete. An admin holds the first and not the second, so
// they see Rename and no Delete; the owner sees both.
export default function Admin({ me, onChanged, onOrgGone }) {
  const org = me.org;
  const action = useAction(onChanged);

  const rename = () => {
    const name = window.prompt(`Rename ${org.name} to:`, org.name);
    if (name && name.trim() !== org.name) action.run(() => api.patch(`/orgs/${org.id}`, { name: name.trim() }), 'Organization renamed.');
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${org.name}? Everyone loses access to it and its live sessions end.`)) return;
    const out = await action.run(() => api.del(`/orgs/${org.id}`).then(() => true));
    if (out) onOrgGone();
  };

  return (
    <section className="panel" data-testid="admin-card">
      <h3>{org.name}</h3>
      <p className="muted">Sessions in this org last at most {org.max_session_minutes} minutes.</p>
      <div className="row-actions">
        <Gate permission="org:update" entry={me.permissions['org:update']} testid="rename-org" onClick={rename}>
          Rename organization
        </Gate>
        <Gate permission="org:delete" entry={me.permissions['org:delete']} testid="delete-org" kind="danger" onClick={remove}>
          Delete organization
        </Gate>
      </div>
      <Problem error={action.error} testid="admin-error" onClose={action.clear} />
      <Done text={action.done} onClose={action.clear} />
    </section>
  );
}
