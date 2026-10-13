// stats/instagram.mjs: Instagram's numbers for Grafana (instagram.json), straight from Instagram with the token
// Postiz keeps, since the posts are made in the app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { env, STATE_FILE, log, networkOn, POSTIZ_KEY, INSTAGRAM_IDS, SITE_TIMEZONE } from '../config.mjs';
import { PG, pgQuery, postiz } from '../services.mjs';
import { trackAccount, withWeekly, trackPosts, surgingRefs, postsPerPoll, META_CALLS_PER_HOUR, siteLinks, postRef, withOlder,
  toCheck, historyKeys, withPostedMs, everyText, archive, archiveRead, askLearned, insightValue, insightBreakdown,
  audienceLists, zoneHour } from './history.mjs';
import { withPerformance } from './performance.mjs';

// ---------- Instagram numbers -> Grafana ----------
// You post Instagram by hand (from the bridge's notification), so Postiz's own stats don't know those posts.
// Every IG_STATS_MINUTES this collects the account's numbers and writes them to instagram.json, served at
// GET /instagram.json (Docker networks only: Grafana's Infinity datasource reads it over the monitoring network).
//  - account: Postiz's analytics for the Instagram channel (new followers and reach per day, 30 days of totals)
//    and, with POSTIZ_DB_PASSWORD, the follower total, kept per day in followerHistory (from the first poll on), and
//    profile views and taps on the profile's links (the site's bio link among them) per day, in profileHistory with
//    the account's other numbers per day (IG_DAY_METRICS, and their breakdowns: follows vs unfollows, ...)
//  - stories: every Story seen while it was up, with its last numbers (Instagram has none once it's gone)
//  - the archive (data/archive/instagram.json): all that, plus each post's whole object and every number Instagram
//    gives for it, and once a day the audience (age, gender, country, city) and followers online by hour
//  - posts: with POSTIZ_DB_PASSWORD set, every post on the account and its numbers, straight from Instagram with the
//    token Postiz keeps for the channel (read from Postiz's database, never saved or logged). So they include what you
//    posted in the app. Likes and comments come with the list; the rest is a call per post, so each poll asks for the
//    newest IG_STATS_POSTS and as many older ones (the longest unchecked first) and the others keep their last numbers;
//    fewer when META_CALLS_PER_HOUR wouldn't cover them at IG_STATS_MINUTES (postsPerPoll, after the account's calls).
//    The account's numbers per day (profile views, ...) are asked for at most hourly, however often it polls.
// Read-only (nothing is posted), so it runs in DRY_RUN too.
// (off too when NETWORKS leaves instagram out)
export const IG_STATS = (env.IG_STATS || 'true') === 'true' && networkOn('instagram');
const IG_STATS_MINUTES = Math.max(10, Number(env.IG_STATS_MINUTES) || 60);
export const IG_STATS_FILE = path.join(path.dirname(STATE_FILE), 'instagram.json');
const IG_GRAPH = 'https://graph.instagram.com/v25.0';
const IG_FOLLOWER_DAYS = 400;
const IG_POSTS = Math.min(50, Math.max(1, Number(env.IG_STATS_POSTS) || 25));
const IG_PAGES = 50; // of 100 posts
// Each post's numbers, [Instagram's name, ours]: as many as Instagram gives for that kind of post (askLearned:
// it refuses a whole call when one doesn't apply, e.g. watch time on a photo, replies on anything but a Story)
const IG_MEDIA_METRICS = [['views', 'views'], ['reach', 'reach'], ['likes', 'likes'], ['comments', 'comments'], ['saved', 'saved'],
  ['shares', 'shares'], ['total_interactions', 'interactions'], ['follows', 'follows'], ['profile_visits', 'profileVisits'],
  ['profile_activity', 'profileActivity'], ['ig_reels_avg_watch_time', 'avgWatchMs'], ['ig_reels_video_view_total_time', 'watchTimeMs'],
  ['reposts', 'reposts'], ['crossposted_views', 'crosspostedViews'], ['facebook_views', 'facebookViews'], ['replies', 'replies'],
  ['navigation', 'navigation']];
