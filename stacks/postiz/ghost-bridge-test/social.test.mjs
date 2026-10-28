// stats/social.mjs (Bluesky, Threads, TikTok, Mixcloud) and stats/stats.mjs's Postiz collector: what each writes for
// Grafana from what the networks' APIs answer (the fake web; made-up numbers in the APIs' real shapes), and what
// goes in the errors when an API says no.
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectors, web, NOW, DAY, date, POSTIZ } from './collectors.mjs';

const c = await collectors({ BLUESKY_HANDLE: '@dj.example.com', MIXCLOUD_USER: 'https://www.mixcloud.com/djname/',
  POSTIZ_DB_PASSWORD: 'secret' });
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const CHANNELS = [
  { id: 'c-bsky', identifier: 'bluesky', name: 'DJ', profile: 'dj.example.com', disabled: false },
  { id: "c-th'1", identifier: 'threads', name: 'DJ on Threads', profile: 'djname', picture: 'th.jpg', disabled: false },
  { id: 'c-tt', identifier: 'tiktok', name: 'DJ on TikTok', profile: 'djname', disabled: false },
  { id: 'c-off', identifier: 'mastodon', name: 'Old', disabled: true },
];
beforeEach(() => {
  web.reset();
  web.on(`${POSTIZ}/integrations`, CHANNELS);
  c.tokens["c-th'1"] = 'th-token___refresh';
  c.tokens['c-tt'] = 'tt-token';
});

// ---------- Bluesky ----------
const BSKY = 'https://public.api.bsky.app/xrpc/';
const bskyPost = (id, days, extra = {}) => ({ post: { uri: `at://did:plc:me/app.bsky.feed.post/${id}`, author: { did: 'did:plc:me' },
  record: { text: `post ${id}`, createdAt: ago(days) }, likeCount: 1, repostCount: 0, replyCount: 0, quoteCount: 0, ...extra } });
function bluesky() {
  web.on(`${BSKY}app.bsky.actor.getProfile`, { did: 'did:plc:me', handle: 'dj.example.com', displayName: 'DJ', avatar: 'a.jpg',
    followersCount: 120, followsCount: 30, postsCount: 4, associated: { lists: 1, feedgens: 0, starterPacks: 2 } });
  web.on(`${BSKY}app.bsky.feed.getAuthorFeed`, (url) => (url.searchParams.get('cursor') === 'page2'
    ? { feed: [bskyPost('old', 60, { likeCount: 7 })] }
    : { cursor: 'page2', feed: [
      bskyPost('img', 1, { likeCount: 5, repostCount: 2, record: { text: 'New mix out', createdAt: ago(1), embed: { $type: 'app.bsky.embed.images' },
        facets: [{ features: [{ uri: 'https://example.com/new-mix/?ref=bsky' }] }] } }),
      bskyPost('vid', 2, { record: { text: 'clip', createdAt: ago(2), embed: { $type: 'app.bsky.embed.video' } } }),
      { ...bskyPost('theirs', 1), reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }, // a repost of someone else's
      { post: { ...bskyPost('x', 1).post, author: { did: 'did:plc:someone' } } },
    ] }));
}

