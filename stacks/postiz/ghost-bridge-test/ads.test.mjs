// stats/ads.mjs: boosts. Instagram's from Meta's Marketing API (the fake web, made-up numbers in its real shapes),
// matched to Instagram's posts; TikTok Promotes typed in on the staff page (through serveDraftPreview, as the bridge
// routes it); and the `boosted` marks withBoosts puts on the networks' posts.
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { collectors, web, NOW, DAY, date, GHOST } from './collectors.mjs';

const c = await collectors({ META_ADS_TOKEN: 'meta-token', META_AD_ACCOUNT_ID: '123456' });
const { serveDraftPreview } = await import('../ghost-bridge/pages/preview-routes.mjs');
const { withBoosts, adAccount } = await import('../ghost-bridge/stats/ads.mjs');
const G = 'https://graph.facebook.com/v25.0/act_123456';
const put = (name, doc) => fs.writeFileSync(path.join(c.dataDir, `${name}.json`), JSON.stringify(doc));
const rmData = (name) => fs.rmSync(path.join(c.dataDir, name), { force: true });

const IG_POSTS = [
  { id: '1789', ref: '1789', caption: 'New mix out', permalink: 'https://www.instagram.com/p/AAA/', time: NOW - 10 * DAY },
  { id: '1790', ref: '1790', caption: 'Live tonight', permalink: 'https://www.instagram.com/reel/BBB/', time: NOW - 5 * DAY },
];
const TT_POSTS = [{ id: '7001', ref: '7001', text: 'Drop at 1:30', cover: 'https://p16.tiktokcdn.example/7001.jpg', permalink: 'https://www.tiktok.com/@dj/video/7001', time: NOW - 8 * DAY, views: 5000 }];
const ADS = [
  { id: 'ad1', name: 'Boost: New mix', effective_status: 'COMPLETED', created_time: `${date(9)}T10:00:00+0000`,
    adset: { start_time: `${date(9)}T10:00:00+0000`, end_time: `${date(6)}T10:00:00+0000`, lifetime_budget: '2000' },
    creative: { effective_instagram_media_id: '1789' } },
  { id: 'ad2', name: 'Boost: Live tonight', effective_status: 'ACTIVE', created_time: `${date(2)}T10:00:00+0000`,
    adset: { start_time: `${date(2)}T10:00:00+0000`, daily_budget: '500' },
    creative: { instagram_permalink_url: 'https://www.instagram.com/reel/BBB?igsh=x' } },
  { id: 'ad3', name: 'A Facebook ad', effective_status: 'PAUSED', created_time: `${date(20)}T10:00:00+0000`, adset: {}, creative: {} },
];
const life = (id, spend, reach, actions = []) => ({ ad_id: id, spend: String(spend), reach: String(reach), impressions: String(reach * 2), clicks: '12', inline_link_clicks: '4', actions });
const LIFETIME = [
  life('ad1', 20, 4000, [{ action_type: 'video_view', value: '900' }, { action_type: 'onsite_conversion.follow', value: '10' }, { action_type: 'ig_profile_visit', value: '30' }]),
  life('ad2', 10, 1000), life('ad3', 5, 500),
];
const dailyRows = () => [
  ...[9, 8, 7, 6].map((d) => ({ ...life('ad1', 5, 1000), date_start: date(d) })),
  ...[2, 1, 0].map((d) => ({ ...life('ad2', d ? 5 : 0, d ? 500 : 0), date_start: date(d) })),
];
function meta({ ads = ADS, refuse = '' } = {}) {
  web.on(`${G}?`, { name: 'DJ ads', currency: 'EUR', timezone_name: 'Europe/Berlin' });
  web.on(`${G}/ads?`, (u) => (refuse && u.searchParams.get('fields').includes(refuse)
    ? { status: 400, body: { error: { code: 100, message: `(#100) Tried accessing nonexisting field (${refuse}) on node type (AdCreative)` } } }
    : { data: ads, paging: {} }));
  web.on(`${G}/insights?`, (u) => ({ data: u.searchParams.get('time_increment') ? dailyRows() : LIFETIME }));
}
beforeEach(() => {
  web.reset();
  put('instagram', { posts: IG_POSTS });
  put('tiktok', { posts: TT_POSTS });
  rmData('ads-typed.json');
  web.on(`${GHOST}/ghost/api/admin/site/`, { site: { url: 'https://example.com/' } });
  web.on(`${GHOST}/ghost/api/admin/users/me/`, (u, req) => (req.headers.cookie ? { users: [{ id: 'u1' }] } : { status: 403, body: {} }));
});

