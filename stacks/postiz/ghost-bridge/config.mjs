// config.mjs: the bridge's settings (environment variables, read once at start), its log, and what it keeps
// between posts (posted.json, custom.json). Every other module takes what it needs from here, so a setting has one
// name and one default.
// The log: a line goes to the console, and while a post is being shared for a preview (previewStore: dry runs and
// draft previews) onto that preview page too; a draft preview's lines go only on the page.

import path from 'node:path';
import fs from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

export const env = process.env;
export const PORT = Number(env.PORT || 8080);
export const HOOK_PATH = env.HOOK_PATH || '/ghost-webhook';
export const POSTIZ_API = (env.POSTIZ_API_URL || 'http://postiz:5000/api/public/v1').replace(/\/$/, '');
export const POSTIZ_KEY = env.POSTIZ_API_KEY || '';
export const SECRET = env.GHOST_WEBHOOK_SECRET || '';
export const WEBHOOK_MAX_BYTES = 8 * 1024 * 1024;
export const CHANNELS = (env.CHANNELS || 'bluesky,threads,instagram-standalone,tiktok,tiktok-business')
  .split(',').map((s) => s.trim()).filter(Boolean);
export const SKIP_TAG = (env.SKIP_TAG || '#nosocial').toLowerCase();
// Posts with this tag are a "big drop": you get an ntfy reminder to post a link-sticker Story.
export const BIG_DROP_TAG = (env.BIG_DROP_TAG || '#bigdrop').toLowerCase();
// Also auto-post a (link-less) Instagram Story? Off by default - you post the one Story with the link.
export const BIG_DROP_AUTO_STORY = (env.BIG_DROP_AUTO_STORY || 'false') === 'true';
// Instagram + TikTok routing (the apps where you add sound and tags yourself). Bluesky + Threads always auto-post.
//   manual = Postiz draft + an ntfy notification per platform, you finish it in the app (default)
//   audio  = auto-post when the post has sound (Ghost video, or audio card -> clip), else manual
//   auto   = always auto-post
// Tags override per post: #autopost (auto) / #manualpost (manual).
export const MUSIC_MODE = ['auto', 'audio'].includes(env.IG_TIKTOK_MODE) ? env.IG_TIKTOK_MODE : 'manual';
export const AUTOPOST_TAG = (env.AUTOPOST_TAG || '#autopost').toLowerCase();       // force auto-post
export const MANUALPOST_TAG = (env.MANUALPOST_TAG || '#manualpost').toLowerCase(); // force the ntfy flow
export const STORY_TAG = (env.STORY_TAG || '#story').toLowerCase();                // Instagram: Story instead of feed post
// Manual posts are also saved as Postiz drafts (shown on the calendar, never published)
export const MANUAL_DRAFTS = (env.MANUAL_DRAFTS ?? env.IG_MANUAL_DRAFT ?? 'true') === 'true';
// Postiz tag put on those drafts so the calendar shows they go through the ntfy flow.
// The tag must already exist in Postiz (create it once in the post editor); unknown names are ignored.
export const DRAFT_TAG = (env.DRAFT_TAG ?? 'Post in app').trim();
export const ONLY_PUBLIC = (env.ONLY_PUBLIC || 'true') === 'true';
// Caption text: body = the text you write in the post (paragraphs, line breaks, emojis, hashtags;
// cards like video/audio/embeds/captions are skipped), falling back to the excerpt when the body has no text.
// excerpt = the post's Excerpt field.
export const TEXT_SOURCE = env.TEXT_SOURCE === 'excerpt' ? 'excerpt' : 'body';
// Put the post title at the top of captions? None of the platforms use titles, so off by default.
export const INCLUDE_TITLE = (env.INCLUDE_TITLE || 'false') === 'true';
// Links to the site are short tagged links: <SITE_HOST>/b/<slug> (b = Bluesky, t = Threads, i = Instagram,
// k = TikTok), which the theme's redirects.yaml 302s to /<slug>/?utm_source=<network>&utm_medium=social, so
// Ghost's analytics credits the visit (and any signup) to the network, even when the app hides where the
// visitor came from (Instagram's in-app browser often does, or passes it through l.facebook.com). Ghost's
// redirects can't put the slug in the query, so there's no utm_campaign: the landing page says which post.
// Other networks get the long form (?utm_source=<network>&utm_medium=social). The bio short links (/ig,
// /bsky...) say utm_medium=bio instead. false = plain links.
export const TAG_LINKS = (env.TAG_LINKS || 'true') !== 'false';
// Internal tag #campaign-<name> (e.g. #campaign-summer-launch): that post's links (caption links to the site,
// the Instagram sticker) get the long form with &utm_campaign=<name>, for Growth's Campaigns table. Works
// even with TAG_LINKS=false. Letters, digits, - and _ only; the first such tag wins.
export const CAMPAIGN_TAG = (env.CAMPAIGN_TAG || '#campaign-').toLowerCase();
// Internal tag: use the post's Excerpt as the social text for this post (instead of the body)
export const EXCERPT_TAG = (env.EXCERPT_TAG || '#useexcerpt').toLowerCase();
export const DRY_RUN = (env.DRY_RUN || 'false') === 'true';
export const STATE_FILE = env.STATE_FILE || '/data/posted.json';
// Changes made on the draft preview: { <post id>: { bluesky|threads|instagram|tiktok: text,
//   frames: { <image url>: [x%, y%] } (where each photo sits in Instagram's frame),
//   listen: 'none' | <address> (the Listen link, instead of the one found in the post), at } }
export const CUSTOM_FILE = path.join(path.dirname(STATE_FILE), 'custom.json');
export const CUSTOM_CHANNELS = ['bluesky', 'threads', 'instagram', 'tiktok'];
// Instagram/TikTok notifications for several photos link a page with all of them and a "Share all" button
// (the phone's share sheet, straight into the app). Its address is unguessable, not signed in: on the
// site under /social-preview/ (already routed here), so no Ghost sign-in is needed on the phone.
// photos.json: { <id>: { platform, title, site, photos: [url], at } }, dropped after PHOTO_PAGE_DAYS.
export const PHOTOS_FILE = path.join(path.dirname(STATE_FILE), 'photos.json');
export const PHOTOS_BASE = '/social-preview/photos';
export const PHOTO_PAGE_DAYS = Math.max(1, Number(env.PHOTO_PAGE_DAYS) || 14); // not a number = 14
export const CUSTOM_MAX = 5000;
// Dry-run previews: an HTML page per webhook showing each channel's post, served at /previews/
export const PREVIEWS = DRY_RUN && (env.PREVIEWS || 'true') === 'true';
export const PREVIEW_DIR = env.PREVIEW_DIR || path.join(path.dirname(STATE_FILE), 'previews');
export const PREVIEW_KEEP = Math.max(1, Number(env.PREVIEW_KEEP || 30));
export const PREVIEW_URL = (env.PREVIEW_URL || '').replace(/\/$/, ''); // only for the link in the log
// Draft previews need read access to Ghost's posts: a custom integration's Admin API key (id:secret)
export const GHOST_API_URL = (env.GHOST_API_URL || '').replace(/\/$/, '');
export const GHOST_ADMIN_API_KEY = env.GHOST_ADMIN_API_KEY || '';
export const DRAFT_PREVIEWS = /^[0-9a-f]{24}:[0-9a-f]{64}$/.test(GHOST_ADMIN_API_KEY) && !!GHOST_API_URL;
// Under /ghost/ so the browser sends Ghost Admin's sign-in cookie (its path is /ghost), which the bridge
// checks with Ghost. /social-preview/<uuid>/ (the theme's old link) redirects here.
export const DRAFT_BASE = '/ghost/social-preview';
export const SHARE_VIDEO = (env.SHARE_VIDEO || 'true') === 'true';
// Gallery cards: their images go out with the feature image, up to MAX_IMAGES in all
export const GALLERY = (env.GALLERY || 'true') === 'true';
export const MAX_IMAGES = Math.min(20, Math.max(1, Number(env.MAX_IMAGES || 10)));
// UPLOAD = send to your TikTok inbox as a draft (works for unaudited TikTok apps)
// DIRECT_POST = publish straight away (unaudited apps can only use TIKTOK_PRIVACY=SELF_ONLY)
export const TIKTOK_METHOD = env.TIKTOK_METHOD === 'DIRECT_POST' ? 'DIRECT_POST' : 'UPLOAD';
export const TIKTOK_PRIVACY = env.TIKTOK_PRIVACY || 'SELF_ONLY';
// The featured link: a link to where the work itself is (a video, an episode, a track or a set...) found anywhere in
// the post (caption, bookmark card, text link or a YouTube embed) gets its own line in the social posts. The order
// of FEATURED_DOMAINS is the preference: a link to an earlier service wins, else the first in the post. "none" =
// off. The Social preview can pick another link for a post, any address, or none (custom.json "listen").
export const FEATURED_DOMAINS = (env.FEATURED_DOMAINS === 'none' ? '' : env.FEATURED_DOMAINS
  || 'youtube.com,youtu.be,vimeo.com,soundcloud.com,on.soundcloud.com,mixcloud.com,open.spotify.com,podcasts.apple.com,music.apple.com,bandcamp.com,twitch.tv')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Its line where links can be tapped (Bluesky, Threads) and where they can't (Instagram, TikTok: the bio), [name]
