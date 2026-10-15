// ghost-bridge: Ghost "Post published" webhook -> Postiz public API
// Shares each newly published Ghost post to Bluesky, Threads, Instagram and TikTok via Postiz.
// - A link to where the work is (YouTube, Vimeo, SoundCloud, Spotify...: FEATURED_DOMAINS) anywhere in the post (e.g.
//   an embed caption) gets a line of its own, the featured link (the Social preview can pick another link, or none).
// - Posts tagged #bigdrop send an ntfy reminder to post a link-sticker Story (optionally an auto Story too).
// - Postiz's own notifications (publish errors, reconnect warnings) are forwarded to ntfy.
// - Once a week (WEEKLY_SUMMARY_AT), ntfy gets a summary of the week: visitors, members, followers, the best posts.
// - Bluesky + Threads auto-post. Instagram + TikTok get a Postiz draft + one ntfy notification each, so
//   you can add @tags and sound in the app (IG_TIKTOK_MODE=audio/auto to auto-post them instead).
//   Internal tags: #autopost / #manualpost override, #story = Instagram Story,
//   #campaign-<name> = links carry utm_campaign=<name>.
// - If the post contains a Ghost-hosted video (video card, .mp4), the video is shared
//   (Instagram Reel, Threads/Bluesky video, TikTok). Otherwise the feature image is used, plus the
//   images of any gallery card (Bluesky grid, Threads/Instagram carousel, TikTok photo post).
// - If the post has a Ghost audio card (and no video), a 9:16 "audiogram" clip is rendered with
//   ffmpeg (artwork + waveform + a snippet of the audio) and shared as the video.
// - DRY_RUN (staging) posts nothing; each webhook instead writes a preview page of every channel's
//   post, served at /previews/.
// - Draft previews: /ghost/social-preview/<uuid>/ (linked from the theme's Ghost preview page) reads the
//   draft through the Ghost Admin API and shows what publishing it would post. Never posts anything.
//   Only for someone signed in to Ghost Admin in that browser (checked with Ghost on every request).
//   There you can also give a channel its own text, pick the featured link and line up the Instagram photos (custom.json);
//   on publish they're used instead of the post text / centred crop.
// - Instagram numbers (IG_STATS): the account's followers/reach, profile views and taps on its links per day, and
//   each post's likes, views, saves..., also for posts made in the app, in instagram.json, served at
//   /instagram.json for Grafana's Social dashboard.
// - Puppy pets: the theme's petted puppies count up here (POST /.puppy/pets?n=<pets>), kept in pets.json and
//   served at /pets.json for Grafana's Overview dashboard and as a counter at /metrics for Prometheus (pets per day).
// - More numbers for Grafana (stats/): Bluesky, Threads, TikTok, Mixcloud, the site's own posts (Ghost), Cloudflare,
//   Google Search, live shows (TinyIce) and links clicked off the site (POST /.puppy/click), each in
//   data/<name>.json, served at /<name>.json. Everything each API gives (also numbers nothing shows yet) is kept for
//   good in data/archive/<network>.json (stats/history.mjs archive(); not served).
// Modules, all mounted with this file (compose mounts the folder; no npm dependencies, runs on node:24-alpine
// with ffmpeg added: dockerfile_inline in compose). Which file has what: docs/bridge-map.md in the repo.
//  - here:     this file (start-up, routes, Ghost's webhook), config.mjs (settings, log, posted.json/custom.json),
//              services.mjs (Postiz's API and alerts, its database, Ghost's Admin API)
//  - share/:   sharing a post: share.mjs (handlePost, /upnext.json), content.mjs (reading the post, captions),
//              media.mjs (photos, audio clips), ntfy.mjs, pfp.mjs (seasonal profile pictures), weekly.mjs (the
//              weekly summary on the phone)
//  - pages/:   preview-render.mjs (draws them), preview-routes.mjs (dry-run previews, photo pages, draft Social previews)
//  - stats/:   the numbers: stats.mjs (starts the collectors, serves post/page/timing/performance/account), history.mjs
//              (each post over time, take-offs, helpers), performance.mjs (verdicts), timing.mjs (When to post),
//              post.mjs (/post.json, /page.json), store.mjs (stats.db), instagram.mjs, youtube.mjs, soundcloud.mjs,
//              social.mjs (Bluesky, Threads, TikTok, Mixcloud), site.mjs (Ghost, Cloudflare, Search),
//              live.mjs (live shows, link clicks, pets)

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SECRET, WEBHOOK_MAX_BYTES, PREVIEWS, previewStore, log, env, HOOK_PATH, POSTIZ_API, POSTIZ_KEY, CHANNELS,
  MUSIC_MODE, SHARE_VIDEO, AUDIOGRAM, NTFY_URL, NTFY_TOPIC, DRY_RUN, DRY_RUN_NTFY, TIKTOK_METHOD, TIKTOK_PRIVACY,
  PREVIEW_URL, DRAFT_PREVIEWS, PHOTOS_BASE, STATE_FILE, PORT, PETS, METRIC_PREFIX } from './config.mjs';
