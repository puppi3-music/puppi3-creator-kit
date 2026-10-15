// The bridge's tests: a clean environment, like a container with no settings, so a test reads the bridge's own
// defaults whatever the shell has set. Import it first: config.mjs reads the environment once, when it loads.
// A test that wants a setting sets it after this import and before importing the bridge (or imports the bridge
// with import() once it has).
import os from 'node:os';
import path from 'node:path';

const KEEP = new Set(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'LANG']);
for (const k of Object.keys(process.env)) if (!KEEP.has(k) && !k.startsWith('NODE_')) delete process.env[k];

Object.assign(process.env, {
  SITE_HOST: 'example.com',
  // a folder of this run's own: only the numbers collectors' tests write there (collectors.mjs makes it and removes it)
  STATE_FILE: path.join(os.tmpdir(), `ghost-bridge-test-${process.pid}`, 'posted.json'),
  // set so config.mjs doesn't warn that they aren't
  POSTIZ_API_KEY: 'test',
  GHOST_WEBHOOK_SECRET: 'test',
});