// = the service, [url] = the link; what the Social preview calls it, after the line's first emoji
export const FEATURED_LINE = env.FEATURED_LINE || '🔗 [name]: [url]';
export const FEATURED_BIO_LINE = env.FEATURED_BIO_LINE || '🔗 Also on [name] + the full post: link in bio';
export const FEATURED_ICON = (FEATURED_LINE.match(/^\p{Extended_Pictographic}\uFE0F?/u) || ['🔗'])[0];
export const FEATURED_LABEL = `${FEATURED_ICON} ${env.FEATURED_LABEL || 'Featured link'}`;
export const SERVICE_NAMES = { 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'music.youtube.com': 'YouTube Music',
  'vimeo.com': 'Vimeo', 'soundcloud.com': 'SoundCloud', 'on.soundcloud.com': 'SoundCloud', 'mixcloud.com': 'Mixcloud',
  'bandcamp.com': 'Bandcamp', 'open.spotify.com': 'Spotify', 'music.apple.com': 'Apple Music',
  'podcasts.apple.com': 'Apple Podcasts', 'beatport.com': 'Beatport', 'twitch.tv': 'Twitch', 'patreon.com': 'Patreon',
  'ko-fi.com': 'Ko-fi', 'substack.com': 'Substack', 'etsy.com': 'Etsy', 'behance.net': 'Behance' };
