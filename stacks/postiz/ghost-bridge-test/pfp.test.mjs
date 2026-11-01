// share/pfp.mjs' reminders on the phone, against fake-web's Ghost and ntfy: a season's end attaches the theme's
// usual.png when it has one, and says only the text when it hasn't
import './env.mjs';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { web } from './fake-web.mjs';

const GHOST = 'http://ghost.test:2368', NTFY = 'http://ntfy.test';
Object.assign(process.env, { GHOST_API_URL: GHOST, NTFY_URL: NTFY, NTFY_TOPIC: 'test', PFP_TODAY: '2026-11-01' });

const dataDir = path.dirname(process.env.STATE_FILE);
const pfpFile = path.join(dataDir, 'pfp.json');
await fs.mkdir(dataDir, { recursive: true });
after(() => fs.rm(dataDir, { recursive: true, force: true }));

const { checkSeason } = await import('../ghost-bridge/share/pfp.mjs');

let sent;
beforeEach(async () => {
  web.reset();
  sent = [];
  web.on(`${GHOST}/assets/images/pfp/seasons.json`, [['halloween', 1015, 1031]]);
  web.on(`${GHOST}/ghost/api/admin/site/`, { site: { url: 'https://example.com/' } });
  web.on(NTFY, (url, req) => { sent.push(JSON.parse(req.body)); return {}; });
  // Halloween was on and its reminder went: today (1 Nov) it's over
  await fs.writeFile(pfpFile, JSON.stringify({ season: 'halloween', since: '2026-10-15', from: null, notified: true }));
});

test("a season's end attaches the theme's usual.png", async () => {
  web.on(`${GHOST}/assets/images/pfp/usual.png`, '');
  await checkSeason();
  assert.equal(sent.length, 1);
  const [msg] = sent;
  assert.equal(msg.title, '🐶 Back to the usual pfp');
  assert.equal(msg.attach, 'https://example.com/assets/images/pfp/usual.png');
  assert.equal(msg.actions[0].label, 'Save picture');
  assert.match(msg.message, /Save the attached picture/);
});

test("a theme without usual.png gets the text alone", async () => {
  web.on(`${GHOST}/assets/images/pfp/usual.png`, { status: 404, body: '' });
  await checkSeason();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attach, undefined);
  assert.ok(!sent[0].actions.some((a) => a.label === 'Save picture'));
  assert.doesNotMatch(sent[0].message, /attached/);
});
