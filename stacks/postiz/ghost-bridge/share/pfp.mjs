// share/pfp.mjs: seasonal profile pictures. When one of the site's seasonal outfits starts (the theme's SEASONS), the
// phone gets an ntfy reminder with the puppy in that outfit, to put on each network's profile by hand; when it ends,
// a reminder to put the usual picture back. The theme draws the pictures and copies its SEASONS into seasons.json
// (`npm run dev:pfp` there), so this reads both from the site: nothing to keep in step here.

import path from 'node:path';
import { env, log, isDry, GHOST_API_URL, NTFY_URL, SITE_TIMEZONE, STATE_FILE, ID_PREFIX } from '../config.mjs';
import { ghostSiteOrigin } from '../services.mjs';
import { notify } from './ntfy.mjs';
import { readJson, writeJson } from '../stats/history.mjs';

export const PFP_SEASONS = (env.PFP_SEASONS || 'true') === 'true';
const PFP_FILE = path.join(path.dirname(STATE_FILE), 'pfp.json');
const CHECK_MS = 60 * 60_000;
const ASSETS = '/assets/images/pfp/';

// The networks the reminder lists, in PFP_NETWORKS' order (its first two get an "Open" button); a name not
// here is listed as written, without a button
const NETWORKS = {
  bluesky: ['Bluesky', 'https://bsky.app/'],
  instagram: ['Instagram', 'https://www.instagram.com/'],
  threads: ['Threads', 'https://www.threads.com/'],
  tiktok: ['TikTok', 'https://www.tiktok.com/'],
  youtube: ['YouTube', 'https://studio.youtube.com/'],
  soundcloud: ['SoundCloud', 'https://soundcloud.com/'],
  mixcloud: ['Mixcloud', 'https://www.mixcloud.com/'],
  discord: ['Discord', 'https://discord.com/app'],
};
export const PFP_NETWORKS = (env.PFP_NETWORKS ?? Object.keys(NETWORKS).join(','))
  .split(',').map((n) => n.trim()).filter(Boolean)
  .map((n) => { const [name, url] = NETWORKS[n.toLowerCase()] || [n, '']; return { name, url }; });

const NAMES = {
  halloween: 'Halloween', christmas: 'Christmas', newyear: 'New Year', valentine: "Valentine's", djday: 'DJ Day',
  piday: 'Pi Day', puppyday: 'Puppy Day', firstcontact: 'First Contact Day', starwars: 'Star Wars Day',
  dogday: 'Dog Day', startrek: 'Star Trek Day',
};
const nameOf = (s) => NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (n) => `${n % 100} ${MONTHS[Math.floor(n / 100) - 1]}`;

