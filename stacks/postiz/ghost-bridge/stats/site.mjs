// stats/site.mjs: the collectors for the site itself: Ghost (members, visitors, every post), Cloudflare and Google
// Search (stats/stats.mjs runs them).

import crypto from 'node:crypto';
import { SITE_HOST } from '../config.mjs';
import { DAY, day, num, text, fetchJson, withHistory, last30, posts30, perDay, mergeDaily, storeFor, postRef, sitePath,
  withOlder, trackEarly, historyKeys, archiveRead, readJson, TB, tbPipe } from './history.mjs';

// ---------- the site (Ghost) ----------
// The site itself as a network: members, visitors, and every post with its numbers (ghost.json).
export function ghost({ env, dataDir, ghostAdmin, ghostMembers, file, collector, minutes, enabled, archiveTo }) {
  // ---------- the site itself (Ghost) ----------
  // The site as one more network, so its posts sit beside the social ones (Platforms, the Post dashboard, When to
  // post): members and newsletter subscribers now (Ghost's Admin API, kept per day like followers), the site's
  // visitors per day, and every published post with its sign-ups and newsletter numbers (Admin API) and its visitors
  // and page views per day (Ghost's analytics in Tinybird, TINYBIRD_TOKEN: Grafana's read token is enough). A post's
  // days are asked for one call per post, like YouTube's videos: posts under 30 days old every GHOST_POST_HOURS (1),
  // older ones daily, at most GHOST_POST_CALLS (100) a poll, the longest waiting first. Days before Ghost's analytics
  // started (its first day with a visitor) aren't kept, so an older post counts as worked back, not as 0 visitors.
  // stats.db keeps every day with visitors and every day of a post's first GHOST_FIRST_DAYS (14), 0s too.
  const GHOST_PAGES = 50; // of 100 posts
  const GHOST_POST_HOURS = 1;
  const GHOST_POST_CALLS = 100;
  const GHOST_FIRST_DAYS = 14;
  const GHOST_DAYS = Math.max(30, Number(env.GHOST_STATS_DAYS) || 400);
  // Tinybird: TB and tbPipe in history.mjs (TB.site filled in below from Ghost's /site/ when not set)
  async function ghostPostDays(posts, since) {
    const store = storeFor(dataDir);
    const { posts: hist, fetched } = store.history('ghost');
    const today = day(Date.now());
    const due = posts.filter((p) => {
      store.setPostedTime('ghost', p.ref, p.time);
      const hours = p.time && Date.now() - p.time > 30 * DAY ? 24 : GHOST_POST_HOURS;
      return p.links[0] && Date.now() - (fetched[p.ref] || 0) >= hours * 3_600_000;
    }).sort((a, b) => (fetched[a.ref] || 0) - (fetched[b.ref] || 0));
    let failed = '';
    for (const p of due.slice(0, GHOST_POST_CALLS)) {
      const posted = day(p.time || Date.now());
      const from = posted > since ? posted : since;
      try {
        const rows = await tbPipe('api_kpis', { date_from: from, date_to: today, pathname: p.links[0] });
        const first = day(Date.parse(posted) + GHOST_FIRST_DAYS * DAY);
        hist[p.ref] = Object.fromEntries(rows.map((r) => [String(r.date).slice(0, 10), { visitors: num(r.visits) ?? 0, pageviews: num(r.pageviews) ?? 0 }])
          .filter(([d, v]) => d >= from && d <= today && (d < first || v.visitors || v.pageviews)));
        store.setDays('ghost', p.ref, hist[p.ref]);
      } catch (e) { failed = e.message; }
    }
    if (failed) throw new Error(failed);
    return hist;
  }
  collector('ghost', 'Ghost', enabled(env.GHOST_STATS), minutes(env.GHOST_STATS_MINUTES), 65, async (out, prev) => {
    Object.assign(out, { account: null, totals: {}, daily: [], posts: [], postsPerDay: [] });
    let visits = [];
    try {
      if (!ghostAdmin) throw new Error('needs GHOST_API_URL and GHOST_ADMIN_API_KEY (to read the site\'s posts and members from Ghost)');
      const site = (await ghostAdmin('/site/')).site || {};
      out.account = { name: site.title || '', url: site.url || '' };
      TB.site ||= site.site_uuid || '';
      try {
        const count = async (filter) => num((await ghostAdmin(`/members/?limit=1${filter ? `&filter=${encodeURIComponent(filter)}` : ''}`)).meta?.pagination?.total);
        out.totals.members = await count('');
        out.totals.paidMembers = await count('status:-free');
        out.totals.subscribers = await count('subscribed:true');
        out.totals.compedMembers = await count('status:comped');
        out.totals.emailDisabled = await count('email_disabled:true');
      } catch (e) { out.errors.push(`members: ${e.message}`); }
      const extra = { days: {}, posts: [], account: site };
      try { // each newsletter's subscribers and posts sent, into the archive
        const { newsletters = [] } = await ghostAdmin('/newsletters/?limit=all&include=count.active_members,count.posts');
        extra.days[day(Date.now())] = { newsletters: Object.fromEntries(newsletters.map((n) => [n.name || n.id,
          { status: n.status, members: num(n.count?.active_members), posts: num(n.count?.posts) }])) };
      } catch { /* the archive only */ }
      try {
        const listed = [];
        let page = 1;
        let more = true;
        // the feedback counts, authors and newsletter are extra: if this Ghost refuses one, the list goes on without them
        let include = 'tags,authors,email,newsletter,count.signups,count.paid_conversions,count.clicks,count.positive_feedback,count.negative_feedback';
        for (; more && page <= GHOST_PAGES; page++) {
          const ask = () => ghostAdmin(`/posts/?${new URLSearchParams({ filter: 'status:published', order: 'published_at desc', limit: '100',
            page: String(page), formats: 'plaintext', include })}`);
          const basic = 'tags,email,count.signups,count.paid_conversions,count.clicks';
          const r = await ask().catch((e) => { if (include === basic) throw e; include = basic; return ask(); });
          listed.push(...(r.posts || []));
          more = !!r.meta?.pagination?.next;
        }
        out.posts = listed.map((g) => {
          const time = Date.parse(g.published_at) || null;
          let slug = '';
          try { slug = sitePath(new URL(g.url).pathname); } catch {}
          return {
            id: g.id, ref: postRef(g.id), links: slug ? [slug] : [], date: g.published_at, time, network: 'Ghost', account: out.account.name,
            type: g.email ? 'Post + newsletter' : 'Post', title: text(g.title), text: text(g.custom_excerpt || g.plaintext),
            visibility: g.visibility || '', tags: (g.tags || []).filter((t) => t.visibility !== 'internal').map((t) => t.name).join(', '),
            visitors: null, pageviews: null, signups: num(g.count?.signups), paidConversions: num(g.count?.paid_conversions),
            emailRecipients: num(g.email?.email_count), opens: num(g.email?.opened_count), emailClicks: num(g.count?.clicks),
            openRate: g.email?.email_count ? Math.round((1000 * (g.email.opened_count || 0)) / g.email.email_count) / 10 : null,
            emailDelivered: num(g.email?.delivered_count), emailFailed: num(g.email?.failed_count),
            positiveFeedback: num(g.count?.positive_feedback), negativeFeedback: num(g.count?.negative_feedback),
            readingTime: num(g.reading_time), featured: !!g.featured,
            permalink: g.url || '', thumbnail: g.feature_image || '',
          };
        });
        extra.posts = listed.map((g) => ({ ref: postRef(g.id), data: g }));
        out.posts = withOlder(prev.posts, out.posts, !more);
        out.totals.posts = out.posts.length;
      } catch (e) { out.errors.push(`posts: ${e.message}`); out.posts = prev.posts || []; }
      // comments on all the posts (Ghost's count, as the comment box shows it), for the engagement line: its gains
      // per day (history) and between checks
      try {
        const ids = out.posts.map((p) => p.id);
        let comments = 0;
        for (let i = 0; i < ids.length; i += 50) {
          const counts = await ghostMembers(`/comments/counts/?ids=${ids.slice(i, i + 50).join(',')}`);
          comments += Object.values(counts || {}).reduce((a, n) => a + (Number(n) || 0), 0);
        }
        if (ids.length) out.totals.comments = comments;
      } catch (e) { out.errors.push(`comments: ${e.message}`); }

      // Ghost's analytics: the site's visitors per day, and each post's (Grafana's dashboards read the same Tinybird)
      try {
        const rows = await tbPipe('api_kpis', { date_from: day(Date.now() - GHOST_DAYS * DAY), date_to: day(Date.now()) });
        const since = rows.filter((r) => num(r.visits) > 0).map((r) => String(r.date).slice(0, 10)).sort()[0];
        out.analyticsSince = since || prev.analyticsSince || null;
        for (const r of rows) if (since && String(r.date).slice(0, 10) >= since) (extra.days[String(r.date).slice(0, 10)] ||= {}).site = r;
        visits = rows.filter((r) => since && String(r.date).slice(0, 10) >= since)
          .map((r) => ({ date: String(r.date).slice(0, 10), visitors: num(r.visits), pageviews: num(r.pageviews) }));
        last30(visits, ['visitors', 'pageviews'], out.totals);
        if (out.analyticsSince) {
          let hist = {};
          try { hist = await ghostPostDays(out.posts, out.analyticsSince); } catch (e) { out.errors.push(`posts' visitors: ${e.message}`); hist = storeFor(dataDir).history('ghost').posts; }
          for (const p of out.posts) {
            if (!hist[p.ref]) continue; // not asked yet (its numbers stay blank); asked with no visitors kept = 0
            const h = Object.values(hist[p.ref]);
            p.visitors = h.reduce((a, d) => a + (d.visitors || 0), 0);
            p.pageviews = h.reduce((a, d) => a + (d.pageviews || 0), 0);
          }
        }
      } catch (e) { out.errors.push(`visitors: ${e.message}`); visits = (prev.daily || []).filter((d) => d.visitors != null).map(({ date, visitors, pageviews }) => ({ date, visitors, pageviews })); }
      // its first days check by check (and old posts taking off), like the other networks' (trackPosts does theirs)
      await trackEarly(dataDir, 'ghost', out.posts || [], historyKeys('ghost')).catch((e) => out.errors.push(`early checks: ${e.message}`));
      posts30(out.posts, ['signups', 'paidConversions', 'opens'], out.totals);
      out.totals.emails30 = out.posts.filter((p) => p.time >= Date.now() - 30 * DAY && p.emailRecipients).length;
      out.postsPerDay = perDay(out.posts);
      await archiveTo('ghost', extra);
    } catch (e) { out.errors.push(e.message); }
    // clicks off the site and LIVE NOW plays, from the clicks collector's clicks.json: per day, and all of them so far
    // (for the gains between checks), for the engagement line
    let clickDays = [];
    const c = await readJson(file('clicks'));
    if (c.totals) {
      clickDays = (c.perDay || []).map(({ date, clicks, plays }) => ({ date, linkClicks: num(clicks), livePlays: num(plays) }));
      out.totals.linkClicks = Object.values(c.totals.out || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      out.totals.livePlays = Number(c.totals.play) || 0;
    }
    const h = withHistory(prev.history, out.totals, ['members', 'subscribers', 'comments'], 400);
    out.history = h.history;
    out.daily = mergeDaily(visits, clickDays, h.daily);
    last30(h.daily, ['newMembers', 'newSubscribers'], out.totals);
  });
}

// ---------- Cloudflare ----------
// Every request Cloudflare answered for the site, per day (cloudflare.json).
export function cloudflare({ env, collector, minutes, enabled, archiveTo }) {
  // ---------- Cloudflare ----------
  // Everything Cloudflare answered for the zone, per day: all requests (bots and cached pages included, unlike
  // Ghost's analytics, which count people), threats it blocked, bandwidth, top countries. Needs an API token with
  // Zone > Analytics > Read for the zone, and its Zone ID (the zone's Overview page). Days are kept here (400),
  // so the record outlives Cloudflare's own window.
  const CF = { token: env.CLOUDFLARE_API_TOKEN || '', zone: env.CLOUDFLARE_ZONE_ID || '' };
  const CF_QUERY = `query ($zone: string!, $since: Date!, $until: Date!) { viewer { zones(filter: {zoneTag: $zone}) {
    httpRequests1dGroups(limit: 100, filter: {date_geq: $since, date_leq: $until}, orderBy: [date_ASC]) {
      dimensions { date }
      sum { requests cachedRequests bytes cachedBytes threats pageViews
        countryMap { clientCountryName requests threats } responseStatusMap { edgeResponseStatus requests } }
      uniq { uniques } } } } }`;
  // the same with every breakdown Cloudflare has per day, for the archive (days[date].http: the whole group, all
  // countries); if Cloudflare refuses it (a field gone), CF_QUERY alone
  const CF_QUERY_ALL = CF_QUERY.replace('countryMap { clientCountryName requests threats }', `countryMap { clientCountryName requests threats bytes }
        encryptedRequests encryptedBytes browserMap { uaBrowserFamily pageViews } contentTypeMap { edgeResponseContentTypeName requests bytes }
        clientHTTPVersionMap { clientHTTPProtocol requests } clientSSLMap { clientSSLProtocol requests } ipClassMap { ipType requests }
        threatPathingMap { threatPathingName requests }`);
  collector('cloudflare', 'Cloudflare', enabled(env.CF_STATS), minutes(env.CF_STATS_MINUTES), 55, async (out, prev) => {
    Object.assign(out, { totals: {}, daily: [], countries: [] });
    const history = { ...(prev.history || {}) };
    try {
      if (!CF.token || !CF.zone) throw new Error('needs CLOUDFLARE_API_TOKEN (Zone > Analytics > Read) and CLOUDFLARE_ZONE_ID');
      // the last few days each time (today's grows; Cloudflare may still fill in yesterday), 30 on the first run
      const back = Object.keys(history).length ? 3 : 30;
      const ask = (query) => fetchJson('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { zone: CF.zone, since: day(Date.now() - back * DAY), until: day(Date.now()) } }),
      }, 'Cloudflare');
      let { res, data } = await ask(CF_QUERY_ALL);
      if (res.ok && data.errors?.length) ({ res, data } = await ask(CF_QUERY));
      if (!res.ok || data.errors?.length) {
        const msg = data.errors?.map((e) => e.message).join('; ') || res.status;
        throw new Error(`Cloudflare: ${msg}${res.status === 401 || /authz|permission/i.test(msg) ? ' (does the token have Zone > Analytics > Read for this zone?)' : ''}`);
      }
      const zone = data.data?.viewer?.zones?.[0];
      if (!zone) throw new Error('Cloudflare: no such zone for this token (check CLOUDFLARE_ZONE_ID)');
      await archiveTo('cloudflare', { days: Object.fromEntries((zone.httpRequests1dGroups || []).map((g) => [g.dimensions.date, { http: { ...g.sum, ...g.uniq } }])) });
      for (const g of zone.httpRequests1dGroups || []) {
        const s = g.sum || {};
        const status = (lo) => (s.responseStatusMap || []).filter((r) => r.edgeResponseStatus >= lo && r.edgeResponseStatus < lo + 100).reduce((a, r) => a + r.requests, 0);
        const countries = Object.fromEntries((s.countryMap || []).sort((a, b) => b.requests - a.requests).slice(0, 20).map((c) => [c.clientCountryName, c.requests]));
        history[g.dimensions.date] = {
          requests: s.requests, cached: s.cachedRequests, bytes: s.bytes, cachedBytes: s.cachedBytes, threats: s.threats,
          pageViews: s.pageViews, uniques: g.uniq?.uniques ?? null, errors4xx: status(400), errors5xx: status(500), countries,
        };
      }
    } catch (e) { out.errors.push(e.message); }
    const keep = Object.keys(history).sort().slice(-400);
    out.history = Object.fromEntries(keep.map((d) => [d, history[d]]));
    out.daily = keep.map((date) => {
      const { countries, ...d } = history[date];
      return { date, ...d, cachedPct: d.requests ? Math.round((1000 * d.cached) / d.requests) / 10 : null };
    });
    const recent = keep.filter((d) => d > day(Date.now() - 30 * DAY));
    const countries = {};
    for (const d of recent) for (const [c, n] of Object.entries(history[d].countries || {})) countries[c] = (countries[c] || 0) + n;
    out.countries = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([country, requests]) => ({ country, requests }));
    for (const k of ['requests', 'cached', 'bytes', 'threats', 'pageViews', 'errors5xx']) {
      out.totals[`${k}30`] = recent.length ? recent.reduce((a, d) => a + (history[d][k] || 0), 0) : null;
    }
    out.totals.cachedPct30 = out.totals.requests30 ? Math.round((1000 * out.totals.cached30) / out.totals.requests30) / 10 : null;
  });
}