test('Bluesky: the account, every page of posts (not reposts), totals and the last 30 days', async () => {
  bluesky();
  const out = await c.poll('bluesky', { history: { [date(1)]: { followers: 100 } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { handle: 'dj.example.com', name: 'DJ', picture: 'a.jpg', url: 'https://bsky.app/profile/dj.example.com' });
  assert.deepEqual(out.posts.map((p) => [p.text, p.type, p.likes]), [['New mix out', 'Images', 5], ['clip', 'Video', 1], ['post old', 'Text', 7]]);
  assert.deepEqual(out.posts[0].links, ['/new-mix/'], 'the site link, as the page it leads to');
  assert.equal(out.posts[0].permalink, 'https://bsky.app/profile/dj.example.com/post/img');
  assert.equal(out.posts[0].posted_ms, String(NOW - DAY));
  assert.equal(web.calls(`${BSKY}app.bsky.feed.getAuthorFeed`).length, 2, 'the second page asked for with the cursor');
  assert.match(web.calls(`${BSKY}app.bsky.feed.getAuthorFeed`)[0].url, /actor=did%3Aplc%3Ame.*filter=posts_no_replies/);
  const t = out.totals;
  assert.deepEqual([t.followers, t.following, t.posts, t.lists, t.feeds, t.starterPacks], [120, 30, 4, 1, 0, 2]);
  assert.deepEqual([t.likes, t.reposts], [13, 2], 'every post');
  assert.deepEqual([t.likes30, t.reposts30, t.posts30], [6, 2, 2], 'posts of the last 30 days');
  assert.equal(t.newFollowers30, 20, 'followers gained since the day before');
  assert.deepEqual(out.history, { [date(1)]: { followers: 100 }, [date(0)]: { followers: 120 } });
  assert.deepEqual(out.postsPerDay, [{ date: date(60), posts: 1 }, { date: date(2), posts: 1 }, { date: date(1), posts: 1 }]);
  assert.deepEqual(web.unanswered, []);
});

test('Bluesky: the handle from Postiz\'s channel when BLUESKY_HANDLE isn\'t set', async () => {
  bluesky();
  const was = process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_HANDLE; // read at each poll
  try { await c.poll('bluesky'); } finally { process.env.BLUESKY_HANDLE = was; }
  assert.match(web.calls(`${BSKY}app.bsky.actor.getProfile`)[0].url, /actor=dj\.example\.com/);
});

test('Bluesky: a profile it can\'t find, and a feed that fails, keep what was there', async () => {
  web.on(`${BSKY}app.bsky.actor.getProfile`, { status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } });
  let out = await c.poll('bluesky', { history: { [date(1)]: { followers: 100 } } });
  assert.deepEqual(out.errors, ['Bluesky app.bsky.actor.getProfile: Profile not found']);
  assert.deepEqual(out.history, { [date(1)]: { followers: 100 } }, 'the followers kept per day stay');
  assert.ok(c.logged.some((l) => l.startsWith('Bluesky stats: Bluesky app.bsky.actor.getProfile: Profile not found')));

  bluesky();
  web.on(`${BSKY}app.bsky.feed.getAuthorFeed`, { status: 502, body: {} });
  const prev = { posts: [{ id: 'kept', ref: 'kept', time: NOW - DAY, likes: 3 }], postsPerDay: [{ date: date(1), posts: 1 }] };
  out = await c.poll('bluesky', prev);
  assert.deepEqual(out.errors, ['posts: Bluesky app.bsky.feed.getAuthorFeed: 502']);
  assert.deepEqual(out.posts.map((p) => p.ref), ['kept']);
  assert.equal(out.totals.followers, 120, 'the account\'s numbers still came');
});

// ---------- Threads ----------
const TH = 'https://graph.threads.net/v1.0';
function threads() {
  web.on(`${POSTIZ}/analytics/`, (url) => (url.pathname.endsWith(encodeURIComponent("c-th'1")) || url.pathname.endsWith("c-th'1")
    ? [{ label: 'Views', data: [{ date: date(1), total: 50 }, { date: date(0), total: 20 }] },
      { label: 'Likes', data: [{ date: date(1), total: 4 }, { date: date(0), total: 1 }] }]
    : []));
  web.on(`${TH}/me/threads_insights?metric=followers_count`, { data: [{ name: 'followers_count', total_value: { value: 300 } }] });
  web.on(`${TH}/me/threads_insights?metric=views`, (url) => ({ data: [
    { name: 'views', values: [{ value: 10 }] }, { name: 'likes', total_value: { value: 2 } },
    { name: 'clicks', total_value: { value: 3 }, link_total_values: [{ link_url: 'https://example.com/new-mix/', value: 3 }] },
  ], since: url.searchParams.get('since') }));
  web.on(`${TH}/me/threads_insights?metric=follower_demographics`, { status: 400, body: { error: { code: 100, message: 'needs 100 followers' } } });
  web.on(`${TH}/me/threads?`, { data: [
    { id: '111', text: 'New mix https://example.com/new-mix/', timestamp: '2026-10-14T10:00:00+0000', media_type: 'TEXT_POST', permalink: 'https://www.threads.com/@djname/post/a' },
    { id: '112', media_type: 'REPOST_FACADE', timestamp: '2026-10-13T10:00:00+0000' },
    { id: '113', text: 'photo', timestamp: '2026-10-12T10:00:00+0000', media_type: 'IMAGE' },
  ] });
  web.on(`${TH}/111/insights`, { data: [{ name: 'views', values: [{ value: 40 }] }, { name: 'likes', values: [{ value: 4 }] },
    { name: 'replies', values: [{ value: 1 }] }, { name: 'reposts', values: [{ value: 0 }] }, { name: 'quotes', values: [{ value: 0 }] },
    { name: 'shares', values: [{ value: 2 }] }] });
  web.on(`${TH}/113/insights`, { data: [{ name: 'views', values: [{ value: 9 }] }, { name: 'likes', values: [{ value: 1 }] }] });
}

test('Threads: Postiz\'s numbers per day, followers and each post\'s from Threads with the channel\'s token', async () => {
  threads();
  const out = await c.poll('threads');
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'DJ on Threads', username: 'djname', picture: 'th.jpg', url: 'https://www.threads.com/@djname' });
  assert.equal(out.totals.followers, 300);
  assert.deepEqual([out.totals.views30, out.totals.likes30], [70, 5], 'Postiz\'s last 30 days');
  assert.deepEqual(out.posts.map((p) => [p.id, p.type, p.views, p.likes, p.shares]), [['111', 'text post', 40, 4, 2], ['113', 'image', 9, 1, null]],
    'the repost left out; a number Threads didn\'t give stays empty');
  assert.deepEqual(out.posts[0].links, ['/new-mix/']);
  assert.deepEqual([out.totals.postLikes, out.totals.postReplies], [5, 1]);
  // the token: Postiz's, up to its "___", read for that channel only (its id quoted safely) and never written out
  assert.ok(web.calls(TH).every((r) => new URL(r.url).searchParams.get('access_token') === 'th-token'));
  assert.ok(c.pg.queries.some((q) => q.includes("WHERE id = 'c-th''1'")), 'the channel id quoted for SQL');
  assert.doesNotMatch(JSON.stringify(out) + c.logged.join('\n'), /th-token/);
  // per day: Postiz's views, and taps on links (Threads' clicks) and likes from Threads, today and the days before
  const today = out.daily.find((d) => d.date === date(0));
  assert.deepEqual([today.views, today.likes, today.linkClicks], [20, 2, 3]);
  assert.equal(out.totals.linkClicks30, 3 * out.daily.filter((d) => d.linkClicks != null).length);
  assert.ok(c.archive('threads').days[date(0)].clicksByLink['https://example.com/new-mix/'] === 3, 'the per-link split, archived');
  assert.equal(out.checking.posts, 2);
  assert.deepEqual(web.unanswered, []);
});

