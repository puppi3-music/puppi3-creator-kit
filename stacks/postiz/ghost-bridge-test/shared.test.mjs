// Sharing a post again: handlePost's `again` (posted.json keeps the earlier share), and the Shared posts page with its
// "Share again now" (pages/preview-routes.mjs), against a fake Ghost and Postiz (fake-web.mjs).
import './env.mjs';
import { web } from './fake-web.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';

const GHOST = 'http://ghost.test';
const POSTIZ = 'http://postiz.test';
Object.assign(process.env, { GHOST_API_URL: GHOST, POSTIZ_API_URL: POSTIZ,
  GHOST_ADMIN_API_KEY: `${'a'.repeat(24)}:${'b'.repeat(64)}` });
const { handlePost } = await import('../ghost-bridge/share/share.mjs');
const { loadState, recordShared, STATE_FILE } = await import('../ghost-bridge/config.mjs');
const { serveDraftPreview } = await import('../ghost-bridge/pages/preview-routes.mjs');

await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
after(() => fs.rm(path.dirname(STATE_FILE), { recursive: true, force: true }));

const UUID = '11111111-2222-3333-4444-555555555555';
const POST = { id: 'p1', uuid: UUID, status: 'published', visibility: 'public', title: 'New mix',
  url: 'https://example.com/new-mix/', published_at: '2026-10-20T18:00:00.000Z', html: '<p>Out now.</p>' };

beforeEach(async () => {
  web.reset();
  await fs.rm(STATE_FILE, { force: true });
  web.on(`${POSTIZ}/integrations`, [{ id: 'c1', identifier: 'bluesky', name: 'Bluesky', disabled: false }]);
  web.on(`${POSTIZ}/posts`, {});
  web.on(`${GHOST}/ghost/api/admin/site/`, { site: { url: 'https://example.com/' } });
  web.on(`${GHOST}/ghost/api/admin/users/me/`, (u, req) => (req.headers.cookie ? { users: [{ id: 'u1' }] } : { status: 403, body: {} }));
  web.on(`${GHOST}/ghost/api/admin/posts/?`, (u) => ({
    [`uuid:${UUID}`]: { posts: [POST] },
    'status:published': { posts: [POST, { ...POST, id: 'p2', uuid: UUID.replace('1', '9'), title: 'Old mix' }], meta: { pagination: { next: 2 } } },
    'status:scheduled': { posts: [{ id: 'p3', uuid: UUID.replace('1', '3'), title: 'Next week', published_at: '2026-10-30T18:00:00.000Z' }] },
    'status:draft': { posts: [{ id: 'p4', uuid: UUID.replace('1', '4'), title: 'Half done', updated_at: '2026-10-22T09:00:00.000Z' }] },
  })[u.searchParams.get('filter')] || { status: 404, body: {} });
});

test('a post already shared is skipped, unless shared again; the earlier share is kept', async () => {
  await handlePost(POST);
  assert.equal(web.calls(`${POSTIZ}/posts`).length, 1);
  const first = (await loadState()).p1;
  assert.deepEqual(first.results, { bluesky: 'ok' });

  await handlePost(POST);
  assert.equal(web.calls(`${POSTIZ}/posts`).length, 1, 'publishing again posts nothing');

  await handlePost(POST, { again: true });
  assert.equal(web.calls(`${POSTIZ}/posts`).length, 2, 'shared again');
  const entry = (await loadState()).p1;
  assert.deepEqual(entry.earlier, [{ at: first.at, results: { bluesky: 'ok' } }]);
});

test('shared again on some networks only: the others keep what they had', async () => {
  web.on(`${POSTIZ}/integrations`, [{ id: 'c1', identifier: 'bluesky', name: 'Bluesky', disabled: false },
    { id: 'c2', identifier: 'threads', name: 'Threads', disabled: false }]);
  await recordShared('p1', { title: 'New mix', at: '2026-10-20T18:01:00.000Z', results: { bluesky: 'ok', threads: 'error' } });
  await handlePost(POST, { again: true, only: ['threads'] });
  const posted = web.calls(`${POSTIZ}/posts`).map((c) => JSON.parse(c.body).posts[0].integration.id);
  assert.deepEqual(posted, ['c2'], 'only Threads');
  const entry = (await loadState()).p1;
  assert.deepEqual(entry.results, { bluesky: 'ok', threads: 'ok' });
  assert.deepEqual(entry.earlier, [{ at: '2026-10-20T18:01:00.000Z', results: { bluesky: 'ok', threads: 'error' } }]);
});

