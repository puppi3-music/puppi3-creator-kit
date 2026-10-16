// share/share.mjs: what a published post turns into on each network, run fully dry the way the Social preview runs
// it (a draft preview: nothing posted, uploaded or sent), against a fake Postiz that only lists its channels.
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

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
const { previewStore, editCustom } = await import('../ghost-bridge/config.mjs');

// handlePost as a draft preview: { entries (one per network: label, status, caption, why, media), notes (the ntfy
// notifications it would send), log }
async function share(post) {
  const pv = { draft: true, log: [], entries: [], notes: [] };
  await previewStore.run(pv, () => handlePost({ id: 'p1', status: 'published', visibility: 'public',
    url: 'https://example.com/new-mix/', title: 'New mix', ...post }));
  return { ...pv, byLabel: Object.fromEntries(pv.entries.map((e) => [e.label, e])) };
}
const tags = (...names) => names.map((name) => ({ name }));
// custom.json (what the Social preview saves) sits next to STATE_FILE, in this run's own folder
const dataDir = path.dirname(process.env.STATE_FILE);
await fs.mkdir(dataDir, { recursive: true });
after(() => fs.rm(dataDir, { recursive: true, force: true }));

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
  assert.equal(byLabel['instagram-standalone:story'].stickerOn, true);
  assert.equal(byLabel['instagram-standalone:story'].stickerUrl, 'https://example.com/i/new-mix');
  assert.equal(notes.length, 1, 'the Story reminder');
});