test('Threads: a token Threads turned down says to reconnect the channel', async () => {
  threads();
  web.on(`${TH}/me/threads_insights?metric=followers_count`, { status: 400, body: { error: { code: 190, message: 'Session has expired' } } });
  const out = await c.poll('threads', { posts: [{ id: '9', ref: '9', time: NOW - DAY }] });
  assert.deepEqual(out.errors, ['followers and posts: Threads /me/threads_insights: Session has expired (reconnect the Threads channel in Postiz)']);
  assert.deepEqual(out.posts.map((p) => p.ref), ['9'], 'the posts kept from last time');
  assert.equal(out.totals.views30, 70, 'Postiz\'s numbers still came');
});

test('Threads: no channel in Postiz', async () => {
  web.on(`${POSTIZ}/integrations`, CHANNELS.filter((ch) => ch.identifier !== 'threads'));
  const out = await c.poll('threads');
  assert.deepEqual(out.errors, ['no Threads channel in Postiz']);
  assert.equal(out.account, null);
});

// ---------- TikTok ----------
const TT = 'https://open.tiktokapis.com/v2';
const video = (id, days, views) => ({ id, title: `video ${id} example.com/live/`, create_time: (NOW - days * DAY) / 1000, view_count: views,
  like_count: 3, comment_count: 1, share_count: 0, duration: 30, share_url: `https://www.tiktok.com/@djname/video/${id}` });
