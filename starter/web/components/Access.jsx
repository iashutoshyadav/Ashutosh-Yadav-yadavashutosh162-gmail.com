import React, { useState } from 'react';
import { whyNot } from '../api.js';

// "Why can't I …?" An absent button cannot explain itself, so this panel lists the
// permissions the caller does NOT hold in this org, with the server's reason: nobody
// granted it (implicit) reads differently from someone took it away (explicit_deny).
// Org-level view; per-device answers are on each device row.
export default function Access({ me }) {
  const [open, setOpen] = useState(false);
  const missing = Object.entries(me.permissions).filter(([, e]) => e.effect !== 'allow');
  const held = Object.keys(me.permissions).length - missing.length;

  return (
    <div className="access">
      <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} You hold {held} of {Object.keys(me.permissions).length} permissions here — why not the rest?
      </button>
      {open && (
        <ul>
          {missing.map(([key, entry]) => (
            <li key={key} data-reason={entry.reason}>
              <code>{key}</code> — {whyNot(entry)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
