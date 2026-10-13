// stats/history.mjs: each post's numbers over time (stats.db, through stats/store.mjs), and the small helpers every
// stats module shares. Every stats module imports from here (none from stats/stats.mjs), so there's no cycle.

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { openStore } from './store.mjs';
import { SITE_HOSTS } from '../config.mjs';

// ---------- helpers ----------
// Small helpers the collectors share: dates, JSON files, the archive (everything an API gave, kept
// for good), Instagram/Threads insights, and per-day records for APIs that only give totals.
export const DAY = 86_400_000;
export const day = (t) => new Date(t).toISOString().slice(0, 10);
export const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
export const text = (s, max = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function writeJson(file, data) {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data, null, 2));
  await fs.rename(`${file}.tmp`, file);
}
export function writeJsonSync(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file);
}
export async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
}

export async function fetchJson(url, opts, what) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new Error(`${what}: ${e.cause?.code || e.message}`); });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Ghost's analytics in Tinybird (Grafana's dashboards read the same pipes): TINYBIRD_URL, TINYBIRD_TOKEN, and the site's
// uuid from TINYBIRD_SITE_UUID, else Ghost's own (the Ghost collector fills it in from /site/ on its first poll).
// Shared by the Ghost collector, /page.json and the weekly summary.
export const TB = { url: (process.env.TINYBIRD_URL || 'http://tinybird-local:7181').replace(/\/$/, ''),
  // tinybird__adminToken: tb-setup's tokens.env, which staging's bridge reads (its own Tinybird)
  token: process.env.TINYBIRD_TOKEN || process.env.tinybird__adminToken || '', site: process.env.TINYBIRD_SITE_UUID || '' };
export async function tbPipe(pipe, params) {
  if (!TB.token) throw new Error('needs TINYBIRD_TOKEN (a token that reads Ghost\'s analytics pipes, e.g. Grafana\'s)');
  if (!TB.site) throw new Error('needs TINYBIRD_SITE_UUID (Ghost hasn\'t said its site_uuid yet)');
  const { res, data } = await fetchJson(`${TB.url}/v0/pipes/${pipe}.json?${new URLSearchParams({ site_uuid: TB.site, timezone: 'Etc/UTC', ...params })}`,
    { headers: { Authorization: `Bearer ${TB.token}` } }, 'Tinybird');
  if (!res.ok || data.error) throw new Error(`Tinybird ${pipe}: ${data.error || res.status}${res.status === 403 ? ' (is TINYBIRD_TOKEN one that can read the pipes?)' : ''}`);
  return data.data || [];
}

// ---------- the archive: everything the APIs gave, kept for good ----------
// data/archive/<name>.json, one per network (and Cloudflare, Search Console, Postiz), so numbers no dashboard shows
// yet are there to use later, including ones an API can't give again (today's totals, a Story's numbers once it's
// gone, days past an API's own window). Not served, nothing reads it yet, and nothing in it is trimmed:
//  - days:    { <UTC date>: { <part>: ... } }  per-day records: "totals" (every number the collector had, the last
//             poll of the day), and per network more (account insights per day, audience, breakdowns, ...)
//  - posts:   { <ref>: { first, last, data } }  each post's whole API object (whole caption, tags, numbers now, ...),
//             field by field as last seen, kept after it's deleted; its numbers over time are in stats.db
//  - account: the account's whole API object as last seen; meta: the collector's own notes (what's been fetched)
// Cut out of every object: picture and media addresses, often signed and short-lived, so no use later.
const ARCHIVE_DROP = new Set(['media_url', 'thumbnail_url', 'cover_image_url', 'avatar_url', 'profile_picture_url', 'stream_url',
  'download_url', 'waveform_url', 'access_token']);
const archiveClean = (o) => (Array.isArray(o) ? o.map(archiveClean)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !ARCHIVE_DROP.has(k)).map(([k, v]) => [k, archiveClean(v)])) : o);
export const archiveFile = (dataDir, name) => path.join(dataDir, 'archive', `${name}.json`);
export const archiveRead = (dataDir, name) => readJson(archiveFile(dataDir, name));
// One write per poll; parts of a day are replaced part by part, so a poll that couldn't ask for one keeps the last
export async function archive(dataDir, name, { days, posts, account, meta } = {}) {
  const f = archiveFile(dataDir, name);
  await fs.mkdir(path.dirname(f), { recursive: true });
  const a = await readJson(f);
  a.days ||= {};
  a.posts ||= {};
  for (const [date, parts] of Object.entries(days || {})) {
    const keep = Object.entries(parts).filter(([, v]) => v != null && !(typeof v === 'object' && !Object.keys(v).length));
    if (keep.length) Object.assign(a.days[date] ||= {}, archiveClean(Object.fromEntries(keep)));
  }
  const now = Date.now();
  for (const { ref, data } of posts || []) {
    if (!ref || !data) continue;
    // field by field over what was kept, so a poll that only listed it keeps the numbers an earlier one asked for
    a.posts[ref] = { first: a.posts[ref]?.first || now, last: now, data: { ...a.posts[ref]?.data, ...archiveClean(data) } };
  }
  if (account) a.account = archiveClean(account);
  if (meta) a.meta = { ...a.meta, ...meta };
  await fs.writeFile(`${f}.tmp`, JSON.stringify(a));
  await fs.rename(`${f}.tmp`, f);
}

