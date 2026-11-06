// A shared post's Story still to come, at a new time set on the Social preview (POST .../story-at -> moveStory): its
// reminder in later.json moves (or comes now), one Postiz holds is deleted there and made again; one gone out moves
// nothing. Against fake-web's Ghost, Postiz and ntfy
import './env.mjs';
import { web } from './fake-web.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';

const GHOST = 'http://ghost.test';
const POSTIZ = 'http://postiz.test';
const NTFY = 'http://ntfy.test';
Object.assign(process.env, { GHOST_API_URL: GHOST, POSTIZ_API_URL: POSTIZ, NTFY_URL: NTFY, NTFY_TOPIC: 'test',
  GHOST_ADMIN_API_KEY: `${'a'.repeat(24)}:${'b'.repeat(64)}` });
const { handlePost } = await import('../ghost-bridge/share/share.mjs');
// the tests' videos aren't real: ffprobe would fetch their made-up addresses (media.mjs's own test reads real ones)
(await import('../ghost-bridge/share/media.mjs')).videoTools.probe = async () => ({ streams: [] });
const { loadState, recordShared, editCustom, STATE_FILE } = await import('../ghost-bridge/config.mjs');
const { serveDraftPreview } = await import('../ghost-bridge/pages/preview-routes.mjs');

const dataDir = path.dirname(STATE_FILE);
const LATER = path.join(dataDir, 'later.json');
await fs.mkdir(dataDir, { recursive: true });
after(() => fs.rm(dataDir, { recursive: true, force: true }));
const kept = async () => { try { return JSON.parse(await fs.readFile(LATER, 'utf8')); } catch { return []; } };

const UUID = '11111111-2222-3333-4444-555555555555';
const POST = { id: 'p1', uuid: UUID, status: 'published', visibility: 'public', title: 'New mix',
  url: 'https://example.com/new-mix/', published_at: '2026-10-20T18:00:00.000Z',
  html: '<p>Big one.</p><video src="/content/media/clip.mp4"></video>' };
let post = POST;
const tags = (...names) => names.map((name) => ({ name }));
// the box's 'YYYY-MM-DDTHH:MM' (the site's zone is UTC here)
const local = (ms) => new Date(ms).toISOString().slice(0, 16);
const minute = (ms) => Math.floor(ms / 60_000) * 60_000;

beforeEach(async () => {
  web.reset();
  await Promise.all([STATE_FILE, LATER].map((f) => fs.rm(f, { force: true })));
  await editCustom('p1', (m) => { for (const k of Object.keys(m)) delete m[k]; });
  web.on(`${POSTIZ}/integrations`, [{ id: 'c3', identifier: 'instagram-standalone', name: 'Instagram', disabled: false }]);
  web.on(`${POSTIZ}/upload-from-url`, { id: 'm1', path: 'https://uploads.example.com/clip.mp4' });
  let n = 0;
  web.on(`${POSTIZ}/posts`, (u, req) => (req.method === 'POST' ? [{ postId: `s${++n}`, integration: 'c3' }] : {}));
  web.on(NTFY, {});
  web.on(`${GHOST}/ghost/api/admin/site/`, { site: { url: 'https://example.com/' } });
  web.on(`${GHOST}/ghost/api/admin/users/me/`, { users: [{ id: 'u1' }] });
  web.on(`${GHOST}/ghost/api/admin/posts/?`, () => ({ posts: [post] }));
});

async function ask(method, url, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { cookie: 'ghost-admin-api-session=s1', origin: 'https://example.com',
    ...(body != null && { 'content-type': 'application/json' }) } });
  const res = { status: 0, body: '', headersSent: false,
    writeHead(code) { this.status = code; this.headersSent = true; return this; }, end(b = '') { this.body = String(b); return this; } };
  await serveDraftPreview(req, res, url, { sharing: new Set(), share: async () => {} });
  return res;
}
const moveTo = (at) => ask('POST', `/ghost/social-preview/${UUID}/story-at`, { at: at ? local(at) : '' });

