// stats/history.mjs's helpers: the numbers per day the dashboards draw, and which site page a post leads to.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY, day, num, median, withHistory, mergeDaily, totalsByDate, perDay, last30, posts30, insightValue, zoneHour,
  postRef, sitePath, siteLinks, trackEarly, setTakeOffNotice, gainsByDay, storeFor, keepLastOverZero } from '../ghost-bridge/stats/history.mjs';

test('withHistory: a total per day, and each day\'s gain on the day before', () => {
  const now = Date.now();
  const [d2, d1, d0] = [day(now - 2 * DAY), day(now - DAY), day(now)];
  const { history, daily } = withHistory({ [d2]: { followers: 100 }, [d1]: { followers: 110 } }, { followers: 125 }, ['followers'], 30);
  assert.deepEqual(history, { [d2]: { followers: 100 }, [d1]: { followers: 110 }, [d0]: { followers: 125 } });
  assert.deepEqual(daily, [
    { date: d2, followers: 100, newFollowers: null }, // no day before it
    { date: d1, followers: 110, newFollowers: 10 },
    { date: d0, followers: 125, newFollowers: 15 },
  ]);
  // a total that went down (a post deleted) is no gain; a day missed is no gain the day after it
  const down = withHistory({ [d1]: { followers: 110 } }, { followers: 105 }, ['followers'], 30).daily;
  assert.equal(down.at(-1).newFollowers, null);
  const gap = withHistory({ [d2]: { followers: 100 } }, { followers: 125 }, ['followers'], 30).daily;
  assert.equal(gap.at(-1).newFollowers, null);
  // only the last `days` days are kept; nothing collected today adds no day
  assert.deepEqual(Object.keys(withHistory({ [d2]: { followers: 1 }, [d1]: { followers: 2 } }, { followers: 3 }, ['followers'], 2).history), [d1, d0]);
  assert.deepEqual(Object.keys(withHistory({ [d1]: { followers: 2 } }, {}, ['followers'], 30).history), [d1]);
});

test('last30 and posts30: sums over the last 30 days', () => {
  const now = Date.now();
  const totals = {};
  last30([{ date: day(now - 40 * DAY), views: 1000 }, { date: day(now - DAY), views: 5 }, { date: day(now), views: 7 },
    { date: day(now), likes: null }], ['views', 'likes'], totals);
  assert.deepEqual(totals, { views30: 12, likes30: null });
  posts30([{ time: now - 40 * DAY, likes: 100 }, { time: now - DAY, likes: 3 }, { time: now, likes: 4 }, { time: now }], ['likes'], totals);
  assert.equal(totals.likes30, 7);
  assert.equal(totals.posts30, 3);
});

test('mergeDaily, totalsByDate and perDay', () => {
  assert.deepEqual(mergeDaily([{ date: '2026-01-02', a: 1 }], [{ date: '2026-01-01', b: 2 }, { date: '2026-01-02', b: 3 }], null),
    [{ date: '2026-01-01', b: 2 }, { date: '2026-01-02', a: 1, b: 3 }]);
  const h = { '2026-01-02': { views: 2, likes: null }, '2026-01-01': { views: 1, likes: 4 } };
  assert.deepEqual(totalsByDate(h, false), { '2026-01-01': { views: 1, likes: 4 }, '2026-01-02': { views: 2, likes: null } });
  // YouTube's numbers per day are added up into totals
  assert.deepEqual(totalsByDate(h, true), { '2026-01-01': { views: 1, likes: 4 }, '2026-01-02': { views: 3, likes: 4 } });
  assert.deepEqual(perDay([{ time: Date.parse('2026-01-01T05:00Z') }, { time: Date.parse('2026-01-01T23:59Z') },
    { time: Date.parse('2026-01-02T00:00Z') }, {}]), [{ date: '2026-01-01', posts: 2 }, { date: '2026-01-02', posts: 1 }]);
});

