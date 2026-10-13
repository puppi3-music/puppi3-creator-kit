// share/weekly.mjs: the weekly summary on the phone. Once a week (WEEKLY_SUMMARY_AT in the site's time zone) an ntfy
// notification says how the week before went, without opening Grafana: the site's visitors and new members, followers
// gained on each network, the best posts, the most-read pages and the live shows. Read only: everything comes from what
// the bridge already collects (the numbers files, stats.db, Ghost's analytics), so it runs in DRY_RUN too.

import path from 'node:path';
import { env, log, isDry, DRY_RUN, NTFY_URL, SITE_TIMEZONE, STATE_FILE, GRAFANA_URL, ID_PREFIX, SITE_NAME } from '../config.mjs';
import { notify } from './ntfy.mjs';
import { DAY, readJson, writeJson, storeFor, tbPipe, text, ACCOUNT_KEYS, NETWORKS } from '../stats/history.mjs';
import { performanceDoc } from '../stats/performance.mjs';

export const WEEKLY_SUMMARY = (env.WEEKLY_SUMMARY || 'true') === 'true';
const DATA_DIR = path.dirname(STATE_FILE);
const WEEKLY_FILE = path.join(DATA_DIR, 'weekly.json');
const CHECK_MS = 15 * 60_000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// WEEKLY_SUMMARY_AT: "<weekday> HH:MM" [Mon 09:00], in SITE_TIMEZONE; a bad value falls back to it
export function parseAt(raw) {
  const m = /^\s*(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d{1,2}):(\d\d)\s*$/i.exec(String(raw || ''));
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return { dow: 1, hour: 9, minute: 0 };
  return { dow: DAYS.findIndex((d) => d.toLowerCase() === m[1].slice(0, 3).toLowerCase()), hour: Number(m[2]), minute: Number(m[3]) };
}
const AT = parseAt(env.WEEKLY_SUMMARY_AT || 'Mon 09:00');