// ---------- Google Search ----------
// Google Search clicks, impressions and position (Search Console, search.json).
export function search({ env, dataDir, collector, minutes, enabled, archiveTo }) {
  // ---------- Google Search Console ----------
  // A Google Cloud service account (its JSON key in SEARCH_CONSOLE_KEY, whole or base64'd) added as a user of the
  // Search Console property SEARCH_CONSOLE_SITE ("sc-domain:<SITE_HOST>" for a domain property, or the
  // address for a URL-prefix one), with the Search Console API enabled in its project. Google keeps 16 months;
  // the days are kept here too, so the record can grow past that. Google fills in a day 2-3 days late.
  const GSC_SITE = env.SEARCH_CONSOLE_SITE || `sc-domain:${SITE_HOST}`;
  const GSC_ROWS = Math.min(250, Math.max(10, Number(env.GSC_STATS_ROWS) || 50));
  let gscAccess = { token: '', until: 0 };
  const gscKey = () => {
    const raw = String(env.SEARCH_CONSOLE_KEY || '').trim();
    const key = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (!key.client_email || !key.private_key) throw new Error('SEARCH_CONSOLE_KEY is not a service account key (no client_email/private_key)');
    return key;
  };
  async function gscToken() {
    if (gscAccess.token && Date.now() < gscAccess.until) return gscAccess.token;
    const key = gscKey();
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const jwt = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
    const { res, data } = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    }, 'Google sign-in');
    if (!res.ok || !data.access_token) throw new Error(`Google sign-in: ${data.error_description || data.error || res.status}`);
    gscAccess = { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 120_000 };
    return gscAccess.token;
  }
  async function gscQuery(body) {
    const { res, data } = await fetchJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await gscToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'Search Console');
    if (!res.ok || data.error) {
      const hint = res.status === 403 ? ` (add ${(() => { try { return gscKey().client_email; } catch { return 'the service account'; } })()} as a user of ${GSC_SITE} in Search Console, and enable the Search Console API)` : '';
      throw new Error(`Search Console: ${data.error?.message || res.status}${hint}`);
    }
    return data.rows || [];
  }
  // Each day's searches, pages, countries and devices, and the other search types' totals (image, video, news,
  // Discover, Google News), into the archive (days[date].queries/pages/countries/devices/types), since Google keeps
  // only 16 months. A day is final 3-4 days late, so the last GSC_FINAL days are asked again every poll and older
  // ones once (the first poll: all 16 months); meta.finalThrough = the last day asked for once final.
  const GSC_FINAL = 4;
  const GSC_DIMS = [['query', 'queries'], ['page', 'pages'], ['country', 'countries'], ['device', 'devices']];
  const GSC_TYPES = ['image', 'video', 'news', 'discover', 'googleNews'];
  const GSC_PAGE = 25000;
  async function gscDays(row) {
    const meta = (await archiveRead(dataDir, 'search')).meta || {};
    const final = day(Date.now() - GSC_FINAL * DAY);
    const from = meta.finalThrough ? day(Math.min(Date.parse(meta.finalThrough) + DAY, Date.parse(final))) : day(Date.now() - 486 * DAY);
    const range = { startDate: from, endDate: day(Date.now()) };
    const days = {};
    for (const [dim, part] of GSC_DIMS) {
      for (let start = 0; start < 20 * GSC_PAGE; start += GSC_PAGE) {
        const rows = await gscQuery({ ...range, dimensions: ['date', dim], rowLimit: GSC_PAGE, startRow: start });
        for (const r of rows) ((days[r.keys[0]] ||= {})[part] ||= {})[r.keys[1]] = row(r);
        if (rows.length < GSC_PAGE) break;
      }
    }
    for (const type of GSC_TYPES) {
      try {
        for (const r of await gscQuery({ ...range, dimensions: ['date'], type, rowLimit: 1000 })) ((days[r.keys[0]] ||= {}).types ||= {})[type] = row(r);
      } catch { /* a type this site has none of */ }
    }
    await archiveTo('search', { days, meta: { finalThrough: final } });
  }
  collector('search', 'Search Console', enabled(env.GSC_STATS), minutes(env.GSC_STATS_MINUTES), 60, async (out, prev) => {
    Object.assign(out, { site: GSC_SITE, totals: {}, daily: [], queries: [], pages: [] });
    const history = { ...(prev.history || {}) };
    try {
      if (!env.SEARCH_CONSOLE_KEY) throw new Error('needs SEARCH_CONSOLE_KEY (a service account\'s JSON key) and SEARCH_CONSOLE_SITE');
      const today = day(Date.now());
      const since28 = day(Date.now() - 28 * DAY);
      const pct = (ctr) => Math.round(ctr * 1000) / 10;
      const pos = (p) => Math.round(p * 10) / 10;
      for (const r of await gscQuery({ startDate: day(Date.now() - 486 * DAY), endDate: today, dimensions: ['date'], rowLimit: 1000 })) {
        history[r.keys[0]] = { clicks: r.clicks, impressions: r.impressions, ctr: pct(r.ctr), position: pos(r.position) };
      }
      const [all] = await gscQuery({ startDate: since28, endDate: today });
      if (all) out.totals = { clicks28: all.clicks, impressions28: all.impressions, ctr28: pct(all.ctr), position28: pos(all.position) };
      const rows = (r) => ({ clicks: r.clicks, impressions: r.impressions, ctr: pct(r.ctr), position: pos(r.position) });
      out.queries = (await gscQuery({ startDate: since28, endDate: today, dimensions: ['query'], rowLimit: GSC_ROWS })).map((r) => ({ query: r.keys[0], ...rows(r) }));
      out.pages = (await gscQuery({ startDate: since28, endDate: today, dimensions: ['page'], rowLimit: GSC_ROWS }))
        .map((r) => ({ page: r.keys[0].replace(/^https?:\/\/[^/]+/, '') || '/', url: r.keys[0], ...rows(r) }));
      try { await gscDays(rows); } catch (e) { out.errors.push(`per day: ${e.message}`); }
    } catch (e) { out.errors.push(e.message); }
    const keep = Object.keys(history).sort().slice(-1000);
    out.history = Object.fromEntries(keep.map((d) => [d, history[d]]));
    out.daily = keep.map((date) => ({ date, ...history[date] }));
  });
}
