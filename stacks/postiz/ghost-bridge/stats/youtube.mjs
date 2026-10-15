// stats/youtube.mjs: YouTube's numbers for Grafana (youtube.json), from YouTube's own APIs with the channel's sign-in
// in Postiz, since Postiz's YouTube analytics leave out views and subscribers.

import fs from 'node:fs/promises';
import path from 'node:path';
import { env, STATE_FILE, log, networkOn } from '../config.mjs';
import { PG, pgQuery } from '../services.mjs';
import { storeFor, postRef, siteLinks, withOlder, trackEarly, historyKeys, trackAccount, withWeekly, withPostedMs, everyText,
  archive, archiveRead } from './history.mjs';
import { withPerformance } from './performance.mjs';

// ---------- YouTube numbers -> Grafana ----------
// Like the Instagram numbers: every YT_STATS_MINUTES the YouTube channel connected in Postiz is read and written to
// youtube.json, served at GET /youtube.json for Grafana's Social dashboard. Postiz's own YouTube analytics leave out
// views and the subscriber count, so the bridge asks YouTube itself: it reads the channel's refresh token from
// Postiz's database (one SELECT, never saved or logged) and swaps it at Google for a short-lived access token with
// the same Google app (YOUTUBE_CLIENT_ID/SECRET). Postiz's own tokens stay as they are.
//  - account: subscribers, total views and videos now (YouTube Data API; it rounds subscribers to 3 digits)
//  - daily: the last YT_STATS_DAYS days of views, watch time, likes, comments, shares and subscribers gained/lost
//    (YouTube Analytics API; YouTube fills in a day 2-3 days late), with subscribers per day worked back from now
//  - videos: every upload and its views, likes and comments
// Read-only, so it runs in DRY_RUN too. Needs POSTIZ_DB_PASSWORD and the client ID and secret.
// (off too when NETWORKS leaves youtube out)
export const YT_STATS = (env.YT_STATS || 'true') === 'true' && networkOn('youtube');
const YT_STATS_MINUTES = Math.max(10, Number(env.YT_STATS_MINUTES) || 60);
const YT_STATS_DAYS = Math.min(730, Math.max(30, Number(env.YT_STATS_DAYS) || 365));
const YT_PAGES = 50; // of 50 uploads
export const YT_STATS_FILE = path.join(path.dirname(STATE_FILE), 'youtube.json');
const YT_CLIENT = { id: env.YOUTUBE_CLIENT_ID || '', secret: env.YOUTUBE_CLIENT_SECRET || '' };
let ytAccess = { token: '', until: 0, refresh: '' };

async function ytToken(refreshToken) {
  if (ytAccess.refresh === refreshToken && Date.now() < ytAccess.until) return ytAccess.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: YT_CLIENT.id, client_secret: YT_CLIENT.secret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`Google sign-in: ${e.cause?.code || e.message}`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // invalid_grant = the sign-in was revoked, or it expired: a Google app left in "Testing" drops it after 7 days
    const hint = data.error === 'invalid_grant' ? ' (reconnect the YouTube channel in Postiz; is the Google app "In production"?)' : '';
    throw new Error(`Google sign-in: ${data.error_description || data.error || res.status}${hint}`);
  }
  ytAccess = { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 120_000, refresh: refreshToken };
  return ytAccess.token;
}