// the ones that come only from the insights call (likes and comments come with the list too)
const IG_INSIGHTS = IG_MEDIA_METRICS.map(([, k]) => k).filter((k) => k !== 'likes' && k !== 'comments');
// Account numbers Instagram gives per day only as one total over the days asked for (metric_type=total_value),
// [Instagram's name, ours], as many as it gives this account (askLearned); and some split by a breakdown, each its own
// call ([metric, breakdown] -> by["<metric>/<breakdown>"] = { <value>: n }: follows vs unfollows, followers vs not...)
const IG_DAY_METRICS = [['profile_views', 'profileViews'], ['profile_links_taps', 'linkTaps'], ['views', 'views'], ['reach', 'reach'],
  ['accounts_engaged', 'accountsEngaged'], ['total_interactions', 'interactions'], ['likes', 'likes'], ['comments', 'comments'],
  ['shares', 'shares'], ['saves', 'saves'], ['replies', 'replies'], ['reposts', 'reposts'], ['follows_and_unfollows', 'followsAndUnfollows'],
  ['website_clicks', 'websiteClicks']];
const IG_DAY_BREAKDOWNS = [['follows_and_unfollows', 'follow_type'], ['profile_links_taps', 'contact_button_type'], ['reach', 'follow_type'],
  ['reach', 'media_product_type'], ['views', 'follow_type'], ['views', 'media_product_type'], ['total_interactions', 'media_product_type']];
const IG_PROFILE_KEYS = ['profileViews', 'linkTaps', 'likes', 'comments', 'shares', 'saves']; // the ones the dashboards show
const IG_DAY_BACKFILL_CALLS = 24; // calls a poll for earlier days of the last 30 (8 a day), until they're all kept

