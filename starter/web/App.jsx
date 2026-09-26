import React, { useCallback, useEffect, useState } from 'react';
import { api, allowed, explain } from './api.js';
import { Problem } from './components/common.jsx';
import Login from './components/Login.jsx';
import AcceptInvite from './components/AcceptInvite.jsx';
import Devices from './components/Devices.jsx';
import People from './components/People.jsx';
import Grants from './components/Grants.jsx';
import Sessions from './components/Sessions.jsx';
import Audit from './components/Audit.jsx';
import Admin from './components/Admin.jsx';
import Access from './components/Access.jsx';

// The six cards and the permission that makes each one exist. Admin needs either of two.
// This table names permissions, never roles: which role holds what is the server's business.
const CARDS = [
  { key: 'devices', label: 'Devices', needs: ['device:list'] },
  { key: 'people', label: 'People', needs: ['user:read'] },
  { key: 'grants', label: 'Grants', needs: ['user:read'] },
  { key: 'sessions', label: 'Sessions', needs: ['session:view'] },
  { key: 'audit', label: 'Audit log', needs: ['audit:read'] },
  { key: 'admin', label: 'Admin', needs: ['org:update', 'org:delete'] },
];

const INVITE = /^\/invite\/([^/]+)\/?$/;

export default function App() {
  const inviteToken = INVITE.exec(window.location.pathname)?.[1] ?? null;
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(!inviteToken);
  const [bootError, setBootError] = useState(null);
  const [view, setView] = useState('devices');
  const [shellError, setShellError] = useState(null);

  const loadMe = useCallback(async () => setMe(await api.me()), []);

  // No token is stored anywhere, so a reload starts signed out and asks the refresh cookie.
  // If the server answers but is broken (e.g. no database), say so on the sign-in screen.
  useEffect(() => {
    if (inviteToken) return;
    (async () => {
      try {
        if (await api.restore()) await loadMe();
      } catch (err) {
        setBootError(explain(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [inviteToken, loadMe]);

  async function guarded(fn) {
    setShellError(null);
    try { await fn(); } catch (err) { setShellError(err); }
  }

  const switchOrg = (id) => guarded(async () => {
    if (id === me.org.id) return;
    await api.switchOrg(id);
    await loadMe();
    setView('devices');
  });

  // Anyone signed in may create an org and becomes its owner. The new org needs a new
  // token, because a token names exactly one org.
  const createOrg = () => guarded(async () => {
    const name = window.prompt('Name of the new organization');
    if (!name?.trim()) return;
    const org = await api.post('/orgs', { name: name.trim() });
    await api.switchOrg(org.id);
    await loadMe();
    setView('devices');
  });

  const signOut = () => guarded(async () => {
    await api.post('/auth/logout').catch(() => {});   // best effort: revoke the refresh cookie
    api.signOut();
    setMe(null);
  });

  // The current org was deleted: our token is dead. Start again from the cookie.
  const orgGone = () => guarded(async () => {
    const restored = await api.restore();
    if (restored) await loadMe(); else { api.signOut(); setMe(null); }
    setView('devices');
  });

  if (inviteToken) {
    return <AcceptInvite token={inviteToken} onDone={() => window.location.assign('/')} />;
  }
  if (booting) return <div className="screen-center muted">Loading…</div>;
  if (!me) return <Login onSignedIn={loadMe} bootError={bootError} />;

  const cards = CARDS.filter((c) => c.needs.some((p) => allowed(me.permissions[p])));
  const current = cards.find((c) => c.key === view) ?? cards[0];
  const props = { me, onChanged: loadMe, goTo: setView };

  return (
    <div className="shell" data-testid="app-shell" data-org-id={me.org.id} data-org-theme={me.org.theme}>
      <aside className="side">
        <div className="brand">Remote<span>Ops</span></div>

        <div className="side-label">Organizations</div>
        <div className="orgs" data-testid="org-switcher">
          {me.orgs.map((o) => (
            <button key={o.id} type="button" className="org" data-testid="org-option" data-org-id={o.id}
                    data-org-theme={o.theme} aria-pressed={o.id === me.org.id} onClick={() => switchOrg(o.id)}>
              <span className="dot" />
              <span className="org-name">{o.name}</span>
              <span className="org-role">{o.role}</span>
            </button>
          ))}
          <button type="button" className="org add" data-testid="create-org" onClick={createOrg}>
            + New organization
          </button>
        </div>

        <div className="side-label">In {me.org.name}</div>
        <nav className="nav">
          {cards.map((c) => (
            <button key={c.key} type="button" data-testid={`nav-${c.key}`} data-permission={c.needs.join('|')}
                    data-state="unlocked" aria-current={c.key === current?.key ? 'page' : undefined}
                    onClick={() => setView(c.key)}>
              {c.label}
            </button>
          ))}
        </nav>

        <div className="who">
          <div className="strong">{me.user.name}</div>
          <div className="sub">{me.user.email}</div>
          <button type="button" className="btn ghost small" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <header className="band">
          <div>
            <div className="band-org">{me.org.name}</div>
            <div className="band-role">You are <strong data-testid="active-role">{me.role}</strong> here</div>
          </div>
          <Access me={me} />
        </header>

        <Problem error={shellError} testid="shell-error" onClose={() => setShellError(null)} />
        {me.status === 'suspended' && (
          <div className="problem" role="alert" data-testid="suspended-banner">
            Your membership in {me.org.name} is suspended, so you can't do anything here. Switch to
            another organization, or ask an admin to reinstate you.
          </div>
        )}

        {current ? (
          <>
            <h2>{current.label}</h2>
            {current.key === 'devices' && <Devices {...props} />}
            {current.key === 'people' && <People {...props} />}
            {current.key === 'grants' && <Grants {...props} />}
            {current.key === 'sessions' && <Sessions {...props} />}
            {current.key === 'audit' && <Audit {...props} />}
            {current.key === 'admin' && <Admin {...props} onOrgGone={orgGone} />}
          </>
        ) : (
          <div className="empty">You have no permissions in {me.org.name} that show anything here.</div>
        )}
      </main>
    </div>
  );
}
