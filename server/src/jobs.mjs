// Background work in the service process: expiring old grants and sessions.

import { expireGrants } from './billing/ledger.mjs';

export async function runJobs(db, now = new Date()) {
  await expireGrants(db, now);
  await db.query('DELETE FROM admin_sessions WHERE expires_at <= $1', [now]);
}

/** Runs the jobs at start and then every hour; returns a function that stops them. */
export function startJobs(db) {
  const run = () => runJobs(db).catch((error) => console.error('jobs', error));
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, 3600_000);
  timer.unref?.();
  first.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
