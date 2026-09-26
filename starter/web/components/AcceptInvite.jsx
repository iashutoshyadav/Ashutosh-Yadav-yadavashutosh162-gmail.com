import React, { useEffect, useState } from 'react';
import { api, explain } from '../api.js';
import { Problem } from './common.jsx';

// /invite/<token>. Reachable signed out: the token in the URL is the credential. The server
// tells us only the org's name, the role and the email — nothing else about the org.
export default function AcceptInvite({ token, onDone }) {
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/invites/${encodeURIComponent(token)}`).then(setInvite).catch((err) => {
      // Don't echo anything the server might know about the org — just what went wrong.
      const byCode = {
        GONE: 'This invite has expired or was cancelled. Ask for a new one.',
        CONFLICT: 'This invite has already been used. Sign in instead.',
      };
      setLoadError({ code: err.code ?? 'UNKNOWN', message: byCode[err.code] ?? 'This invite link is not valid.' });
    });
  }, [token]);

  async function accept(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/invites/${encodeURIComponent(token)}/accept`, { name: name.trim(), password });
      onDone();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="screen-center">
        <div className="panel narrow">
          <h1>Invitation</h1>
          <Problem error={loadError} testid="invite-error" />
        </div>
      </div>
    );
  }
  if (!invite) return <div className="screen-center muted">Checking your invitation…</div>;

  return (
    <div className="screen-center">
      <form className="panel narrow" onSubmit={accept} data-testid="invite-form">
        <h1>Join {invite.orgName}</h1>
        <p className="muted">
          You're invited as <strong data-testid="invite-role">{invite.role}</strong>. The link
          expires {new Date(invite.expiresAt).toLocaleString()}.
        </p>

        <label htmlFor="inv-email">Email</label>
        <input id="inv-email" data-testid="invite-email" value={invite.email} readOnly />

        <label htmlFor="inv-name">Your name</label>
        <input id="inv-name" data-testid="invite-name" value={name} onChange={(e) => setName(e.target.value)} />

        <label htmlFor="inv-password">Choose a password (8+ characters)</label>
        <input id="inv-password" data-testid="invite-password" type="password"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="fine">If you already have an account, leave these blank — your existing password stays.</p>

        <button className="btn primary wide" type="submit" data-testid="invite-submit" disabled={busy}>
          {busy ? 'Joining…' : 'Accept invitation'}
        </button>
        <Problem error={error} testid="invite-error" />
      </form>
    </div>
  );
}
