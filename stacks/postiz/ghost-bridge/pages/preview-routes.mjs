// pages/preview-routes.mjs: the pages the bridge serves (pages/preview-render.mjs draws them): dry-run previews (staging), the
// page with all of a post's photos that a notification links to, and the Social preview of a draft with its saves.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { esc, escAttr, previewPage, renderPreview, photosPage } from './preview-render.mjs';
import { LIMITS, IMAGE_LIMITS, INSTAGRAM_IDS, TIKTOK_IDS, NO_LINK_IDS, CUSTOM_CHANNELS, CUSTOM_MAX, MANUAL_DRAFTS,
  BIG_DROP_TAG, STORY_TAG, PREVIEW_DIR, PREVIEW_KEEP, PREVIEW_URL, log, channelKey, PHOTOS_FILE, PHOTOS_BASE,
  PHOTO_PAGE_DAYS, GHOST_API_URL, previewStore, DRAFT_BASE, DRAFT_PREVIEWS, editCustom, setCustom,
  setFrame } from '../config.mjs';
import { ghostPostByUuid, ghostSiteOrigin, GHOST_KEY_FIX } from '../services.mjs';
import { cleanLink } from '../share/content.mjs';
import { handlePost } from '../share/share.mjs';

// ---------- dry-run previews ----------
// Dry-run previews (staging): a page per post shared, written to data/previews/ and served at
// /previews/, plus serving a preview's files (video with Range requests, for Safari).
// The pages themselves are drawn by pages/preview-render.mjs. Written to PREVIEW_DIR/<time>-<slug>.html after each
// webhook in DRY_RUN, and used for draft previews.
export const PREVIEW_SETTINGS = { LIMITS, IMAGE_LIMITS, INSTAGRAM_IDS, TIKTOK_IDS, NO_LINK_IDS, CUSTOM_CHANNELS, CUSTOM_MAX,
  MANUAL_DRAFTS, BIG_DROP_TAG, STORY_TAG, channelKey };