function tiktok() {
  web.on(`${POSTIZ}/analytics/c-tt`, [{ label: 'Followers', data: [{ date: date(1), total: 480 }, { date: date(0), total: 490 }] },
    { label: 'Total Likes', data: [{ date: date(0), total: 900 }] }]);
  web.on(`${TT}/user/info/`, { data: { user: { display_name: 'DJ', username: 'djname', avatar_url: 'tt.jpg',
    profile_deep_link: 'https://www.tiktok.com/@djname', follower_count: 500, following_count: 10, likes_count: 950, video_count: 3 } },
  error: { code: 'ok' } });
  web.on(`${TT}/video/list/`, (url, req) => (JSON.parse(req.body).cursor
    ? { data: { videos: [video('3', 90, 1000)], has_more: false }, error: { code: 'ok' } }
    : { data: { videos: [video('1', 1, 200), video('2', 5, 100)], has_more: true, cursor: 1234 }, error: { code: 'ok' } }));
}

test('TikTok: the account from TikTok (over Postiz\'s), every page of videos', async () => {
  tiktok();
  const out = await c.poll('tiktok');
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'DJ', username: 'djname', picture: 'tt.jpg', url: 'https://www.tiktok.com/@djname' });
  assert.deepEqual([out.totals.followers, out.totals.likes, out.totals.videos], [500, 950, 3]);
  assert.deepEqual(out.posts.map((p) => [p.id, p.views]), [['1', 200], ['2', 100], ['3', 1000]]);
  assert.deepEqual(out.posts[0].links, ['/live/']);
  assert.deepEqual([out.totals.views, out.totals.views30, out.totals.posts30], [1300, 300, 2]);
  const lists = web.calls(`${TT}/video/list/`);
  assert.deepEqual(lists.map((r) => JSON.parse(r.body)), [{ max_count: 20 }, { max_count: 20, cursor: 1234 }]);
  assert.ok(lists.every((r) => r.method === 'POST' && r.headers.authorization === 'Bearer tt-token'));
  assert.deepEqual(web.unanswered, []);
});

test('TikTok: a permission the sign-in lacks says to reconnect; Postiz\'s numbers stay', async () => {
  tiktok();
  web.on(`${TT}/video/list/`, { status: 401, body: { error: { code: 'scope_not_authorized', message: 'video.list' } } });
  const out = await c.poll('tiktok');
  assert.deepEqual(out.errors, ['videos: TikTok /video/list/: video.list (reconnect TikTok in Postiz so it asks for every permission again)']);
  assert.equal(out.totals.followers, 500, 'from the user info, before the videos failed');
});

test('TikTok: a video that comes back with 0 views, after it had some, keeps its last number (any network\'s posts do)', async () => {
  tiktok();
  const out1 = await c.poll('tiktok');
  assert.deepEqual(out1.posts.map((p) => [p.id, p.views]), [['1', 200], ['2', 100], ['3', 1000]]);
  web.on(`${TT}/video/list/`, (url, req) => (JSON.parse(req.body).cursor
    ? { data: { videos: [video('3', 90, 0)], has_more: false }, error: { code: 'ok' } }
    : { data: { videos: [video('1', 1, 0), video('2', 5, 100)], has_more: true, cursor: 1234 }, error: { code: 'ok' } }));
  const out = await c.poll('tiktok', out1);
  assert.deepEqual(out.posts.map((p) => [p.id, p.views]), [['1', 200], ['2', 100], ['3', 1000]]);
  assert.equal(out.totals.views, 1300, 'the totals add up the kept numbers');
  assert.deepEqual(out.errors, ['2 number(s) came back 0 after being well above it: kept the last ones']);
});