// Instagram and Threads refuse a whole insights call when one metric in it doesn't apply (to the account, or to that
// kind of post). Which of `wanted` they give is found out once per kind (each asked on its own), kept in `learned`
// ({ <kind>: { list, at } }, saved with the collector's file) and found out again weekly, when new ones may have come.
// call(list) returns the API's data array. Throws when none are given (or the known ones fail for this post).
export async function askLearned(learned, kind, wanted, call) {
  const k = learned[kind];
  if (k?.list?.length && Date.now() - k.at < 7 * DAY) return call(k.list);
  try {
    const data = await call(wanted);
    learned[kind] = { list: wanted, at: Date.now() };
    return data;
  } catch { /* each on its own */ }
  const ok = [];
  const data = [];
  let failed;
  for (const m of wanted) {
    try { data.push(...await call([m])); ok.push(m); } catch (e) { failed = e; }
  }
  if (!ok.length) throw failed;
  learned[kind] = { list: ok, at: Date.now() };
  return data;
}
// An insights metric's value (Instagram, Threads): one number, or per-day values summed, or by link (Threads' clicks)
export const insightValue = (m) => m.total_value?.value ?? (Array.isArray(m.link_total_values) ? m.link_total_values.reduce((a, l) => a + (Number(l.value) || 0), 0) : null)
  ?? (Array.isArray(m.values) ? m.values.reduce((a, v) => (typeof v.value === 'number' ? (a ?? 0) + v.value : a), null) : null);
// A metric asked for with breakdown=: { <dimension value>: n }
export const insightBreakdown = (m) => Object.fromEntries((m?.total_value?.breakdowns?.[0]?.results || [])
  .map((r) => [(r.dimension_values || []).join(' / ') || '-', r.value]));
// A demographics breakdown ({ age: {...}, gender: {...}, country: {...}, city: {...} }) as lists for the dashboards,
// biggest first: [{ name, people }], countries and genders in words
const GENDERS = { F: 'Women', M: 'Men', U: 'Unknown' };
export function audienceLists(byDim, date) {
  let region = (c) => c;
  try { const names = new Intl.DisplayNames(['en'], { type: 'region' }); region = (c) => { try { return names.of(c) || c; } catch { return c; } }; } catch {}
  const list = (o, name = (x) => x) => Object.entries(o || {}).map(([k, v]) => ({ name: name(k), people: Number(v) || 0 }))
    .sort((a, b) => b.people - a.people);
  return { date, age: list(byDim.age), gender: list(byDim.gender, (g) => GENDERS[g] || g), country: list(byDim.country, region),
    city: list(byDim.city) };
}
// The hour (0-23) in time zone `to` of hour `hour` on `date` (YYYY-MM-DD) in time zone `from`
export function zoneHour(date, hour, from, to) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const wall = (tz, t) => Date.parse(`${new Date(t).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')}Z`);
  const at = guess - (wall(from, guess) - guess); // that wall-clock time in `from`
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: to, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

// Totals kept per UTC day (the last poll of each day), and each day's gain on the day before: only when that day
// was recorded too, and none when the total went down (e.g. a post deleted)
export function withHistory(prev, totals, keys, days) {
  const history = { ...(prev || {}) };
  if (keys.some((k) => totals[k] != null)) history[day(Date.now())] = Object.fromEntries(keys.map((k) => [k, totals[k] ?? null]));
  const keep = Object.keys(history).sort().slice(-days);
  const daily = keep.map((date) => {
    const now = history[date];
    const before = history[day(Date.parse(date) - DAY)];
    const gains = keys.map((k) => [`new${k[0].toUpperCase()}${k.slice(1)}`,
      before && now[k] != null && before[k] != null && now[k] >= before[k] ? now[k] - before[k] : null]);
    return { date, ...now, ...Object.fromEntries(gains) };
  });
  return { history: Object.fromEntries(keep.map((d) => [d, history[d]])), daily };
}

// The sum of each key over the last 30 days of daily (null when none of those days has it)
export function last30(daily, keys, totals) {
  const since = day(Date.now() - 30 * DAY);
  for (const k of keys) {
    const days = daily.filter((d) => d.date > since && d[k] != null);
    totals[`${k}30`] = days.length ? days.reduce((a, d) => a + d[k], 0) : null;
  }
}

// The sum of each key over posts made in the last 30 days
export function posts30(posts, keys, totals) {
  const since = Date.now() - 30 * DAY;
  const recent = posts.filter((p) => p.time >= since);
  for (const k of keys) totals[`${k}30`] = recent.reduce((a, p) => a + (p[k] || 0), 0);
  totals.posts30 = recent.length;
}

// Posts per UTC day: [{ date, posts }]
export function perDay(items) {
  const counts = {};
  for (const p of items) if (p.time) counts[day(p.time)] = (counts[day(p.time)] || 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, posts]) => ({ date, posts }));
}