export async function writePreview(pv) {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const slug = (pv.post.slug || 'post').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'post';
  const file = `${pv.at.toISOString().replace(/[:.]/g, '-')}-${slug}.html`;
  await fs.writeFile(path.join(PREVIEW_DIR, file), renderPreview(pv, PREVIEW_SETTINGS));
  // newest first; drop the oldest (and their clips) beyond PREVIEW_KEEP
  const indexFile = path.join(PREVIEW_DIR, 'index.json');
  let index;
  try { index = JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch { index = []; }
  index.unshift({ file, title: pv.post.title || '', at: pv.at.toISOString(),
    channels: pv.entries.filter((e) => e.status !== 'skip').length, files: pv.files });
  for (const old of index.splice(PREVIEW_KEEP)) {
    for (const f of [old.file, ...(old.files || [])]) await fs.rm(path.join(PREVIEW_DIR, f), { force: true });
  }
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
  log(`  preview: ${PREVIEW_URL}/previews/${file}`);
}

async function previewIndex() {
  let index;
  try { index = JSON.parse(await fs.readFile(path.join(PREVIEW_DIR, 'index.json'), 'utf8')); } catch { index = []; }
  const items = index.map((i) => `<li><a href="/previews/${escAttr(i.file)}">${esc(i.title || '(no title)')}</a>
    <span class="dim"> · ${esc(new Date(i.at).toLocaleString('en-GB'))} · ${i.channels} channel${i.channels === 1 ? '' : 's'}</span></li>`);
  return previewPage('Social previews', `<h1>Social previews</h1>
    <div class="meta">What the staging bridge would post for each post published on staging (dry run, newest first).</div>
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p>None yet. Publish a post on staging.</p>'}`);
}

const PREVIEW_TYPES = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' };
export async function servePreview(req, res, p) {
  if (p === '/' || p === '/previews' || p === '/previews/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(await previewIndex());
    return;
  }
  const m = /^\/previews\/((?:media\/)?[\w-][\w.-]*\.(?:html|mp4))$/.exec(p);
  await serveFile(req, res, m && path.join(PREVIEW_DIR, m[1]));
}

export async function serveFile(req, res, file) {
  const size = file && (await fs.stat(file).catch(() => null))?.size;
  if (size == null) { res.writeHead(404).end('not found'); return; }
  const headers = { 'Content-Type': PREVIEW_TYPES[path.extname(file)], 'Accept-Ranges': 'bytes' };
  // Safari only plays video from servers that answer Range requests
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (r && size) {
    let start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
    let end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

// A plain page with a heading and one line (not found, sign in, ...)
export const draftPage = (title, text) => previewPage(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

// Ghost turned down the bridge's GHOST_ADMIN_API_KEY: what Ghost said, then the fix one step per line
const keyRejectedPage = (e) => previewPage('The bridge\'s Ghost key isn\'t accepted',
  '<h1>The bridge\'s Ghost key isn\'t accepted</h1>'
  + `<p>Ghost turned down the bridge's <code>GHOST_ADMIN_API_KEY</code>, so it can't read this post. Ghost said: "${esc(e.said)}".</p>`
  + `<p><strong>To fix it:</strong></p><ol>${GHOST_KEY_FIX.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>`
  + '<p>Then reload this page.</p>');

// ---------- photo pages ----------
// The page with all of a post's photos that an Instagram/TikTok notification links to
// (/social-preview/photos/<id>/, "Share all" into the app), and photos.json, where each set is kept.
async function loadPhotoSets() {
  try { return JSON.parse(await fs.readFile(PHOTOS_FILE, 'utf8')); } catch { return {}; }
}
const photoSetLive = (e) => !!e && Date.now() - Date.parse(e.at) < PHOTO_PAGE_DAYS * 86_400_000;
// Saves one set of photos (dropping expired ones) and gives its page's address; one write at a time, via a temp file.
// Draft previews save nothing: they only show the notification.
let photosQueue = Promise.resolve();
export function photoPage({ platform, title, site, photos }) {
  if (previewStore.getStore()?.draft) return Promise.resolve(`${site}${PHOTOS_BASE}/<made when published>/`);
  const id = crypto.randomBytes(18).toString('base64url');
  const run = photosQueue.then(async () => {
    const all = await loadPhotoSets();
    for (const [k, v] of Object.entries(all)) if (!photoSetLive(v)) delete all[k];
    all[id] = { platform, title, site, photos, at: new Date().toISOString() };
    await fs.writeFile(`${PHOTOS_FILE}.tmp`, JSON.stringify(all, null, 2));
    await fs.rename(`${PHOTOS_FILE}.tmp`, PHOTOS_FILE);
    return `${site}${PHOTOS_BASE}/${id}/`;
  });
  photosQueue = run.catch(() => {});
  return run;
}

// ---------- photo pages (/social-preview/photos/<id>/) ----------
// The page for one notification's photos (see photoPage), and each photo at .../<n>, fetched here so the
// page can share them (a browser only shares files it could read, i.e. from its own site). Only the
// photos saved for that id are served. The site's own images come from Ghost directly.
const PHOTO_MAX_BYTES = 50 * 1024 * 1024;
export async function servePhotos(req, res, p) {
  const headers = { 'Cache-Control': 'no-store, private', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };
  const html = { ...headers, 'Content-Type': 'text/html; charset=utf-8' };
  const m = new RegExp(`^${PHOTOS_BASE}/([\\w-]{24})/(\\d+)?$`).exec(p);
  const set = m && (await loadPhotoSets())[m[1]];
  if (!photoSetLive(set)) {
    return res.writeHead(404, html).end(draftPage('Not found', `This photo link is wrong, or older than ${PHOTO_PAGE_DAYS} days.`));
  }
  if (!m[2]) return res.writeHead(200, html).end(photosPage({ ...set, base: `${PHOTOS_BASE}/${m[1]}/` }));
  const src = set.photos[Number(m[2]) - 1];
  if (!src) return res.writeHead(404, headers).end('not found');
  const u = new URL(src);
  const own = GHOST_API_URL && u.origin === set.site;
  const up = await fetch(own ? `${GHOST_API_URL}${u.pathname}${u.search}` : src, {
    headers: own ? { 'X-Forwarded-Proto': u.protocol.slice(0, -1) } : {},
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: e.cause?.code || e.message }));
  const type = up.ok ? up.headers.get('content-type') || '' : '';
  if (!type.startsWith('image/')) {
    log(`photo page: photo ${m[2]} of "${set.title}": ${up.ok ? `not an image (${type})` : up.status}`);
    return res.writeHead(502, headers).end('couldn\'t get the photo');
  }
  const buf = Buffer.from(await up.arrayBuffer());
  if (buf.length > PHOTO_MAX_BYTES) return res.writeHead(502, headers).end('photo too big');
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': buf.length }).end(buf);
}

// ---------- draft previews (/ghost/social-preview/<uuid>/) ----------
// The Social preview of a draft (/ghost/social-preview/<uuid>/), and its saves (a channel's own
// text, the Listen link, Instagram framing).
// Ghost's preview page (/p/<uuid>/) links here from the theme. Only for staff signed in to Ghost Admin
// (staffSignedIn). The draft is read with the Admin API (so only real posts are rendered), run through
// the same logic as a publish with everything dry, and cached until Ghost's copy of it changes.

// Is this browser signed in to Ghost Admin? Its session cookie is passed to Ghost's /users/me/, which
// answers only for a signed-in (and, with staff device verification, verified) staff user. Answers
// are remembered for a minute per cookie, so a page and its saves don't each ask Ghost.
const SESSION_COOKIE = 'ghost-admin-api-session';
const staffChecks = new Map(); // sha256(cookie) -> { ok, until }
async function staffSignedIn(req) {
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return false;
  const key = crypto.createHash('sha256').update(cookie).digest('hex');
  const hit = staffChecks.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/users/me/?fields=id`, {
    headers: { Cookie: cookie, Origin: await ghostSiteOrigin(), 'Accept-Version': 'v6.0', 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status >= 500) throw new Error(`Ghost Admin API /users/me/ -> ${res.status}`);
  const ok = res.ok && !!(await res.json().catch(() => null))?.users?.[0]?.id;
  for (const [k, v] of staffChecks) if (v.until <= Date.now()) staffChecks.delete(k);
  staffChecks.set(key, { ok, until: Date.now() + 60_000 });
  return ok;
}

const draftCache = new Map(); // uuid -> { key (draftKey), html, post }
const DRAFT_CACHE_SIZE = 20;
let draftQueue = Promise.resolve(); // one render at a time (audio clips are heavy)
// the cache is in memory, so clips from before a restart belong to nothing
export function cleanDraftMedia() {
  fs.readdir(path.join(PREVIEW_DIR, 'media')).then((names) => Promise.all(names.filter((n) => n.startsWith('draft-'))
    .map((n) => fs.rm(path.join(PREVIEW_DIR, 'media', n), { force: true })))).catch(() => {});
}

// The whole post Ghost sent, not its updated_at: Ghost can save a change to the tags alone without
// moving updated_at, and a page still showing a removed #nosocial is worse than one re-render
const draftKey = (post) => crypto.createHash('sha256').update(JSON.stringify(post)).digest('hex');

async function draftPreview(uuid) {
  const post = await ghostPostByUuid(uuid);
  if (!post) return null;
  const hit = draftCache.get(uuid);
  if (hit?.key === draftKey(post) && hit.html) return hit.html;
  return renderDraft(uuid, post);
}

function renderDraft(uuid, post) {
  const key = draftKey(post);
  const run = draftQueue.then(async () => {
    const again = draftCache.get(uuid);
    if (again?.key === key && again.html) return again.html;
    // a draft's url is its preview link; captions get the address it will have once published
    const ghostPreview = post.url;
    const live = /\/p\/[0-9a-f-]{36}\/?$/.test(post.url || '') && post.slug
      ? new URL(`/${post.slug}/`, post.url).toString() : post.url;
    const pv = { post: { ...post, url: live }, at: new Date(), entries: [], notes: [], log: [], files: [],
      media: null, base: DRAFT_BASE, draft: true, ghostPreview };
    await previewStore.run(pv, async () => {
      try { await handlePost(pv.post); } catch (e) { log(`ERROR: ${e.message}`); }
    });
    const html = renderPreview(pv, PREVIEW_SETTINGS);
    // a page that hit an error (Postiz down, a failed download) isn't kept: the next load tries again
    const failed = pv.log.some((l) => l.startsWith('ERROR'));
    draftCache.delete(uuid);
    draftCache.set(uuid, { key, html: failed ? null : html, post });
    if (draftCache.size > DRAFT_CACHE_SIZE) draftCache.delete(draftCache.keys().next().value);
    log(`social preview: "${post.title}" (${post.status}), ${pv.entries.length} channel entr${pv.entries.length === 1 ? 'y' : 'ies'}`);
    return html;
  });
  draftQueue = run.catch(() => {});
  return run;
}

export const sendJson = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  .end(JSON.stringify(body));
// The request's JSON body, or null after answering with an error
async function readJson(req, res) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'send JSON' }) && null;
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) return sendJson(res, 413, { error: 'too big' }) && null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}; } catch { return sendJson(res, 400, { error: 'bad JSON' }) && null; }
}

// POST /ghost/social-preview/<uuid>/frame {src, x, y}: where a photo sits in Instagram's frame (x, y: 0-100 %;
// null = centred again)
async function saveFrame(req, res, uuid) {
  const body = await readJson(req, res);
  if (!body) return;
  const { src, x, y } = body;
  if (typeof src !== 'string' || !/^https?:\/\//.test(src) || src.length > 2048) return sendJson(res, 400, { error: 'bad image' });
  const pos = x == null ? null : [x, y].map(Number);
  if (pos && !pos.every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) return sendJson(res, 400, { error: 'x and y are 0-100' });
  const hit = draftCache.get(uuid);
  const post = hit?.post || await ghostPostByUuid(uuid);
  if (!post) return sendJson(res, 404, { error: 'no post has that preview link' });
  await setFrame(post.id, src, pos && pos.map((v) => Math.round(v * 10) / 10));
  if (hit) hit.html = null;
  return sendJson(res, 200, { ok: true });
}

// POST /ghost/social-preview/<uuid>/listen {url}: the post's Listen link: '' = found automatically,
// 'none' = no Listen line, or any web address
async function saveListen(req, res, uuid) {
  const body = await readJson(req, res);
  if (!body) return;
  let url = typeof body.url === 'string' ? body.url.trim() : '';
  if (url && url !== 'none') {
    let u;
    try { u = new URL(/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`); } catch { return sendJson(res, 400, { error: 'not a web address' }); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.toString().length > 2048) return sendJson(res, 400, { error: 'not a web address' });
    url = cleanLink(u);
  }
  const hit = draftCache.get(uuid);
  const post = hit?.post || await ghostPostByUuid(uuid);
  if (!post) return sendJson(res, 404, { error: 'no post has that preview link' });
  await editCustom(post.id, (m) => { if (url) m.listen = url; else delete m.listen; });
  if (hit) hit.html = null;
  log(`social preview: listen link for "${post.title}": ${url || 'automatic'}`);
  return sendJson(res, 200, { ok: true });
}