test("#bigdrop shared again: Instagram's Story reminder and its feed post are ticked apart", async () => {
  web.on(`${POSTIZ}/integrations`, [{ id: 'c1', identifier: 'bluesky', name: 'Bluesky', disabled: false },
    { id: 'c3', identifier: 'instagram-standalone', name: 'Instagram', disabled: false }]);
  web.on(`${POSTIZ}/upload-from-url`, { id: 'm1', path: 'https://uploads.example.com/clip.mp4' });
  const drop = { ...POST, html: '<p>Big one.</p><video src="/content/media/clip.mp4"></video>', tags: [{ name: '#bigdrop' }, { name: '#autopost' }] };
  await handlePost(drop);
  const first = (await loadState()).p1;
  assert.deepEqual(first.results, { bluesky: 'ok', 'instagram-standalone': 'ok', 'instagram-standalone:story': 'manual' },
    'the Story by hand is noted with the rest');
  const posts = () => web.calls(`${POSTIZ}/posts`).map((c) => JSON.parse(c.body).posts[0].integration.id);
  assert.deepEqual(posts(), ['c1', 'c3']);

  await handlePost(drop, { again: true, only: ['instagram-standalone:story'] });
  assert.deepEqual(posts(), ['c1', 'c3'], 'only the Story: nothing posted, just its reminder');
  assert.deepEqual((await loadState()).p1.results, first.results);
  assert.equal((await loadState()).p1.earlier.length, 1);

  await recordShared('p1', { ...first, results: { ...first.results, 'instagram-standalone': 'error' } });
  await handlePost(drop, { again: true, only: ['instagram-standalone'] });
  assert.deepEqual(posts(), ['c1', 'c3', 'c3'], 'only the feed post');
  assert.deepEqual((await loadState()).p1.results, first.results, 'the feed post fixed, the Story as it was');
});

// serveDraftPreview with a request and a response that note what was answered
async function ask(method, url, { cookie = 'ghost-admin-api-session=s1', origin = 'https://example.com', body, sharer } = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { ...(cookie && { cookie }), ...(origin && { origin }),
    ...(body != null && { 'content-type': 'application/json' }) } });
  const res = { status: 0, body: '', headersSent: false,
    writeHead(code) { this.status = code; this.headersSent = true; return this; }, end(b = '') { this.body = String(b); return this; } };
  await serveDraftPreview(req, res, url.split('?')[0], sharer);
  return res;
}
const sharer = () => { const s = { sharing: new Set(), shared: [] }; s.share = async (post, only) => { s.shared.push([post.id, only]); }; return s; };

test('the Shared posts page: each published post, what each network got, a link to its preview', async () => {
  await recordShared('p1', { title: 'New mix', at: '2026-10-20T18:01:00.000Z', results: { bluesky: 'ok', 'instagram-standalone': 'manual', tiktok: 'error' },
    earlier: [{ at: '2026-10-19T10:00:00.000Z', results: {} }] });
  const res = await ask('GET', '/ghost/social-preview/', { sharer: sharer() });
  assert.equal(res.status, 200);
  assert.match(res.body, /<a href="11111111-2222-3333-4444-555555555555\/">New mix<\/a>/);
  assert.match(res.body, /Shared 20 Oct 2026.*\(shared 2 times in all\): <span class="">Bluesky: posted<\/span>, <span class="">Instagram: in the app<\/span>, <span class="error">TikTok: error<\/span>/s);
  assert.match(res.body, /Old mix<\/a>.*Not shared by the bridge/s);
  assert.match(res.body, /href="\?page=2">Older posts/);
  assert.match(res.body, /<h2>Scheduled<\/h2>.*<a href="31111111-[^"]*\/">Next week<\/a>.*goes out 30 Oct 2026.*<h2>Drafts<\/h2>.*Half done<\/a>.*last edited 22 Oct 2026.*<h2>Published<\/h2>.*New mix/s);
  const filters = web.calls(`${GHOST}/ghost/api/admin/posts/?`).map((c) => new URL(c.url).searchParams.get('filter'));
  assert.deepEqual(filters.sort(), ['status:draft', 'status:published', 'status:scheduled']);

  web.asked.length = 0;
  const older = await ask('GET', '/ghost/social-preview/?page=2', { sharer: sharer() });
  assert.doesNotMatch(older.body, /Scheduled|Drafts/, 'older pages: published posts only');
  assert.deepEqual(web.calls(`${GHOST}/ghost/api/admin/posts/?`).map((c) => new URL(c.url).searchParams.get('page')), ['2']);

  assert.equal((await ask('GET', '/ghost/social-preview/', { cookie: null })).status, 401, 'staff only');
});

test('Share again now: only from the page itself, only a published post, one share at a time', async () => {
  const s = sharer();
  const res = await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: {}, sharer: s });
  assert.equal(res.status, 202);
  assert.deepEqual(s.shared, [['p1', null]], 'no list: every network');
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: { networks: ['threads', 'threads'] }, sharer: s })).status, 202);
  assert.deepEqual(s.shared[1], ['p1', ['threads']]);
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: { networks: [] }, sharer: s })).status, 400, 'none ticked');
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: { networks: ['a b'] }, sharer: s })).status, 400, 'not a channel name');
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: { networks: ['instagram-standalone:story'] }, sharer: s })).status, 202, 'a Story');
  s.shared.length = 1;

  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: {}, origin: 'https://evil.test', sharer: s })).status, 403);
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: {}, cookie: null, sharer: s })).status, 401);
  s.sharing.add('p1');
  assert.equal((await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: {}, sharer: s })).status, 409, 'being shared now');
  s.sharing.clear();
  web.on(`${GHOST}/ghost/api/admin/posts/?`, { posts: [{ ...POST, status: 'draft' }] });
  const draft = await ask('POST', `/ghost/social-preview/${UUID}/share`, { body: {}, sharer: s });
  assert.equal(draft.status, 409);
  assert.match(draft.body, /only a published post/);
  assert.deepEqual(s.shared, [['p1', null]], 'nothing else shared');
});