// ntfy phone notifications (empty NTFY_URL = off)
export const NTFY_URL = (env.NTFY_URL || '').replace(/\/$/, '');
export const NTFY_TOPIC = env.NTFY_TOPIC || 'postiz';
export const NTFY_TOKEN = env.NTFY_TOKEN || '';
export const NTFY_USER = env.NTFY_USER || '';
export const NTFY_PASS = env.NTFY_PASS || '';
// A dry run (staging) sends its notifications too only with DRY_RUN_NTFY=true (give it its own NTFY_TOPIC);
// a draft preview never does. NTFY_TITLE_PREFIX (e.g. "[staging] ") starts every title.
export const DRY_RUN_NTFY = (env.DRY_RUN_NTFY || 'false') === 'true';
export const NTFY_TITLE_PREFIX = env.NTFY_TITLE_PREFIX || '';
export const NOTIFY_ERRORS = (env.NOTIFY_ERRORS || 'true') === 'true';
// Forward Postiz's own notifications (the bell) to ntfy: publish failures, reconnect warnings...
export const POSTIZ_ALERTS = (env.POSTIZ_ALERTS || 'true') === 'true';
export const POSTIZ_ALERTS_SUCCESS = (env.POSTIZ_ALERTS_SUCCESS || 'false') === 'true'; // also "published" confirmations
export const POSTIZ_POLL_SECONDS = Math.max(15, Number(env.POSTIZ_POLL_SECONDS || 60));
export const POSTIZ_PUBLIC_URL = (env.POSTIZ_PUBLIC_URL || '').replace(/\/$/, '');
export const SEEN_FILE = env.SEEN_FILE || '/data/postiz-notifications.json';
// Audiogram: turn a Ghost audio card into a short vertical video clip
export const AUDIOGRAM = (env.AUDIOGRAM || 'true') === 'true';
export const CLIP_SECONDS = Math.min(90, Math.max(5, Number(env.CLIP_SECONDS || 30)));
export const CLIP_DEFAULT_START = Math.max(0, Number(env.CLIP_DEFAULT_START || 60));
export const CLIP_TAG = (env.CLIP_TAG || '#clip').toLowerCase(); // internal tag: "#clip 12:30" or "#clip 12:30-13:15"

// Character budgets (a little under each platform's hard limit)
export const LIMITS = {
  bluesky: 290, threads: 490,
  'instagram-standalone': 2150, instagram: 2150,
  tiktok: 1950, 'tiktok-business': 1950,
};
export const INSTAGRAM_IDS = ['instagram-standalone', 'instagram'];
export const TIKTOK_IDS = ['tiktok', 'tiktok-business'];
export const NO_LINK_IDS = [...INSTAGRAM_IDS, ...TIKTOK_IDS]; // links aren't clickable there
// Images per post each platform takes (Bluesky's 4 is enforced by Postiz; the rest are the platforms')
export const IMAGE_LIMITS = { bluesky: 4, threads: 20, instagram: 10, 'instagram-standalone': 10, tiktok: 35, 'tiktok-business': 35 };

// The site's time zone: Instagram's "followers online" hours and take-off notices' dates are shown in it
export const SITE_TIMEZONE = env.SITE_TIMEZONE || 'Etc/UTC';

