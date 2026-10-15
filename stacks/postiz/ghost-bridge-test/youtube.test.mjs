// stats/youtube.mjs: one poll of YouTube's numbers (youtube.json): the channel's sign-in read from Postiz's database
// (a fake Postgres), swapped at Google for an access token, then YouTube's Data and Analytics APIs (the fake web).
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectors, web, date } from './collectors.mjs';

const c = await collectors({ POSTIZ_DB_PASSWORD: 'secret', YOUTUBE_CLIENT_ID: 'client-1', YOUTUBE_CLIENT_SECRET: 'shh' });
const { pollYouTubeStats } = await import('../ghost-bridge/stats/youtube.mjs');
const { storeFor } = await import('../ghost-bridge/stats/history.mjs');
async function poll(prev) {
  if (prev) fs.writeFileSync(`${c.dataDir}/youtube.json`, JSON.stringify(prev));
  else fs.rmSync(`${c.dataDir}/youtube.json`, { force: true });
  await pollYouTubeStats();
  return c.read('youtube');
}

const TOKEN = 'https://oauth2.googleapis.com/token';
const DATA = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const report = (cols, rows) => ({ columnHeaders: cols.map((name) => ({ name })), rows });
let channel;
function youtube() {
  channel = { name: 'DJ', picture: 'yt.jpg', refreshToken: 'yt-refresh', refreshNeeded: 'f' };
  c.pg.answer = (sql) => (/"providerIdentifier" = 'youtube'/.test(sql) && channel ? [channel] : []);
  web.on(TOKEN, (url, req) => {
    const form = new URLSearchParams(req.body);
    if (form.get('refresh_token') !== 'yt-refresh') return { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    assert.deepEqual([form.get('client_id'), form.get('client_secret'), form.get('grant_type')], ['client-1', 'shh', 'refresh_token']);
    return { access_token: 'yt-access', expires_in: 3600 };
  });
  web.on(DATA, (url, req) => {
    assert.equal(req.headers.authorization, 'Bearer yt-access');
    const q = url.searchParams;
    if (url.pathname.endsWith('/channels')) {
      return { items: [{ id: 'UC1', snippet: { title: 'DJ Channel', customUrl: '@djname' },
        statistics: { subscriberCount: '1000', viewCount: '50000', videoCount: '2', hiddenSubscriberCount: false },
        contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] };
    }
    if (url.pathname.endsWith('/playlistItems')) {
      return q.get('pageToken') === 'p2'
        ? { items: [{ contentDetails: { videoId: 'v2' } }] }
        : { items: [{ contentDetails: { videoId: 'v1' } }], nextPageToken: 'p2' };
    }
    if (url.pathname.endsWith('/videos')) {
      assert.equal(q.get('id'), 'v1,v2');
      return { items: [
        { id: 'v1', snippet: { title: 'Mix one', publishedAt: `${date(10)}T18:00:00Z`, description: 'More at https://example.com/mix-one/' },
          contentDetails: { duration: 'PT1H2M3S' }, statistics: { viewCount: '400', likeCount: '20', commentCount: '3' } },
        { id: 'v2', snippet: { title: 'Live set', publishedAt: `${date(3)}T20:00:00Z` }, liveStreamingDetails: { actualStartTime: `${date(3)}T20:05:00Z` },
          contentDetails: { duration: 'PT2H' }, statistics: { viewCount: '100' } },
      ] };
    }
    return { status: 404, body: { error: { message: 'no such fake' } } };
  });
  web.on(ANALYTICS, (url) => {
    const q = url.searchParams;
    const metrics = q.get('metrics');
    const dims = q.get('dimensions');
    // this channel has no "engaged views": a report asking for them is refused whole
    if (metrics.includes('engagedViews')) return { status: 400, body: { error: { message: 'Unknown identifier (engagedViews)' } } };
    if (q.get('filters') === 'video==v1') return report(['day', 'views', 'estimatedMinutesWatched', 'likes'], [[date(10), 300, 900, 15], [date(9), 100, 200, 5]]);
    if (q.get('filters')) return report(['day', 'views'], []);
    if (dims === 'day') {
      return report(['day', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost', 'dislikes'],
        [[date(40), 999, 0, 0, 0, 0, 0, 0, 0, 0], [date(2), 100, 300, 180, 10, 1, 2, 5, 1, 0], [date(1), 50, 100, 120, 4, 0, 0, 3, 0, 0]]);
    }
    if (dims === 'day,insightTrafficSourceType') return report(['day', 'insightTrafficSourceType', 'views', 'estimatedMinutesWatched'],
      [[date(1), 'YT_SEARCH', 30, 60], [date(1), 'SUBSCRIBER', 10, 20], [date(2), 'YT_SEARCH', 5, 5], [date(60), 'EXT_URL', 99, 99]]);
    if (dims === 'ageGroup,gender') return report(['ageGroup', 'gender', 'viewerPercentage'], [['age25-34', 'female', 60], ['age18-24', 'male', 40]]);
    return { status: 400, body: { error: { message: 'not for this channel' } } };
  });
}
beforeEach(() => web.reset());

test('the channel, its days, every video (each page) and its days, where the views came from', async () => {
  youtube();
  const out = await poll();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'DJ', picture: 'yt.jpg', id: 'UC1', title: 'DJ Channel', handle: '@djname', url: 'https://www.youtube.com/@djname' });
  assert.deepEqual([out.totals.subscribers, out.totals.viewsAllTime, out.totals.videos], [1000, 50000, 2]);
  // per day: by our names; subscribers worked back from today's count
  assert.deepEqual(out.daily.map((d) => [d.date, d.views, d.minutesWatched, d.subscribersNet, d.subscribers]),
    [[date(40), 999, 0, 0, 993], [date(2), 100, 300, 4, 997], [date(1), 50, 100, 3, 1000]]);
  assert.equal(out.daily.find((d) => d.date === date(2)).dislikes, 0, 'the numbers nothing shows yet, kept by YouTube\'s name');
  assert.deepEqual([out.totals.views, out.totals.subscribersGained, out.totals.subscribersLost], [150, 8, 1], 'the last 30 days');
  // videos: both pages, a live one, its length, its link to the site
  assert.deepEqual(out.videos.map((v) => [v.id, v.type, v.duration, v.views, v.likes]), [['v2', 'Live', 7200, 100, null], ['v1', 'Video', 3723, 400, 20]]);
  assert.equal(out.videos[0].date, `${date(3)}T20:05:00Z`, 'a live video dates from when it started');
  assert.deepEqual(out.videos[1].links, ['/mix-one/']);
  assert.deepEqual([out.totals.likesAllTime, out.totals.commentsAllTime], [20, 3]);
  // each video's days, from YouTube's own numbers per day, in stats.db
  const days = storeFor(c.dataDir).history('youtube').posts.v1;
  assert.deepEqual(days[date(10)].views, 300);
  assert.deepEqual(days[date(9)].minutesWatched, 200);
  // where the views came from, the last 28 days, in words
  assert.deepEqual(out.sources28, [{ source: 'YouTube search', views: 35, minutes: 65 }, { source: 'Subscriptions', views: 10, minutes: 20 }]);
  assert.deepEqual(c.archive('youtube').days[date(0)].audience, { 'age25-34 / female': 60, 'age18-24 / male': 40 });
  assert.equal(web.calls(TOKEN).length, 1);
  assert.doesNotMatch(JSON.stringify(out) + c.logged.join('\n'), /yt-refresh|yt-access/);
  assert.deepEqual(web.unanswered, []);
});

test('a sign-in Google turned down says what to check; the channel saying it needs reconnecting too', async () => {
  youtube();
  channel.refreshToken = 'revoked';
  channel.refreshNeeded = 't';
  const out = await poll();
  assert.deepEqual(out.errors, ['Postiz says the YouTube channel needs reconnecting',
    'Google sign-in: Token has been expired or revoked. (reconnect the YouTube channel in Postiz; is the Google app "In production"?)']);
  assert.deepEqual(out.account, { name: 'DJ', picture: 'yt.jpg' });
});

test('no YouTube channel, and an API not enabled in the Google project', async () => {
  youtube();
  channel = null;
  assert.deepEqual((await poll()).errors, ['no YouTube channel in Postiz']);
  youtube();
  web.on(`${DATA}/channels`, { status: 403, body: { error: { message: 'YouTube Data API v3 has not been used', errors: [{ reason: 'accessNotConfigured' }] } } });
  const out = await poll();
  assert.deepEqual(out.errors, ['channel: YouTube /channels: YouTube Data API v3 has not been used (enable this API in the Google Cloud project)']);
  assert.equal(out.daily.length, 3, 'the Analytics API still answered');
});
