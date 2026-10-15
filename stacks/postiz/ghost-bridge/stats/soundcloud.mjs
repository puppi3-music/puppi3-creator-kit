// stats/soundcloud.mjs: SoundCloud's numbers for Grafana (soundcloud.json), with the bridge's own SoundCloud app,
// since Postiz has no SoundCloud.

import fs from 'node:fs/promises';
import path from 'node:path';
import { env, STATE_FILE, log, networkOn } from '../config.mjs';
import { postRef, siteLinks, withOlder, trackPosts, historyKeys, trackAccount, withWeekly, withPostedMs, everyText,
  archive } from './history.mjs';
import { withPerformance } from './performance.mjs';

// ---------- SoundCloud numbers -> Grafana ----------
// Postiz has no SoundCloud channel, so the bridge asks SoundCloud's API itself with its own app
// (SOUNDCLOUD_CLIENT_ID/SECRET, registered at soundcloud.com/you/apps; client credentials, so public data only)
// for the account SOUNDCLOUD_USER (profile address or name). Every SC_STATS_MINUTES it writes soundcloud.json,
// served at GET /soundcloud.json for Grafana's Social dashboard:
//  - account: followers, following, tracks and playlists now; totals: plays, likes, reposts and comments summed
//    over all public tracks
//  - daily: SoundCloud's API has no numbers per day, so each poll keeps that day's totals in history (carried over
//    from the last soundcloud.json, last poll of each UTC day, SC_STATS_DAYS kept) and the change from the day
//    before (only when that day was recorded; none when it went down, e.g. a track deleted)
//  - tracks: every public track and its plays, likes, reposts and comments; playlists: every public playlist (and
//    album) and its likes and reposts (playlists' numbers over time in stats.db as soundcloud-playlists)
// SoundCloud allows an app 50 sign-ins per 12 hours, so the access token is reused until it runs out, then renewed.
// (off too when NETWORKS leaves soundcloud out)
export const SC_STATS = (env.SC_STATS || 'true') === 'true' && networkOn('soundcloud');
const SC_STATS_MINUTES = Math.max(10, Number(env.SC_STATS_MINUTES) || 60);
const SC_STATS_DAYS = Math.min(1000, Math.max(30, Number(env.SC_STATS_DAYS) || 400));
const SC_PAGES = 50; // of 200 tracks
export const SC_STATS_FILE = path.join(path.dirname(STATE_FILE), 'soundcloud.json');
const SC_CLIENT = { id: env.SOUNDCLOUD_CLIENT_ID || '', secret: env.SOUNDCLOUD_CLIENT_SECRET || '' };
const SC_USER = (env.SOUNDCLOUD_USER || '').trim();
const SC_API = 'https://api.soundcloud.com';
let scAccess = { token: '', until: 0, refresh: '' };

async function scSignIn(body) {
  const res = await fetch('https://secure.soundcloud.com/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${SC_CLIENT.id}:${SC_CLIENT.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`SoundCloud sign-in: ${e.cause?.code || e.message}`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const hint = res.status === 429 ? ' (too many sign-ins: SoundCloud allows 50 per 12 hours per app)'
      : data.error === 'invalid_client' ? ' (check SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET)' : '';
    throw new Error(`SoundCloud sign-in: ${data.error_description || data.error || res.status}${hint}`);
  }
  scAccess = { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 120_000,
    refresh: data.refresh_token || '' };
  return scAccess.token;
}

async function scToken() {
  if (scAccess.token && Date.now() < scAccess.until) return scAccess.token;
  if (scAccess.refresh) {
    try { return await scSignIn({ grant_type: 'refresh_token', refresh_token: scAccess.refresh }); } catch { /* sign in afresh */ }
  }
  return scSignIn({ grant_type: 'client_credentials' });
}

async function scApi(pathOrUrl, retried = false) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${SC_API}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `OAuth ${await scToken()}`, Accept: 'application/json; charset=utf-8' },
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`SoundCloud: ${e.cause?.code || e.message}`); });
  if (res.status === 401 && !retried) { scAccess = { token: '', until: 0, refresh: '' }; return scApi(pathOrUrl, true); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 404 && url.includes('/resolve') ? ' (is SOUNDCLOUD_USER the profile address?)' : '';
    throw new Error(`SoundCloud ${new URL(url).pathname.replace(/\d{3,}/, '<id>')}: ${data.error || data.message || res.status}${hint}`);
  }
  return data;
}