test("#bigdrop's Story by hand, shared: a new time moves its reminder, \"With the post\" sends it now", async () => {
  post = { ...POST, tags: tags('#bigdrop') };
  const first = minute(Date.now() + 3 * 3_600_000);
  await editCustom('p1', (m) => { m.storyAt = new Date(first).toISOString(); });
  await handlePost(post);
  assert.deepEqual((await kept()).map((k) => [k.at, k.key]), [[first, 'p1']]);
  assert.equal(web.calls(NTFY).filter((c) => /Big drop/.test(c.body)).length, 0, 'not yet');
  assert.match(await ask('GET', `/ghost/social-preview/${UUID}/`).then((r) => r.body), /its Story still to come: a new time moves it/);

  const later = minute(Date.now() + 5 * 3_600_000);
  assert.equal((await moveTo(later)).status, 200);
  const [item] = await kept();
  assert.equal(item.at, later);
  assert.equal((item.msg.message.match(/⏰/g) || []).length, 1, 'one time line, the new one');
  assert.equal((await loadState()).p1.storyAt, new Date(later).toISOString(), 'the Shared posts page says the new time');

  assert.equal((await moveTo(null)).status, 200);
  assert.deepEqual(await kept(), []);
  const sent = web.calls(NTFY).filter((c) => /Big drop/.test(c.body));
  assert.equal(sent.length, 1, 'sent now');
  assert.doesNotMatch(JSON.parse(sent[0].body).message, /⏰/);
  assert.equal((await loadState()).p1.storyAt, undefined);
});

test('a reminder kept before reminders had the post\'s id is found by its title', async () => {
  post = { ...POST, tags: tags('#bigdrop') };
  const first = minute(Date.now() + 3 * 3_600_000);
  await recordShared('p1', { title: 'New mix', at: new Date().toISOString(), results: { 'instagram-standalone:story': 'manual' },
    storyAt: new Date(first).toISOString() });
  await fs.writeFile(LATER, JSON.stringify([{ at: first, msg: { title: '🎧 Big drop: add the link Story for "New mix"', message: '⏰ x\n\nPost it.' } },
    { at: first, msg: { title: '🎧 Big drop: add the link Story for "Other mix"', message: 'y' } }]));
  const later = minute(Date.now() + 4 * 3_600_000);
  assert.equal((await moveTo(later)).status, 200);
  assert.deepEqual((await kept()).map((k) => k.at), [later, first], 'only its own');
});

test('a Story Postiz holds for later: deleted there and made again at the new time', async () => {
  post = { ...POST, tags: tags('#story', '#autopost') };
  const first = minute(Date.now() + 3 * 3_600_000);
  await editCustom('p1', (m) => { m.storyAt = new Date(first).toISOString(); });
  await handlePost(post);
  const job = (await loadState()).p1.storyJob;
  assert.equal(job.id, 's1');
  assert.equal(job.body.date, new Date(first).toISOString());

  const later = minute(Date.now() + 6 * 3_600_000);
  web.asked.length = 0;
  assert.equal((await moveTo(later)).status, 200);
  assert.deepEqual(web.calls(`${POSTIZ}/posts`).map((c) => `${c.method} ${c.url.slice(POSTIZ.length)}`), ['DELETE /posts/s1', 'POST /posts']);
  const made = JSON.parse(web.calls(`${POSTIZ}/posts`)[1].body);
  assert.equal(made.type, 'schedule');
  assert.equal(made.date, new Date(later).toISOString());
  assert.deepEqual(made.posts, job.body.posts, 'the same Story');
  const entry = (await loadState()).p1;
  assert.equal(entry.storyJob.id, 's2');
  assert.equal(entry.storyAt, new Date(later).toISOString());
});