// What the account's posts gained each UTC day (likes etc. on all of them), from each post's last numbers per day
// in stats.db: for a network with no numbers per day for the account (Bluesky). A post first kept a day or more
// after it went up starts there (what it had before isn't that day's); one kept sooner counts in full. A day a post
// wasn't kept puts its gain on the next day it was. [{ date, <key>: gain }]
export function gainsByDay(dataDir, network, keys) {
  const h = storeFor(dataDir).history(network);
  const byDate = {};
  for (const [ref, days] of Object.entries(h.posts)) {
    let last = null;
    for (const date of Object.keys(days).sort()) {
      const now = days[date];
      const fresh = !last && Number.isFinite(h.times[ref]) && day(h.times[ref]) >= day(Date.parse(date) - DAY);
      const gains = byDate[date] ||= { date };
      for (const k of keys) {
        if (now[k] == null) continue;
        const before = last?.[k] ?? (fresh ? 0 : null);
        if (before != null) gains[k] = (gains[k] || 0) + Math.max(0, now[k] - before);
        else gains[k] ??= 0;
      }
      last = { ...last, ...Object.fromEntries(keys.filter((k) => now[k] != null).map((k) => [k, now[k]])) };
    }
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// Two per-day lists joined by date
export function mergeDaily(...lists) {
  const byDate = {};
  for (const list of lists) for (const d of list || []) Object.assign(byDate[d.date] ||= { date: d.date }, d);
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- each post's numbers over time, and the site page it leads to ----------
// Each post's numbers over time (stats.db, through stats/store.mjs): what each network keeps, every
// check of a post's first days, older posts taking off, the accounts check by check, and the site pages posts link to.
// The networks' APIs give a post's numbers as of now, so every poll keeps them in data/stats.db (stats/store.mjs): every
// check that changed a number, for good, and the day's last numbers per UTC day (days). YouTube's Analytics API has
// real numbers per day, so its days are those instead (perDay below; stats/youtube.mjs keeps them), and so are Ghost's
// analytics (the ghost collector below). GET /post.json reads them back for Grafana's Post dashboard.
// The store for a data folder (STATS_DB_BACKUPS [7] daily copies in data/backups/; startStats sets the log)
let storeLog = () => {};
export const setStoreLog = (fn) => { storeLog = fn; };
const DB_BACKUPS = Math.max(0, Number.isFinite(Number(process.env.STATS_DB_BACKUPS)) && process.env.STATS_DB_BACKUPS !== '' ? Number(process.env.STATS_DB_BACKUPS) : 7);
export const storeFor = (dataDir) => openStore(dataDir, { backups: DB_BACKUPS, log: (m) => storeLog(m) });

// What each network's file lists its posts under, the numbers kept, and the names Ghost's analytics give its
// visitors (the referrer's name, its address, or our link tag: utm_source). perDay networks keep real numbers per day
// (dayKeys) with dayTotals added to the post's numbers now, and say where their days come from (days, noDays).
// `more`: numbers also kept per day in the history file (and the posts) but not compared or shown yet.
export const NETWORKS = {
  instagram: { main: ['views', 'reach', 'likes'], label: 'Instagram', list: 'posts', stories: 'stories', keys: ['views', 'reach', 'likes', 'comments', 'shares', 'saved'],
    more: ['interactions', 'follows', 'profileVisits', 'profileActivity', 'avgWatchMs', 'watchTimeMs', 'reposts', 'crosspostedViews',
      'facebookViews', 'replies', 'navigation'],
    sources: ['Instagram', 'instagram', 'instagram.com', 'ig', 'Facebook', 'facebook', 'facebook.com'] },
  youtube: { main: ['views', 'likes'], label: 'YouTube', list: 'videos', keys: ['views', 'likes', 'comments'], perDay: true,
    dayKeys: ['views', 'minutesWatched', 'likes', 'comments', 'shares', 'subscribersGained'], dayTotals: ['minutesWatched', 'subscribersGained'],
    days: 'The upload (from YouTube, which runs 2-3 days behind)', noDays: 'Not yet: YouTube hasn\'t filled in any days',
    fewDays: 'and YouTube Analytics has fewer videos than that.',
    sources: ['YouTube', 'youtube', 'youtube.com', 'm.youtube.com', 'youtu.be'] },
  soundcloud: { main: ['plays', 'likes'], label: 'SoundCloud', list: 'tracks', keys: ['plays', 'likes', 'reposts', 'comments', 'downloads'],
    sources: ['SoundCloud', 'soundcloud', 'soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'] },
  bluesky: { main: ['likes', 'reposts'], label: 'Bluesky', list: 'posts', keys: ['likes', 'reposts', 'replies', 'quotes'], more: ['bookmarks'],
    sources: ['Bluesky', 'bluesky', 'bsky', 'bsky.app'] },
  threads: { main: ['views', 'likes'], label: 'Threads', list: 'posts', keys: ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'],
    sources: ['Threads', 'threads', 'threads.net', 'threads.com', 'l.threads.com', 'l.threads.net'] },
  tiktok: { main: ['views', 'likes'], label: 'TikTok', list: 'posts', keys: ['views', 'likes', 'comments', 'shares'],
    sources: ['TikTok', 'tiktok', 'tiktok.com', 'm.tiktok.com'] },
  mixcloud: { main: ['plays', 'favorites'], label: 'Mixcloud', list: 'uploads', keys: ['plays', 'favorites', 'reposts', 'comments'], more: ['listeners'],
    sources: ['Mixcloud', 'mixcloud', 'mixcloud.com', 'm.mixcloud.com'] },
  // the site itself: a post's "network" visitors are the newsletter's (Ghost names them like "<site>-newsletter")
  ghost: { main: ['visitors', 'signups'], label: 'Ghost', from: 'the newsletter', list: 'posts',
    keys: ['visitors', 'pageviews', 'signups', 'paidConversions', 'emailRecipients', 'opens', 'emailClicks'],
    perDay: true, dayKeys: ['visitors', 'pageviews'], dayTotals: [],
    days: 'When it went up (Ghost\'s analytics)', noDays: 'Not yet: they come with the next hourly check (needs TINYBIRD_TOKEN)',
    fewDays: 'and Ghost\'s analytics have fewer posts than that.', sourceRegex: '[Nn]ewsletter' },
};
// Postiz's names for some of those channels, as links from its rows arrive (spaces and dashes taken out)
export const NETWORK_ALIASES = { instagramstandalone: 'instagram', tiktokbusiness: 'tiktok' };
export const LABELS = { views: 'Views', reach: 'Reach', likes: 'Likes', comments: 'Comments', shares: 'Shares', saved: 'Saves',
  plays: 'Plays', reposts: 'Reposts', downloads: 'Downloads', replies: 'Replies', quotes: 'Quotes', favorites: 'Favorites',
  minutesWatched: 'Minutes watched', subscribersGained: 'Subscribers gained', visitors: 'Visitors', pageviews: 'Page views',
  signups: 'Sign-ups', paidConversions: 'Paid sign-ups', emailRecipients: 'Emailed to', opens: 'Email opens', emailClicks: 'Email clicks',
  follows: 'Follows', profileVisits: 'Profile visits', interactions: 'Interactions', bookmarks: 'Saves', listeners: 'Listeners',
  navigation: 'Taps' };

// Every number a network's history file keeps per post
export const historyKeys = (network) => [...(NETWORKS[network]?.keys || []), ...(NETWORKS[network]?.more || [])];
// The ones the Post dashboard lists and compares: its usual ones, and the extra ones with a name in LABELS
export const postKeys = (n) => [...n.keys, ...(n.more || []).filter((k) => LABELS[k])];

// A post's id made safe for a Grafana link and a file key (Bluesky's are at:// addresses, Mixcloud's paths)
export const postRef = (id) => String(id ?? '').replace(/[^\w:.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200);
// Each listed post's posting time as text too (posted_ms), for the dashboards' links to the Post dashboard (`from=`):
// Grafana writes a number field into a link as it shows it, which isn't always all the digits, and a start date
// it can't read sends the Post dashboard's charts back to 1970
export function withPostedMs(out) {
  for (const list of Object.values(out)) {
    if (Array.isArray(list)) for (const p of list) if (p && p.ref && Number.isFinite(p.time)) p.posted_ms = String(p.time);
  }
  return out;
}

// How often a file is written, in words ("every hour", "every 30 minutes"), as checkedEvery in each file: the
// Platforms dashboard's section texts show it, so they follow the *_STATS_MINUTES settings
export function everyText(mins) {
  if (mins % 60) return `every ${mins} minutes`;
  return mins === 60 ? 'every hour' : `every ${mins / 60} hours`;
}

export async function trackPosts(dataDir, network, items, keys) {
  const list = items.map((p) => ({ ...p, ref: p.ref || postRef(p.id) }));
  storeFor(dataDir).recordDay(network, list, keys);
  await trackEarly(dataDir, network, list, keys);
}

// What kind of post it is, where a network has more than one (the verdicts and When to post compare within it)
export const POST_KIND = {
  instagram: (p) => p.type || '',
  threads: (p) => p.type || '',
  youtube: (p) => (p.type === 'Live' ? 'Live' : p.duration && p.duration <= 180 ? 'Short' : 'Video'),
  soundcloud: (p) => (p.duration >= 20 * 60 ? 'Mix' : 'Track'),
  ghost: (p) => p.type || '', // emailed as a newsletter or not
  bluesky: (p) => (p.type === 'Quote' ? 'Text' : p.type || ''), // quote posts are few: counted with text ones
  tiktok: (p) => (!p.duration ? 'Photo' : p.duration >= 60 ? 'Long video' : 'Short video'), // photo posts have no duration
  mixcloud: (p) => (p.duration >= 30 * 60 ? 'Full mix' : 'Clip'),
};

// ---------- the accounts, check by check ----------
// Followers and other running totals change through the day too, so each network's are kept at every check (the
// stats database's account table, ACCOUNT_CHECK_DAYS [90] days; the network files keep one per UTC day for longer),
// for the Platforms dashboard's "hour by hour" charts (GET /account.json?network=). Totals that only ever climb or
// drift, not 30-day sums; and `<key>Today`: what a network gives only per day, so far today (UTC), from the file's
// daily[] entry for today unless the collector sets it in totals, so the gain between checks is the hour's share.
// Every collector calls it before writing its file; a failure is that file's error.
export const ACCOUNT_KEYS = {
  ghost: ['members', 'paidMembers', 'subscribers', 'visitorsToday', 'comments', 'linkClicks', 'livePlays'],
  instagram: ['followers', 'following', 'posts', 'reachToday', 'profileViewsToday', 'linkTapsToday', 'postLikes', 'postComments',
    'postShares', 'postSaves'],
  tiktok: ['followers', 'following', 'likes', 'videos', 'views', 'comments', 'shares'],
  threads: ['followers', 'viewsToday', 'linkClicksToday', 'postLikes', 'postReplies', 'postReposts', 'postQuotes'],
  bluesky: ['followers', 'following', 'posts', 'likes', 'reposts', 'replies', 'quotes'],
  youtube: ['subscribers', 'viewsAllTime', 'videos', 'likesAllTime', 'commentsAllTime'],
  soundcloud: ['followers', 'following', 'tracks', 'plays', 'likes', 'reposts', 'comments', 'downloads'],
  mixcloud: ['followers', 'following', 'uploads', 'plays', 'favorites', 'reposts', 'comments', 'listeners'],
};
export const ACCOUNT_DAYS = Math.max(1, Number(process.env.ACCOUNT_CHECK_DAYS) || 90);
export function trackAccount(dataDir, network, out) {
  const keys = ACCOUNT_KEYS[network];
  if (!keys || !out.totals) return;
  const today = (out.daily || []).find((d) => d.date === day(Date.now())) || {};
  const value = (k) => out.totals[k] ?? (k.endsWith('Today') ? today[k.slice(0, -5)] : null);
  try {
    storeFor(dataDir).recordAccount(network, Object.fromEntries(keys.map((k) => [k, Number.isFinite(value(k)) ? value(k) : null])), ACCOUNT_DAYS * DAY);
  } catch (e) { out.errors.push(`account checks: ${e.message}`); }
}

// What came in between checks, for the "hour by hour" charts to show what the per-day ones do: each total's gain on
// the check before as new<Key> (newFollowers, newPlays...), and each `<key>Today` as <key> (the gain on the check
// before that UTC day, or all of it at the day's first check after one the day before). null when there's no check
// before with it (not one huge first bar), or it went
// down (a deleted post, Instagram's reach being unique accounts so far...). With a network, each check also gets
// `engagement`: its WEEKLY hourly keys added up (null when none is there).
export function accountGains(checks, network) {
  const last = {};
  const sum = WEEKLY[network]?.hourly;
  return checks.map(([t, vals]) => {
    const row = { time: t, ...vals };
    for (const [k, v] of Object.entries(vals)) {
      if (!Number.isFinite(v)) continue;
      const before = last[k];
      if (k.endsWith('Today')) {
        const gain = !before ? null : day(before[0]) === day(t) ? v - before[1] : v;
        row[k.slice(0, -5)] = gain >= 0 ? gain : null;
      } else row[`new${k[0].toUpperCase()}${k.slice(1)}`] = before && v >= before[1] ? v - before[1] : null;
      last[k] = [t, v];
    }
    if (sum) {
      const parts = sum.filter((k) => Number.isFinite(row[k]));
      row.engagement = parts.length ? parts.reduce((a, k) => a + row[k], 0) : null;
    }
    return row;
  });
}

// ---------- the Platforms charts' 7-day lines ----------
// Each network's per-day numbers are noisy on a small account, so the Platforms charts draw a 7-day average over them,
// and an engagement total and rate. Done here, not in Grafana: Infinity's JSONata (jsonata-go) can't be trusted with it.
// WEEKLY[network]: `avg` = the per-day keys to average (the reach chart's lines); `engagement` = the keys added up into
// each day's `engagement` (likes, comments, shares, saves in each network's words); `per` = what the rate divides by
// (per day, summed over the same 7 days), or `followers` (Bluesky has no views: per 100 followers, that day's count);
// `hourly` = the same engagement keys in /account.json's checks (accountGains' names), added up into each check's `engagement`.
export const WEEKLY = {
  ghost: { avg: ['visitors'], engagement: ['newMembers', 'newComments', 'linkClicks', 'livePlays'], per: 'visitors',
    hourly: ['newMembers', 'newComments', 'newLinkClicks', 'newLivePlays'] },
  instagram: { avg: ['reach', 'profileViews', 'linkTaps'], engagement: ['likes', 'comments', 'shares', 'saves'], per: 'reach',
    hourly: ['newPostLikes', 'newPostComments', 'newPostShares', 'newPostSaves'] },
  tiktok: { avg: ['views'], engagement: ['newLikes', 'comments', 'shares'], per: 'views', hourly: ['newLikes', 'newComments', 'newShares'] },
  threads: { avg: ['views', 'linkClicks'], engagement: ['likes', 'replies', 'reposts', 'quotes'], per: 'views',
    hourly: ['newPostLikes', 'newPostReplies', 'newPostReposts', 'newPostQuotes'] },
  bluesky: { avg: [], engagement: ['likes', 'reposts', 'replies', 'quotes'], per: 'followers',
    hourly: ['newLikes', 'newReposts', 'newReplies', 'newQuotes'] },
  youtube: { avg: ['views'], engagement: ['likes', 'comments', 'shares'], per: 'views', hourly: ['newLikesAllTime', 'newCommentsAllTime'] },
  soundcloud: { avg: ['newPlays'], engagement: ['newLikes', 'newReposts', 'newComments'], per: 'newPlays',
    hourly: ['newLikes', 'newReposts', 'newComments'] },
  mixcloud: { avg: ['newPlays'], engagement: ['newFavorites', 'newReposts', 'newComments'], per: 'newPlays',
    hourly: ['newFavorites', 'newReposts', 'newComments'] },
};
const WEEK_MIN_DAYS = 4; // a 7-day number needs at least this many of its days, so the line doesn't start on one day
// Adds to each day of out.daily: `engagement` (null when none of its keys is there), `<key>7` for each avg key and
// `engagement7` (the average over the 7 days ending that day, by date, so a missing day doesn't stretch the window),
// and `rate7` (% : the 7 days' engagement / the 7 days' `per`, on the days that have both; Bluesky: / that day's followers)
export function withWeekly(network, out) {
  const w = WEEKLY[network];
  if (!w || !Array.isArray(out.daily)) return;
  const days = out.daily;
  if (w.engagement) {
    for (const d of days) {
      const parts = w.engagement.filter((k) => Number.isFinite(d[k]));
      d.engagement = parts.length ? parts.reduce((a, k) => a + d[k], 0) : null;
    }
  }
  const at = days.map((d) => Date.parse(d.date));
  days.forEach((d, i) => {
    const week = days.filter((_, j) => at[j] <= at[i] && at[j] > at[i] - 7 * DAY);
    const avg = (k) => {
      const v = week.map((x) => x[k]).filter(Number.isFinite);
      return v.length >= WEEK_MIN_DAYS ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 10) / 10 : null;
    };
    for (const k of w.avg) d[`${k}7`] = avg(k);
    if (!w.engagement) return;
    d.engagement7 = avg('engagement');
    let rate = null;
    if (w.per === 'followers') {
      if (d.engagement7 != null && d.followers > 0) rate = (d.engagement7 * 7 / d.followers) * 100;
    } else {
      const both = week.filter((x) => Number.isFinite(x.engagement) && Number.isFinite(x[w.per]));
      const per = both.reduce((a, x) => a + x[w.per], 0);
      if (both.length >= WEEK_MIN_DAYS && per > 0) rate = (both.reduce((a, x) => a + x.engagement, 0) / per) * 100;
    }
    d.rate7 = rate == null ? null : Math.round(rate * 100) / 100;
  });
}

// The account numbers from before every check was kept, brought in once per network when the bridge starts: one point
// per UTC day (at its end: the day's last poll, whose time wasn't kept), from the network file's per-day record
// (`history`; Instagram's `followerHistory`; YouTube's `daily` subscribers, worked back from the count) with the
// archive's totals for that day over it (what the poll actually had), for the last ACCOUNT_CHECK_DAYS days before
// today, and only on days with no checks of their own. Returns how many days it added (null when done before).
export async function importAccountDays(dataDir, network) {
  const keys = ACCOUNT_KEYS[network];
  const store = storeFor(dataDir);
  const today = day(Date.now());
  const since = day(Date.now() - ACCOUNT_DAYS * DAY);
  const [f, a] = await Promise.all([readJson(path.join(dataDir, `${network}.json`)), readJson(archiveFile(dataDir, network))]);
  const byDate = {};
  const add = (date, vals) => {
    if (!vals || typeof vals !== 'object' || date < since || date >= today) return;
    for (const k of keys) if (Number.isFinite(vals[k])) (byDate[date] ||= {})[k] = vals[k];
  };
  for (const [date, v] of Object.entries(f.history || {})) add(date, v);
  for (const [date, n] of Object.entries(f.followerHistory || {})) add(date, { followers: n });
  if (network === 'youtube') for (const d of f.daily || []) add(d.date, { subscribers: d.subscribers });
  for (const [date, parts] of Object.entries(a.days || {})) add(date, parts?.totals);
  const checked = new Set(store.account(network, Date.parse(since)).map(([t]) => day(t)));
  const rows = Object.fromEntries(Object.entries(byDate).filter(([date]) => !checked.has(date)).map(([date, vals]) => [Date.parse(date) + DAY - 1, vals]));
  return store.importAccount(network, `account:${network}`, rows) ? Object.keys(rows).length : null;
}

// ---------- a post's first days, check by check (and again when an old one takes off) ----------
// One number per UTC day says little about a post's first hours, when the networks decide whether to show it
// around, and "day 0" is 2 hours for an evening post and 20 for a morning one. Every check is kept (stats.db's
// checks), and a post's first POST_EARLY_HOURS [96] are what "vs your usual" and the Post dashboard compare by the
// hour (stats/store.mjs keeps all of a post's checks then, not just changes): readHistory gives them as `early` ({ <ref>:
// [[<minutes since posted>, { <key>: n }], ...] }), a check every 15 minutes in the first 2 hours, every 30 to 6,
// hourly to 24, then every 3 hours (earlyStep), and the last. Ages count from the posting time itself.
// An older post can take off too (shared, picked up by the network weeks later): when its main number gains, in
// about 4 or 18 hours, at least SURGE_SHARE (5%) of what it had and SURGE_MIN (10), and 3x its usual gain over the
// week before for that time, it's a take-off (stats.db's surges: from where it was before, watched closely for
// SURGE_HOURS (72, longer while it keeps climbing, 14 days at most)): Instagram and Threads check it every time
// meanwhile (surgingRefs), the Post dashboard draws its every check, and share/ntfy.mjs sends a notice.
// trackPosts calls it; YouTube's and Ghost's per-day numbers are kept elsewhere, so their pollers call it themselves.
export const EARLY_HOURS = Math.min(14 * 24, Math.max(24, Number(process.env.POST_EARLY_HOURS) || 96));
const earlyStep = (min) => (min < 120 ? 15 : min < 360 ? 30 : min < 1440 ? 60 : 180);
const HOUR = 3_600_000;
const SURGE_HOURS = 72;
const SURGE_SHARE = 0.05;
const SURGE_MIN = 10;
// keeps a list of [time or age, ...] points thinned: the newest always, an earlier one only a step after the one kept
// before it (step(point) in the same units)
export const thin = (pts, step) => {
  const kept = [];
  pts.forEach((pt, i) => { if (!kept.length || i === pts.length - 1 || pt[0] - kept[kept.length - 1][0] >= 0.9 * step(pt)) kept.push(pt); });
  return kept;
};
// share/ntfy.mjs' notice for a post that just took off (setTakeOffNotice): ({ network, post, key, was, wasAt, now })
let takeOffNotice = null;
export const setTakeOffNotice = (fn) => { takeOffNotice = fn; };
// Keeps this check of each item (its numbers, at its `checked` time or now), then looks for older posts taking off
export async function trackEarly(dataDir, network, items, keys) {
  const now = Date.now();
  const store = storeFor(dataDir);
  const list = items.filter(Boolean).map((p) => ({ ...p, ref: p.ref || postRef(p.id) }));
  store.recordChecks(network, list, keys, now, { everyFor: EARLY_HOURS * HOUR, always: store.surging(network, now) });
  const started = [];
  const main = NETWORKS[network]?.main || NETWORKS[network.split('-')[0]]?.main || [];
  for (const p of list) {
    if (!p.ref || !p.time || now - p.time <= EARLY_HOURS * HOUR) continue;
    const key = main.find((k) => p[k] != null);
    if (!key) continue;
    const v = p[key];
    // what it had about 4 hours and 18 hours ago, and its usual gain per day over the week before that (from 8 days
    // back, or its first check if that's later but still 4 days before)
    const at = (t) => { const x = store.at(network, p.ref, t); return x && x[1][key] != null ? [t, x[1][key]] : null; };
    const day1 = at(now - 18 * HOUR);
    const first = day1 && store.first(network, p.ref);
    const week = day1 && (at(now - 8 * 24 * HOUR)
      || (first && first[1][key] != null && day1[0] - first[0] >= 4 * 24 * HOUR ? [first[0], first[1][key]] : null));
    const usual = week ? Math.max(0, day1[1] - week[1]) / ((day1[0] - week[0]) / (24 * HOUR)) : null;
    const from = [at(now - 4 * HOUR), day1].find((x) => x && v - x[1] >= SURGE_MIN && v - x[1] >= SURGE_SHARE * x[1]
      && (usual == null || v - x[1] >= 3 * usual * ((now - x[0]) / (24 * HOUR))));
    const s = store.lastSurge(network, p.ref);
    if (!from) continue;
    if (!s || s.until < now) {
      store.startSurge(network, p.ref, { start: now, until: Math.min(now + 14 * 24 * HOUR, now + SURGE_HOURS * HOUR), key, from });
      started.push({ network, post: p, key, was: from[1], wasAt: from[0], now: v, usual });
    } else store.extendSurge(network, p.ref, s.start, Math.min(s.start + 14 * 24 * HOUR, now + SURGE_HOURS * HOUR));
  }
  for (const x of started) await Promise.resolve(takeOffNotice?.(x)).catch(() => {});
}
// Words for a take-off notice: what the post is, its number's name, whether the Post dashboard can open it
export const takeOffWords = (network, key) => {
  const base = network.split('-')[0];
  const n = NETWORKS[network] || NETWORKS[base];
  const noun = network === 'soundcloud-playlists' ? 'playlist'
    : { youtube: 'video', soundcloud: 'track', mixcloud: 'mix', tiktok: 'video', ghost: 'post' }[base] || 'post';
  return { label: n?.label || network, noun, metric: (LABELS[key] || key).toLowerCase(), postDashboard: !!NETWORKS[network] };
};
// The posts taking off right now, for the pollers that check only some posts each time (toCheck's `also`)
export async function surgingRefs(dataDir, network) {
  return storeFor(dataDir).surging(network);
}
// A post's numbers at `min` minutes old from those checks: between two, the straight line between them (when
// they're close enough together to trust it), else the nearest one within a little of it, else null
export function earlyAt(pts, min) {
  if (!pts?.length) return null;
  const tol = Math.max(20, 0.15 * min);
  const near = (pt) => (pt && Math.abs(pt[0] - min) <= tol ? pt[1] : null);
  const i = pts.findIndex(([a]) => a >= min);
  if (i <= 0) return near(pts[i === 0 ? 0 : pts.length - 1]);
  const [[a0, v0], [a1, v1]] = [pts[i - 1], pts[i]];
  if (a1 - a0 > Math.max(60, 0.5 * min)) return near(min - a0 <= a1 - min ? pts[i - 1] : pts[i]);
  const f = (min - a0) / (a1 - a0);
  const out = {};
  for (const k of new Set([...Object.keys(v0), ...Object.keys(v1)])) {
    out[k] = v0[k] != null && v1[k] != null ? v0[k] + (v1[k] - v0[k]) * f : (f < 0.5 ? v0 : v1)[k] ?? null;
  }
  return out;
}
// A network's history: { posts: { ref: { date: vals } }, times, fetched } (stats.db's days), with its posts' first
// days by the hour (`early`: ref -> [[minutes since posted, vals]], its checks thinned to earlyStep's steps) and its
// take-offs (`surges`: ref -> [{ start, until, key, pts: [[ms, vals]] }], from where it was before)
export async function readHistory(dataDir, name) {
  const store = storeFor(dataDir);
  const h = store.history(name);
  const early = {};
  for (const [ref, rows] of Object.entries(store.early(name, EARLY_HOURS * HOUR))) {
    const posted = h.times[ref];
    if (!Number.isFinite(posted)) continue;
    early[ref] = thin(rows.map(([t, v]) => [Math.round((t - posted) / 60_000), v]).filter(([min]) => min >= 0), ([min]) => earlyStep(min));
  }
  const surges = {};
  for (const [ref, list] of Object.entries(store.surges(name))) {
    surges[ref] = list.map((s) => {
      const end = Math.min(s.until, h.checked[ref] ?? s.until);
      const rows = store.checks(name, ref, s.start, end).filter(([t]) => t >= s.start);
      const pts = [[s.from[0], { [s.key]: s.from[1] }], ...rows];
      if (rows.length && end > rows[rows.length - 1][0]) pts.push([end, rows[rows.length - 1][1]]);
      return { ...s, pts };
    });
  }
  return { ...h, early, surges };
}
export const hoursOld = (min) => `${Math.round(min / 60)} hours`;

// A network's posts as listed: what this poll got, plus those in the last file older than all of them when the
// listing stopped short of the account's first post (a page limit, or it failed: fresh is empty), so a post stays
// listed once seen. One missing from a full listing was deleted, and goes (its history stays).
export function withOlder(prev, fresh, complete) {
  if (complete) return fresh;
  const have = new Set(fresh.map((p) => p.ref));
  const oldest = fresh.reduce((m, p) => Math.min(m, p.time ?? Infinity), Infinity);
  return [...fresh, ...(prev || []).filter((p) => !have.has(p.ref) && (p.time ?? 0) < oldest)];
}
// Which posts get their numbers asked for this poll, where that's a call per post (Instagram, Threads): the newest
// `newest` (posts newest first), and as many older ones again, the longest unchecked first (`checked` = when a post's
// numbers were last asked for), so every post comes round and a call count stays the same however many there are;
// plus `also` (the posts taking off, surgingRefs) every time
export function toCheck(posts, prevByRef, newest, also = new Set()) {
  const older = posts.slice(newest).filter((p) => !also.has(p.ref)).sort((a, b) => (prevByRef[a.ref]?.checked || 0) - (prevByRef[b.ref]?.checked || 0));
  return new Set([...posts.slice(0, newest), ...posts.filter((p) => also.has(p.ref)), ...older.slice(0, newest)].map((p) => p.ref));
}

// How many of the newest posts toCheck should ask for (it asks as many older ones again, plus `also`), where each is
// a call (Instagram, Threads): what's left of META_CALLS_PER_HOUR [120] for one poll every `minutes` after the `used`
// calls the poll has already made (the account's numbers, the listing), at least 1 and at most `cap`
// (IG_STATS_POSTS / THREADS_STATS_POSTS). Meta allows about 200 calls an hour per account, and Postiz uses the same
// token too, so the default leaves room.
export const META_CALLS_PER_HOUR = Math.max(10, Number(process.env.META_CALLS_PER_HOUR) || 120);
export const postsPerPoll = ({ minutes, used = 0, also = 0, cap }) =>
  Math.max(1, Math.min(cap, Math.floor((META_CALLS_PER_HOUR * (minutes / 60) - used - also) / 2)));

// A post's totals per day: as kept, or (YouTube's real per-day numbers) added up from its first day
export function totalsByDate(h, perDay) {
  const dates = Object.keys(h || {}).sort();
  if (!perDay) return Object.fromEntries(dates.map((d) => [d, h[d]]));
  const sum = {};
  return Object.fromEntries(dates.map((d) => {
    for (const [k, v] of Object.entries(h[d])) sum[k] = (sum[k] || 0) + (v || 0);
    return [d, { ...sum }];
  }));
}
export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// The site's pages a post links to: full addresses, the bridge's short links (/b/, /t/, /i/, /k/, /d/, /y/<path>)
// and the bio links (the home page), as paths like Ghost's analytics keep them ("/<slug>/")
// (the site's names: SITE_HOSTS in config.mjs, www. dropped)
let siteHosts = [...new Set(SITE_HOSTS.map((h) => h.replace(/^www\./, '')))];
// more names, if a caller has any
export const addSiteHosts = (hosts) => { siteHosts = [...new Set([...siteHosts, ...hosts])].filter(Boolean); };
const BIO_LINKS = ['/bsky', '/ig', '/th', '/tk', '/threads', '/tiktok', '/dis', '/yt', '/d', '/y'];
export function sitePath(raw) {
  let p = String(raw || '/').split(/[?#]/)[0].replace(/[.,;:!]+$/, '');
  const short = /^\/[btikdy]\/([\w-].*?)\/*$/.exec(p);
  if (short) p = `/${short[1]}/`;
  else if (BIO_LINKS.includes(p.replace(/\/+$/, ''))) p = '/';
  else p = p.replace(/\/*$/, '/');
  return /^\/(ghost|content|social-preview|members|\.)/.test(p) || !/^\/[\w\-./~%@]*$/.test(p) ? '' : p;
}
export function siteLinks(texts) {
  const found = [];
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s"'<>()[\]]*)?/gi)) {
      if (!siteHosts.includes(m[1].toLowerCase().replace(/^www\./, ''))) continue;
      const p = sitePath(m[2]);
      if (p && !found.includes(p)) found.push(p);
    }
  }
  return found.slice(0, 5);
}
