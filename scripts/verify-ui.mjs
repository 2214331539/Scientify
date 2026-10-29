import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';

const suites = {
  sources: 'scripts/verify-sources-ui.mjs',
  experiments: 'scripts/verify-experiments-ui.mjs',
  git: 'scripts/verify-git-ui.mjs',
  reader: 'scripts/verify-reader-ui.mjs',
  assistant: 'scripts/verify-assistant-ui.mjs',
  notes: 'scripts/verify-notes-ui.mjs',
};
const selected = process.argv.slice(2);
if (selected.some((suite) => !Object.hasOwn(suites, suite)))
  throw new Error(`Unknown UI suite. Choose: ${Object.keys(suites).join(', ')}`);
let server;
try {
  let url = process.env.SCIENTIFY_UI_URL;
  if (!url) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    url = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: resolve('.'),
        windowsHide: true,
        stdio: 'inherit',
      },
    );
    server.on('error', (error) => console.error(error));
    const deadline = Date.now() + 30_000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`UI server exited: ${server.exitCode}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {
        /* The server may still be starting. */
      }
      if (Date.now() >= deadline) throw new Error(`UI server did not become ready: ${url}`);
      await delay(250);
    }
  }
  for (const suite of selected.length ? selected : Object.keys(suites)) {
    console.log(`UI verification: ${suite}`);
    const child = spawn(process.execPath, [suites[suite]], {
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, SCIENTIFY_UI_URL: url },
    });
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${suite} UI verification failed: ${code ?? signal}`);
  }
} finally {
  // Only stop the Vite process created by this run, never a user's dev server.
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
}