// the staff page through serveDraftPreview, as the bridge routes it; a form like a browser's
async function ask(method, url, { cookie = 'ghost-admin-api-session=s1', origin = 'https://example.com', form } = {}) {
  const body = form && new URLSearchParams(form).toString();
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  Object.assign(req, { method, url, headers: { ...(cookie && { cookie }), ...(origin && { origin }),
    ...(body != null && { 'content-type': 'application/x-www-form-urlencoded' }) } });
  const res = { status: 0, body: '', headers: {}, writeHead(code, h = {}) { this.status = code; this.headers = h; return this; }, end(b = '') { this.body = String(b); return this; } };
  await serveDraftPreview(req, res, url.split('?')[0]);
  return res;
}
const PAGE = '/ghost/social-preview/boosts/';
const typed = () => JSON.parse(fs.readFileSync(path.join(c.dataDir, 'ads-typed.json'), 'utf8')).entries;

test('the ad account id: digits or act_<digits>', () => {
  assert.equal(adAccount('123456'), 'act_123456');
  assert.equal(adAccount(' act_123456 '), 'act_123456');
  assert.equal(adAccount('my account'), '');
});

test('Instagram boosts from Meta: matched to their posts, numbers per ad and per day, the token never in an address', async () => {
  meta();
  const out = await c.poll('ads');
  assert.deepEqual(out.errors, []);
  const byId = Object.fromEntries(out.ads.map((a) => [a.id, a]));
  assert.equal(byId.ad1.ref, '1789', 'by the media id');
  assert.equal(byId.ad2.ref, '1790', 'by the permalink, its query left off');
  assert.equal(byId.ad3.network, 'other', 'no Instagram post: another Meta ad');
  assert.equal(byId.ad1.network, 'instagram');
  assert.equal(byId.ad1.spend, 20);
  assert.equal(byId.ad1.follows, 10);
  assert.equal(byId.ad1.profileVisits, 30);
  assert.equal(byId.ad1.views, 900);
  assert.equal(byId.ad1.cpm, 5, '20 for 4000 reached = 5 per 1000');
  assert.equal(byId.ad1.costPerFollow, 2);
  assert.equal(byId.ad1.budget, 20, 'Meta gives budgets in cents');
  assert.equal(byId.ad2.status, 'running');
  assert.equal(byId.ad2.budgetPer, 'a day');
  assert.equal(out.account.currency, 'EUR');
  // per day, from the first boost's day to today; 7-day averages count days with no boost as 0
  assert.equal(out.daily[0].date, date(9));
  assert.equal(out.daily.at(-1).date, date(0));
  const d6 = out.daily.find((x) => x.date === date(6));
  assert.equal(d6.instagramSpend, 5);
  assert.equal(d6.instagramSpend7, round2(20 / 7));
  assert.equal(d6.instagramCpm7, 5);
  assert.equal(out.totals.spend30, 30);
  assert.equal(out.totals.instagramSpend30, 30);
  assert.equal(out.totals.running, 1);
  for (const a of web.asked.filter((x) => x.url.includes('graph.facebook.com'))) {
    assert.ok(!a.url.includes('meta-token'), 'the token is in a header');
    assert.equal(a.headers.authorization, 'Bearer meta-token');
  }
  assert.ok(Object.keys(c.archive('ads').posts).includes('ad1'), 'every ad kept in the archive');
});

const round2 = (v) => Math.round(v * 100) / 100;

test('a field Meta refuses is left out and asked again; a turned-down token keeps the last boosts', async () => {
  meta({ refuse: 'instagram_permalink_url' });
  let out = await c.poll('ads');
  assert.match(out.errors.join(), /no instagram_permalink_url/);
  assert.equal(out.ads.find((a) => a.id === 'ad1').ref, '1789', 'the media id still matches');
  const prev = out;
  web.reset();
  web.on(`${G}?`, { status: 400, body: { error: { code: 190, message: 'Error validating access token' } } });
  out = await c.poll('ads', prev);
  assert.match(out.errors.join(), /turned the token down/);
  assert.equal(out.ads.filter((a) => a.source === 'meta').length, 3, 'the last ones read');
});