// ---------- Mixcloud ----------
const MC = 'https://api.mixcloud.com';
const upload = (key, days, plays) => ({ key, name: `Mix ${key}`, created_time: ago(days), audio_length: 3600, play_count: plays,
  favorite_count: 2, repost_count: 1, comment_count: 0, url: `https://www.mixcloud.com${key}`, tags: [{ name: 'House' }] });
function mixcloud() {
  web.on(`${MC}/djname/`, { username: 'djname', name: 'DJ', follower_count: 40, following_count: 5, cloudcast_count: 3,
    pictures: { medium: 'mc.jpg' }, url: 'https://www.mixcloud.com/djname/' });
  web.on(`${MC}/djname/cloudcasts/?limit=100`, { data: [upload('/djname/one/', 2, 30), upload('/djname/two/', 40, 70)],
    paging: { next: `${MC}/djname/cloudcasts/?offset=100` } });
  web.on(`${MC}/djname/cloudcasts/?offset=100`, { data: [upload('/djname/three/', 400, 5)] });
  web.on(`${MC}/djname/one/`, { description: 'Tracklist and more at https://example.com/mix-one/' });
  web.on(`${MC}/djname/two/`, { description: 'no links' });
  web.on(`${MC}/djname/three/`, { description: '' });
}

test('Mixcloud: the profile from its address, every upload, the site links in their details (looked up once)', async () => {
  mixcloud();
  const out = await c.poll('mixcloud', { history: { [date(1)]: { followers: 38, plays: 100, favorites: 6, reposts: 3, comments: 0 } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'DJ', username: 'djname', picture: 'mc.jpg', url: 'https://www.mixcloud.com/djname/' });
  assert.deepEqual(out.uploads.map((u) => [u.title, u.plays, u.tags]), [['Mix /djname/one/', 30, 'House'], ['Mix /djname/two/', 70, 'House'], ['Mix /djname/three/', 5, 'House']]);
  assert.deepEqual([out.totals.followers, out.totals.plays, out.totals.listeners], [40, 105, null], 'no listener numbers: none, not 0');
  assert.deepEqual(out.linksByRef[out.uploads[0].ref], ['/mix-one/']);
  assert.deepEqual([out.totals.newFollowers30, out.totals.newPlays30], [2, 5]);
  // the next poll doesn't look them up again
  web.asked = [];
  await c.poll('mixcloud', out);
  assert.equal(web.calls(`${MC}/djname/one/`).length, 0);
});

test('Mixcloud: a profile that isn\'t there, and no profile set', async () => {
  web.on(`${MC}/djname/`, { status: 404, body: { error: { message: 'Not found' } } });
  assert.deepEqual((await c.poll('mixcloud')).errors, ['Mixcloud: Not found (is MIXCLOUD_USER the profile address?)']);
  const was = process.env.MIXCLOUD_USER;
  process.env.MIXCLOUD_USER = '';
  try { assert.match((await c.poll('mixcloud')).errors[0], /^needs MIXCLOUD_USER/); } finally { process.env.MIXCLOUD_USER = was; }
});

// ---------- Postiz's own analytics, every channel ----------
test('Postiz: every channel\'s series into the archive, the disabled ones left out', async () => {
  web.on(`${POSTIZ}/analytics/`, { status: 500, body: 'no analytics for this provider' });
  web.on(`${POSTIZ}/analytics/c-bsky?date=30`, []);
  web.on(`${POSTIZ}/analytics/c-tt?date=30`, [{ label: 'Followers', data: [{ date: `${date(1)}T00:00:00Z`, total: '480' }, { date: 'bad', total: 1 }] }]);
  const out = await c.poll('postiz');
  assert.deepEqual(out.channels.map((ch) => [ch.network, ch.series, ch.note]), [
    ['bluesky', [], 'Postiz has no numbers for this channel'],
    ['threads', [], `GET /analytics/c-th'1?date=30 -> 500: no analytics for this provider`],
    ['tiktok', ['Followers'], ''],
  ]);
  const a = c.archive('postiz');
  assert.deepEqual(a.days[date(1)], { 'c-tt': { Followers: 480 } });
  assert.deepEqual(Object.keys(a.account.channels), ['c-bsky', "c-th'1", 'c-tt']);
});