async function ytApi(base, pathAndQuery, token) {
  const res = await fetch(`${base}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new Error(`YouTube: ${e.cause?.code || e.message}`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // accessNotConfigured = that API isn't enabled in the Google Cloud project
    const reason = data.error?.errors?.[0]?.reason;
    const hint = reason === 'accessNotConfigured' ? ' (enable this API in the Google Cloud project)' : '';
    throw new Error(`YouTube ${pathAndQuery.split('?')[0]}: ${data.error?.message || res.status}${hint}`);
  }
  return data;
}
const ytData = (q, token) => ytApi('https://www.googleapis.com/youtube/v3', q, token);
const ytAnalytics = (q, token) => ytApi('https://youtubeanalytics.googleapis.com/v2', q, token);
// An Analytics report with the first of `lists` (metrics) YouTube takes: it refuses a whole report over one metric it
// doesn't have for it, so the longer lists (numbers nothing shows yet, for the archive) go first and the one the
// dashboards need last. The list that worked is remembered (ytWorked[key]) until the bridge restarts.
const ytWorked = {};
async function ytReport(key, query, lists, token) {
  let failed;
  for (const metrics of lists.slice(Math.max(0, lists.indexOf(ytWorked[key])))) {
    try {
      const r = await ytAnalytics(`/reports?ids=channel==MINE&${query}&metrics=${metrics}`, token);
      ytWorked[key] = metrics;
      return r;
    } catch (e) { failed = e; }
  }
  throw failed;
}
// A report's rows as objects named by its columns
const ytRows = (r) => {
  const cols = (r.columnHeaders || []).map((h) => h.name);
  return (r.rows || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
};
const YT_MORE = 'dislikes,averageViewDuration,averageViewPercentage,subscribersLost,videosAddedToPlaylists,videosRemovedFromPlaylists';
const YT_VIDEO_DAY_METRICS = [`views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,${YT_MORE},engagedViews,redViews,estimatedRedMinutesWatched`,
  `views,estimatedMinutesWatched,likes,comments,shares,subscribersGained,${YT_MORE}`,
  'views,estimatedMinutesWatched,likes,comments,shares,subscribersGained'];
// The channel's views (and watch time...) split each day by where they came from, for the archive only
// (days[date].<name> = { <value>: { <metric>: n } }): once a UTC day, the last 7 days (YouTube fills them in late),
// and on the first poll every day of YT_STATS_DAYS; ageGroup/gender (no days) = the last 28 days' audience, as of today
const YT_BREAKDOWNS = [['trafficSources', 'insightTrafficSourceType', 'views,estimatedMinutesWatched'],
  ['countries', 'country', 'views,estimatedMinutesWatched,subscribersGained'], ['devices', 'deviceType', 'views,estimatedMinutesWatched'],
  ['operatingSystems', 'operatingSystem', 'views,estimatedMinutesWatched'], ['playbackLocations', 'playbackLocationType', 'views,estimatedMinutesWatched'],
  ['contentTypes', 'creatorContentType', 'views,estimatedMinutesWatched,likes,subscribersGained'],
  ['subscribedStatus', 'subscribedStatus', 'views,estimatedMinutesWatched,likes'], ['sharingServices', 'sharingService', 'shares']];
// YouTube's traffic source types in words (others as they come)
const YT_SOURCES = { YT_SEARCH: 'YouTube search', SUBSCRIBER: 'Subscriptions', RELATED_VIDEO: 'Suggested', SHORTS: 'Shorts feed',
  SHORTS_CONTENT_LINKS: 'Shorts links', EXT_URL: 'Other sites', NO_LINK_OTHER: 'Direct', NO_LINK_EMBEDDED: 'Embeds',
  YT_CHANNEL: 'Channel page', PLAYLIST: 'Playlists', YT_PLAYLIST_PAGE: 'Playlist pages', YT_OTHER_PAGE: 'Other YouTube',
  NOTIFICATION: 'Notifications', END_SCREEN: 'End screens', ANNOTATION: 'Cards', CAMPAIGN_CARD: 'Campaign cards',
  HASHTAGS: 'Hashtags', SOUND_PAGE: 'Sound pages', VIDEO_REMIXES: 'Remixes', LIVE_REDIRECT: 'Live redirects', ADVERTISING: 'Ads',
  PROMOTED: 'Promoted', PRODUCT_PAGE: 'Product pages', IMMERSIVE_LIVE: 'Immersive live' };
// The last 28 days' views and minutes by traffic source, from the breakdowns kept per day: [{ source, views, minutes }]
function ytSources(days) {
  const since = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
  const by = {};
  for (const [d, parts] of Object.entries(days)) {
    if (d < since) continue;
    for (const [k, nums] of Object.entries(parts.trafficSources || {})) {
      const s = by[YT_SOURCES[k] || k] ||= { views: 0, minutes: 0 };
      s.views += Number(nums.views) || 0;
      s.minutes += Number(nums.estimatedMinutesWatched) || 0;
    }
  }
  return Object.entries(by).map(([source, s]) => ({ source, ...s })).filter((s) => s.views > 0).sort((a, b) => b.views - a.views);
}
async function ytBreakdowns(token, meta) {
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const today = day(Date.now());
  const days = {};
  const start = day(Date.now() - (meta.breakdownsFull ? 7 : YT_STATS_DAYS) * 86_400_000);
  for (const [name, dim, metrics] of YT_BREAKDOWNS) {
    try {
      const r = await ytAnalytics(`/reports?ids=channel==MINE&startDate=${start}&endDate=${today}&metrics=${metrics}&dimensions=day,${dim}&sort=day`, token);
      for (const { day: d, [dim]: value, ...nums } of ytRows(r)) ((days[d] ||= {})[name] ||= {})[value ?? '-'] = nums;
    } catch { /* one YouTube doesn't give this channel */ }
  }
  try {
    const r = await ytAnalytics(`/reports?ids=channel==MINE&startDate=${day(Date.now() - 28 * 86_400_000)}&endDate=${today}&metrics=viewerPercentage&dimensions=ageGroup,gender`, token);
    (days[today] ||= {}).audience = Object.fromEntries(ytRows(r).map((o) => [`${o.ageGroup} / ${o.gender}`, o.viewerPercentage]));
  } catch { /* none (too few views) */ }
  return { days, meta: { breakdownsDay: today, breakdownsFull: true } };
}

// Each video's numbers per day (YouTube Analytics, one call per video), for the Post dashboard: in stats.db's days
// like the other networks' (stats/history.mjs, stats/store.mjs), but real per-day numbers, not totals kept each day.
// Each video's days go back to its upload (not just YT_STATS_DAYS), so its totals add up to the real ones, however old
// it is. A video is asked again after YT_VIDEO_HOURS (one over a month old once a day), since YouTube fills in its days
// late anyway; at most YT_VIDEO_CALLS videos a poll, the longest waiting first. Videos no longer listed (deleted) stay.
const YT_VIDEO_HOURS = 6;
const YT_VIDEO_CALLS = 50;
async function ytVideoDays(videos, token) {
  if (!videos.length) return; // the list failed: keep what's there
  const store = storeFor(path.dirname(STATE_FILE));
  const fetched = { ...store.history('youtube').fetched };
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const failed = [];
  const due = [];
  for (const v of videos) {
    const ref = postRef(v.id);
    fetched[ref] ||= 0;
    store.setPostedTime('youtube', ref, v.time);
    const hours = v.time && Date.now() - v.time > 30 * 86_400_000 ? 24 : YT_VIDEO_HOURS;
    if (Date.now() - fetched[ref] >= hours * 3_600_000) due.push(v);
  }
  due.sort((a, b) => fetched[postRef(a.id)] - fetched[postRef(b.id)]);
  for (const v of due.slice(0, YT_VIDEO_CALLS)) {
    const ref = postRef(v.id);
    const start = day(v.time || Date.now() - YT_STATS_DAYS * 86_400_000);
    try {
      const r = await ytReport('video', `startDate=${start}&endDate=${day(Date.now())}&dimensions=day&sort=day`
        + `&filters=video==${encodeURIComponent(v.id)}`, YT_VIDEO_DAY_METRICS, token);
      // the dashboards' numbers by our names, and the rest (for later) by YouTube's
      store.setDays('youtube', ref, Object.fromEntries(ytRows(r).map(({ day: d, views, estimatedMinutesWatched, likes, comments, shares, subscribersGained, ...more }) =>
        [d, { views, minutesWatched: estimatedMinutesWatched, likes, comments, shares, subscribersGained, ...more }])));
    } catch (e) { failed.push(e.message); }
  }
  if (failed.length) throw new Error(`${failed.length} of ${Math.min(due.length, YT_VIDEO_CALLS)}: ${failed[0]}`);
}

// One poll now: startYouTubeStats runs it on its timer; the tests call it
export async function pollYouTubeStats() {
  const out = { updatedAt: new Date().toISOString(), account: null, totals: {}, daily: [], videos: [], videosPerDay: [], errors: [] };
  const kept = { days: {}, posts: [] }; // for the archive
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(YT_STATS_FILE, 'utf8')); } catch {}
  try {
    if (!PG.password) throw new Error('needs POSTIZ_DB_PASSWORD (the bridge reads the channel\'s sign-in from Postiz\'s database)');
    if (!YT_CLIENT.id || !YT_CLIENT.secret) throw new Error('needs YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (the same Google app Postiz uses)');
    const rows = await pgQuery(PG, `SELECT name, picture, "refreshToken", "refreshNeeded" FROM "Integration"
      WHERE "providerIdentifier" = 'youtube' AND "deletedAt" IS NULL AND NOT disabled AND NOT "inBetweenSteps"
      ORDER BY "createdAt" LIMIT 1`);
    const ch = rows[0];
    if (!ch) throw new Error('no YouTube channel in Postiz');
    out.account = { name: ch.name, picture: ch.picture || '' };
    if (ch.refreshNeeded === 't') out.errors.push('Postiz says the YouTube channel needs reconnecting');
    if (!ch.refreshToken) throw new Error('no refresh token for the channel in Postiz\'s database (reconnect it in Postiz)');
    const token = await ytToken(ch.refreshToken);

    let uploads = '';
    try {
      const { items = [] } = await ytData('/channels?part=snippet,statistics,contentDetails,status,topicDetails,brandingSettings&mine=true', token);
      const c = items[0];
      if (!c) throw new Error('the signed-in account has no YouTube channel');
      kept.account = c;
      out.account = { ...out.account, id: c.id, title: c.snippet?.title || out.account.name, handle: c.snippet?.customUrl || '',
        url: c.snippet?.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}` };
      const s = c.statistics || {};
      if (!s.hiddenSubscriberCount && s.subscriberCount != null) out.totals.subscribers = Number(s.subscriberCount);
      if (s.viewCount != null) out.totals.viewsAllTime = Number(s.viewCount);
      if (s.videoCount != null) out.totals.videos = Number(s.videoCount);
      uploads = c.contentDetails?.relatedPlaylists?.uploads || '';
    } catch (e) { out.errors.push(`channel: ${e.message}`); }

    try {
      const day = (d) => new Date(d).toISOString().slice(0, 10);
      const end = day(Date.now());
      const start = day(Date.now() - YT_STATS_DAYS * 86_400_000);
      const metrics = 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost';
      const more = 'dislikes,averageViewPercentage,videosAddedToPlaylists,videosRemovedFromPlaylists';
      const r = await ytReport('channel', `startDate=${start}&endDate=${end}&dimensions=day&sort=day`,
        [`${metrics},${more},engagedViews,redViews,estimatedRedMinutesWatched`, `${metrics},${more}`, metrics], token);
      // the dashboards' numbers by our names, and the rest (for later) by YouTube's
      out.daily = ytRows(r).map(({ day: date, views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares,
        subscribersGained, subscribersLost, ...rest }) => ({ date, views, minutesWatched: estimatedMinutesWatched, averageViewSeconds: averageViewDuration,
        likes, comments, shares, subscribersGained, subscribersLost, subscribersNet: (subscribersGained || 0) - (subscribersLost || 0), ...rest }));
      // subscribers at the end of each day: today's count minus what was gained since (approximate: YouTube rounds
      // the count and fills in the last 2-3 days late)
      if (out.totals.subscribers != null) {
        let n = out.totals.subscribers;
        for (let i = out.daily.length - 1; i >= 0; i--) { out.daily[i].subscribers = n; n -= out.daily[i].subscribersNet; }
      }
      const last30 = out.daily.filter((d) => d.date >= day(Date.now() - 30 * 86_400_000));
      for (const [k, f] of [['views', 'views'], ['minutesWatched', 'minutesWatched'], ['likes', 'likes'], ['comments', 'comments'],
        ['shares', 'shares'], ['subscribersGained', 'subscribersGained'], ['subscribersLost', 'subscribersLost']]) {
        out.totals[k] = last30.reduce((a, d) => a + (Number(d[f]) || 0), 0);
      }
    } catch (e) { out.errors.push(`analytics: ${e.message}`); }

    if (uploads) {
      let complete = false;
      try {
        const ids = [];
        let pageToken = '';
        for (let page = 0; page < YT_PAGES; page++) {
          const r = await ytData(`/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}${pageToken && `&pageToken=${encodeURIComponent(pageToken)}`}`, token);
          ids.push(...(r.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean));
          pageToken = r.nextPageToken || '';
          if (!pageToken) break;
        }
        for (let i = 0; i < ids.length; i += 50) {
          const { items: vids = [] } = await ytData(`/videos?part=snippet,statistics,contentDetails,liveStreamingDetails,status,topicDetails,recordingDetails&id=${ids.slice(i, i + 50).join(',')}`, token);
          for (const v of vids) {
            const s = v.statistics || {};
            kept.posts.push({ ref: postRef(v.id), data: v });
            const published = v.liveStreamingDetails?.actualStartTime || v.snippet?.publishedAt;
            const secs = (/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v.contentDetails?.duration || '') || [])
              .slice(1).reduce((a, x, i) => a + (Number(x) || 0) * [86400, 3600, 60, 1][i], 0);
            out.videos.push({
              id: v.id, ref: postRef(v.id), links: siteLinks([v.snippet?.description]), date: published, time: Date.parse(published) || null, network: 'YouTube', account: out.account?.title || '',
              type: v.liveStreamingDetails ? 'Live' : 'Video', title: String(v.snippet?.title || '').slice(0, 140),
              duration: secs || null, thumbnail: v.snippet?.thumbnails?.medium?.url || '', permalink: `https://www.youtube.com/watch?v=${v.id}`,
              views: s.viewCount != null ? Number(s.viewCount) : null, likes: s.likeCount != null ? Number(s.likeCount) : null,
              comments: s.commentCount != null ? Number(s.commentCount) : null,
              dislikes: s.dislikeCount != null ? Number(s.dislikeCount) : null,
            });
          }
        }
        out.videos.sort((a, b) => (b.time || 0) - (a.time || 0));
        complete = !pageToken;
      } catch (e) { out.errors.push(`videos: ${e.message}`); }
      out.videos = withOlder(prev.videos, out.videos, complete);
      // all the videos' likes and comments now, for the hour-by-hour gains between checks (Analytics' per day is 2-3 days late)
      for (const [k, f] of [['likesAllTime', 'likes'], ['commentsAllTime', 'comments']]) {
        if (out.videos.some((v) => v[f] != null)) out.totals[k] = out.videos.reduce((a, v) => a + (v[f] || 0), 0);
      }
      try { await ytVideoDays(out.videos, token); } catch (e) { out.errors.push(`videos per day: ${e.message}`); }
      // its first days check by check, and old videos taking off (stats/history.mjs; stats.db's youtube days are YouTube's own)
      await trackEarly(path.dirname(STATE_FILE), 'youtube', out.videos, historyKeys('youtube')).catch((e) => out.errors.push(`early checks: ${e.message}`));
    }
    out.sources28 = prev.sources28 || [];
    try {
      const meta = (await archiveRead(path.dirname(STATE_FILE), 'youtube')).meta || {};
      if (meta.breakdownsDay !== new Date().toISOString().slice(0, 10)) {
        const b = await ytBreakdowns(token, meta);
        for (const [d, parts] of Object.entries(b.days)) Object.assign(kept.days[d] ||= {}, parts);
        kept.meta = b.meta;
      }
      // where the last 28 days' views came from, for the dashboard (the archive's days, with any just fetched)
      const days = { ...(await archiveRead(path.dirname(STATE_FILE), 'youtube')).days };
      for (const [d, parts] of Object.entries(kept.days)) days[d] = { ...days[d], ...parts };
      out.sources28 = ytSources(days);
    } catch (e) { out.errors.push(`breakdowns: ${e.message}`); }
    const perDay = {};
    for (const v of out.videos) if (v.time) { const d = new Date(v.time).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
    out.videosPerDay = Object.entries(perDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, videos]) => ({ date, videos }));
  } catch (e) { out.errors.push(e.message); }

  withWeekly('youtube', out);
  trackAccount(path.dirname(STATE_FILE), 'youtube', out);
  await withPerformance(path.dirname(STATE_FILE), 'youtube', out);
  out.checkedEvery = everyText(YT_STATS_MINUTES);
  await fs.writeFile(`${YT_STATS_FILE}.tmp`, JSON.stringify(withPostedMs(out), null, 2));
  await fs.rename(`${YT_STATS_FILE}.tmp`, YT_STATS_FILE);
  const today = new Date().toISOString().slice(0, 10);
  if (Object.values(out.totals).some((v) => v != null)) (kept.days[today] ||= {}).totals = out.totals;
  for (const d of out.daily) (kept.days[d.date] ||= {}).channel = d; // YouTube keeps these too, but not forever
  await archive(path.dirname(STATE_FILE), 'youtube', kept).catch((e) => out.errors.push(`archive: ${e.message}`));
  if (out.errors.length) log(`YouTube stats: ${out.errors.join('; ')}`);
}

export function startYouTubeStats() {
  if (!YT_STATS) return;
  let polling = false;
  const tick = () => {
    if (polling) return;
    polling = true;
    pollYouTubeStats().catch((e) => log(`YouTube stats: ${e.message}`)).finally(() => { polling = false; });
  };
  setTimeout(tick, 25_000);
  setInterval(tick, YT_STATS_MINUTES * 60_000);
}