test('the Boosts page: staff only, from the page itself, numbers checked, then the boost counts at once', async () => {
  assert.equal((await ask('GET', PAGE, { cookie: '' })).status, 401);
  const page = await ask('GET', PAGE);
  assert.equal(page.status, 200);
  assert.match(page.body, /Drop at 1:30/, 'the TikTok videos to pick from');
  assert.match(page.body, /<input type="radio" name="ref" value="7001" checked/, 'picked by its cover, the newest already');
  assert.match(page.body, /src="https:\/\/p16\.tiktokcdn\.example\/7001\.jpg"/);
  assert.match(page.body, /name="running" value="1" checked/, 'a new one is still running');
  assert.match(page.body, /data-play="7001" data-ref="7001" data-link="https:\/\/www\.tiktok\.com\/@dj\/video\/7001"/, 'played in TikTok\'s player');
  const form = { action: 'save', ref: '7001', start: date(5), end: date(1), spend: '€12,50', views: '2000', follows: '8' };
  assert.equal((await ask('POST', PAGE, { origin: 'https://elsewhere.example', form })).status, 403);
  let r = await ask('POST', PAGE, { form: { ...form, views: 'lots' } });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.Location), /Not saved: check views/);
  assert.ok(!fs.existsSync(path.join(c.dataDir, 'ads-typed.json')));
  meta({ ads: [] });
  r = await ask('POST', PAGE, { form });
  assert.match(decodeURIComponent(r.headers.Location), /Added/);
  const [e] = typed();
  assert.equal(e.spend, 12.5, 'a currency sign and a decimal comma are fine');
  assert.equal(e.views, 2000);
  // changed: same id; Still running empties the end day, and neither is asked again
  await ask('POST', PAGE, { form: { ...form, id: e.id, spend: '15', running: '1' } });
  assert.equal(typed().length, 1);
  assert.equal(typed()[0].spend, 15);
  assert.equal(typed()[0].end, '');
  r = await ask('POST', PAGE, { form: { ...form, id: e.id, spend: '15', end: '' } });
  assert.match(decodeURIComponent(r.headers.Location), /Not saved: check the end date \(or tick Still running\)/);
  await ask('POST', PAGE, { form: { ...form, id: e.id, spend: '15' } });
  assert.equal(typed()[0].end, date(1));
  const editing = await ask('GET', `${PAGE}?edit=${e.id}`);
  assert.match(editing.body, /Change: Drop at 1:30/);
  assert.match(editing.body, /name="running" value="1">/, 'an ended one: not ticked');
  assert.match(editing.body, /<td>15\.00<\/td>/, 'every number in the table');

  const out = await c.poll('ads');
  const boost = out.ads.find((a) => a.source === 'typed');
  assert.equal(boost.network, 'tiktok');
  assert.equal(boost.title, 'Drop at 1:30');
  assert.equal(boost.seen, 2000, "TikTok's seen = views");
  assert.equal(boost.cpm, 7.5);
  // spread over its 5 days
  assert.equal(out.daily.find((x) => x.date === date(3)).tiktokSpend, 3);
  assert.equal(out.totals.tiktokSpend30, 15);

  await ask('POST', PAGE, { form: { action: 'delete', id: e.id } });
  assert.deepEqual(typed(), []);
});

test('withBoosts: boosted posts marked; on TikTok their views are partly paid, so they leave the usual', async () => {
  put('ads', { ads: [
    { network: 'tiktok', ref: '7001', source: 'typed', spend: 10, views: 1500, follows: 3, start: date(5), end: date(1), status: 'ended' },
    { network: 'tiktok', ref: '7001', source: 'typed', spend: 5, views: 500, start: date(1), end: '', status: 'running' },
    { network: 'instagram', ref: '1789', source: 'meta', spend: 20, reach: 4000, start: date(9), end: date(6) },
  ] });
  const tt = { posts: [{ ...TT_POSTS[0] }, { id: '7002', ref: '7002', views: 10, boosted: { old: true }, paidCounted: true }] };
  await withBoosts(c.dataDir, 'tiktok', tt);
  const [b, other] = tt.posts;
  assert.equal(b.boosted.boosts, 2);
  assert.equal(b.boosted.spend, 15);
  assert.equal(b.boosted.views, 2000);
  assert.equal(b.boosted.end, '', 'one still running');
  assert.equal(b.boosted.running, true);
  assert.equal(b.paidCounted, true);
  assert.equal(b.organicViews, 3000);
  assert.equal(other.boosted, undefined, 'no boost now: the old mark goes');
  assert.equal(other.paidCounted, undefined);
  const ig = { posts: IG_POSTS.map((p) => ({ ...p })) };
  await withBoosts(c.dataDir, 'instagram', ig);
  assert.equal(ig.posts[0].boosted.cpm, 5);
  assert.equal(ig.posts[0].paidCounted, undefined, "Instagram's numbers are organic only");
});
