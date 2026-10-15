// stats/site.mjs: the site's own numbers (Ghost's Admin API and its analytics in Tinybird), Cloudflare's and Google
// Search Console's, from what those APIs answer (the fake web), and what goes in the errors when one says no.
import './env.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { collectors, web, NOW, DAY, date, GHOST } from './collectors.mjs';

// a service account's key for Search Console, made here: the fake Google checks what the bridge signs with it
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { client_email: 'stats@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const TB = 'https://tinybird.test';
const c = await collectors({ TINYBIRD_URL: TB, TINYBIRD_TOKEN: 'tb-token', CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ZONE_ID: 'zone1',
  SEARCH_CONSOLE_KEY: Buffer.from(JSON.stringify(KEY)).toString('base64') });
beforeEach(() => web.reset());
const ADMIN = `${GHOST}/ghost/api/admin`;

// ---------- Ghost ----------
const ghostPost = (id, days, extra = {}) => ({ id, title: `Post ${id}`, url: `https://example.com/${id}/`, published_at: new Date(NOW - days * DAY).toISOString(),
  plaintext: `the words of ${id}`, visibility: 'public', tags: [{ name: 'House' }, { name: '#internal', visibility: 'internal' }],
  count: { signups: 1, paid_conversions: 0, clicks: 2 }, reading_time: 3, ...extra });
function ghost() {
  web.on(`${ADMIN}/site/`, { site: { title: 'Test Radio', url: 'https://example.com/', site_uuid: 'uuid-1' } });
  web.on(`${ADMIN}/members/`, (url) => ({ meta: { pagination: { total: { '': 50, 'status:-free': 5, 'subscribed:true': 40,
    'status:comped': 1, 'email_disabled:true': 2 }[url.searchParams.get('filter') || ''] } } }));
  web.on(`${ADMIN}/newsletters/`, { newsletters: [{ name: 'Weekly', status: 'active', count: { active_members: 40, posts: 7 } }] });
  web.on(`${ADMIN}/posts/`, (url) => (url.searchParams.get('page') === '1'
    ? { posts: [ghostPost('new-mix', 2, { email: { email_count: 40, opened_count: 17, delivered_count: 40, failed_count: 0 } })],
      meta: { pagination: { next: 2 } } }
    : { posts: [ghostPost('old-mix', 90)], meta: { pagination: { next: null } } }));
  web.on(`${GHOST}/members/api/comments/counts/`, { 'new-mix': 3, 'old-mix': 1 });
  web.on(`${TB}/v0/pipes/api_kpis.json`, (url) => {
    const page = url.searchParams.get('pathname');
    if (page === '/new-mix/') return { data: [{ date: date(2), visits: 30, pageviews: 40 }, { date: date(1), visits: 10, pageviews: 12 }] };
    if (page) return { data: [] };
    // the site: nothing before Ghost's analytics started, 10 days ago
    return { data: Array.from({ length: 15 }, (_, i) => ({ date: date(14 - i), visits: i >= 4 ? 100 : 0, pageviews: i >= 4 ? 150 : 0 })) };
  });
}

test('Ghost: members, every page of posts with their sign-ups and newsletter, visitors per day and per post', async () => {
  ghost();
  const out = await c.poll('ghost', { history: { [date(1)]: { members: 45, subscribers: 40, comments: 4 } } });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.account, { name: 'Test Radio', url: 'https://example.com/' });
  const t = out.totals;
  assert.deepEqual([t.members, t.paidMembers, t.subscribers, t.compedMembers, t.emailDisabled], [50, 5, 40, 1, 2]);
  assert.deepEqual([t.newMembers30, t.newSubscribers30, t.comments], [5, 0, 4]);
  assert.deepEqual(out.posts.map((p) => [p.title, p.type, p.links[0], p.tags]),
    [['Post new-mix', 'Post + newsletter', '/new-mix/', 'House'], ['Post old-mix', 'Post', '/old-mix/', 'House']]);
  const [p] = out.posts;
  assert.deepEqual([p.emailRecipients, p.opens, p.openRate, p.signups, p.emailClicks], [40, 17, 42.5, 1, 2], 'open rate to a tenth');
  assert.deepEqual([p.visitors, p.pageviews], [40, 52], 'its days from Tinybird, added up');
  assert.deepEqual([out.posts[1].visitors, out.posts[1].pageviews], [0, 0], 'asked, with no visitors');
  assert.equal(out.analyticsSince, date(10), 'the first day with a visitor');
  assert.equal(out.daily.filter((d) => d.visitors != null).length, 11, 'no days before the analytics started');
  assert.deepEqual([t.visitors30, t.pageviews30, t.emails30, t.signups30], [1100, 1650, 1, 1]);
  // Tinybird asked with the site's uuid from Ghost and the token
  const kpis = web.calls(`${TB}/v0/pipes/api_kpis.json`);
  assert.ok(kpis.every((r) => new URL(r.url).searchParams.get('site_uuid') === 'uuid-1' && r.headers.authorization === 'Bearer tb-token'));
  // Ghost's Admin API with a signed key, never the key itself
  const admin = web.calls(ADMIN);
  assert.ok(admin.every((r) => /^Ghost [\w-]+\.[\w-]+\.[\w-]+$/.test(r.headers.authorization)));
  assert.equal(c.archive('ghost').days[date(0)].newsletters.Weekly.members, 40);
  assert.deepEqual(web.unanswered, []);
});

