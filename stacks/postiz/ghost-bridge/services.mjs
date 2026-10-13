// services.mjs: the services both halves of the bridge talk to: Postiz's public API (posts, uploads, channels) and
// its own notifications (publish errors, reconnect warnings) passed on to ntfy; Postiz's database (a channel's
// sign-in); Ghost's Admin API.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { POSTIZ_API, POSTIZ_KEY, PREVIEW_DIR, NTFY_URL, POSTIZ_ALERTS, POSTIZ_ALERTS_SUCCESS, POSTIZ_POLL_SECONDS,
  POSTIZ_PUBLIC_URL, SEEN_FILE, DRY_RUN, previewStore, log, isDry, env, GHOST_API_URL,
  GHOST_ADMIN_API_KEY } from './config.mjs';
import { notify } from './share/ntfy.mjs';

// ---------- Postiz API ----------
// Postiz's public API (posts, uploads, channels), and its own notifications (publish errors, reconnect
// warnings) passed on to ntfy.
export async function postiz(method, path, body, timeoutMs = 60_000) {
  const res = await fetch(POSTIZ_API + path, {
    method,
    headers: { Authorization: POSTIZ_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw new Error(`${method} ${path} failed: ${e.cause?.code || e.cause?.message || e.name + ' ' + e.message}`);
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Your channels. A draft preview may use a list up to a minute old, so typing a channel's text doesn't
// ask Postiz every time; a publish always asks.
let channelsCache = null;
export async function postizChannels() {
  if (previewStore.getStore()?.draft && channelsCache && Date.now() - channelsCache.at < 60_000) return channelsCache.list;
  const list = await postiz('GET', '/integrations');
  channelsCache = { at: Date.now(), list };
  return list;
}

export async function uploadMedia(url, kind) {
  if (isDry()) return { id: 'dry-run', path: url, src: url };
  // Postiz downloads the file during this request - allow plenty of time for videos
  const up = await postiz('POST', '/upload-from-url', { url }, kind === 'video' ? 15 * 60_000 : 2 * 60_000);
  log(`  uploaded ${kind} -> ${up.path}`);
  return { id: up.id, path: up.path, src: url };
}

// Upload a local file to Postiz (multipart)
export async function uploadFile(file, name, type) {
  if (isDry()) {
    const pv = previewStore.getStore();
    if (!pv) return { id: 'dry-run', path: `file://${file}` };
    // keep the clip so the preview page can play it
    const saved = `media/${pv.draft ? 'draft-' : ''}${Date.now()}-${name}`;
    await fs.mkdir(path.join(PREVIEW_DIR, 'media'), { recursive: true });
    await fs.copyFile(file, path.join(PREVIEW_DIR, saved));
    if (!pv.draft) pv.files.push(saved); // a draft's clips are removed by clipCache
    return { id: 'dry-run', path: `${pv.base}/${saved}` };
  }
  const buf = await fs.readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  const res = await fetch(POSTIZ_API + '/upload', {
    method: 'POST',
    headers: { Authorization: POSTIZ_KEY },
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /upload -> ${res.status}: ${text}`);
  const up = JSON.parse(text);
  log(`  uploaded ${name} -> ${up.path}`);
  return { id: up.id, path: up.path };
}

// ---------- Postiz notifications -> ntfy ----------
const isSuccess = (text) => /has been published/i.test(text);
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

async function pollPostizNotifications() {
  let seen;
  try { seen = JSON.parse(await fs.readFile(SEEN_FILE, 'utf8')); } catch { seen = null; }
  const data = await postiz('GET', '/notifications?page=0');
  const list = Array.isArray(data?.notifications) ? data.notifications : [];

  if (!seen) {
    // first run: remember what's already there instead of blasting old alerts
    await fs.writeFile(SEEN_FILE, JSON.stringify({ ids: list.map((n) => n.id) }));
    log(`Postiz alerts: watching notifications (${list.length} existing marked as seen)`);
    return;
  }

  const known = new Set(seen.ids);
  const fresh = list.filter((n) => !known.has(n.id)).reverse(); // oldest first
  for (const n of fresh) {
    const text = stripTags(n.content);
    const ok = isSuccess(text);
    if (!ok || POSTIZ_ALERTS_SUCCESS) {
      const releaseUrl = (text.match(/https?:\/\/\S+/) || [])[0];
      log(`Postiz notification: ${text}`);
      await notify({
        title: ok ? '✅ Postiz: posted' : '⚠️ Postiz needs attention',
        message: text,
        tags: [ok ? 'white_check_mark' : 'warning'],
        priority: ok ? 2 : 4,
        ...(n.link || releaseUrl || POSTIZ_PUBLIC_URL
          ? { click: n.link || releaseUrl || POSTIZ_PUBLIC_URL } : {}),
      });
    }
    known.add(n.id);
  }
  if (fresh.length) {
    await fs.writeFile(SEEN_FILE, JSON.stringify({ ids: [...known].slice(-500) }));
  }
}

export function startPostizAlerts() {
  if (!NTFY_URL || !POSTIZ_ALERTS || DRY_RUN) return;
  // one check at a time: a slow Postiz could otherwise have two checks forward the same alerts
  let polling = false;
  const tick = () => {
    if (polling) return;
    polling = true;
    pollPostizNotifications().catch((e) => log(`Postiz alerts: poll failed: ${e.message}`)).finally(() => { polling = false; });
  };
  setTimeout(tick, 5_000);
  setInterval(tick, POSTIZ_POLL_SECONDS * 1000);
}

// ---------- Postiz's database ----------
// Just enough of a Postgres client to read a channel's sign-in from Postiz's database (POSTIZ_DB_*).
export const PG = {
  host: env.POSTIZ_DB_HOST || 'postiz-postgres', port: Number(env.POSTIZ_DB_PORT || 5432),
  user: env.POSTIZ_DB_USER || 'postiz', database: env.POSTIZ_DB_NAME || 'postiz', password: env.POSTIZ_DB_PASSWORD || '',
};

// A minimal Postgres client (simple query protocol; SCRAM-SHA-256, md5 or password sign-in; no TLS: Docker network
// only), enough for one SELECT. Rows come back as objects of strings (null for NULL).
export function pgQuery({ host, port, user, database, password }, sql, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
    const msg = (type, body) => {
      const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
      return Buffer.concat([Buffer.from(type), len, body]);
    };
    const cstr = (s) => Buffer.from(`${s}\0`);
    let buf = Buffer.alloc(0);
    let scram = null;
    let cols = [];
    const rows = [];
    let failed = null;
    const done = (err) => {
      clearTimeout(timer);
      sock.removeAllListeners('data');
      if (!sock.destroyed) { if (!err) sock.write(msg('X', Buffer.alloc(0))); sock.destroy(); }
      err ? reject(err) : resolve(rows);
    };
    const timer = setTimeout(() => done(new Error('Postgres: timed out')), timeoutMs);
    sock.on('error', (e) => done(new Error(`Postgres: ${e.code || e.message}`)));
    sock.on('connect', () => {
      const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), cstr('user'), cstr(user), cstr('database'), cstr(database), Buffer.from([0])]);
      const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
      sock.write(Buffer.concat([len, body]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) break;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === 'R') {
          const code = body.readInt32BE(0);
          if (code === 0) continue;
          if (code === 3) sock.write(msg('p', cstr(password)));
          else if (code === 5) {
            const inner = crypto.createHash('md5').update(password + user).digest('hex');
            const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), body.subarray(4, 8)])).digest('hex');
            sock.write(msg('p', cstr(`md5${outer}`)));
          } else if (code === 10) {
            if (!body.subarray(4).toString().split('\0').includes('SCRAM-SHA-256')) return done(new Error('Postgres: no SCRAM-SHA-256'));
            const nonce = crypto.randomBytes(18).toString('base64');
            scram = { bare: `n=,r=${nonce}`, nonce };
            const first = Buffer.from(`n,,${scram.bare}`);
            const n = Buffer.alloc(4); n.writeInt32BE(first.length);
            sock.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), n, first])));
          } else if (code === 11) {
            const server = body.subarray(4).toString();
            const f = Object.fromEntries(server.split(',').map((kv) => [kv[0], kv.slice(2)]));
            if (!f.r?.startsWith(scram.nonce)) return done(new Error('Postgres: bad SCRAM nonce'));
            const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(f.s, 'base64'), Number(f.i), 32, 'sha256');
            const clientKey = hmac(salted, 'Client Key');
            const stored = crypto.createHash('sha256').update(clientKey).digest();
            const without = `c=biws,r=${f.r}`;
            const auth = `${scram.bare},${server},${without}`;
            const sig = hmac(stored, auth);
            const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
            scram.expect = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
            sock.write(msg('p', Buffer.from(`${without},p=${proof.toString('base64')}`)));
          } else if (code === 12) {
            const v = /(?:^|,)v=([^,]+)/.exec(body.subarray(4).toString())?.[1];
            if (v !== scram?.expect) return done(new Error('Postgres: server signature mismatch'));
          } else return done(new Error(`Postgres: unsupported sign-in (${code})`));
        } else if (type === 'E') {
          const fields = {};
          for (const part of body.toString().split('\0')) if (part) fields[part[0]] = part.slice(1);
          failed = new Error(`Postgres: ${fields.M || 'error'}`);
          if (!scram?.queried && !cols.length) return done(failed); // sign-in failed: no ReadyForQuery follows
        } else if (type === 'Z') {
          if (failed) return done(failed);
          if (scram?.queried || cols.length || rows.length) return done();
          (scram ||= {}).queried = true;
          sock.write(msg('Q', cstr(sql)));
        } else if (type === 'T') {
          cols = [];
          let o = 2;
          for (let i = 0; i < body.readInt16BE(0); i++) {
            const end = body.indexOf(0, o);
            cols.push(body.subarray(o, end).toString());
            o = end + 1 + 18;
          }
        } else if (type === 'D') {
          const row = {};
          let o = 2;
          for (let i = 0; i < body.readInt16BE(0); i++) {
            const n = body.readInt32BE(o); o += 4;
            row[cols[i]] = n < 0 ? null : body.subarray(o, o + n).toString(); if (n > 0) o += n;
          }
          rows.push(row);
        }
      }
    });
  });
}

// ---------- Ghost's Admin API ----------
// Ghost's Admin API with the integration key (GHOST_ADMIN_API_KEY): a draft by its preview link,
// the site's address, and GETs for the stats (the site's own posts and members).
export function ghostToken() {
  const [id, secret] = GHOST_ADMIN_API_KEY.split(':');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT', kid: id })}.${b64({ iat: now, exp: now + 300, aud: '/admin/' })}`;
  return `${unsigned}.${crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(unsigned).digest('base64url')}`;
}

// Ghost turning the key down (401) says only "invalid signature" or "Unknown Admin API Key": name the setting and
// how to fix it (e.keyRejected, e.said: Ghost's words), e.g. staging's .env still holding production's key, which
// staging doesn't have. The steps are a list so the preview page can show them one per line; the log joins them.
export const GHOST_KEY_FIX = [
  `${DRY_RUN ? 'In staging\'s own Ghost Admin (staging has its own keys, not production\'s)' : 'In this Ghost\'s Admin'},`
    + ' open Settings -> Integrations -> the bridge\'s integration.',
  'Copy its Admin API key into GHOST_ADMIN_API_KEY in the bridge\'s .env.',
  'Restart the bridge.',
];
async function ghostError(res, what) {
  const body = (await res.text()).slice(0, 300);
  if (res.status !== 401) return new Error(`Ghost Admin API${what} -> ${res.status}: ${body.slice(0, 200)}`);
  let said = body;
  try { said = JSON.parse(body).errors?.[0]?.message || body; } catch {}
  const e = new Error(`Ghost (${GHOST_API_URL}) rejected GHOST_ADMIN_API_KEY ("${said}"). ${GHOST_KEY_FIX.join(' ')}`);
  Object.assign(e, { keyRejected: true, said });
  return e;
}

export async function ghostPostByUuid(uuid) {
  const q = new URLSearchParams({ filter: `uuid:${uuid}`, formats: 'html', include: 'tags', limit: '1' });
  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/posts/?${q}`, {
    headers: {
      Authorization: `Ghost ${ghostToken()}`,
      'Accept-Version': 'v6.0',
      'X-Forwarded-Proto': 'https', // called directly, not through Traefik: stops Ghost redirecting to https
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await ghostError(res, '');
  return (await res.json()).posts?.[0] || null;
}

// Ghost's own address (its url setting), as Ghost wants it in the Origin of session requests
let siteOrigin = '';
export async function ghostSiteOrigin() {
  if (siteOrigin) return siteOrigin;
  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin/site/`, {
    headers: { 'Accept-Version': 'v6.0', 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ghost Admin API /site/ -> ${res.status}`);
  siteOrigin = new URL((await res.json()).site.url).origin;
  return siteOrigin;
}

// A GET on Ghost's Admin API with the integration key (stats/site.mjs: the site's own posts and members)
export async function ghostAdmin(pathAndQuery) {
  const res = await fetch(`${GHOST_API_URL}/ghost/api/admin${pathAndQuery}`, {
    headers: { Authorization: `Ghost ${ghostToken()}`, 'Accept-Version': 'v6.0', 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await ghostError(res, ` ${pathAndQuery.split('?')[0]}`);
  return res.json();
}

// A GET on Ghost's Members API, the public one the site's pages use (stats/site.mjs: the posts' comment counts)
export async function ghostMembers(pathAndQuery) {
  const res = await fetch(`${GHOST_API_URL}/members/api${pathAndQuery}`, {
    headers: { 'X-Forwarded-Proto': 'https' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Ghost Members API ${pathAndQuery.split('?')[0]} -> ${res.status}`);
  return res.json();
}

// At start-up: one Admin API call, so a key Ghost turns down shows in the log before anyone opens a preview.
// Ghost may still be starting (staging starts with it): tried 5 times, a minute apart; only a rejected key is logged.
export async function checkGhostKey(tries = 5) {
  try { await ghostAdmin('/posts/?limit=1&fields=id'); } catch (e) {
    if (e.keyRejected) return log(`WARNING: draft previews and the site's numbers won't work: ${e.message}`);
    if (tries > 1) setTimeout(() => checkGhostKey(tries - 1), 60_000).unref();
  }
}

// Ghost's newest published posts, for guessing which one a social post was about (stats/post.mjs, GET /post.json);
// asked again after 10 minutes
let ghostList = { at: 0, posts: [] };
export async function ghostPublished() {
  if (Date.now() - ghostList.at < 600_000) return ghostList.posts;
  const q = new URLSearchParams({ filter: 'status:published', fields: 'id,uuid,slug,title,url,published_at', order: 'published_at desc', limit: '100' });
  ghostList = { at: Date.now(), posts: (await ghostAdmin(`/posts/?${q}`)).posts || [] };
  return ghostList.posts;
}