test('the link sticker set on the Social preview: its text on the card and in both reminders, turned off, turned on, another link, no link', async () => {
  await editCustom('p1', (m) => { m.sticker = 'LISTEN NOW'; });
  try {
    const { byLabel, notes } = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(byLabel['instagram-standalone:story'].stickerText, 'LISTEN NOW');
    assert.match(notes[0].message, /Sticker text:\nLISTEN NOW/);
    assert.deepEqual(notes[0].actions.map((a) => a.label), ['Copy sticker link', 'Open Instagram', 'Copy sticker text']);
    // #story + #bigdrop by hand: the Story's own notification carries it
    const byHand = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#story') });
    assert.equal(byHand.byLabel['instagram-standalone:story'].stickerText, 'LISTEN NOW');
    const ig = byHand.notes.find((n) => n.title.includes('Instagram'));
    assert.match(ig.message, /Sticker text \("Customize sticker text"\): LISTEN NOW/);
    assert.ok(ig.actions.some((a) => a.label === 'Copy sticker text' && a.value === 'LISTEN NOW'));
    // turned off: a plain Story
    await editCustom('p1', (m) => { m.storyLink = false; });
    const off = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(off.byLabel['instagram-standalone:story'].stickerOn, false);
    assert.doesNotMatch(off.notes[0].message, /sticker/i);
    assert.deepEqual(off.notes[0].actions.map((a) => a.label), ['Open Instagram', 'Open post']);
    // turned on for a #story by hand that isn't a #bigdrop
    await editCustom('p1', (m) => { m.storyLink = true; });
    const on = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story') });
    assert.equal(on.byLabel['instagram-standalone:story'].stickerOn, true);
    const story = on.notes.find((n) => n.title.includes('Instagram'));
    assert.match(story.message, /🔗 Add a link sticker to it → https:\/\/example.com\/i\/new-mix/);
    // a link typed on the Social preview: as typed elsewhere, tagged for Instagram on the site
    await editCustom('p1', (m) => { m.storyLink = true; m.stickerLink = 'https://shop.example.org/merch'; });
    const other = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(other.byLabel['instagram-standalone:story'].stickerUrl, 'https://shop.example.org/merch');
    assert.equal(other.byLabel['instagram-standalone:story'].stickerAuto, 'https://example.com/i/new-mix');
    assert.match(other.notes[0].message, /Sticker link:\nhttps:\/\/shop.example.org\/merch/);
    assert.equal(other.notes[0].actions[0].value, 'https://shop.example.org/merch');
    await editCustom('p1', (m) => { m.stickerLink = 'https://example.com/tickets/'; });
    const site = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story') });
    assert.equal(site.byLabel['instagram-standalone:story'].stickerUrl, 'https://example.com/i/tickets');
    assert.ok(site.notes.find((n) => n.title.includes('Instagram')).actions.some((a) => a.value === 'https://example.com/i/tickets'));
    // no link: a sticker of text only, both reminders without a link
    await editCustom('p1', (m) => { m.stickerLink = 'none'; });
    const plain = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(plain.byLabel['instagram-standalone:story'].stickerOn, true);
    assert.equal(plain.byLabel['instagram-standalone:story'].stickerUrl, null);
    assert.doesNotMatch(plain.notes[0].message, /Sticker link|Link sticker/);
    assert.match(plain.notes[0].message, /add its text with Aa[^]*Sticker text:\nLISTEN NOW/);
    assert.deepEqual(plain.notes[0].actions.map((a) => a.label), ['Copy sticker text', 'Open Instagram', 'Open post']);
    const plainStory = (await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story') })).notes.find((n) => n.title.includes('Instagram'));
    assert.match(plainStory.message, /🔗 Add its text with Aa: LISTEN NOW/);
    assert.deepEqual(plainStory.actions.map((a) => a.label), ['Open Instagram', 'Copy sticker text']);
    // no link and no text: nothing to add
    await editCustom('p1', (m) => { delete m.sticker; });
    const empty = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(empty.byLabel['instagram-standalone:story'].stickerOn, false);
    assert.doesNotMatch(empty.notes[0].message, /sticker/i);
  } finally {
    await editCustom('p1', (m) => { delete m.sticker; delete m.storyLink; delete m.stickerLink; });
  }
});

test('#story by hand without #bigdrop: no link sticker unless turned on', async () => {
  const { byLabel, notes } = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story') });
  assert.equal(byLabel['instagram-standalone:story'].stickerOn, false);
  assert.equal(byLabel['instagram-standalone:story'].stickerUrl, 'https://example.com/i/new-mix');
  assert.doesNotMatch(notes.find((n) => n.title.includes('Instagram')).message, /link sticker/);
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

test('the Instagram Story at a time of its own: Postiz schedules one it posts, a reminder for one by hand comes then', async () => {
  const at = Date.now() + 5 * 3_600_000;
  await editCustom('p1', (m) => { m.storyAt = new Date(at).toISOString(); });
  try {
    // #story posted by Postiz: scheduled for then, the rest now
    const auto = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story', '#autopost') });
    assert.equal(auto.byLabel['instagram-standalone:story'].storyAt, new Date(at).toISOString());
    const log = auto.log.join('\n');
    assert.match(log, new RegExp(`"type": "schedule",\\s*"date": "${new Date(at).toISOString()}"`));
    assert.match(log, /"type": "now"/, 'the other networks go now');
    // #bigdrop: its Story reminder comes then, saying so
    const big = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(big.notes[0].at, at);
    assert.match(big.notes[0].message, /^⏰ The time you set for it: /);
    // #story by hand: its notification comes then
    const byHand = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#story') });
    assert.equal(byHand.notes.find((n) => n.title.includes('Instagram')).at, at);
    assert.equal(byHand.notes.find((n) => n.title.includes('TikTok')).at, undefined);
    // a time gone by: with the post
    await editCustom('p1', (m) => { m.storyAt = new Date(Date.now() - 3_600_000).toISOString(); });
    const late = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost') });
    assert.equal(late.byLabel['instagram-standalone:story'].storyLate, true);
    assert.equal(late.notes[0].at, undefined);
    // nothing set: the card shows the post's own time in Ghost (a scheduled post's), and it goes with the post
    await editCustom('p1', (m) => { delete m.storyAt; });
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const sched = await share({ html: '<video src="/v.mp4"></video>', tags: tags('#bigdrop', '#autopost'), status: 'scheduled', published_at: when });
    assert.equal(sched.byLabel['instagram-standalone:story'].postAt, when);
    assert.equal(sched.byLabel['instagram-standalone:story'].storyAt, '');
    assert.equal(sched.notes[0].at, undefined);
  } finally {
    await editCustom('p1', (m) => { delete m.storyAt; });
  }
});