// POST /ghost/social-preview/<uuid>/custom {channel, text}: save (or with an empty text, remove) a channel's own
// text. Answers with the re-rendered page, which the page swaps that channel's cards from.
async function saveCustomText(req, res, uuid) {
  const json = (code, body) => sendJson(res, code, body);
  const body = await readJson(req, res);
  if (!body) return;
  const { channel } = body;
  const text = typeof body?.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
  if (!CUSTOM_CHANNELS.includes(channel)) return json(400, { error: 'unknown channel' });
  if (Array.from(text).length > CUSTOM_MAX) return json(400, { error: `longer than ${CUSTOM_MAX} characters` });
  // the page was just loaded, so its post is normally cached; the answer is the page, re-rendered
  const hit = draftCache.get(uuid);
  const post = hit?.post || await ghostPostByUuid(uuid);
  if (!post) return json(404, { error: 'no post has that preview link' });
  await setCustom(post.id, channel, text);
  if (hit) hit.html = null;
  log(`social preview: ${text ? 'saved' : 'removed'} modified ${channel} text for "${post.title}"`);
  const html = await renderDraft(uuid, post);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
}

export async function serveDraftPreview(req, res, p) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer', // keep the uuid out of other sites' logs
  };
  const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  // the old address (theme 1.2.0's button): send the page to its new one; nothing else is served there
  if (!p.startsWith(`${DRAFT_BASE}/`)) {
    const old = new RegExp(`^/social-preview/${UUID}/?$`).exec(p);
    if (old && req.method === 'GET') return res.writeHead(301, { ...headers, Location: `${DRAFT_BASE}/${old[1]}/` }).end();
    return res.writeHead(404, headers).end(draftPage('Not found', 'Open this from a post\'s Preview in Ghost.'));
  }
  if (!DRAFT_PREVIEWS) {
    return res.writeHead(503, headers).end(draftPage('Social previews are off',
      'The bridge needs GHOST_API_URL and GHOST_ADMIN_API_KEY (a Ghost custom integration\'s Admin API key).'));
  }
  let staff;
  try { staff = await staffSignedIn(req); } catch (e) {
    log(`social preview: ${e.message}`);
    return res.writeHead(502, headers).end(draftPage('Couldn\'t check your sign-in', e.message));
  }
  if (!staff) {
    if (req.method === 'POST') return sendJson(res, 401, { error: 'sign in to Ghost Admin in this browser, then reload' });
    return res.writeHead(401, headers).end(previewPage('Sign in to Ghost Admin', '<h1>Sign in to Ghost Admin</h1>'
      + '<p>Social previews are only for the site\'s staff. <a href="/ghost/">Sign in to Ghost Admin</a> in this browser, then reload this page.</p>'));
  }
  const media = new RegExp(`^${DRAFT_BASE}/(media/[\\w-][\\w.-]*\\.mp4)$`).exec(p);
  if (media) return serveFile(req, res, path.join(PREVIEW_DIR, media[1]));
  const m = new RegExp(`^${DRAFT_BASE}/${UUID}/(custom|frame|listen)?$`).exec(p) || new RegExp(`^${DRAFT_BASE}/${UUID}()$`).exec(p);
  if (m?.[2] && req.method === 'POST') {
    // saves come from the preview page itself: a page on another site can't make your browser send one
    if (req.headers.origin !== await ghostSiteOrigin()) return sendJson(res, 403, { error: 'wrong origin' });
    return ({ frame: saveFrame, listen: saveListen }[m[2]] || saveCustomText)(req, res, m[1]);
  }
  if (!m || m[2] || req.method !== 'GET') return res.writeHead(404, headers).end(draftPage('Not found', 'Open this from a post\'s Preview in Ghost.'));
  let html;
  try { html = await draftPreview(m[1]); } catch (e) {
    log(`social preview: ${e.message}`);
    if (e.keyRejected) return res.writeHead(502, headers).end(keyRejectedPage(e));
    return res.writeHead(502, headers).end(draftPage('Couldn\'t load the post', e.message));
  }
  if (!html) return res.writeHead(404, headers).end(draftPage('Not found', 'No post has that preview link.'));
  res.writeHead(200, headers).end(html);
}