import { handlePost, upNextDoc } from './share/share.mjs';
import { writePreview, servePreview, serveDraftPreview, cleanDraftMedia, sendJson,
  servePhotos } from './pages/preview-routes.mjs';
import { postiz, startPostizAlerts, ghostAdmin, ghostMembers, ghostPublished, checkGhostKey, PG, pgQuery } from './services.mjs';
import { startTakeOffNotices } from './share/ntfy.mjs';
import { startSeasonalPfp } from './share/pfp.mjs';
import { startWeeklySummary } from './share/weekly.mjs';
import { pets, countPets, savePets, startPets } from './stats/live.mjs';
import { IG_STATS, IG_STATS_FILE, startInstagramStats } from './stats/instagram.mjs';
import { YT_STATS, YT_STATS_FILE, startYouTubeStats } from './stats/youtube.mjs';
import { SC_STATS, SC_STATS_FILE, startSoundCloudStats } from './stats/soundcloud.mjs';
import { startStats } from './stats/stats.mjs';

// ---------- Ghost signature ----------
// Ghost's "Post published" webhook: its signature checked, answered at once, and the post shared in
// the background (one share per post at a time; in a dry run, with a preview page written).
// Header: "sha256=<hex>, t=<ms timestamp>", hex = HMAC_SHA256(secret, rawBody + t).
// No secret = nothing can be verified, so nothing gets in (anyone could otherwise post as you).
function verifySignature(raw, header) {
  if (!SECRET) return false;
  if (!header) return false;
  const m = /sha256=([a-f0-9]+),\s*t=(\d+)/i.exec(header);
  if (!m) return false;
  const [, sig, ts] = m;
  if (Math.abs(Date.now() - Number(ts)) > 10 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(raw + ts).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Posts being shared right now: a second "published" webhook for one (unpublished and published again
// within the minutes an upload takes) would pass the posted.json check and post it twice.
export const sharing = new Set();
async function handleWebhookPost(post) {
  if (sharing.has(post.id)) return log(`skip "${post.title}": it's still being shared from the last webhook`);
  sharing.add(post.id);
  try { await shareOrPreview(post); } finally { sharing.delete(post.id); }
}
async function shareOrPreview(post) {
  if (!PREVIEWS) return handlePost(post);
  const pv = { post, at: new Date(), entries: [], notes: [], log: [], files: [], media: null, base: '/previews' };
  await previewStore.run(pv, async () => {
    try { await handlePost(post); } catch (e) { log(`ERROR: ${e.message}`); }
    await writePreview(pv).catch((e) => log(`WARNING: couldn't write the preview: ${e.message}`));
  });
}

export function receiveWebhook(req, res) {
  // Ghost's "Post published" body is the post (html, lexical, plaintext), well under this even for long posts
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= WEBHOOK_MAX_BYTES) { chunks.push(c); return; }
    if (res.headersSent) return;
    log(`Rejected request: body over ${WEBHOOK_MAX_BYTES} bytes`);
    res.writeHead(413, { Connection: 'close' }).end('too big');
    req.destroy();
  });
  req.on('end', () => {
    if (size > WEBHOOK_MAX_BYTES) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verifySignature(raw, req.headers['x-ghost-signature'])) {
      log(`Rejected request: ${SECRET ? 'bad or missing X-Ghost-Signature' : 'GHOST_WEBHOOK_SECRET is not set'}`);
      res.writeHead(401).end('bad signature');
      return;
    }
    // Ghost times out webhooks after 2s, so answer right away and work in the background
    res.writeHead(202).end('accepted');
    let payload;
    try { payload = JSON.parse(raw); } catch { return log('Invalid JSON body'); }
    const post = payload?.post?.current;
    if (!post || !post.id) return log('Payload has no post.current - is the webhook event "Post published"?');
    handleWebhookPost(post).catch((e) => log(`ERROR: ${e.message}`));
  });
}

// ---------- start ----------
cleanDraftMedia();
startPostizAlerts();
if (DRAFT_PREVIEWS) checkGhostKey();
startInstagramStats();
startYouTubeStats();
startSoundCloudStats();
if (PETS) startPets();
startTakeOffNotices();
startSeasonalPfp();
startWeeklySummary();
const stats = startStats({ env, dataDir: path.dirname(STATE_FILE), log, postiz: POSTIZ_KEY ? postiz : null, pgQuery, PG,
  ghostPosts: DRAFT_PREVIEWS ? ghostPublished : null, ghostAdmin: DRAFT_PREVIEWS ? ghostAdmin : null,
  ghostMembers: DRAFT_PREVIEWS ? ghostMembers : null });

// The numbers files for Grafana (not routed by Traefik: only containers on the bridge's networks reach them):
// Instagram's, YouTube's and SoundCloud's from here, the rest from stats/stats.mjs
const statsFiles = { '/instagram.json': { file: IG_STATS_FILE, on: IG_STATS }, '/youtube.json': { file: YT_STATS_FILE, on: YT_STATS },
  '/soundcloud.json': { file: SC_STATS_FILE, on: SC_STATS }, ...stats.files };