test('Postiz takes the old Story down but not the new one: the page says so, and it is no longer "to come"', async () => {
  post = { ...POST, tags: tags('#story', '#autopost') };
  await editCustom('p1', (m) => { m.storyAt = new Date(Date.now() + 3 * 3_600_000).toISOString(); });
  await handlePost(post);
  web.on(`${POSTIZ}/posts`, (u, req) => (req.method === 'POST' ? { status: 500, body: { error: 'down' } } : {}));
  const res = await moveTo(Date.now() + 5 * 3_600_000);
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /share again with only the Story ticked/);
  assert.equal((await loadState()).p1.storyAt, undefined);
});

test('a Postiz Story scheduled before the bridge kept its id: move it in Postiz', async () => {
  post = { ...POST, tags: tags('#story', '#autopost') };
  const first = new Date(Date.now() + 3 * 3_600_000).toISOString();
  await editCustom('p1', (m) => { m.storyAt = first; });
  await recordShared('p1', { title: 'New mix', at: new Date().toISOString(), results: { 'instagram-standalone:story': 'ok' }, storyAt: first });
  const res = await moveTo(Date.now() + 5 * 3_600_000);
  assert.equal(res.status, 409);
  assert.match(JSON.parse(res.body).error, /Postiz's calendar/);
  assert.equal((await loadState()).p1.storyAt, first, 'nothing changed');
});

test('its Story went out already: the time is saved for sharing again, nothing moves', async () => {
  post = { ...POST, tags: tags('#bigdrop') };
  await handlePost(post);
  assert.equal((await loadState()).p1.storyAt, undefined, 'with the post');
  assert.match(await ask('GET', `/ghost/social-preview/${UUID}/`).then((r) => r.body), /Its Story went out already/);
  web.asked.length = 0;
  assert.equal((await moveTo(Date.now() + 2 * 3_600_000)).status, 200);
  assert.deepEqual(web.calls(`${POSTIZ}/posts`), []);
  assert.deepEqual(await kept(), []);
});

// (not a Story: the Social preview's cover upload, which shares this file's preview harness)
test('a cover of your own: uploaded to Ghost\'s images, picked, and shown among the cover choices', async () => {
  const send = (type, bytes, name) => {
    const req = Readable.from([bytes]);
    Object.assign(req, { method: 'POST', url: `/ghost/social-preview/${UUID}/cover-upload`, headers: { cookie: 'ghost-admin-api-session=s1',
      origin: 'https://example.com', 'content-type': type, 'x-file-name': encodeURIComponent(name) } });
    const res = { status: 0, body: '', writeHead(code) { this.status = code; return this; }, end(b = '') { this.body = String(b); return this; } };
    return serveDraftPreview(req, res, req.url, { sharing: new Set(), share: async () => {} }).then(() => res);
  };
  const mine = 'https://example.com/content/images/2026/11/my-cover.jpg';
  web.on(`${GHOST}/ghost/api/admin/images/upload/`, { images: [{ url: mine }] });
  assert.equal((await send('text/plain', Buffer.from('hi'), 'a.txt')).status, 415, 'only a picture');
  assert.deepEqual(web.calls(`${GHOST}/ghost/api/admin/images/upload/`), []);
  const res = await send('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]), 'My cover.JPG');
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).src, mine);
  assert.equal(web.calls(`${GHOST}/ghost/api/admin/images/upload/`)[0].method, 'POST');
  let saved; await editCustom('p1', (m) => { saved = m.cover; });
  assert.equal(saved, mine, 'saved as the cover');
  const page = (await ask('GET', `/ghost/social-preview/${UUID}/`)).body;
  assert.match(page, new RegExp(`<label class="cover on"[^>]*><input type="radio"[^>]*value="${mine.replace(/[.]/g, '\\.')}" checked`), 'the upload shows, picked');
  assert.match(page, /data-cover-upload/, 'and the Upload tile is there');
  web.on(`${GHOST}/ghost/api/admin/images/upload/`, { status: 413, body: { errors: [{ message: 'File is too large.' }] } });
  assert.equal((await send('image/png', Buffer.from([1]), 'x.png')).status, 502, 'Ghost refusing it says so');
});