// Today in the site's time zone as YYYY-MM-DD; PFP_TODAY (YYYY-MM-DD or MM-DD) pretends, for trying it on staging
export function today(now = new Date()) {
  const fake = String(env.PFP_TODAY || '').trim();
  if (/^\d{4}-\d\d-\d\d$/.test(fake)) return fake;
  if (/^\d\d-\d\d$/.test(fake)) return `${now.getUTCFullYear()}-${fake}`;
  return new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// The season on a date, matched like puppies.js does (month * 100 + day, the last match wins); null = none
export function seasonOn(date, seasons) {
  const [, m, d] = date.split('-').map(Number);
  const monthDay = m * 100 + d;
  let season = null;
  for (const [name, from, to] of seasons) if (monthDay >= from && monthDay <= to) season = name;
  return season;
}

// Every date range a season has, for the notification ("31 Dec – 2 Jan" joins newyear's two entries)
function datesOf(season, seasons) {
  const ranges = seasons.filter((s) => s[0] === season).map((s) => [s[1], s[2]]);
  if (ranges.length === 2 && ranges[0][1] === 1231 && ranges[1][0] === 101) return `${md(ranges[0][0])} – ${md(ranges[1][1])}`;
  return ranges.map(([a, b]) => (a === b ? md(a) : `${md(a)} – ${md(b)}`)).join(', ');
}

// The theme's seasons.json, read from Ghost directly; null = the theme has none (a theme without seasonal pictures,
// like the kit's own: nothing to remind about)
async function siteSeasons() {
  const res = await fetch(`${GHOST_API_URL}${ASSETS}seasons.json`, {
    headers: { 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => { throw new Error(`the site's seasons.json: ${e.cause?.code || e.message}`); });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the site's seasons.json: ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.every((s) => Array.isArray(s) && typeof s[0] === 'string' && s[1] > 0 && s[2] > 0)) {
    throw new Error("the site's seasons.json isn't a list of [season, from, to]");
  }
  return list;
}

// ---------- the phone ----------
async function tellPhone(state, seasons) {
  const names = PFP_NETWORKS.map((n) => n.name).join(', ');
  const opens = PFP_NETWORKS.filter((n) => n.url).slice(0, 2)
    .map((n) => ({ action: 'view', label: `Open ${n.name}`, url: n.url, clear: false }));
  let msg;
  if (state.season) {
    const origin = await ghostSiteOrigin().catch(() => '');
    const picture = origin ? `${origin}${ASSETS}${state.season}.png` : '';
    msg = {
      title: `🐶 ${nameOf(state.season)} puppy pfp`,
      message: [`${nameOf(state.season)} outfit time (${datesOf(state.season, seasons)}): the puppy's dressed up on the site.`, '',
        `Put her on your profile picture on: ${names}.`, '',
        picture ? '1. Save the attached picture: tap ⋯ → Save file (or "Save picture").\n2. Set it as your profile picture in each app.'
          : 'The picture: assets/images/pfp/ in the theme.'].join('\n'),
      tags: ['dog'],
      ...(picture && { attach: picture, filename: `${ID_PREFIX}-${state.season}.png` }),
      actions: [...(picture ? [{ action: 'view', label: 'Save picture', url: picture, clear: false }] : []), ...opens],
    };
  } else {
    msg = {
      title: '🐶 Back to the usual pfp',
      message: `${nameOf(state.from)}'s over. Put your usual profile picture back on: ${names}.`,
      tags: ['dog'],
      actions: opens,
    };
  }
  // Off (no NTFY_URL) or a dry run counts as done: notify() logged it, so it isn't tried again every hour
  return (await notify(msg)) || !NTFY_URL || isDry();
}

// ---------- the hourly check ----------
// data/pfp.json: { season (null = none), since, from (the season before), notified }. Saved after every step, so a
// restart never repeats one; a reminder that didn't go out is tried again on the next check.
let running = false, noSeasonsLogged = false;
export async function checkSeason() {
  if (running) return;
  running = true;
  try {
    const seasons = await siteSeasons();
    if (!seasons) {
      if (!noSeasonsLogged) log('Seasonal pfp: the theme has no seasonal pictures (no assets/images/pfp/seasons.json): nothing to remind');
      noSeasonsLogged = true;
      return;
    }
    noSeasonsLogged = false;
    const date = today();
    const season = seasonOn(date, seasons);
    const state = await readJson(PFP_FILE);
    if (!('season' in state)) {   // first run: start from no season (an outfit due today is sent below)
      Object.assign(state, { season: null, since: date, from: null, notified: true });
      await writeJson(PFP_FILE, state);
    }
    if (season !== state.season) {
      log(`Seasonal pfp: ${state.season || 'none'} -> ${season || 'none'} (${date})`);
      Object.assign(state, { from: state.season, season, since: date, notified: false });
      await writeJson(PFP_FILE, state);
    }
    if (!state.notified) {
      state.notified = await tellPhone(state, seasons);
      await writeJson(PFP_FILE, state);
    }
  } finally {
    running = false;
  }
}

export function startSeasonalPfp() {
  if (!PFP_SEASONS) return;
  if (!GHOST_API_URL) return log('Seasonal pfp: off (needs GHOST_API_URL, to read the theme\'s seasons.json)');
  if (!PFP_NETWORKS.length) return log('Seasonal pfp: off (PFP_NETWORKS is empty)');
  const run = () => checkSeason().catch((e) => log(`WARNING: seasonal pfp: ${e.message}`));
  setTimeout(run, 20_000).unref();
  setInterval(run, CHECK_MS).unref();
}