// A date (YYYY-MM-DD) and wall-clock time in `tz` as ms (like zoneHour in stats/history.mjs)
function zoned(date, hour, minute, tz) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const wall = Date.parse(`${new Date(guess).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')}Z`);
  return guess - (wall - guess);
}
const localDate = (t, tz = SITE_TIMEZONE) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// The latest send time at or before now: { due (local date it's due on), at (ms) }. The week it covers is the 7 local
// days before `due`.
export function lastDue(now = Date.now(), at = AT, tz = SITE_TIMEZONE) {
  const today = localDate(now, tz);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  let due = addDays(today, -((dow - at.dow + 7) % 7));
  if (zoned(due, at.hour, at.minute, tz) > now) due = addDays(due, -7);
  return { due, at: zoned(due, at.hour, at.minute, tz) };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (date) => `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

// ---------- what the week did ----------
// The week = the 7 local days [from, to] (YYYY-MM-DD, both in), as ms [start, end)
export async function weekDoc(due, dataDir = DATA_DIR, tz = SITE_TIMEZONE) {
  const from = addDays(due, -7);
  const to = addDays(due, -1);
  const start = zoned(from, 0, 0, tz);
  const end = zoned(due, 0, 0, tz);
  const doc = { from, to, site: null, followers: [], posts: { count: 0, best: [] }, pages: [], live: null, errors: [] };
  const inWeek = (t) => t >= start && t < end;

  // the site: visitors and new members per day (ghost.json; its days are UTC days, close enough for a week)
  try {
    const ghost = await readJson(path.join(dataDir, 'ghost.json'));
    const daily = ghost.daily || [];
    const sum = (key, a, b) => {
      const days = daily.filter((d) => d.date >= a && d.date <= b && d[key] != null);
      return days.length ? days.reduce((x, d) => x + d[key], 0) : null;
    };
    doc.site = { visitors: sum('visitors', from, to), visitorsBefore: sum('visitors', addDays(from, -7), addDays(to, -7)),
      members: sum('newMembers', from, to), subscribers: sum('newSubscribers', from, to), total: ghost.totals?.members ?? null };
  } catch (e) { doc.errors.push(`site: ${e.message}`); }

  // followers gained on each network: the account checks in stats.db (the last one before the week began, else its
  // first in the week, to the last one in it)
  try {
    const store = storeFor(dataDir);
    for (const [network, keys] of Object.entries(ACCOUNT_KEYS)) {
      if (network === 'ghost') continue; // members, above
      const key = keys[0];
      const checks = store.account(network, start - 30 * DAY).filter(([, v]) => Number.isFinite(v[key]));
      const before = checks.filter(([t]) => t < start).pop() || checks.find(([t]) => inWeek(t));
      const last = checks.filter(([t]) => t < end).pop();
      if (before && last && last[0] > before[0]) {
        doc.followers.push({ network: NETWORKS[network]?.label || network, key, gained: last[1][key] - before[1][key], now: last[1][key] });
      }
    }
    doc.followers.sort((a, b) => b.gained - a.gained);
  } catch (e) { doc.errors.push(`followers: ${e.message}`); }

  // the posts made in the week, and the best 3 by "vs your usual" (performance.json's verdicts)
  try {
    const { posts } = await performanceDoc(dataDir);
    const week = posts.filter((p) => inWeek(p.time));
    doc.posts.count = week.length;
    doc.posts.best = week.filter((p) => p.perf != null).slice(0, 3);
  } catch (e) { doc.errors.push(`posts: ${e.message}`); }

  // the most-read pages (Ghost's analytics), with their titles from ghost.json's posts
  try {
    const rows = await tbPipe('api_top_pages', { date_from: from, date_to: to, timezone: tz, limit: '3' });
    const ghost = await readJson(path.join(dataDir, 'ghost.json'));
    const titles = Object.fromEntries((ghost.posts || []).filter((p) => p.links?.[0]).map((p) => [p.links[0], p.title]));
    doc.pages = rows.slice(0, 3).map((r) => ({ path: r.pathname, title: titles[r.pathname] || (r.pathname === '/' ? 'Home page' : r.pathname),
      visitors: Number(r.visits) || 0 }));
  } catch (e) { doc.errors.push(`pages: ${e.message}`); }

  // live shows that started in the week (live.json)
  try {
    const live = await readJson(path.join(dataDir, 'live.json'));
    const shows = (live.shows || []).filter((s) => inWeek(s.start));
    if (shows.length) {
      doc.live = { shows: shows.length, hours: shows.reduce((a, s) => a + (s.minutes || 0), 0) / 60,
        peak: Math.max(...shows.map((s) => s.peakListeners || 0)), listenerHours: shows.reduce((a, s) => a + (s.listenerHours || 0), 0) };
    }
  } catch (e) { doc.errors.push(`live: ${e.message}`); }
  return doc;
}

// The notification's text: short, the way ntfy shows it on a phone
export function weekMessage(w) {
  const lines = [];
  if (w.site && (w.site.visitors != null || w.site.members != null)) {
    const parts = [];
    if (w.site.visitors != null) {
      const vs = w.site.visitorsBefore ? Math.round((100 * (w.site.visitors - w.site.visitorsBefore)) / w.site.visitorsBefore) : null;
      parts.push(`${fmt(w.site.visitors)} visitors${vs != null ? ` (${vs >= 0 ? '+' : '−'}${Math.abs(vs)}% on the week before)` : ''}`);
    }
    if (w.site.members != null) parts.push(`${fmt(w.site.members)} new member${w.site.members === 1 ? '' : 's'}`);
    lines.push(`🌐 Site: ${parts.join(', ')}`);
  }
  if (w.followers.length) {
    const moved = w.followers.filter((f) => f.gained);
    lines.push(`👥 Followers: ${moved.length ? moved.map((f) => `${f.network} ${signed(f.gained)}`).join(', ') : 'no change'}`);
  }
  if (w.posts.count) {
    lines.push(`📣 ${w.posts.count} post${w.posts.count === 1 ? '' : 's'}${w.posts.best.length ? ', best:' : ''}`);
    w.posts.best.forEach((p, i) => lines.push(`${i + 1}. ${p.network}: "${text(p.title, 50) || p.type || 'post'}" · ${p.label}`));
  } else lines.push('📣 No posts this week');
  if (w.pages.length) lines.push(`📖 Most read: ${w.pages.map((p) => `${text(p.title, 40)} (${fmt(p.visitors)})`).join(', ')}`);
  if (w.live) {
    lines.push(`🎧 Live: ${w.live.shows} show${w.live.shows === 1 ? '' : 's'}, ${Math.round(w.live.hours * 10) / 10} h, `
      + `peak ${fmt(w.live.peak)} listener${w.live.peak === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}

async function tellPhone(due) {
  const w = await weekDoc(due);
  if (w.errors.length) log(`Weekly summary: ${w.errors.join('; ')}`);
  const msg = {
    title: `📊 Your week on ${SITE_NAME} (${short(w.from)} – ${short(w.to)})`,
    message: weekMessage(w),
    tags: ['bar_chart'],
    // the Grafana button only with GRAFANA_URL set
    ...(GRAFANA_URL ? { actions: [{ action: 'view', label: 'Open Grafana', url: `${GRAFANA_URL}/d/${ID_PREFIX}-overview${DRY_RUN ? '-staging' : ''}`, clear: false }] } : {}),
  };
  // Off (no NTFY_URL) or a dry run counts as done: notify() logged it, so it isn't tried again every check
  return (await notify(msg)) || !NTFY_URL || isDry();
}

// ---------- the check ----------
// data/weekly.json: { sent: the local date of the last send time handled }. Saved after sending, so a restart doesn't
// send twice; one that didn't go out (or was due while the bridge was down) is sent at the next check, until the next
// one is due. The first run starts from the latest send time without sending.
let running = false;
export async function checkWeekly() {
  if (running) return;
  running = true;
  try {
    const { due } = lastDue();
    const state = await readJson(WEEKLY_FILE);
    if (!state.sent) {
      await writeJson(WEEKLY_FILE, { sent: due });
      return;
    }
    if (state.sent >= due) return;
    log(`Weekly summary: the week before ${due}`);
    if (await tellPhone(due)) await writeJson(WEEKLY_FILE, { sent: due });
  } finally {
    running = false;
  }
}

export function startWeeklySummary() {
  if (!WEEKLY_SUMMARY) return;
  const run = () => checkWeekly().catch((e) => log(`WARNING: weekly summary: ${e.message}`));
  // the first check after the collectors' first polls (the Ghost one tells Tinybird's site_uuid when it isn't set)
  setTimeout(run, 3 * 60_000).unref();
  setInterval(run, CHECK_MS).unref();
  // WEEKLY_SUMMARY_NOW=true: send last week's once at start, to try it (staging); weekly.json isn't touched
  if ((env.WEEKLY_SUMMARY_NOW || 'false') === 'true') {
    setTimeout(() => tellPhone(lastDue().due).catch((e) => log(`WARNING: weekly summary (now): ${e.message}`)), 3 * 60_000 + 10_000).unref();
  }
}
