// share/ntfy.mjs' notifications kept for a time (a Story's own, set on the Social preview): kept in later.json and
// sent when due, against a fake ntfy server; and the Social preview's time in SITE_TIMEZONE (zonedTime)
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

// the fake ntfy: notes each message; answers 500 while `down`
const got = [];
let down = false;
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { if (down) return res.writeHead(500).end('down'); got.push(JSON.parse(body)); res.end('{}'); });
});
await new Promise((ok) => ntfy.listen(0, '127.0.0.1', ok));
after(() => { ntfy.closeAllConnections(); ntfy.close(); });
process.env.NTFY_URL = `http://127.0.0.1:${ntfy.address().port}`;
process.env.NTFY_TOPIC = 'test';

const dataDir = path.dirname(process.env.STATE_FILE);
await fs.mkdir(dataDir, { recursive: true });
after(() => fs.rm(dataDir, { recursive: true, force: true }));
const kept = async () => { try { return JSON.parse(await fs.readFile(path.join(dataDir, 'later.json'), 'utf8')); } catch { return []; } };

const { notifyAt, sendDueLater } = await import('../ghost-bridge/share/ntfy.mjs');
const { zonedTime } = await import('../ghost-bridge/pages/preview-routes.mjs');

test('a notification for later is kept, then sent when it\'s due', async () => {
  const at = Date.now() + 3_600_000;
  assert.equal(await notifyAt({ title: 'Story', message: 'Post it.' }, at), true);
  assert.equal(got.length, 0, 'not sent yet');
  assert.equal((await kept()).length, 1);
  await sendDueLater(at - 1000);
  assert.equal(got.length, 0, 'not due yet');
  await sendDueLater(at + 1000);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, 'Story');
  assert.match(got[0].message, /^⏰ The time you set for it: .*\n\nPost it\.$/);
  assert.deepEqual(await kept(), []);
});

test('under a minute away: sent now; ntfy down: kept and tried again, dropped a day late', async () => {
  got.length = 0;
  await notifyAt({ title: 'Now', message: 'x' }, Date.now() + 10_000);
  assert.equal(got.length, 1);
  const at = Date.now() + 3_600_000;
  await notifyAt({ title: 'Later', message: 'x' }, at);
  down = true;
  await sendDueLater(at + 1000);
  assert.equal((await kept()).length, 1, 'kept to try again');
  await sendDueLater(at + 25 * 3_600_000);
  assert.deepEqual(await kept(), [], 'given up a day after it was due');
  down = false;
});

test('zonedTime: the Social preview\'s time in the site\'s zone', () => {
  assert.equal(new Date(zonedTime('2026-10-17T18:00', 'America/New_York')).toISOString(), '2026-10-17T22:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-12-01T09:00', 'America/New_York')).toISOString(), '2026-12-01T14:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-07-01T09:30', 'Etc/UTC')).toISOString(), '2026-07-01T09:30:00.000Z');
  assert.ok(Number.isNaN(zonedTime('tomorrow', 'Etc/UTC')));
});