// SoundCloud's dates look like "2024/05/01 18:30:00 +0000"
function scTime(s) {
  const m = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/.exec(String(s || ''));
  return (m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}${m[5]}:${m[6]}`) : Date.parse(s)) || null;
}

// One poll now: startSoundCloudStats runs it on its timer; the tests call it
export async function pollSoundCloudStats() {
  const out = { updatedAt: new Date().toISOString(), account: null, totals: {}, daily: [], tracks: [], tracksPerDay: [], playlists: [], errors: [] };
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(SC_STATS_FILE, 'utf8')); } catch {}
  const kept = { days: {}, posts: [] }; // for the archive
  try {
    if (!SC_CLIENT.id || !SC_CLIENT.secret) throw new Error('needs SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET (an app registered at soundcloud.com/you/apps)');
    if (!SC_USER) throw new Error('needs SOUNDCLOUD_USER (the profile address, e.g. https://soundcloud.com/<name>)');
    const profile = /^https?:\/\//.test(SC_USER) ? SC_USER : `https://soundcloud.com/${SC_USER.replace(/^@/, '')}`;
    const u = await scApi(`/resolve?url=${encodeURIComponent(profile)}`);
    if (u.kind && u.kind !== 'user') throw new Error(`SOUNDCLOUD_USER is a ${u.kind}, not a profile`);
    const uid = u.urn || u.id;
    out.account = { id: uid, name: u.full_name || u.username || '', username: u.username || '', picture: u.avatar_url || '',
      url: u.permalink_url || profile };
    for (const [k, f] of [['followers', 'followers_count'], ['following', 'followings_count'], ['tracks', 'track_count'],
      ['playlists', 'playlist_count'], ['likesGiven', 'public_favorites_count'], ['repostsGiven', 'reposts_count'],
      ['commentsGiven', 'comments_count']]) if (u[f] != null) out.totals[k] = Number(u[f]);
    kept.account = u;

    try {
      const all = [];
      let next = `/users/${uid}/tracks?limit=200&linked_partitioning=true`;
      for (let page = 0; next && page < SC_PAGES; page++) {
        const r = await scApi(next);
        all.push(...(Array.isArray(r) ? r : r.collection || []));
        next = Array.isArray(r) ? '' : r.next_href || '';
      }
      const n = (x) => (x == null ? null : Number(x));
      const tracks = all.map((t) => ({
        id: t.urn || t.id, ref: postRef(t.urn || t.id), links: siteLinks([t.description]), date: t.created_at, time: scTime(t.created_at), network: 'SoundCloud', account: out.account.name,
        type: t.kind === 'track' || !t.kind ? 'Track' : t.kind, title: String(t.title || '').slice(0, 140),
        duration: t.duration ? Math.round(t.duration / 1000) : null, thumbnail: t.artwork_url || '', permalink: t.permalink_url || '',
        plays: n(t.playback_count), likes: n(t.favoritings_count ?? t.likes_count), reposts: n(t.reposts_count),
        comments: n(t.comment_count), downloads: n(t.download_count),
      })).sort((a, b) => (b.time || 0) - (a.time || 0));
      for (const k of ['plays', 'likes', 'reposts', 'comments', 'downloads']) out.totals[k] = tracks.reduce((a, t) => a + (t[k] || 0), 0);
      kept.posts.push(...all.map((t) => ({ ref: postRef(t.urn || t.id), data: t })));
      out.tracks = withOlder(prev.tracks, tracks, !next);
      await trackPosts(path.dirname(STATE_FILE), 'soundcloud', tracks, historyKeys('soundcloud'))
        .catch((e) => out.errors.push(`history: ${e.message}`));
      const perDay = {};
      for (const t of tracks) if (t.time) { const d = new Date(t.time).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
      out.tracksPerDay = Object.entries(perDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, tracks]) => ({ date, tracks }));
    } catch (e) { out.errors.push(`tracks: ${e.message}`); Object.assign(out, { tracks: prev.tracks || [], tracksPerDay: prev.tracksPerDay || [] }); }

    try {
      const all = [];
      let next = `/users/${uid}/playlists?limit=200&linked_partitioning=true&show_tracks=false`;
      for (let page = 0; next && page < SC_PAGES; page++) {
        const r = await scApi(next);
        all.push(...(Array.isArray(r) ? r : r.collection || []));
        next = Array.isArray(r) ? '' : r.next_href || '';
      }
      const n = (x) => (x == null ? null : Number(x));
      const playlists = all.map((pl) => ({
        id: pl.urn || pl.id, ref: postRef(pl.urn || pl.id), date: pl.created_at, time: scTime(pl.created_at), network: 'SoundCloud', account: out.account.name,
        type: pl.playlist_type || (pl.is_album ? 'Album' : 'Playlist'), title: String(pl.title || '').slice(0, 140),
        duration: pl.duration ? Math.round(pl.duration / 1000) : null, permalink: pl.permalink_url || '', tracks: n(pl.track_count),
        likes: n(pl.likes_count ?? pl.favoritings_count), reposts: n(pl.reposts_count),
      })).sort((a, b) => (b.time || 0) - (a.time || 0));
      out.playlists = withOlder(prev.playlists, playlists, !next);
      kept.posts.push(...all.map((pl) => ({ ref: postRef(pl.urn || pl.id), data: pl })));
      await trackPosts(path.dirname(STATE_FILE), 'soundcloud-playlists', playlists, ['likes', 'reposts', 'tracks'])
        .catch((e) => out.errors.push(`playlists history: ${e.message}`));
    } catch (e) { out.errors.push(`playlists: ${e.message}`); out.playlists = prev.playlists || []; }
  } catch (e) { out.errors.push(e.message); }

  // Totals per day, kept from poll to poll (the API only gives today's)
  const history = { ...prev.history };
  if (out.totals.followers != null && out.totals.plays != null) {
    const { followers, plays, likes, reposts, comments } = out.totals;
    history[new Date().toISOString().slice(0, 10)] = { followers, plays, likes, reposts, comments };
  }
  const keep = Object.keys(history).sort().slice(-SC_STATS_DAYS);
  out.history = Object.fromEntries(keep.map((d) => [d, history[d]]));
  out.daily = keep.map((date) => {
    const now = history[date];
    const before = history[new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10)];
    const gain = (k) => (before && now[k] != null && before[k] != null && now[k] >= before[k] ? now[k] - before[k] : null);
    return { date, ...now, newFollowers: gain('followers'), newPlays: gain('plays'), newLikes: gain('likes'),
      newReposts: gain('reposts'), newComments: gain('comments') };
  });
  // the last 30 days' gains, for the stat row
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const k of ['newFollowers', 'newPlays', 'newLikes']) {
    const days = out.daily.filter((d) => d.date > since && d[k] != null);
    out.totals[`${k}30`] = days.length ? days.reduce((a, d) => a + d[k], 0) : null;
  }

  withWeekly('soundcloud', out);
  trackAccount(path.dirname(STATE_FILE), 'soundcloud', out);
  await withPerformance(path.dirname(STATE_FILE), 'soundcloud', out);
  out.checkedEvery = everyText(SC_STATS_MINUTES);
  await fs.writeFile(`${SC_STATS_FILE}.tmp`, JSON.stringify(withPostedMs(out), null, 2));
  await fs.rename(`${SC_STATS_FILE}.tmp`, SC_STATS_FILE);
  if (Object.values(out.totals).some((v) => v != null)) kept.days[new Date().toISOString().slice(0, 10)] = { totals: out.totals };
  await archive(path.dirname(STATE_FILE), 'soundcloud', kept).catch((e) => out.errors.push(`archive: ${e.message}`));
  if (out.errors.length) log(`SoundCloud stats: ${out.errors.join('; ')}`);
}

export function startSoundCloudStats() {
  if (!SC_STATS) return;
  let polling = false;
  const tick = () => {
    if (polling) return;
    polling = true;
    pollSoundCloudStats().catch((e) => log(`SoundCloud stats: ${e.message}`)).finally(() => { polling = false; });
  };
  setTimeout(tick, 30_000);
  setInterval(tick, SC_STATS_MINUTES * 60_000);
}
