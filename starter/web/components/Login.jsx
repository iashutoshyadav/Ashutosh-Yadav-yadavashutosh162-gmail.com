import React, { useState } from 'react';
import { api, explain } from '../api.js';
import { Problem } from './common.jsx';

// Sign-in is the screen most likely to be reached when something is broken — wrong
// password, a server that died, a database that was never built. Every failure is shown
// next to the form (login-error) and stays until the next attempt.
//
// The message is the server's own. It says the same thing for an unknown email as for a
// wrong password, and this screen must not "improve" on that: telling the two apart would
// let anyone test which emails have accounts.
export default function Login({ onSignedIn, bootError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(bootError);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError({ code: 'VALIDATION', message: 'Enter your email address and your password.' });
      return;
    }
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      await onSignedIn();
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-center">
      <form className="panel narrow" onSubmit={submit} data-testid="login-form" noValidate>
        <div className="brand">Remote<span>Ops</span></div>
        <h1>Sign in</h1>

        <label htmlFor="login-email">Email</label>
        <input id="login-email" data-testid="login-email" autoComplete="username"
               value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="login-password">Password</label>
        <input id="login-password" data-testid="login-password" type="password" autoComplete="current-password"
               value={password} onChange={(e) => setPassword(e.target.value)} />

        <button className="btn primary wide" type="submit" data-testid="login-submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div aria-live="assertive">
          <Problem error={error} testid="login-error" />
        </div>

        <p className="fine">
          Demo accounts: <code>dana@example.test</code>, <code>sam@example.test</code>,{' '}
          <code>admin@acme.test</code>, <code>viewer@acme.test</code> — password <code>demo1234</code>.
        </p>
      </form>
    </div>
  );
}