test('Ghost: an older Ghost that refuses the extra fields gets the list without them', async () => {
  ghost();
  web.on(`${ADMIN}/posts/`, (url) => (url.searchParams.get('include').includes('authors')
    ? { status: 400, body: { errors: [{ message: 'Unknown include' }] } }
    : { posts: [ghostPost('new-mix', 2)], meta: { pagination: {} } }));
  const out = await c.poll('ghost');
  assert.deepEqual(out.posts.map((p) => p.title), ['Post new-mix']);
  assert.ok(!out.errors.some((e) => e.startsWith('posts:')), out.errors.join('; '));
});

test('Ghost: Tinybird down keeps the visitors per day it had', async () => {
  ghost();
  web.on(`${TB}/v0/pipes/api_kpis.json`, { status: 403, body: { error: 'forbidden' } });
  const out = await c.poll('ghost', { daily: [{ date: date(3), visitors: 7, pageviews: 9 }] });
  assert.deepEqual(out.errors, ['visitors: Tinybird api_kpis: forbidden (is TINYBIRD_TOKEN one that can read the pipes?)']);
  const kept = out.daily.find((d) => d.date === date(3));
  assert.deepEqual([kept.visitors, kept.pageviews], [7, 9]);
  assert.equal(out.totals.members, 50, 'the rest still came');
});

// ---------- Cloudflare ----------
const CF = 'https://api.cloudflare.com/client/v4/graphql';
const cfDay = (daysAgo, requests) => ({ dimensions: { date: date(daysAgo) }, uniq: { uniques: requests / 10 }, sum: {
  requests, cachedRequests: requests / 2, bytes: requests * 1000, cachedBytes: 0, threats: 1, pageViews: requests / 4,
  countryMap: [{ clientCountryName: 'DE', requests: requests * 0.25, threats: 0 }, { clientCountryName: 'US', requests: requests * 0.75, threats: 1 }],
  responseStatusMap: [{ edgeResponseStatus: 200, requests: requests - 3 }, { edgeResponseStatus: 404, requests: 2 }, { edgeResponseStatus: 502, requests: 1 }] } });

test('Cloudflare: requests per day, cached share, errors and countries; the last 3 days once it has history', async () => {
  web.on(CF, (url, req) => {
    const { query, variables } = JSON.parse(req.body);
    assert.equal(variables.zone, 'zone1');
    assert.equal(req.headers.authorization, 'Bearer cf-token');
    // a field Cloudflare dropped: the query with every breakdown is refused, the plain one answers
    if (query.includes('browserMap')) return { data: null, errors: [{ message: 'unknown field "browserMap"' }] };
    return { data: { viewer: { zones: [{ httpRequests1dGroups: [cfDay(1, 1000), cfDay(0, 400)] }] } } };
  });
  const out = await c.poll('cloudflare', { history: { [date(40)]: { requests: 5, cached: 5 } } });
  assert.deepEqual(out.errors, []);
  assert.equal(JSON.parse(web.asked.at(-1).body).variables.since, date(3), 'the last 3 days, as it has days kept');
  const d1 = out.daily.find((d) => d.date === date(1));
  assert.deepEqual([d1.requests, d1.cachedPct, d1.errors4xx, d1.errors5xx, d1.uniques], [1000, 50, 2, 1, 100]);
  assert.deepEqual(out.countries, [{ country: 'US', requests: 1050 }, { country: 'DE', requests: 350 }]);
  assert.deepEqual([out.totals.requests30, out.totals.cachedPct30, out.totals.errors5xx30], [1400, 50, 2], 'the day 40 days ago left out');
  assert.equal(out.daily[0].date, date(40), 'the days kept stay');
});

