// stats/instagram.mjs: one poll of Instagram's numbers (instagram.json) against a fake Postiz and a fake Instagram
// that, like the real one, refuses a whole insights call when one number in it doesn't apply (watch time on a photo,
// a Story's replies on a post), so the collector has to find out which ones each kind of post has.
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectors, web, NOW, DAY, date, POSTIZ } from './collectors.mjs';

const c = await collectors({ POSTIZ_DB_PASSWORD: 'secret' });
const { pollInstagramStats } = await import('../ghost-bridge/stats/instagram.mjs');
const ago = (ms) => new Date(NOW - ms).toISOString().replace('Z', '+0000');
async function poll(prev) {
  if (prev) await import('node:fs').then((fs) => fs.writeFileSync(`${c.dataDir}/instagram.json`, JSON.stringify(prev)));
  else await import('node:fs').then((fs) => fs.rmSync(`${c.dataDir}/instagram.json`, { force: true }));
  await pollInstagramStats();
  return c.read('instagram');
}

const IG = 'https://graph.instagram.com/v25.0';
const REELS_ONLY = ['ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const STORY_ONLY = ['replies', 'navigation'];
const POSTS = {
  m1: { id: 'm1', caption: 'New mix, link in bio example.com/new-mix/', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: ago(DAY), like_count: 10, comments_count: 2, permalink: 'https://www.instagram.com/reel/a/' },
  m2: { id: 'm2', caption: 'photos', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: ago(3 * DAY), like_count: 5, comments_count: 0, media_url: 'm2.jpg' },
  m3: { id: 'm3', caption: 'old', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: ago(40 * DAY), like_count: 1, comments_count: 1, media_url: 'm3.jpg' },
};
const breakdown = (results) => ({ total_value: { breakdowns: [{ results: results.map(([v, n]) => ({ dimension_values: [v], value: n })) }] } });
const refuse = (message) => ({ status: 400, body: { error: { code: 100, message } } });

function instagram() {
  web.on(`${POSTIZ}/integrations`, [{ id: 'c-ig', identifier: 'instagram-standalone', name: 'DJ', profile: 'old_name', picture: 'ig.jpg', disabled: false }]);
  web.on(`${POSTIZ}/analytics/c-ig`, [
    { label: 'Followers', data: [{ date: date(1), total: 4 }, { date: date(0), total: 2 }] },
    { label: 'Reach', data: [{ date: date(1), total: 300 }, { date: date(0), total: 100 }] },
    { label: 'Profile Views', data: [{ date: date(0), total: 999 }] }, // not post views: left out
  ]);
  web.on(IG, (url) => {
    const p = url.pathname.replace('/v25.0', '');
    const q = url.searchParams;
    if (q.get('access_token') !== 'ig-token') return { status: 400, body: { error: { code: 190, message: 'Error validating access token' } } };
    const metric = q.get('metric') || '';
    const list = metric.split(',');
    if (p === '/me') return { user_id: '17', username: 'djname', followers_count: 1200, follows_count: 80, media_count: 3 };
    if (p === '/me/media') return { data: Object.values(POSTS) };
    if (p === '/me/stories') return { data: [{ id: 's1', caption: 'tonight', media_type: 'IMAGE', media_product_type: 'STORY', timestamp: ago(7_200_000), permalink: 'https://www.instagram.com/stories/s1/' }] };
    if (p === '/me/insights' && metric === 'online_followers') {
      return { data: [{ name: 'online_followers', values: [{ end_time: '2026-10-14T07:00:00+0000', value: { 0: 10, 12: 30 } }] }] };
    }
    if (p === '/me/insights' && metric.endsWith('_demographics')) {
      if (metric !== 'follower_demographics') return refuse('not enough engagement');
      return { data: [{ name: metric, ...breakdown({ age: [['25-34', 60], ['18-24', 40]], gender: [['M', 30], ['F', 70]],
        country: [['DE', 50]], city: [['Berlin, Germany', 20]] }[q.get('breakdown')]) }] };
    }
    if (p === '/me/insights' && q.get('breakdown')) return { data: [{ name: metric, ...breakdown([['FOLLOWER', 5], ['NON_FOLLOWER', 2]]) }] };
    if (p === '/me/insights') { // the account's numbers per day; this account has no website_clicks
      if (list.includes('website_clicks')) return refuse('(#100) metric[13] must be one of the following values');
      return { data: list.map((name) => ({ name, total_value: { value: { profile_views: 7, profile_links_taps: 3 }[name] ?? 1 } })) };
    }
    const m = /^\/(m\d|s1)\/insights$/.exec(p);
    if (m) {
      const kind = m[1] === 's1' ? 'STORY' : POSTS[m[1]].media_product_type;
      if (kind !== 'REELS' && list.some((x) => REELS_ONLY.includes(x))) return refuse('reels only');
      if (kind !== 'STORY' && list.some((x) => STORY_ONLY.includes(x))) return refuse('stories only');
      return { data: list.map((name) => ({ name, values: [{ value: { likes: m[1] === 'm1' ? 11 : 4, views: 90, saved: 2 }[name] ?? 1 }] })) };
    }
    return { status: 404, body: { error: { message: `the fake Instagram has no ${p}` } } };
  });
}
beforeEach(() => { web.reset(); c.tokens['c-ig'] = 'ig-token___xyz'; });

test('the account, its numbers per day, every post with the numbers its kind has, Stories and the audience', async () => {
  instagram();
  const out = await poll({ followerHistory: { [date(1)]: 1190 } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'DJ', username: 'djname', picture: 'ig.jpg' });
  assert.deepEqual([out.totals.followers, out.totals.following, out.totals.posts], [1200, 80, 3]);
  assert.deepEqual([out.totals.newFollowers, out.totals.reach], [6, 400], 'Postiz\'s 30 days; its profile views left out');
  assert.equal(out.totals.views, undefined);
  // posts: the kind each is, the numbers its kind has, the likes from the insights (newer than the list's)
  assert.deepEqual(out.posts.map((p) => [p.id, p.type, p.likes, p.views, p.saved]), [['m1', 'Reel', 11, 90, 2], ['m2', 'Carousel', 4, 90, 2], ['m3', 'Photo', 4, 90, 2]]);
  assert.equal(out.posts[0].avgWatchMs, 1, 'a Reel\'s watch time');
  assert.equal(out.posts[1].avgWatchMs, null, 'none for a photo');
  assert.deepEqual(out.posts[0].links, ['/new-mix/']);
  assert.ok(!out.metricsOk['media:FEED'].list.includes('ig_reels_avg_watch_time'), 'learned: posts have no watch time');
  assert.ok(out.metricsOk['media:REELS'].list.includes('ig_reels_avg_watch_time'));
  assert.ok(!out.metricsOk.day.list.includes('website_clicks'), 'learned: this account has no website clicks');
  assert.equal(out.totals.postLikes, 19);
  assert.deepEqual(out.postsPerDay.map((d) => d.date), [date(40), date(3), date(1)]);
  // the account per day: today, yesterday and earlier days, as many as the poll's calls allow (8 a day with breakdowns)
  assert.deepEqual(Object.keys(out.profileHistory), [date(4), date(3), date(2), date(1), date(0)]);
  assert.deepEqual(out.profileHistory[date(0)].by['follows_and_unfollows/follow_type'], { FOLLOWER: 5, NON_FOLLOWER: 2 });
  assert.deepEqual([out.totals.profileViews30, out.totals.linkTaps30], [35, 15]);
  // daily: Postiz's new followers and reach, followers kept per day, profile views
  const today = out.daily.find((d) => d.date === date(0));
  assert.deepEqual([today.newFollowers, today.reach, today.followers, today.profileViews], [2, 100, 1200, 7]);
  assert.equal(out.daily.find((d) => d.date === date(1)).followers, 1190);
  // Stories: kept with their numbers (a Story has replies; a post doesn't)
  assert.deepEqual(out.stories.map((s) => [s.id, s.type, s.views, s.replies]), [['s1', 'Story', 90, 1]]);
  assert.deepEqual([out.totals.stories30, out.totals.storyViews30], [1, 90]);
  // the audience: followers only (Instagram gives the others from more engagement), in words, biggest first
  assert.deepEqual(out.audience.gender, [{ name: 'Women', people: 70 }, { name: 'Men', people: 30 }]);
  assert.deepEqual(out.audience.country, [{ name: 'Germany', people: 50 }]);
  // followers online by hour: Instagram's hours are Pacific time (midnight on 14 October = 07:00 UTC, summer time)
  const online = Object.fromEntries(out.onlineByHour.filter((h) => h.followers != null).map((h) => [h.hour, h.followers]));
  assert.deepEqual(online, { '07': 10, 19: 30 });
  assert.doesNotMatch(JSON.stringify(out) + c.logged.join('\n'), /ig-token/);
  assert.ok(c.pg.queries.some((sql) => sql.includes("WHERE id = 'c-ig'")));
});

test('the next poll asks only what it must: the numbers learned, the account per day at most hourly', async () => {
  instagram();
  const first = await poll();
  web.asked = [];
  const out = await poll(first);
  const insights = web.calls(`${IG}/me/insights`);
  assert.equal(insights.length, 0, 'the account per day was asked under an hour ago; the audience today');
  assert.equal(web.calls(`${IG}/m2/insights`).length, 1, 'one call: the numbers a post has are known');
  assert.deepEqual(out.profileHistory, first.profileHistory, 'kept');
});

test('a token Instagram turned down says to reconnect; Postiz\'s numbers and the last posts stay', async () => {
  instagram();
  c.tokens['c-ig'] = 'expired';
  const out = await poll({ posts: [{ id: 'old', ref: 'old', time: NOW - DAY, likes: 1 }] });
  assert.deepEqual(out.errors, [
    'posts: Instagram /me: Error validating access token (reconnect the Instagram channel in Postiz)',
    'stories: Instagram /me/stories: Error validating access token (reconnect the Instagram channel in Postiz)',
  ]);
  assert.deepEqual(out.posts.map((p) => p.ref), ['old']);
  assert.equal(out.totals.reach, 400);
});

test('no Instagram channel in Postiz', async () => {
  web.on(`${POSTIZ}/integrations`, []);
  const out = await poll();
  assert.deepEqual(out.errors, ['no Instagram channel in Postiz']);
  assert.equal(web.calls(IG).length, 0);
});
