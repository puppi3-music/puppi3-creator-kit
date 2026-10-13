// stats/stats.mjs: more numbers for Grafana, collected by the bridge (ghost-bridge.mjs starts them and serves the files).
// Like instagram.json: each collector writes data/<name>.json every <X>_STATS_MINUTES (what went wrong is in its
// "errors"), served at GET /<name>.json to the Docker networks only (Grafana's Infinity datasource bridge-instagram):
//  - bluesky.json     the Bluesky account and all its posts (public API, no sign-in)
//  - threads.json     the Threads channel in Postiz: views etc. per day through Postiz; followers and each post's
//                     numbers from Threads with the channel's token (Postiz's database, like Instagram's)
//  - tiktok.json      the TikTok channel in Postiz: account numbers through Postiz, videos with the channel's token
//  - mixcloud.json    the Mixcloud profile MIXCLOUD_USER and its uploads (public API)
//  - ghost.json       the site itself as a network: members, visitors per day, and every published post with its
//                     visitors per day (Ghost's analytics, Tinybird), sign-ups and newsletter numbers (Admin API)
//  - cloudflare.json  every request Cloudflare answered for the site per day, bots included (GraphQL API, a token)
//  - search.json      Google Search clicks, impressions and position, top searches and pages (Search Console API,
//                     a service account)
//  - live.json        every live show (TinyIce's status every 30 s): start, length, peak listeners, listener-hours,
//                     LIVE NOW bar plays and the tracks played
//  - clicks.json      links followed from the site to other sites, and LIVE NOW bar plays (the theme's beacons,
//                     POST /.puppy/click), also counters at /metrics
//  - stats.db         every post's numbers at every check, and per day, for every network (stats/store.mjs; not served:
//                     GET /post.json, timing.json and the verdicts read it)
//  - post.json        one post up close, for Grafana's Post dashboard: numbers now and per day, against the typical
//                     post at the same age, and the site page it leads to (linked, or guessed from Ghost's posts)
//  - page.json        one site page, for Grafana's Page dashboard: every post that leads to it (the same rules as
//                     post.json's), and its visitors by network
//  - timing.json      when posts do best on each network, by weekday and part of the day (Platforms dashboard)
//  - postiz.json      every channel connected in Postiz and what Postiz's analytics have for it (the numbers
//                     themselves go to the archive only)
//  - archive/<name>.json  everything each API gave, kept for good and never trimmed, for numbers nothing shows yet
//                     (not served; see archive() below)
// This file starts them (startStats: the collector() each runs on, Postiz's channels and their analytics) and
// answers the routes. Beside it in stats/: each network's collector (instagram.mjs, youtube.mjs, soundcloud.mjs
// start themselves; social.mjs, site.mjs and live.mjs hold the rest), history.mjs (posts over time, helpers),
// performance.mjs, timing.mjs, post.mjs (post.json, page.json) and store.mjs.

import path from 'node:path';
import { METRIC_PREFIX, networkOn } from '../config.mjs';
import { day, num, readJson, writeJson, archive, storeFor, setStoreLog, addSiteHosts, trackPosts, trackAccount,
  importAccountDays, historyKeys, withPostedMs, everyText, ACCOUNT_KEYS, ACCOUNT_DAYS, accountGains, withWeekly } from './history.mjs';
import { withPerformance, performanceRoute } from './performance.mjs';
import { timingRoute } from './timing.mjs';
import { postRoute, pageRoute } from './post.mjs';
import { bluesky, threads, tiktok, mixcloud } from './social.mjs';
import { ghost, cloudflare, search } from './site.mjs';
import { liveShows, siteClicks } from './live.mjs';

