// stats/live.mjs: what visitors do on the site: live shows (TinyIce), links followed off the site and LIVE NOW bar
// plays (POST /.puppy/click), and petted puppies (POST /.puppy/pets).

import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DAY, fetchJson, writeJson, writeJsonSync, perDay, day } from './history.mjs';
import { STATE_FILE, log, SITE_HOSTS, LIVE_HOSTS, METRIC_PREFIX } from '../config.mjs';

// ---------- live shows ----------
// Every live show, from TinyIce's status every 30 s (live.json).
export function liveShows({ env, log, file, files, enabled }) {
  // ---------- live shows ----------
  // TinyIce's status every 30 s (LIVE_STATUS_URL, the JSON the LIVE NOW bar reads). A show runs while the mount
  // the streaming software sends to (LIVE_MOUNT) is listed; a gap under LIVE_GAP_MINUTES (it reconnecting) doesn't end it.
  // Listeners = all mounts' listeners together (the mp3 transcode is where most listen). Shows shorter than
  // LIVE_MIN_MINUTES (a test connection) aren't kept. The show in progress is saved too, so a restart carries on.
  // LIVE_RELAYS (the kit on Kubernetes: a name whose addresses are the relays, k8s/components/live/): listeners on
  // the relays are counted instead of the relays themselves, which TinyIce sees as one listener each. Unset = as before.
  const LIVE = enabled(env.LIVE_STATS);
  const LIVE_URL = env.LIVE_STATUS_URL || 'http://tinyice:8080/status-json.xsl';
  const LIVE_MOUNT = env.LIVE_MOUNT || '/stream-ogg';
  const LIVE_RELAYS = (env.LIVE_RELAYS || '').trim();
  const LIVE_EVERY = 30_000;
  const LIVE_GAP = Math.max(1, Number(env.LIVE_GAP_MINUTES) || 5) * 60_000;
  const LIVE_MIN = Math.max(0, Number(env.LIVE_MIN_MINUTES ?? 3)) * 60_000;
  const LIVE_FILE = file('live');
  let live = { shows: [], current: null, status: 'unknown', listenersNow: null, error: '' };
  try {
    const last = JSON.parse(readFileSync(LIVE_FILE, 'utf8'));
    live.shows = Array.isArray(last.shows) ? [...last.shows].reverse() : [];
    live.current = last.inProgress || null;
  } catch {}
  files['/live.json'] = { file: LIVE_FILE, on: LIVE };

  const trackOf = (s) => [s.artist, s.title].map((p) => String(p ?? '').trim()).filter((p) => p && p !== 'N/A' && p !== '-').join(' – ');
  const showSummary = (s, open = false) => {
    const seconds = Math.max(1, (s.lastSeen - s.start) / 1000);
    const clock = (t) => { const m = Math.round((t - s.start) / 60_000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
    return {
      start: s.start, end: open ? null : s.lastSeen, date: new Date(s.start).toISOString(), minutes: Math.round(seconds / 60),
      peakListeners: s.peak, avgListeners: Math.round((10 * s.listenerSeconds) / seconds) / 10,
      listenerHours: Math.round((10 * s.listenerSeconds) / 3600) / 10, plays: s.plays || 0,
      stalls: s.stalls || 0, reconnects: s.reconnects || 0, tracks: s.tracks.length,
      firstTrack: s.tracks[0]?.track || '', setlist: s.tracks.map((t) => `${clock(t.time)} ${t.track}`).join(' · '),
    };
  };
  const endShow = () => {
    const s = live.current;
    live.current = null;
    if (s && s.lastSeen - s.start >= LIVE_MIN) {
      live.shows.push(showSummary(s));
      live.shows = live.shows.slice(-1000);
      log(`live show ended: ${Math.round((s.lastSeen - s.start) / 60_000)} min, peak ${s.peak} listeners`);
    }
  };
  // live.json: shows newest first; inProgress is the show going on, as recorded (a restart carries on from it)
  const liveDoc = () => {
    const since = Date.now() - 30 * DAY;
    const recent = live.shows.filter((s) => s.start >= since);
    return {
      updatedAt: new Date().toISOString(), status: live.status, listenersNow: live.listenersNow, mount: LIVE_MOUNT,
      current: live.current ? showSummary(live.current, true) : null, shows: [...live.shows].reverse(),
      showsPerDay: perDay(live.shows.map((s) => ({ time: s.start }))).map(({ date, posts }) => ({ date, shows: posts })),
      totals: { shows: live.shows.length, hours: Math.round(live.shows.reduce((a, s) => a + s.minutes, 0) / 6) / 10,
        shows30: recent.length, hours30: Math.round(recent.reduce((a, s) => a + s.minutes, 0) / 6) / 10,
        listenerHours30: Math.round(10 * recent.reduce((a, s) => a + s.listenerHours, 0)) / 10,
        peak30: recent.length ? Math.max(...recent.map((s) => s.peakListeners)) : null },
      errors: live.error ? [live.error] : [],
      inProgress: live.current,
    };
  };
  const writeLive = () => writeJson(LIVE_FILE, liveDoc());
  // The relays' listeners, and how many relays there are (each is a listener on the main TinyIce); null when the
  // name doesn't resolve. A relay that doesn't answer counts as neither.
  const listenersOf = (sources) => sources.reduce((a, s) => a + (Number(s.listeners) || 0), 0);
  async function relayListeners() {
    const port = new URL(LIVE_URL).port || '8080';
    const addrs = await lookup(LIVE_RELAYS, { all: true }).catch(() => []);
    if (!addrs.length) return null;
    const each = await Promise.all(addrs.map(async ({ address, family }) => {
      const host = family === 6 ? `[${address}]` : address;
      try {
        const { res, data } = await fetchJson(`http://${host}:${port}/status-json.xsl`, { cache: 'no-store' }, 'relay');
        if (!res.ok) return null;
        const src = [data?.icestats?.source || []].flat().filter(Boolean);
        return listenersOf(src);
      } catch { return null; }
    }));
    const up = each.filter((n) => n !== null);
    return { relays: up.length, listeners: up.reduce((a, n) => a + n, 0) };
  }
  async function pollLive() {
    const now = Date.now();
    let sources = null;
    try {
      const { res, data } = await fetchJson(LIVE_URL, { cache: 'no-store' }, 'TinyIce');
      if (!res.ok) throw new Error(`TinyIce: ${res.status}`);
      sources = data?.icestats?.source || [];
      if (!Array.isArray(sources)) sources = [sources]; // Icecast sends one source as an object
      sources = sources.filter(Boolean);
      live.error = '';
    } catch (e) {
      if (live.error !== e.message) log(`live shows: ${e.message}`);
      live.error = e.message;
      live.status = 'unknown';
      live.listenersNow = null;
    }
    if (sources) {
      const mountOf = (s) => s.mount || (String(s.listenurl || '').match(/\/[^/]+$/) || [''])[0];
      const on = sources.find((s) => mountOf(s) === LIVE_MOUNT);
      live.status = on ? 'live' : 'off';
      let listeners = listenersOf(sources);
      const relayed = LIVE_RELAYS ? await relayListeners() : null;
      if (relayed) listeners = Math.max(0, listeners - relayed.relays) + relayed.listeners;
      live.listenersNow = listeners;
      if (on) {
        if (live.current && now - live.current.lastSeen > LIVE_GAP) endShow();
        if (!live.current) {
          live.current = { start: now, lastSeen: now, peak: 0, listenerSeconds: 0, plays: 0, stalls: 0, reconnects: 0, tracks: [] };
          log('live show started');
        }
        const s = live.current;
        s.listenerSeconds += (listeners * Math.min(now - s.lastSeen, 2 * LIVE_EVERY)) / 1000;
        s.lastSeen = now;
        s.peak = Math.max(s.peak, listeners);
        let track = trackOf(on);
        for (const other of sources) if (!track) track = trackOf(other);
        if (track && track !== s.tracks[s.tracks.length - 1]?.track && s.tracks.length < 200) s.tracks.push({ time: now, track });
      } else if (live.current && now - live.current.lastSeen > LIVE_GAP) endShow();
    } else if (live.current && now - live.current.lastSeen > 6 * 3_600_000) endShow(); // status gone for hours
    await writeLive();
  }
  if (LIVE) {
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      pollLive().catch((e) => log(`live shows: ${e.message}`)).finally(() => { busy = false; });
    };
    setTimeout(tick, 5_000);
    setInterval(tick, LIVE_EVERY);
  }
  return {
    live,
    save: () => { if (LIVE) try { writeJsonSync(LIVE_FILE, liveDoc()); } catch {} },
  };
}

// ---------- link clicks ----------
// Links followed from the site to other sites, LIVE NOW bar plays and its listeners' hiccups (the theme's beacons,
// POST /.puppy/click), in clicks.json and as counters at /metrics.
// Links people follow off the site, by service (anything else is "Other")
const SERVICES = [
  [/(^|\.)music\.youtube\.com$/, 'YouTube Music'], [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'],
  [/(^|\.)soundcloud\.com$/, 'SoundCloud'], [/(^|\.)mixcloud\.com$/, 'Mixcloud'], [/(^|\.)bandcamp\.com$/, 'Bandcamp'],
  [/(^|\.)spotify\.com$/, 'Spotify'], [/^music\.apple\.com$/, 'Apple Music'], [/(^|\.)beatport\.com$/, 'Beatport'],
  [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/^bsky\.app$/, 'Bluesky'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'], [/(^|\.)discord\.(gg|com)$/, 'Discord'], [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'], [/^podcasts\.apple\.com$/, 'Apple Podcasts'], [/(^|\.)patreon\.com$/, 'Patreon'],
  [/(^|\.)ko-fi\.com$/, 'Ko-fi'], [/(^|\.)substack\.com$/, 'Substack'], [/(^|\.)etsy\.com$/, 'Etsy'], [/(^|\.)behance\.net$/, 'Behance'],
  [/^ra\.co$/, 'Resident Advisor'], [{ test: (host) => LIVE_HOSTS.includes(host) }, 'Live stream'], // LIVE_HOSTS (config.mjs)
];
const serviceOf = (host) => SERVICES.find(([re]) => re.test(host))?.[1] || 'Other';
// LIVE NOW bar hiccups (kind=stall / reconnect): the reasons the theme sends (live-bar.js, hiccup()), the rest of a
// hiccup's labels, and its key in totals.hiccups (kind, why, tab, device, browser, tab-separated)
const HICCUPS = { stall: ['buffering', 'trickle'], reconnect: ['dropped', 'stuck', 'slowstart', 'behind'] };
const DEVICES = ['mobile', 'computer'];
const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'other'];

export function siteClicks({ env, log, file, files, enabled, live }) {
  // ---------- clicks off the site, LIVE NOW bar plays ----------
  // The theme sends POST /.puppy/click?kind=out&to=<link>&from=<page path> when a visitor follows a link to another
  // site, and kind=play&from=<page path> when they press play on the LIVE NOW bar (not when it reconnects). Counted
  // per UTC day by page, service and link (no visitor data kept), CLICK_DAYS (400) kept; each row has its day's
  // start and end (time, end), so Grafana can pick the days that overlap its time range. kind=stall / reconnect
  // (&why=&hidden=0|1&device=&browser=, HICCUPS) are the bar's listeners' hiccups: only all-time totals by those labels
  // (Prometheus has the when) and per show (live.json). Anyone can call it, so each visitor (X-Real-Ip) is capped and
  // so is the number of different links a day.
  const CLICKS = enabled(env.CLICK_STATS);
  const CLICKS_FILE = file('clicks');
  const CLICK_DAYS = Math.max(30, Number(env.CLICK_DAYS) || 400);
  const CLICKS_PER_VISITOR = 60; // per CLICK_WINDOW
  const CLICK_WINDOW = 10 * 60_000;
  const CLICK_KEYS_PER_DAY = 3000;
  let clicks = { since: new Date().toISOString(), updated: null, totals: { out: {}, play: 0, hiccups: {} }, days: {} };
  try { // carried on from the last clicks.json
    const last = JSON.parse(readFileSync(CLICKS_FILE, 'utf8'));
    clicks = { since: last.since || clicks.since, updated: last.updatedAt || null, days: {},
      totals: { out: { ...last.totals?.out }, play: Number(last.totals?.play) || 0, hiccups: { ...last.totals?.hiccups } } };
    for (const r of last.clicks || []) (clicks.days[r.date] ||= { out: {}, play: {} }).out[`${r.from}\t${r.service}\t${r.target}`] = r.clicks;
    for (const r of last.plays || []) (clicks.days[r.date] ||= { out: {}, play: {} }).play[r.from] = r.plays;
  } catch {}
  let clicksDirty = false;
  const clicksBy = new Map();
  const clickWindow = setInterval(() => clicksBy.clear(), CLICK_WINDOW);
  clickWindow.unref();
  files['/clicks.json'] = { file: CLICKS_FILE, on: CLICKS };

  // the page a click came from: a site path, without its query or #
  const pagePath = (p) => {
    const s = String(p || '').split(/[?#]/)[0].slice(0, 200);
    return /^\/[\w\-./~%@]*$/.test(s) ? s : '';
  };
  function saveClicks() {
    if (!clicksDirty) return;
    clicksDirty = false;
    try {
      const rows = [];
      const plays = [];
      const perDayRows = [];
      for (const [date, d] of Object.entries(clicks.days).sort(([a], [b]) => a.localeCompare(b))) {
        const time = Date.parse(date);
        let out = 0;
        for (const [key, n] of Object.entries(d.out || {})) {
          const [from, service, target] = key.split('\t');
          rows.push({ date, time, end: time + DAY, from, service, target, clicks: n });
          out += n;
        }
        let play = 0;
        for (const [from, n] of Object.entries(d.play || {})) { plays.push({ date, time, end: time + DAY, from, plays: n }); play += n; }
        perDayRows.push({ date, clicks: out, plays: play });
      }
      writeJsonSync(CLICKS_FILE, { updatedAt: clicks.updated, since: clicks.since, totals: clicks.totals, perDay: perDayRows, clicks: rows, plays, errors: [] });
    } catch (e) { clicksDirty = true; log(`clicks: ${e.message}`); }
  }
  if (CLICKS) setInterval(saveClicks, 5_000).unref();

  function countClick(req, res) {
    req.resume();
    const q = new URL(req.url, 'http://x').searchParams;
    const kind = q.get('kind');
    const from = pagePath(q.get('from'));
    if (!CLICKS) return res.writeHead(404).end();
    if (!from || !['out', 'play', ...Object.keys(HICCUPS)].includes(kind)) return res.writeHead(400).end();
    const who = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
    const n = clicksBy.get(who) || 0;
    if (n >= CLICKS_PER_VISITOR) return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    if (HICCUPS[kind]) {
      const why = q.get('why'), device = q.get('device'), browser = q.get('browser');
      if (!HICCUPS[kind].includes(why) || !DEVICES.includes(device) || !BROWSERS.includes(browser)) return res.writeHead(400).end();
      const key = [kind, why, q.get('hidden') === '1' ? 'hidden' : 'shown', device, browser].join('\t');
      clicks.totals.hiccups[key] = (clicks.totals.hiccups[key] || 0) + 1;
      if (live.current) live.current[`${kind}s`] = (live.current[`${kind}s`] || 0) + 1;
      clicksBy.set(who, n + 1);
      clicks.updated = new Date().toISOString();
      clicksDirty = true;
      return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    }
    const date = day(Date.now());
    const d = (clicks.days[date] ||= { out: {}, play: {} });
    if (kind === 'out') {
      let u;
      try { u = new URL(q.get('to')); } catch { return res.writeHead(400).end(); }
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9.-]{1,100}$/.test(host) || SITE_HOSTS.includes(host) || SITE_HOSTS.includes(`www.${host}`)) {
        return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      }
      const service = serviceOf(host);
      const target = `${host}${u.pathname.replace(/\/+$/, '')}`.slice(0, 200).replace(/[\t\n]/g, ' ');
      const key = `${from}\t${service}\t${target}`;
      if (!(key in d.out) && Object.keys(d.out).length >= CLICK_KEYS_PER_DAY) return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      d.out[key] = (d.out[key] || 0) + 1;
      clicks.totals.out[service] = (clicks.totals.out[service] || 0) + 1;
    } else {
      if (!(from in d.play) && Object.keys(d.play).length >= CLICK_KEYS_PER_DAY) return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      d.play[from] = (d.play[from] || 0) + 1;
      clicks.totals.play += 1;
      if (live.current) live.current.plays = (live.current.plays || 0) + 1;
    }
    clicksBy.set(who, n + 1);
    const keep = Object.keys(clicks.days).sort().slice(-CLICK_DAYS);
    if (keep.length < Object.keys(clicks.days).length) clicks.days = Object.fromEntries(keep.map((k) => [k, clicks.days[k]]));
    clicks.updated = new Date().toISOString();
    clicksDirty = true;
    res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
  }
  if (CLICKS) { clicksDirty = true; saveClicks(); } // so clicks.json exists before the first click
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // <prefix>_live_stalls_total / <prefix>_live_reconnects_total{why, tab, device, browser} (METRIC_PREFIX: puppi3); HELP/TYPE even with none yet
  const hiccupMetrics = () => Object.keys(HICCUPS).map((kind) =>
    `# HELP ${METRIC_PREFIX}_live_${kind}s_total LIVE NOW bar listeners' ${kind}s, by why, tab (shown/hidden), device and browser, all time.\n` +
    `# TYPE ${METRIC_PREFIX}_live_${kind}s_total counter\n` +
    Object.entries(clicks.totals.hiccups).filter(([k]) => k.startsWith(`${kind}\t`)).map(([k, n]) => {
      const [, why, tab, device, browser] = k.split('\t');
      return `${METRIC_PREFIX}_live_${kind}s_total{why="${why}",tab="${tab}",device="${device}",browser="${browser}"} ${n}\n`;
    }).join('')).join('');
  const metrics = () => (CLICKS
      ? `# HELP ${METRIC_PREFIX}_link_clicks_total Links followed from the site to other sites, by service, all time.\n` +
        `# TYPE ${METRIC_PREFIX}_link_clicks_total counter\n` +
        Object.entries(clicks.totals.out).map(([s, n]) => `${METRIC_PREFIX}_link_clicks_total{service="${esc(s)}"} ${n}\n`).join('') +
        `# HELP ${METRIC_PREFIX}_live_plays_total Plays pressed on the LIVE NOW bar, all time.\n` +
        `# TYPE ${METRIC_PREFIX}_live_plays_total counter\n` +
        `${METRIC_PREFIX}_live_plays_total ${clicks.totals.play}\n` + hiccupMetrics()
      : '');
  return { countClick, save: saveClicks, metrics };
}

// ---------- puppy pets ----------
// The theme's petted puppies, counted (POST /.puppy/pets) and kept in pets.json.
// The theme's puppies (puppies.js, "Pet the puppies") send their pets in batches: POST /.puppy/pets?n=<pets>, from
// the site via Traefik (traefik/dynamic/puppi3.yml), when PETS is on. One running total, in pets.json, served at GET /pets.json
// (Docker networks only, like /instagram.json) for Grafana, and at GET /metrics as <prefix>_puppy_pets_total, which
// Prometheus scrapes (nas-infra's monitoring stack) so Grafana can show pets per day. Anyone can call it, so each batch is capped and so is
// each visitor (X-Real-Ip, from real-ip.yml): stroking flat out makes about 10 pets a second.
const PETS_FILE = path.join(path.dirname(STATE_FILE), 'pets.json');
const PETS_PER_POST = 200;
const PETS_PER_VISITOR = 2000; // per PETS_WINDOW
const PETS_WINDOW = 10 * 60_000;
export let pets = { total: 0, since: new Date().toISOString(), updated: null };
try { pets = { ...pets, ...JSON.parse(readFileSync(PETS_FILE, 'utf8')) }; } catch {}
let petsDirty = false;
const petsBy = new Map(); // visitor -> pets this window

// Written every few seconds when it changed, and when stopping, so a restart loses nothing
export function savePets() {
  if (!petsDirty) return;
  petsDirty = false;
  try {
    writeFileSync(`${PETS_FILE}.tmp`, JSON.stringify(pets, null, 2));
    renameSync(`${PETS_FILE}.tmp`, PETS_FILE);
  } catch (e) { petsDirty = true; log(`pets: ${e.message}`); }
}

export function countPets(req, res) {
  const n = Math.floor(Number(new URL(req.url, 'http://x').searchParams.get('n')));
  if (!(n >= 1)) return res.writeHead(400).end();
  const who = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
  const room = PETS_PER_VISITOR - (petsBy.get(who) || 0);
  const add = Math.min(n, PETS_PER_POST, Math.max(room, 0));
  if (add > 0) {
    petsBy.set(who, PETS_PER_VISITOR - room + add);
    pets.total += add;
    pets.updated = new Date().toISOString();
    petsDirty = true;
  }
  req.resume();
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}

export function startPets() {
  setInterval(() => petsBy.clear(), PETS_WINDOW).unref();
  setInterval(savePets, 5_000).unref();
}
