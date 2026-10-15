// share/share.mjs: what a published post turns into on each network, run fully dry the way the Social preview runs
// it (a draft preview: nothing posted, uploaded or sent), against a fake Postiz that only lists its channels.
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// the fake Postiz: GET /integrations, and a note of every request, so a test can see nothing else was asked
const CHANNELS = [
  { id: 'c1', identifier: 'bluesky', name: 'Bluesky', disabled: false },
  { id: 'c2', identifier: 'threads', name: 'Threads', disabled: false },
  { id: 'c3', identifier: 'instagram-standalone', name: 'Instagram', disabled: false },
  { id: 'c4', identifier: 'tiktok', name: 'TikTok', disabled: false },
  { id: 'c5', identifier: 'mastodon', name: 'Mastodon (not in CHANNELS)', disabled: false },
];
const asked = [];
const postiz = http.createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`);
  if (req.method === 'GET' && req.url === '/integrations') return res.end(JSON.stringify(CHANNELS));
  res.writeHead(500).end('the fake Postiz only lists channels');
});
await new Promise((ok) => postiz.listen(0, '127.0.0.1', ok));
after(() => { postiz.closeAllConnections(); postiz.close(); });
process.env.POSTIZ_API_URL = `http://127.0.0.1:${postiz.address().port}`;

// the bridge reads its settings when it loads: after the fake's address is set
const { handlePost, musicRouting } = await import('../ghost-bridge/share/share.mjs');
const { previewStore } = await import('../ghost-bridge/config.mjs');

// handlePost as a draft preview: { entries (one per network: label, status, caption, why, media), notes (the ntfy
// notifications it would send), log }
async function share(post) {
  const pv = { draft: true, log: [], entries: [], notes: [] };
  await previewStore.run(pv, () => handlePost({ id: 'p1', status: 'published', visibility: 'public',
    url: 'https://example.com/new-mix/', title: 'New mix', ...post }));
  return { ...pv, byLabel: Object.fromEntries(pv.entries.map((e) => [e.label, e])) };
}
const tags = (...names) => names.map((name) => ({ name }));

test('a text post: Bluesky and Threads post themselves; Instagram and TikTok wait for you in the app', async () => {
  asked.length = 0;
  const { byLabel, notes } = await share({ html: '<p>Out now.</p><p>#house</p>' });
  assert.deepEqual(Object.keys(byLabel), ['bluesky', 'threads', 'instagram-standalone', 'tiktok']);
  assert.equal(byLabel.bluesky.status, 'auto');
  assert.equal(byLabel.bluesky.caption, 'Out now.\n\nhttps://example.com/b/new-mix\n\n#house');
  assert.equal(byLabel.threads.caption, 'Out now.\n\nhttps://example.com/t/new-mix\n\n#house');
  assert.equal(byLabel['instagram-standalone'].status, 'manual');
  assert.equal(byLabel['instagram-standalone'].why, 'IG_TIKTOK_MODE=manual');
  assert.equal(byLabel['instagram-standalone'].caption, 'Out now.\n\nFull post: link in bio 🔗\n\n#house');
  assert.equal(byLabel.tiktok.status, 'manual');
  assert.equal(notes.length, 2, 'a "post it in the app" notification each for Instagram and TikTok');
  assert.deepEqual(asked, ['GET /integrations'], 'nothing posted to Postiz');
});

test('#autopost on a post with no picture or video: Instagram and TikTok are left out', async () => {
  const { byLabel, notes } = await share({ html: '<p>Words only.</p>', tags: tags('#autopost') });
  assert.equal(byLabel.bluesky.status, 'auto');
  assert.equal(byLabel['instagram-standalone'].status, 'skip');
  assert.equal(byLabel.tiktok.status, 'skip');
  assert.equal(notes.length, 0);
});

test('#autopost with a video: every network posts it, the video attached', async () => {
  const { byLabel } = await share({ html: '<p>Clip.</p><video src="/content/media/clip.mp4"></video>', tags: tags('#AutoPost') });
  for (const label of ['bluesky', 'threads', 'instagram-standalone', 'tiktok']) {
    assert.equal(byLabel[label].status, 'auto', label);
    assert.deepEqual(byLabel[label].media, [{ kind: 'video', url: 'https://example.com/content/media/clip.mp4', src: 'https://example.com/content/media/clip.mp4' }], label);
  }
});

test('the featured link and a #campaign- tag', async () => {
  const { byLabel } = await share({
    html: '<p>Full set: <a href="https://soundcloud.com/me/set?si=x">here</a></p>',
    tags: tags('#campaign-summer'),
  });
  assert.equal(byLabel.bluesky.caption, 'Full set: here\n\n🔗 SoundCloud: https://soundcloud.com/me/set\n'
    + 'https://example.com/new-mix/?utm_source=bluesky&utm_medium=social&utm_campaign=summer');
  assert.equal(byLabel.tiktok.caption, 'Full set: here\n\n🔗 Also on SoundCloud + the full post: link in bio');
});

test('#bigdrop with a video: a reminder to add the link-sticker Story', async () => {
  const { byLabel, notes } = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
  assert.equal(byLabel['instagram-standalone:story'].status, 'manual');
  assert.equal(byLabel['instagram-standalone:story'].sticker, 'https://example.com/i/new-mix');
  assert.equal(notes.length, 1, 'the Story reminder');
});

test('posts that aren\'t shared', async () => {
  for (const [why, post] of [['#nosocial', { tags: tags('#nosocial') }], ['members only', { visibility: 'members' }],
    ['no title', { title: '' }]]) {
    const { entries, log } = await share({ html: '<p>Hi</p>', ...post });
    assert.equal(entries.length, 0, why);
    assert.match(log.join('\n'), /skip:/, why);
  }
});

test('musicRouting: Instagram and TikTok post themselves only when a tag says so (IG_TIKTOK_MODE=manual)', () => {
  assert.deepEqual(musicRouting([], 'video', false), { auto: false, why: 'IG_TIKTOK_MODE=manual' });
  assert.deepEqual(musicRouting(['#autopost'], 'image', false), { auto: true, why: '#autopost' });
  assert.deepEqual(musicRouting(['#autopost', '#manualpost'], 'video', false), { auto: false, why: '#manualpost' });
});