export function startStats({ env, dataDir, log, postiz, pgQuery, PG, ghostPosts, ghostAdmin, ghostMembers }) {
  const file = (name) => path.join(dataDir, `${name}.json`);
  // keeps a collector's posts per day; a failure is that file's error, not the poll's
  const keepPosts = async (out, network, items) => {
    try { await trackPosts(dataDir, network, items, historyKeys(network)); } catch (e) { out.errors.push(`history: ${e.message}`); }
  };
  const minutes = (v) => Math.max(10, Number(v) || 60);
  // the stats database: opened now, so the old JSON files are brought in before the first poll, and copied once a day
  setStoreLog(log);
  let db = null;
  const backup = () => { try { const to = db?.backup(); if (to) log(`stats db: backed up to ${path.relative(dataDir, to)}`); } catch (e) { log(`stats db: backup: ${e.message}`); } };
  try { db = storeFor(dataDir); backup(); setInterval(backup, 3_600_000).unref(); } catch (e) { log(`stats db: ${e.message}`); }
  if (db) {
    for (const network of Object.keys(ACCOUNT_KEYS)) {
      importAccountDays(dataDir, network).then((n) => { if (n) log(`stats db: brought in ${n} earlier day${n === 1 ? '' : 's'} of account numbers for ${network}`); })
        .catch((e) => log(`stats db: account numbers for ${network}, earlier days: ${e.message}`));
    }
  }
  const enabled = (v) => (v || 'true') === 'true';
  const files = {};

  const archiveTo = (name, parts) => archive(dataDir, name, parts);
  // Runs collect(out, prev) every few minutes and writes out (prev = the last file, for its history), and keeps the
  // totals in the archive (the day's last poll)
  // a network left out of NETWORKS (config.mjs) is off like its <NAME>_STATS=false
  const NETWORK_FILES = ['ghost', 'bluesky', 'threads', 'tiktok', 'mixcloud'];
  function collector(name, label, on, mins, delaySeconds, collect) {
    on = on && (!NETWORK_FILES.includes(name) || networkOn(name));
    files[`/${name}.json`] = { file: file(name), on };
    if (!on) return;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const out = { updatedAt: new Date().toISOString(), checkedEvery: everyText(mins), errors: [] };
        try { await collect(out, await readJson(file(name))); } catch (e) { out.errors.push(e.message); }
        withWeekly(name, out);
        trackAccount(dataDir, name, out);
        await withPerformance(dataDir, name, out);
        await writeJson(file(name), withPostedMs(out));
        if (out.totals && Object.values(out.totals).some((v) => v != null)) {
          await archiveTo(name, { days: { [day(Date.now())]: { totals: out.totals } } }).catch((e) => log(`${label} stats: archive: ${e.message}`));
        }
        if (out.errors.length) log(`${label} stats: ${out.errors.join('; ')}`);
      } catch (e) { log(`${label} stats: ${e.message}`); } finally { busy = false; }
    };
    setTimeout(tick, delaySeconds * 1000);
    setInterval(tick, mins * 60_000);
  }

  // ---------- Postiz channels (Threads, TikTok, Bluesky's handle) ----------
  async function channel(ids, label) {
    if (!postiz) throw new Error('needs POSTIZ_API_KEY (to find the channel in Postiz)');
    const ch = (await postiz('GET', '/integrations')).find((c) => ids.includes(c.identifier) && !c.disabled);
    if (!ch) throw new Error(`no ${label} channel in Postiz`);
    return ch;
  }
  // Postiz's analytics for a channel (it renews an expired sign-in first): per-day series for perDayKeys, and each
  // picked series summed over the days asked for, as <key>30
  async function postizAnalytics(ch, days, pick, perDayKeys) {
    const series = await postiz('GET', `/analytics/${ch.id}?date=${days}`);
    const totals = {};
    const byDate = {};
    for (const s of Array.isArray(series) ? series : []) {
      const key = pick.find(([re]) => re.test(s.label || ''))?.[1];
      if (!key || `${key}30` in totals) continue;
      const data = Array.isArray(s.data) ? s.data : [];
      totals[`${key}30`] = data.reduce((a, d) => a + (Number(d.total) || 0), 0);
      totals[`${key}Latest`] = data.length ? Number(data[data.length - 1].total) || 0 : null;
      if (perDayKeys.includes(key)) for (const d of data) (byDate[String(d.date).slice(0, 10)] ||= { date: String(d.date).slice(0, 10) })[key] = Number(d.total) || 0;
    }
    return { totals, daily: Object.values(byDate), empty: !Object.keys(totals).length };
  }
  // The channel's access token, from Postiz's database (one SELECT; never saved or logged)
  async function channelToken(ch, label) {
    if (!PG.password) throw new Error('needs POSTIZ_DB_PASSWORD (the bridge reads the channel\'s token from Postiz\'s database)');
    const rows = await pgQuery(PG, `SELECT token FROM "Integration" WHERE id = '${String(ch.id).replace(/'/g, "''")}' AND "deletedAt" IS NULL`);
    const token = String(rows[0]?.token || '').split('___')[0];
    if (!token) throw new Error(`no token for the ${label} channel in Postiz's database`);
    return token;
  }

  // ---------- every Postiz channel's analytics ----------
  // Postiz's own numbers for every channel connected there, whatever the network (also ones nothing else here reads),
  // as Postiz gives them: each series per day over its last 30 days. Into the archive only (archive/postiz.json,
  // days[date][<channel id>][<series>], channels in account), so they're kept past Postiz's window; postiz.json lists
  // the channels and their series. A call per channel, so every POSTIZ_STATS_MINUTES [360] (the days hardly change).
  collector('postiz', 'Postiz', enabled(env.POSTIZ_STATS) && !!postiz, Math.max(60, Number(env.POSTIZ_STATS_MINUTES) || 360), 70, async (out) => {
    Object.assign(out, { channels: [] });
    const days = {};
    const channels = {};
    for (const ch of await postiz('GET', '/integrations')) {
      if (ch.disabled) continue;
      const row = { id: ch.id, network: ch.identifier, name: ch.name, profile: ch.profile || '', series: [], note: '' };
      channels[ch.id] = { network: ch.identifier, name: ch.name, profile: ch.profile || '' };
      try {
        const series = await postiz('GET', `/analytics/${ch.id}?date=30`);
        for (const sr of Array.isArray(series) ? series : []) {
          if (!sr.label) continue;
          row.series.push(sr.label);
          for (const d of Array.isArray(sr.data) ? sr.data : []) {
            const date = String(d.date).slice(0, 10);
            if (/^\d{4}-\d\d-\d\d$/.test(date)) ((days[date] ||= {})[ch.id] ||= {})[sr.label] = num(d.total);
          }
        }
        if (!row.series.length) row.note = 'Postiz has no numbers for this channel';
      } catch (e) { row.note = e.message; } // a network Postiz has no analytics for: not a problem
      out.channels.push(row);
    }
    await archiveTo('postiz', { days, account: { channels } });
  });

  // ---------- each network's collector (social.mjs, site.mjs, live.mjs) ----------
  const ctx = { env, dataDir, log, postiz, PG, ghostAdmin, ghostMembers, file, files, collector, channel, postizAnalytics, channelToken,
    keepPosts, minutes, enabled, archiveTo };
  bluesky(ctx);
  threads(ctx);
  tiktok(ctx);
  mixcloud(ctx);
  ghost(ctx);
  cloudflare(ctx);
  search(ctx);
  const live = liveShows(ctx);
  const clicks = siteClicks({ ...ctx, live: live.live });
  // A network's account totals at every check kept (trackAccount), oldest first, with what came in since the check
  // before (accountGains): { network, keys, checks: [{ time, <key>: n, new<Key>: n, ... }] }
  function accountChecks(req, res) {
    const network = new URL(req.url, 'http://x').searchParams.get('network') || '';
    const doc = { updatedAt: new Date().toISOString(), network, keys: ACCOUNT_KEYS[network] || [], days: ACCOUNT_DAYS, checks: [], errors: [] };
    if (!ACCOUNT_KEYS[network]) doc.errors.push(`no account checks for "${network}" (one of ${Object.keys(ACCOUNT_KEYS).join(', ')})`);
    else try { doc.checks = accountGains(storeFor(dataDir).account(network), network); } catch (e) { doc.errors.push(e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc));
  }

  return {
    files,
    countClick: clicks.countClick,
    post: postRoute({ dataDir, ghostPosts }),
    page: pageRoute({ dataDir, ghostPosts }),
    timing: timingRoute({ dataDir, env }),
    account: accountChecks,
    performance: performanceRoute({ dataDir }),
    metrics: () => {
      let size = null;
      try { size = db?.size(); } catch {}
      const m = METRIC_PREFIX;
      return (size ? `# HELP ${m}_stats_db_bytes Size of the bridge's stats database (data/stats.db and its write-ahead log).\n`
        + `# TYPE ${m}_stats_db_bytes gauge\n` + `${m}_stats_db_bytes ${size.bytes}\n`
        + `# HELP ${m}_stats_checks Post checks kept in the stats database (every check in a post's first days and take-offs, then one per change).\n`
        + `# TYPE ${m}_stats_checks gauge\n` + `${m}_stats_checks ${size.checks}\n` : '') + clicks.metrics();
    },
    save: () => {
      clicks.save();
      live.save();
    },
    summary: () => `more stats: ${Object.entries(files).filter(([, f]) => f.on).map(([p]) => p.slice(1, -5)).join(', ') || 'off'}`,
  };
}