let igCalls = 0; // this poll's calls to Instagram, for postsPerPoll
async function igGraph(pathAndQuery, token) {
  igCalls++;
  const url = `${IG_GRAPH}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new Error(`Instagram: ${e.cause?.code || e.message}`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // 190 = the token is expired, revoked or the app was removed from the account: only reconnecting helps
    const hint = data.error?.code === 190 ? ' (reconnect the Instagram channel in Postiz)' : '';
    throw new Error(`Instagram ${pathAndQuery.split('?')[0].replace(/\/\d+/, '/<id>')}: ${data.error?.message || res.status}${hint}`);
  }
  return data;
}

// One post's numbers, by our names: the ones Instagram gives for its kind (media_product_type: FEED, REELS, STORY;
// learned in `learned`), or if that fails for this post, the few every post has (fewer again if refused)
async function igPostInsights(id, kind, token, learned) {
  const call = async (list) => (await igGraph(`/${id}/insights?metric=${list.join(',')}`, token)).data || [];
  let data = [];
  try { data = await askLearned(learned, `media:${kind}`, IG_MEDIA_METRICS.map(([m]) => m), call); } catch {
    for (const metrics of ['views,reach,saved,likes,comments,shares', 'reach,saved,likes,comments,shares', 'reach,saved']) {
      try { data = await call(metrics.split(',')); break; } catch { /* try fewer */ }
    }
  }
  const byName = Object.fromEntries(data.map((m) => [m.name, insightValue(m)]));
  return Object.fromEntries(IG_MEDIA_METRICS.filter(([m]) => m in byName).map(([m, k]) => [k, byName[m]]));
}

// The account's numbers per day (IG_DAY_METRICS: profile views, taps on the profile's links, views, reach, ...).
// Instagram sums them over the window asked for, so each UTC day is its own call (and one per breakdown): today and
// yesterday every poll (they still grow), and earlier days of the last 30 (as far back as Instagram goes) not kept yet
// with their breakdowns, IG_DAY_BACKFILL_CALLS a poll. Kept from poll to poll in profileHistory, IG_FOLLOWER_DAYS.
async function igProfileDays(token, prevHistory, learned, errors) {
  const history = { ...prevHistory };
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const days = [];
  for (let i = 0; i < 30; i++) {
    const start = today - i * 86_400_000;
    if (i < 2 || !history[iso(start)]?.by) days.push(start);
  }
  let failed = '';
  let calls = 0;
  const fetched = [];
  for (const [i, start] of days.entries()) {
    if (i >= 2 && calls >= 2 * (1 + IG_DAY_BREAKDOWNS.length) + IG_DAY_BACKFILL_CALLS) break;
    const window = `period=day&metric_type=total_value&since=${start / 1000}&until=${start / 1000 + 86_400}`;
    const got = {};
    calls++;
    try {
      const data = await askLearned(learned, 'day', IG_DAY_METRICS.map(([m]) => m),
        async (list) => (await igGraph(`/me/insights?metric=${list.join(',')}&${window}`, token)).data || []);
      for (const m of data) got[m.name] = insightValue(m);
    } catch (e) { failed = e.message; }
    if (!Object.keys(got).length) continue;
    const by = {};
    for (const [m, b] of IG_DAY_BREAKDOWNS) {
      if (!(m in got)) continue; // one this account doesn't give
      calls++;
      try {
        const { data = [] } = await igGraph(`/me/insights?metric=${m}&breakdown=${b}&${window}`, token);
        by[`${m}/${b}`] = insightBreakdown(data[0]);
      } catch { /* not split for this account */ }
    }
    history[iso(start)] = { ...Object.fromEntries(IG_DAY_METRICS.map(([m, k]) => [k, got[m] ?? null])), by };
    fetched.push(iso(start));
  }
  if (failed && !fetched.length) errors.push(`profile views: ${failed}`);
  const keep = Object.keys(history).sort().slice(-IG_FOLLOWER_DAYS);
  return { history: Object.fromEntries(keep.map((d) => [d, history[d]])), fetched };
}

// Who the account reaches, once a UTC day (Instagram gives it from 100 followers): followers, accounts engaged and
// accounts reached this month by age, gender, country and city, and followers online by hour on each recent day
async function igAudience(token) {
  const audience = {};
  const online = {};
  for (const metric of ['follower_demographics', 'engaged_audience_demographics', 'reached_audience_demographics']) {
    for (const by of ['age', 'gender', 'country', 'city']) {
      let m = null;
      for (const timeframe of ['&timeframe=this_month', '']) {
        try {
          m = (await igGraph(`/me/insights?metric=${metric}&period=lifetime&metric_type=total_value&breakdown=${by}${timeframe}`, token)).data?.[0];
          break;
        } catch { /* without the timeframe */ }
      }
      if (!m) break; // none for this account: no use asking its other breakdowns
      (audience[metric] ||= {})[by] = insightBreakdown(m);
    }
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const { data = [] } = await igGraph(`/me/insights?metric=online_followers&period=lifetime&since=${now - 7 * 86_400}&until=${now}`, token);
    for (const v of data[0]?.values || []) if (v.value && Object.keys(v.value).length) online[String(v.end_time).slice(0, 10)] = v.value;
  } catch { /* none for this account */ }
  return { audience, online };
}

// Followers online by hour, averaged over the days Instagram gave ({ date: { <hour>: n } }), its hours taken as
// Pacific time (Meta's own) and turned into SITE_TIMEZONE's: [{ hour: '18', followers }], midnight first
function igOnlineByHour(online) {
  const sums = Array.from({ length: 24 }, () => ({ total: 0, days: 0 }));
  for (const [date, hours] of Object.entries(online)) {
    for (const [h, n] of Object.entries(hours)) {
      const s = sums[zoneHour(date, Number(h), 'America/Los_Angeles', SITE_TIMEZONE)];
      s.total += Number(n) || 0;
      s.days++;
    }
  }
  return sums.map((s, h) => ({ hour: String(h).padStart(2, '0'), followers: s.days ? Math.round(s.total / s.days) : null }));
}

async function pollInstagramStats() {
  igCalls = 0;
  const out = { updatedAt: new Date().toISOString(), account: null, daily: [], totals: {}, posts: [], postsPerDay: [], stories: [], errors: [] };
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(IG_STATS_FILE, 'utf8')); } catch {}
  out.metricsOk = prev.metricsOk || {}; // which numbers Instagram gives, per kind (askLearned)
  const dataDir = path.dirname(STATE_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const kept = { days: {}, posts: [] }; // for the archive
  const channels = (await postiz('GET', '/integrations'))
    .filter((c) => INSTAGRAM_IDS.includes(c.identifier) && !c.disabled);
  const ch = channels[0];
  if (!ch) out.errors.push('no Instagram channel in Postiz');
  else {
    out.account = { name: ch.name, username: ch.profile || '', picture: ch.picture || '' };
    if (ch.refreshNeeded) out.errors.push('Postiz says the Instagram channel needs reconnecting');
    try {
      const series = await postiz('GET', `/analytics/${ch.id}?date=30`);
      const days = {};
      // Instagram's follower_count is new follows per day (and missing below 100 followers), not the total
      // (profile views aren't post views: those come from Instagram itself, igProfileDays)
      const pick = [[/profile/i, null], [/follower/i, 'newFollowers'], [/reach/i, 'reach'], [/like/i, 'likes'], [/view|impression/i, 'views'],
        [/comment/i, 'comments'], [/share/i, 'shares'], [/save/i, 'saves'], [/repl/i, 'replies']];
      for (const s of Array.isArray(series) ? series : []) {
        const key = pick.find(([re]) => re.test(s.label || ''))?.[1];
        if (!key) continue;
        const data = Array.isArray(s.data) ? s.data : [];
        out.totals[key] = data.reduce((a, d) => a + (Number(d.total) || 0), 0);
        // new followers and reach come per day; the others as one total
        if (key === 'newFollowers' || key === 'reach') {
          for (const d of data) {
            const date = String(d.date).slice(0, 10);
            (days[date] ||= { date })[key] = Number(d.total) || 0;
          }
        }
      }
      out.daily = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
      // Postiz answers [] when Instagram refuses it (usually the channel's token), instead of an error
      if (!Object.keys(out.totals).length) out.errors.push('Postiz analytics: no numbers (is the Instagram channel still connected in Postiz?)');
    } catch (e) { out.errors.push(`Postiz analytics: ${e.message}`); }
  }

  out.stories = prev.stories || [];
  out.audience = prev.audience || null;
  out.onlineByHour = prev.onlineByHour || [];
  // said in the status tile, so a dashboard with half its Instagram panels empty explains itself (staging has none)
  if (ch && !PG.password) out.errors.push('followers and posts need POSTIZ_DB_PASSWORD set');
  if (PG.password && ch) {
    let token = '';
    try {
      const rows = await pgQuery(PG, `SELECT token FROM "Integration" WHERE id = '${String(ch.id).replace(/'/g, "''")}' AND "deletedAt" IS NULL`);
      token = String(rows[0]?.token || '').split('___')[0];
      if (!token) throw new Error('no token for the channel in Postiz\'s database');
      const basic = 'username,followers_count,media_count';
      const me = await igGraph(`/me?fields=user_id,${basic},name,follows_count,account_type`, token)
        .catch(() => igGraph(`/me?fields=${basic}`, token)); // the extra fields are newer: without them if refused
      kept.account = me;
      if (me.username && out.account) out.account.username = me.username;
      if (me.followers_count != null) out.totals.followers = me.followers_count;
      if (me.follows_count != null) out.totals.following = me.follows_count;
      if (me.media_count != null) out.totals.posts = me.media_count;
      // per-day numbers move slowly and cost a call per day and breakdown: at most hourly
      out.profileFetched = prev.profileFetched || 0;
      if (Date.now() - out.profileFetched >= 55 * 60_000) {
        const days = await igProfileDays(token, prev.profileHistory, out.metricsOk, out.errors);
        out.profileHistory = days.history;
        for (const d of days.fetched) kept.days[d] = { insights: days.history[d] };
        out.profileFetched = Date.now();
      }
      try {
        if (!(await archiveRead(dataDir, 'instagram')).days?.[today]?.audience) {
          const { audience, online } = await igAudience(token);
          if (Object.keys(audience).length) (kept.days[today] ||= {}).audience = audience;
          for (const [d, hours] of Object.entries(online)) (kept.days[d] ||= {}).onlineFollowers = hours;
          // for the dashboard: who follows, and when they're online
          if (audience.follower_demographics) out.audience = audienceLists(audience.follower_demographics, today);
          if (Object.keys(online).length) out.onlineByHour = igOnlineByHour(online);
        }
      } catch (e) { out.errors.push(`audience: ${e.message}`); }
      const listed = [];
      let after = '';
      for (let page = 0; page < IG_PAGES; page++) {
        const r = await igGraph(`/me/media?fields=id,caption,media_type,media_product_type,permalink,shortcode,timestamp,like_count,comments_count,is_comment_enabled,is_shared_to_feed,thumbnail_url,media_url&limit=100${after && `&after=${encodeURIComponent(after)}`}`, token);
        listed.push(...(r.data || []));
        after = r.paging?.next ? r.paging.cursors?.after || '' : '';
        if (!after) break;
      }
      const was = Object.fromEntries((prev.posts || []).map((p) => [p.ref, p]));
      const posts = listed.map((m) => {
        const ref = postRef(m.id);
        return {
          id: m.id, ref, links: siteLinks([m.caption]), date: m.timestamp, time: Date.parse(m.timestamp) || null, network: 'Instagram', account: out.account?.name || '', type: m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : m.media_type === 'VIDEO' ? 'Video' : 'Photo',
          caption: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 140), permalink: m.permalink,
          thumbnail: m.thumbnail_url || (m.media_type === 'VIDEO' ? '' : m.media_url || ''),
          likes: m.like_count ?? was[ref]?.likes ?? null, comments: m.comments_count ?? was[ref]?.comments ?? null,
          ...Object.fromEntries(IG_INSIGHTS.map((k) => [k, was[ref]?.[k] ?? null])), checked: was[ref]?.checked || null,
        };
      });
      const surging = await surgingRefs(dataDir, 'instagram');
      // Stories still to come this poll: a call for the list and one each (as many as last time)
      const storyCalls = 1 + (prev.stories || []).filter((x) => x.time > Date.now() - 86_400_000).length;
      const newest = postsPerPoll({ minutes: IG_STATS_MINUTES, used: igCalls + storyCalls, also: surging.size, cap: IG_POSTS });
      const check = toCheck(posts, was, newest, surging);
      out.checking = { posts: check.size, newest, minutes: IG_STATS_MINUTES, callsPerHour: META_CALLS_PER_HOUR };
      const fresh = [];
      const raw = Object.fromEntries(listed.map((m) => [postRef(m.id), m]));
      for (const p of posts) {
        if (!check.has(p.ref)) continue;
        const ins = await igPostInsights(p.id, raw[p.ref].media_product_type || 'FEED', token, out.metricsOk);
        p.checked = Date.now(); // asked, so it waits its turn again even when Instagram has nothing for it
        if (!Object.keys(ins).length) continue; // none this time: keeps its last numbers
        for (const k of IG_INSIGHTS) p[k] = ins[k] ?? null;
        p.likes = ins.likes ?? p.likes;
        p.comments = ins.comments ?? p.comments;
        raw[p.ref] = { ...raw[p.ref], insights: ins };
        fresh.push(p);
      }
      // each post's numbers per day, for the Post dashboard (stats/post.mjs): the ones asked for just now
      await trackPosts(dataDir, 'instagram', fresh, historyKeys('instagram'))
        .catch((e) => out.errors.push(`history: ${e.message}`));
      kept.posts.push(...Object.entries(raw).map(([ref, data]) => ({ ref, data })));
      out.posts = withOlder(prev.posts, posts, !after);
    } catch (e) { out.errors.push(`posts: ${e.message}`); out.posts = prev.posts || []; }
    // Stories: Instagram lists one only while it's up (24 hours) and has no numbers for it after, so every poll asks
    // for each story up now; its last numbers before it went are its final ones. All kept in stories, newest first.
    // Their numbers per day are kept as instagram-stories in stats.db, so the Post dashboard opens a Story like a post.
    const stories = Object.fromEntries((prev.stories || []).map((x) => [x.ref, x]));
    const seen = [];
    if (token) try {
      const { data: up = [] } = await igGraph('/me/stories?fields=id,caption,media_type,media_product_type,permalink,timestamp', token);
      for (const m of up) {
        const ref = postRef(m.id);
        const ins = await igPostInsights(m.id, 'STORY', token, out.metricsOk);
        stories[ref] = { ...stories[ref], id: m.id, ref, date: m.timestamp, time: Date.parse(m.timestamp) || null, network: 'Instagram',
          account: out.account?.name || '', type: 'Story', links: siteLinks([m.caption]), caption: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 140),
          permalink: m.permalink || '', ...ins, checked: Date.now() };
        seen.push(stories[ref]);
        kept.posts.push({ ref, data: { ...m, insights: ins } });
      }
    } catch (e) { out.errors.push(`stories: ${e.message}`); }
    await trackPosts(dataDir, 'instagram-stories', seen, historyKeys('instagram'))
      .catch((e) => out.errors.push(`stories history: ${e.message}`));
    out.stories = Object.values(stories).sort((a, b) => (b.time || 0) - (a.time || 0));
    const recent = out.stories.filter((x) => x.time > Date.now() - 30 * 86_400_000);
    out.totals.stories30 = recent.length;
    out.totals.storyViews30 = recent.some((x) => x.views != null) ? recent.reduce((a, x) => a + (x.views || 0), 0) : null;
    // posts per day (UTC, like Postiz's own per-day counts) for the top of the Social dashboard
    const perDay = {};
    for (const p of out.posts) if (p.time) { const d = new Date(p.time).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
    out.postsPerDay = Object.entries(perDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, posts]) => ({ date, posts }));
    // all the posts' likes etc. now, for the hour-by-hour gains between checks (trackAccount): the account's per-day
    // likes come late and at most hourly, so today's so far hardly moved between checks. Likes and comments come with
    // every poll's list; shares and saves when a post's insights are asked (its turn)
    if (out.posts.length) {
      for (const [k, f] of [['postLikes', 'likes'], ['postComments', 'comments'], ['postShares', 'shares'], ['postSaves', 'saved']]) {
        out.totals[k] = out.posts.reduce((a, p) => a + (p[f] || 0), 0);
      }
    }
  }

  // Total followers per day: Instagram only gives today's count, so each poll keeps it in followerHistory
  // (carried over from the last instagram.json, last count of each UTC day, IG_FOLLOWER_DAYS kept) and daily[] gets it.
  const history = { ...prev.followerHistory };
  if (out.totals.followers != null) history[new Date().toISOString().slice(0, 10)] = out.totals.followers;
  const keep = Object.keys(history).sort().slice(-IG_FOLLOWER_DAYS);
  out.followerHistory = Object.fromEntries(keep.map((d) => [d, history[d]]));
  const byDate = Object.fromEntries(out.daily.map((d) => [d.date, d]));
  for (const date of keep) (byDate[date] ||= { date }).followers = history[date];
  // profile views and link taps per day (and over the last 30), kept even when this poll couldn't ask; the account's
  // other numbers per day stay in profileHistory (and the archive)
  out.profileHistory ||= prev.profileHistory || {};
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const [date, d] of Object.entries(out.profileHistory)) {
    Object.assign(byDate[date] ||= { date }, Object.fromEntries(IG_PROFILE_KEYS.map((k) => [k, d[k] ?? null])));
  }
  for (const k of IG_PROFILE_KEYS) {
    const recent = Object.entries(out.profileHistory).filter(([date, d]) => date > since30 && d[k] != null);
    out.totals[`${k}30`] = recent.length ? recent.reduce((a, [, d]) => a + d[k], 0) : null;
  }
  out.daily = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  // today's reach so far from Instagram itself (fresher than Postiz's), for the hour-by-hour chart
  const reachToday = out.profileHistory[new Date().toISOString().slice(0, 10)]?.reach;
  if (Number.isFinite(reachToday)) out.totals.reachToday = reachToday;

  withWeekly('instagram', out);
  trackAccount(dataDir, 'instagram', out);
  await withPerformance(dataDir, 'instagram', out);
  out.checkedEvery = everyText(IG_STATS_MINUTES);
  await fs.writeFile(`${IG_STATS_FILE}.tmp`, JSON.stringify(withPostedMs(out), null, 2));
  await fs.rename(`${IG_STATS_FILE}.tmp`, IG_STATS_FILE);
  if (Object.values(out.totals).some((v) => v != null)) (kept.days[today] ||= {}).totals = out.totals;
  await archive(dataDir, 'instagram', kept).catch((e) => out.errors.push(`archive: ${e.message}`));
  if (out.errors.length) log(`Instagram stats: ${out.errors.join('; ')}`);
}

export function startInstagramStats() {
  if (!IG_STATS || !POSTIZ_KEY) return;
  let polling = false;
  const tick = () => {
    if (polling) return;
    polling = true;
    pollInstagramStats().catch((e) => log(`Instagram stats: ${e.message}`)).finally(() => { polling = false; });
  };
  setTimeout(tick, 20_000);
  setInterval(tick, IG_STATS_MINUTES * 60_000);
}