test('num and median', () => {
  assert.deepEqual([num('12'), num(0), num(''), num(null), num('abc'), num(Infinity)], [12, 0, null, null, null, null]);
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('insightValue: Instagram and Threads give one number three ways', () => {
  assert.equal(insightValue({ total_value: { value: 5 } }), 5);
  assert.equal(insightValue({ values: [{ value: 1 }, { value: 2 }, { value: 'x' }] }), 3);
  assert.equal(insightValue({ link_total_values: [{ value: '2' }, { value: 3 }] }), 5);
  assert.equal(insightValue({}), null);
});

test('zoneHour: an hour moved between time zones, summer time included', () => {
  assert.equal(zoneHour('2026-01-15', 12, 'Etc/UTC', 'America/New_York'), 7);
  assert.equal(zoneHour('2026-07-15', 12, 'Etc/UTC', 'America/New_York'), 8);
  assert.equal(zoneHour('2026-07-15', 20, 'America/New_York', 'Etc/UTC'), 0);
});

test('postRef: a post\'s id as a safe name', () => {
  assert.equal(postRef('ig:123/abc'), 'ig:123_abc');
  assert.equal(postRef(' at://did:plc:x/app.bsky.feed.post/3k '), 'at:_did:plc:x_app.bsky.feed.post_3k');
  assert.equal(postRef(null), '');
});

test('sitePath: a link to the site as the page Ghost\'s analytics counts', () => {
  assert.equal(sitePath('/my-post'), '/my-post/');
  assert.equal(sitePath('/my-post/?utm_source=x#top'), '/my-post/');
  assert.equal(sitePath('/my-post/.'), '/my-post/');
  // the short links and bio links go where their redirects send people
  assert.equal(sitePath('/b/my-post'), '/my-post/');
  assert.equal(sitePath('/k/my-post/'), '/my-post/');
  assert.equal(sitePath('/ig'), '/');
  assert.equal(sitePath('/b'), '/');
  assert.equal(sitePath('/t/'), '/');
  assert.equal(sitePath(''), '/');
  // not a page
  assert.equal(sitePath('/ghost/#/posts'), '');
  assert.equal(sitePath('/members/api/x'), '');
  assert.equal(sitePath('/content/images/a.jpg'), '');
  assert.equal(sitePath('/a b'), '');
});

test('siteLinks: the site\'s pages a post links to, with or without https://', () => {
  assert.deepEqual(siteLinks(['Out now: example.com/my-post/ and https://www.example.com/b/other.',
    'elsewhere.com/x and example.com/my-post', 'example.com']), ['/my-post/', '/other/', '/']);
  assert.deepEqual(siteLinks(['notexample.com/x']), []);
});

test('trackEarly: an older post taking off, from the most it had (a check at 0 that comes back is no take-off)', async (t) => {
  const HOUR = 3_600_000;
  const start = Date.parse('2026-10-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const dir = mkdtempSync(join(tmpdir(), 'takeoff-'));
  const notices = [];
  setTakeOffNotice((x) => notices.push(x));
  t.after(() => setTakeOffNotice(null));
  const post = { id: 'v1', ref: 'v1', time: start - 20 * DAY };
  const check = async (h, views) => {
    t.mock.timers.setTime(start + h * HOUR);
    await trackEarly(dir, 'tiktok', [{ ...post, views }], ['views']);
  };
  // 10 days of about 24 views a day, a check an hour
  for (let h = 0; h < 240; h++) await check(h, 1000 + h);
  // one check where the network answers 0, then the real number again
  await check(240, 0);
  await check(241, 1241);
  await check(242, 1242);
  assert.deepEqual(notices, []);
  // a real jump is still one
  await check(243, 1600);
  assert.deepEqual(notices.map((x) => [x.network, x.post.ref, x.was, x.now]), [['tiktok', 'v1', 1239, 1600]]);
});

test('gainsByDay: a day kept at 0 that comes back gains nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gains-'));
  const store = storeFor(dir);
  const p = { ref: 'v1', time: Date.parse('2026-09-01T12:00:00Z') };
  for (const [date, views] of [['2026-10-01', 1000], ['2026-10-02', 1020], ['2026-10-03', 0], ['2026-10-04', 1050]]) {
    store.recordDay('tiktok', [{ ...p, views }], ['views'], date);
  }
  assert.deepEqual(gainsByDay(dir, 'tiktok', ['views']).map((d) => [d.date, d.views]),
    [['2026-10-01', 0], ['2026-10-02', 20], ['2026-10-03', 0], ['2026-10-04', 30]]);
});

test('keepLastOverZero: a count back at 0 from 5 or more keeps its last; withHistory\'s totals too', () => {
  const now = { followers: 0, likes: 0, plays: 0, views: 12 };
  assert.equal(keepLastOverZero(now, { followers: 480, likes: 2, views: 10 }, ['followers', 'likes', 'plays', 'views'], 'test'), 1);
  assert.deepEqual(now, { followers: 480, likes: 0, plays: 0, views: 12 }, 'a small count can really go to 0; nothing before, nothing kept');
  const d1 = day(Date.now() - DAY);
  const totals = { followers: 0 };
  const { daily } = withHistory({ [d1]: { followers: 480 } }, totals, ['followers'], 30);
  assert.equal(totals.followers, 480);
  assert.deepEqual(daily.at(-1), { date: day(Date.now()), followers: 480, newFollowers: 0 });
});