// The site, from its instance profile (instances/CLAUDE.md, via compose); the instance's values by default.
// SITE_NAME heads the weekly summary. ID_PREFIX names its Grafana dashboards (<ID_PREFIX>-overview, -post) and, with
// - as _, the counters at /metrics (<prefix>_puppy_pets_total, ...), which Prometheus history and alerts follow.
export const SITE_HOST = (env.SITE_HOST || 'example.com').trim().toLowerCase();
export const SITE_NAME = env.SITE_NAME || SITE_HOST;
export const ID_PREFIX = env.ID_PREFIX || 'puppi3';
export const METRIC_PREFIX = ID_PREFIX.replace(/[^A-Za-z0-9_]/g, '_');
const hostList = (v) => String(v).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
// The site's names (SITE_HOSTS, e.g. its staging copy's too): links to them are the site's own pages, not clicks off it
export const SITE_HOSTS = hostList(env.SITE_HOSTS || `${SITE_HOST},www.${SITE_HOST}`);
// The live stream's names (LIVE_HOSTS, else LIVE_HOST): links there are "Live stream" clicks
export const LIVE_HOSTS = hostList(env.LIVE_HOSTS || env.LIVE_HOST || `live.${SITE_HOST}`);
// The mascot's pets (the theme's puppies): the route, the count, /pets.json and its counter; false = all 404
export const PETS = (env.PETS || 'true') === 'true';
// Which networks are collected (NETWORKS, comma-separated; empty = all); each one's <NAME>_STATS still applies
const NETWORK_LIST = hostList(env.NETWORKS || '');
export const networkOn = (network) => !NETWORK_LIST.length || NETWORK_LIST.includes(network);
// Grafana, for notifications' buttons (take-off notice, weekly summary); empty = no buttons
export const GRAFANA_URL = (env.GRAFANA_URL || '').replace(/\/$/, '');

// The preview being collected for the post in progress (log lines, entries, notifications)
export const previewStore = new AsyncLocalStorage();
export const log = (...a) => {
  const pv = previewStore.getStore();
  if (pv?.draft) return pv.log.push(a.join(' ')); // draft previews only go on the page
  console.log(new Date().toISOString(), ...a);
  pv?.log.push(a.join(' '));
};
// Dry run: DRY_RUN, or a draft preview (which never posts, whatever DRY_RUN says)
export const isDry = () => DRY_RUN || previewStore.getStore()?.draft === true;

if (!POSTIZ_KEY) log('WARNING: POSTIZ_API_KEY is not set');
if (!SECRET) log('WARNING: GHOST_WEBHOOK_SECRET is not set - every webhook will be refused');
if (DRY_RUN) log('DRY_RUN is on - nothing will actually be posted');
if (GHOST_ADMIN_API_KEY && !DRAFT_PREVIEWS) log('WARNING: draft previews are off - GHOST_ADMIN_API_KEY must look like <id>:<secret> and GHOST_API_URL must be set');

// ---------- state (dedupe so re-publishing doesn't double post) ----------
// What the bridge keeps between posts: posted.json (each post shared, so publishing again doesn't post
// twice) and custom.json (what the draft preview changed: a channel's own text, the Listen link, Instagram framing).
export async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
// Adds one post to the file. Sharing takes minutes (uploads), so two posts can be in progress at once:
// each re-reads the file here and adds only its own entry, one write at a time, via a temp file.
let stateQueue = Promise.resolve();
export function recordShared(id, entry) {
  const run = stateQueue.then(async () => {
    const state = await loadState();
    state[id] = entry;
    await fs.writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
    await fs.rename(`${STATE_FILE}.tmp`, STATE_FILE);
  });
  stateQueue = run.catch(() => {});
  return run;
}
export async function loadCustom() {
  try { return JSON.parse(await fs.readFile(CUSTOM_FILE, 'utf8')); } catch { return {}; }
}
// one write at a time, via a temp file, so a crash can't leave half a file
let customQueue = Promise.resolve();
export function editCustom(postId, change) {
  const run = customQueue.then(async () => {
    const all = await loadCustom();
    const { at, ...mine } = all[postId] || {};
    change(mine);
    if (Object.keys(mine).length) all[postId] = { ...mine, at: new Date().toISOString() }; else delete all[postId];
    await fs.writeFile(`${CUSTOM_FILE}.tmp`, JSON.stringify(all, null, 2));
    await fs.rename(`${CUSTOM_FILE}.tmp`, CUSTOM_FILE);
  });
  customQueue = run.catch(() => {});
  return run;
}
export const setCustom = (postId, channel, text) => editCustom(postId, (m) => { if (text) m[channel] = text; else delete m[channel]; });
export const setFrame = (postId, src, pos) => editCustom(postId, (m) => {
  const frames = { ...m.frames };
  if (pos) frames[src] = pos; else delete frames[src];
  if (Object.keys(frames).length) m.frames = frames; else delete m.frames;
});

// instagram-standalone -> instagram, tiktok-business -> tiktok
export const channelKey = (idf) => (INSTAGRAM_IDS.includes(idf) ? 'instagram' : TIKTOK_IDS.includes(idf) ? 'tiktok' : idf);