test('Cloudflare: a token without the permission says which one', async () => {
  web.on(CF, { data: null, errors: [{ message: 'not authorized for that account (authz)' }] });
  const out = await c.poll('cloudflare');
  assert.deepEqual(out.errors, ['Cloudflare: not authorized for that account (authz) (does the token have Zone > Analytics > Read for this zone?)']);
  assert.equal(JSON.parse(web.asked.at(-1).body).variables.since, date(30), '30 days on the first run');
});

// ---------- Google Search Console ----------
const GSC = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent('sc-domain:example.com')}/searchAnalytics/query`;
function google() {
  web.on('https://oauth2.googleapis.com/token', (url, req) => {
    const jwt = new URLSearchParams(req.body).get('assertion');
    const [head, claims, sig] = jwt.split('.');
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(sig, 'base64url'))) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    }
    const c = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(c.iss, KEY.client_email);
    assert.equal(c.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
    return { access_token: 'gsc-token', expires_in: 3600 };
  });
  web.on(GSC, (url, req) => {
    assert.equal(req.headers.authorization, 'Bearer gsc-token');
    const q = JSON.parse(req.body);
    const dims = (q.dimensions || []).join(',');
    if (q.type) return { rows: [] };
    if (dims === 'date') return { rows: [{ keys: [date(3)], clicks: 4, impressions: 100, ctr: 0.04, position: 8.26 }] };
    if (dims === 'query') return { rows: [{ keys: ['dj mix'], clicks: 3, impressions: 50, ctr: 0.06, position: 4.04 }] };
    if (dims === 'page') return { rows: [{ keys: ['https://example.com/new-mix/'], clicks: 3, impressions: 60, ctr: 0.05, position: 5 }] };
    if (dims === '') return { rows: [{ clicks: 10, impressions: 400, ctr: 0.025, position: 9.94 }] };
    return { rows: [{ keys: [date(3), 'x'], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] };
  });
}

test('Search Console: signs in with the service account, the last 28 days, top searches and pages', async () => {
  google();
  const out = await c.poll('search');
  assert.deepEqual(out.errors, []);
  assert.equal(out.site, 'sc-domain:example.com');
  assert.deepEqual(out.totals, { clicks28: 10, impressions28: 400, ctr28: 2.5, position28: 9.9 });
  assert.deepEqual(out.queries, [{ query: 'dj mix', clicks: 3, impressions: 50, ctr: 6, position: 4 }]);
  assert.deepEqual(out.pages, [{ page: '/new-mix/', url: 'https://example.com/new-mix/', clicks: 3, impressions: 60, ctr: 5, position: 5 }]);
  assert.deepEqual(out.daily, [{ date: date(3), clicks: 4, impressions: 100, ctr: 4, position: 8.3 }]);
  assert.equal(web.calls('https://oauth2.googleapis.com/token').length, 1, 'one sign-in, then its token reused');
  assert.equal(c.archive('search').meta.finalThrough, date(4));
});

test('Search Console: a service account that isn\'t a user of the property says to add it', async () => {
  google();
  web.on(GSC, { status: 403, body: { error: { message: 'User does not have sufficient permission' } } });
  const out = await c.poll('search');
  assert.deepEqual(out.errors, ['Search Console: User does not have sufficient permission (add stats@project.iam.gserviceaccount.com'
    + ' as a user of sc-domain:example.com in Search Console, and enable the Search Console API)']);
});