// ---------- stopping ----------
// Node as the container's main process ignores docker stop's SIGTERM, so Docker waited out its whole timeout
// and killed it. Now it stops at once, unless a post is being shared (uploads take minutes): then as soon as
// that's done, so a post isn't left half shared and unrecorded (compose gives it stop_grace_period for this).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    savePets();
    stats.save();
    if (!sharing.size) process.exit(0);
    log(`${sig}: stopping once the post being shared is done`);
    setInterval(() => { if (!sharing.size) process.exit(0); }, 250);
  });
}

// ---------- server ----------
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  // One post up close, for the Post dashboard (stats/stats.mjs; not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/post.json') {
    stats.post(req, res);
    return;
  }
  // Every post about one site page, for the Page dashboard (stats/stats.mjs; not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/page.json') {
    stats.page(req, res);
    return;
  }
  // Ghost's scheduled posts and where each will go, for the Social dashboard (not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/upnext.json') {
    upNextDoc().catch((e) => ({ updatedAt: new Date().toISOString(), posts: [], errors: [e.message] }))
      .then((doc) => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc)));
    return;
  }
  // Every recent post's verdict, for the Overview dashboard (stats/stats.mjs; not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/performance.json') {
    stats.performance(req, res);
    return;
  }
  // A network's followers etc. at every check, for the Platforms dashboard (stats/stats.mjs; not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/account.json') {
    stats.account(req, res);
    return;
  }
  // When posts do best, for the Platforms dashboard (stats/stats.mjs; not routed by Traefik either)
  if (req.method === 'GET' && req.url.split('?')[0] === '/timing.json') {
    stats.timing(req, res);
    return;
  }
  // The numbers files (Instagram, YouTube, SoundCloud and stats/stats.mjs')
  const statsFile = req.method === 'GET' && statsFiles[req.url.split('?')[0]];
  if (statsFile) {
    fs.readFile(statsFile.file).then(
      (b) => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(b),
      () => res.writeHead(statsFile.on ? 503 : 404, { 'Content-Type': 'application/json' }).end('{"errors":["not collected yet"]}'),
    );
    return;
  }
  if (PETS && req.method === 'POST' && req.url.split('?')[0] === '/.puppy/pets') {
    countPets(req, res);
    return;
  }
  // The theme's clicks on links to other sites and LIVE NOW bar plays (stats/stats.mjs); /.site/click is the kit
  // theme's path, /.puppy/click the older one
  if (req.method === 'POST' && ['/.puppy/click', '/.site/click'].includes(req.url.split('?')[0])) {
    stats.countClick(req, res);
    return;
  }
  // The pet count for Grafana and Prometheus (not routed by Traefik either)
  if (PETS && req.method === 'GET' && req.url.split('?')[0] === '/pets.json') {
    sendJson(res, 200, pets);
    return;
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' }).end(
      (PETS ? `# HELP ${METRIC_PREFIX}_puppy_pets_total Puppies petted on the site, all time.\n` +
      `# TYPE ${METRIC_PREFIX}_puppy_pets_total counter\n` +
      `${METRIC_PREFIX}_puppy_pets_total ${pets.total}\n` : '') + stats.metrics());
    return;
  }
  if (req.method === 'GET' && req.url.startsWith(`${PHOTOS_BASE}/`)) {
    servePhotos(req, res, req.url.split('?')[0]).catch((e) => {
      log(`photo page: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  if ((req.method === 'GET' || req.method === 'POST') && /^\/(ghost\/)?social-preview\//.test(req.url)) {
    serveDraftPreview(req, res, req.url.split('?')[0]).catch((e) => {
      log(`social preview: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  if (PREVIEWS && req.method === 'GET') {
    servePreview(req, res, req.url.split('?')[0]).catch((e) => {
      log(`preview: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  if (req.method !== 'POST' || req.url.split('?')[0] !== HOOK_PATH) {
    res.writeHead(404).end();
    return;
  }
  receiveWebhook(req, res);
}).listen(PORT, () => log(
  `ghost-bridge listening on :${PORT}${HOOK_PATH} -> ${POSTIZ_API} (channels: ${CHANNELS.join(', ')}; ` +
  `video: ${SHARE_VIDEO ? 'on' : 'off'}; audio clips: ${AUDIOGRAM ? 'on' : 'off'}; IG/TikTok: ${MUSIC_MODE}; ntfy: ${NTFY_URL && (!DRY_RUN || DRY_RUN_NTFY) ? NTFY_URL + '/' + NTFY_TOPIC : 'off'}; tiktok: ${TIKTOK_METHOD}${TIKTOK_METHOD === 'DIRECT_POST' ? '/' + TIKTOK_PRIVACY : ''}` +
  `${PREVIEWS ? `; previews: ${PREVIEW_URL}/previews/` : ''}; draft previews: ${DRAFT_PREVIEWS ? 'on' : 'off'}; ` +
  `Instagram stats: ${IG_STATS && POSTIZ_KEY ? (PG.password ? 'account + posts' : 'account') : 'off'}; ${stats.summary()})`,
));
