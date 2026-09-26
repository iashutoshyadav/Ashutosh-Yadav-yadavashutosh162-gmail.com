// Route registration. The router takes the FIRST match, so a specific path must be
// registered before a parameterised one that would swallow it — '/members/me' before
// '/members/:userId' (handled inside orgs.js).

import * as auth from './auth.js';
import * as orgs from './orgs.js';
import * as invites from './invites.js';
import * as devices from './devices.js';
import * as sessions from './sessions.js';

export function registerRoutes(router, deps) {
  for (const group of [auth, orgs, invites, devices, sessions]) group.register(router, deps);
}
