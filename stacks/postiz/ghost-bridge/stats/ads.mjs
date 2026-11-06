// stats/ads.mjs: boosts, what paid posts cost and bought (data/ads.json, GET /ads.json; Platforms' Boosts row, Post's
// Boost row).
//  - Instagram: a boost made in the app is an ad in the Meta ad account META_AD_ACCOUNT_ID, read with the Marketing API
//    and META_ADS_TOKEN (a Business portfolio's system-user token with ads_read on that account; Postiz's Instagram
//    token can't read ads). Each ad is matched to its Instagram post by the media id, else the permalink.
//  - TikTok: Promote has no API, so its numbers are typed in on a staff-only page, /ghost/social-preview/boosts/
//    (serveBoosts; ADS_TYPED), kept in data/ads-typed.json.
// Instagram's post numbers are organic only; TikTok's views include the paid ones, so a boosted TikTok is marked
// (paidCounted, withBoosts) and left out of the usual its network's verdicts and timing compare with.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_FILE, DRAFT_BASE } from '../config.mjs';
import { DAY, day, num, text, readJson, writeJson, fetchJson, postRef } from './history.mjs';
import { esc, escAttr, previewPage } from '../pages/preview-render.mjs';

const GRAPH = 'https://graph.facebook.com/v25.0';
const KEEP_DAYS = 400;
const NETS = { instagram: 'Instagram', tiktok: 'TikTok', other: 'Other Meta ads' };
// numbers each boost may have; `seen` = reach on Instagram (and other Meta ads), views on TikTok
const KEYS = ['spend', 'reach', 'impressions', 'views', 'likes', 'follows', 'profileVisits', 'clicks', 'linkClicks'];
const typedFile = (dataDir) => path.join(dataDir, 'ads-typed.json');
const seenOf = (network, x) => (network === 'tiktok' ? x.views : x.reach);
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const per1000 = (spend, seen) => (spend != null && seen ? round((spend / seen) * 1000) : null);
const perOne = (spend, n) => (spend != null && n ? round(spend / n) : null);
const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s));
const datesFrom = (from, to) => {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(day(t));
  return out;
};
export const adAccount = (v) => {
  const s = String(v || '').trim().replace(/^act_/, '');
  return /^\d{3,25}$/.test(s) ? `act_${s}` : '';
};

let rerun = null; // the collector's poll, run again after the form saves (so a typed boost shows at once)

// ---------- Meta's Marketing API ----------
// The field a #100 error names ("Tried accessing nonexisting field (x)", "... (#100) x is not valid"), if it's one
// asked for at any depth of fields= (adset{a,b}), and the list without it (and its own {...})
const fieldNames = (s) => s.match(/\w+/g) || [];
const refusedField = (fields, message = '') => {
  const named = /field \((\w+)\)/.exec(message)?.[1];
  return fieldNames(fields).find((f) => f === named || (!named && new RegExp(`\\b${f}\\b`).test(message))) || '';
};
const withoutField = (fields, name) => fields.replace(new RegExp(`(^|[,{])${name}(\\{[^{}]*\\})?(?=[,}]|$)`), '$1')
  .replace(/,,+/g, ',').replace(/\{,/g, '{').replace(/,\}/g, '}').replace(/^,|,$/g, '').replace(/\w+\{\}/g, '').replace(/,,+/g, ',').replace(/^,|,$/g, '');
const metaError = (e, account) => {
  const code = e?.code;
  if (code === 190) return 'Meta turned the token down: make a new system-user token and put it in META_ADS_TOKEN';
  if ([10, 200, 272, 294].includes(code) || /permission/i.test(e?.message || '')) {
    return `the token can't read ${account}: give its system user the ad account with ads_read (Business settings > Users > System users > Assign assets)`;
  }
  if ([4, 17, 32, 613, 80004].includes(code)) return 'Meta is limiting calls for now: the next poll tries again';
  return text(e?.message || 'Meta said no', 300);
};
// One Graph call, every page of it (pages: at most `pages`). A field Meta refuses (#100 naming it) is dropped and
// asked again without it; `refused` collects them. The token goes in a header, never in an address or the log.
async function graph(url, token, { pages = 1, refused = [], account = '' } = {}) {
  const u = new URL(url);
  const all = [];
  let next = u.toString();
  for (let tries = 0, page = 0; next && page < pages;) {
    const { res, data } = await fetchJson(next, { headers: { Authorization: `Bearer ${token}` } }, 'Meta');
    if (!res.ok) {
      const e = data?.error || {};
      const fields = u.searchParams.get('fields');
      const bad = e.code === 100 && fields && refusedField(fields, e.message);
      if (bad && tries++ < 3 && page === 0) {
        refused.push(bad);
        u.searchParams.set('fields', withoutField(fields, bad));
        next = u.toString();
        continue;
      }
      throw new Error(metaError(e, account));
    }
    if (!Array.isArray(data.data)) return data; // a single object (the ad account)
    all.push(...data.data);
    next = data.paging?.next || '';
    page++;
  }
  return all;
}

const actionValue = (actions, re) => {
  const hit = (actions || []).filter((a) => re.test(a.action_type || ''));
  return hit.length ? hit.reduce((a, x) => a + (num(x.value) || 0), 0) : null;
};
// Meta's numbers for one ad (or one ad's day) in ours. Action names vary by objective, so they're matched by
// pattern; the whole list is in the archive.
const metaNumbers = (r) => ({
  spend: num(r.spend), reach: num(r.reach), impressions: num(r.impressions), clicks: num(r.clicks),
  linkClicks: num(r.inline_link_clicks), views: actionValue(r.actions, /^video_view$/),
  likes: actionValue(r.actions, /^(post_reaction|like)$/),
  follows: actionValue(r.actions, /follow/), profileVisits: actionValue(r.actions, /profile_visit/),
});

const cleanLink = (s) => String(s || '').split(/[?#]/)[0].replace(/\/+$/, '');

async function metaBoosts(env, account, token, prev, out, archiveTo) {
  const refused = [];
  const opts = { refused, account };
  const acct = await graph(`${GRAPH}/${account}?fields=name,currency,timezone_name`, token, opts);
  out.account = { ...out.account, name: acct.name || '', currency: acct.currency || '', timezone: acct.timezone_name || '' };
  const ads = await graph(`${GRAPH}/${account}/ads?limit=100&fields=id,name,effective_status,created_time,`
    + 'adset{start_time,end_time,daily_budget,lifetime_budget},creative{effective_instagram_media_id,instagram_permalink_url}', token, { ...opts, pages: 20 });
  const insightFields = 'ad_id,spend,reach,impressions,clicks,inline_link_clicks,actions';
  const lifetime = await graph(`${GRAPH}/${account}/insights?level=ad&date_preset=maximum&limit=500&fields=${insightFields}`, token, { ...opts, pages: 20 });
  // per day: the last 30 (Meta revises them for a while), the last 90 the first time; older days kept from the last file
  const today = day(Date.now());
  const since = day(Date.now() - (Object.keys(prev.metaDays || {}).length ? 29 : 89) * DAY);
  const range = encodeURIComponent(JSON.stringify({ since, until: today }));
  const daily = await graph(`${GRAPH}/${account}/insights?level=ad&time_increment=1&time_range=${range}&limit=500&fields=${insightFields},date_start`, token, { ...opts, pages: 50 });
  if (refused.length) out.errors.push(`Meta has no ${[...new Set(refused)].join(', ')} for this account: left out`);

  const days = {};
  for (const [d, v] of Object.entries(prev.metaDays || {})) if (d < since && d >= day(Date.now() - KEEP_DAYS * DAY)) days[d] = v;
  for (const r of daily) if (isDate(r.date_start) && r.ad_id) (days[r.date_start] ||= {})[r.ad_id] = metaNumbers(r);
  out.metaDays = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));

  const ig = await readJson(path.join(path.dirname(STATE_FILE), 'instagram.json'));
  const byId = new Map((ig.posts || []).map((p) => [String(p.id), p]));
  const byLink = new Map((ig.posts || []).filter((p) => p.permalink).map((p) => [cleanLink(p.permalink), p]));
  const life = new Map(lifetime.map((r) => [r.ad_id, r]));
  const raw = [];
  const rows = ads.map((a) => {
    const c = a.creative || {};
    const post = byId.get(String(c.effective_instagram_media_id || '')) || byLink.get(cleanLink(c.instagram_permalink_url));
    const ig = !!(post || c.effective_instagram_media_id || c.instagram_permalink_url);
    const s = a.adset || {};
    const n = metaNumbers(life.get(a.id) || {});
    raw.push({ ref: postRef(a.id), data: { ...a, insights: life.get(a.id) || null } });
    return {
      id: a.id, source: 'meta', network: ig ? 'instagram' : 'other', name: text(a.name),
      status: a.effective_status === 'ACTIVE' ? 'running' : String(a.effective_status || '').toLowerCase().replace(/_/g, ' '),
      start: (s.start_time || a.created_time || '').slice(0, 10), end: (s.end_time || '').slice(0, 10),
      budget: num(s.lifetime_budget) != null ? num(s.lifetime_budget) / 100 : num(s.daily_budget) != null ? num(s.daily_budget) / 100 : null,
      budgetPer: s.lifetime_budget ? 'in all' : s.daily_budget ? 'a day' : '',
      ref: post ? post.ref : '', title: post ? post.caption || '' : text(a.name), permalink: post?.permalink || c.instagram_permalink_url || '',
      postTime: post?.time ?? null, ...n,
    };
  });
  await archiveTo('ads', { posts: raw, days: Object.fromEntries(Object.entries(days).filter(([d]) => d >= since).map(([d, v]) => [d, { meta: v }])) })
    .catch((e) => out.errors.push(`archive: ${e.message}`));
  return rows;
}

// ---------- typed boosts (TikTok Promote) ----------
async function readTyped(dataDir) {
  const t = await readJson(typedFile(dataDir));
  return Array.isArray(t.entries) ? t.entries : [];
}
async function typedBoosts(dataDir) {
  const tt = await readJson(path.join(dataDir, 'tiktok.json'));
  const byRef = new Map((tt.posts || []).map((p) => [p.ref, p]));
  const today = day(Date.now());
  return (await readTyped(dataDir)).map((e) => {
    const post = byRef.get(e.ref);
    const n = Object.fromEntries(KEYS.map((k) => [k, num(e[k])]));
    return {
      id: e.id, source: 'typed', network: 'tiktok', name: '', status: e.end && e.end < today ? 'ended' : 'running',
      start: e.start, end: e.end || '', budget: num(e.budget), budgetPer: e.budget != null ? 'in all' : '',
      ref: e.ref, title: post?.text || e.title || '', permalink: post?.permalink || '', postTime: post?.time ?? null, ...n,
    };
  });
}

// ---------- the file ----------
// Every day from each network's first boost to today: spend and the rest, 7-day averages (`<net>Spend7`; days with
// no boost count as 0, which they are), and the cost per 1000 seen over the 7 days (`<net>Cpm7`)
function dailyOf(rows, metaDays) {
  const today = day(Date.now());
  const oldest = day(Date.now() - KEEP_DAYS * DAY);
  const byDay = {}; // date -> net -> numbers
  const add = (d, net, n, share = 1) => {
    if (d < oldest || d > today) return;
    const x = ((byDay[d] ||= {})[net] ||= {});
    for (const k of KEYS) if (n[k] != null) x[k] = (x[k] || 0) + n[k] * share;
  };
  const netOf = new Map(rows.map((r) => [r.id, r.network]));
  for (const [d, ads] of Object.entries(metaDays || {})) for (const [id, n] of Object.entries(ads)) add(d, netOf.get(id) || 'other', n);
  // a typed boost's numbers so far, spread evenly over its days up to today
  for (const r of rows.filter((x) => x.source === 'typed' && isDate(x.start))) {
    const to = r.end && r.end < today ? r.end : today;
    const ds = datesFrom(r.start, to < r.start ? r.start : to);
    for (const d of ds) add(d, r.network, r, 1 / ds.length);
  }
  const dates = Object.keys(byDay).sort();
  if (!dates.length) return [];
  const nets = Object.keys(NETS).filter((n) => dates.some((d) => byDay[d][n]));
  const all = datesFrom(dates[0], today);
  return all.map((d, i) => {
    const row = { date: d };
    let spend = 0;
    for (const n of nets) {
      const x = byDay[d]?.[n] || {};
      const week = all.slice(Math.max(0, i - 6), i + 1).map((w) => byDay[w]?.[n] || {});
      const sum = (k) => week.reduce((a, w) => a + ((k === 'seen' ? seenOf(n, w) : w[k]) || 0), 0);
      row[`${n}Spend`] = round(x.spend || 0);
      row[`${n}Seen`] = round(seenOf(n, x) || 0, 0);
      row[`${n}Follows`] = round(x.follows || 0, 1);
      row[`${n}Spend7`] = round(sum('spend') / 7);
      row[`${n}Cpm7`] = per1000(sum('spend'), sum('seen'));
      spend += x.spend || 0;
    }
    row.spend = round(spend);
    return row;
  }).map((r, i, rows2) => ({ ...r, spend7: round(rows2.slice(Math.max(0, i - 6), i + 1).reduce((a, x) => a + x.spend, 0) / 7) }));
}

function totalsOf(rows, daily, currency) {
  const last30 = daily.slice(-30);
  const totals = { currency, spend30: round(last30.reduce((a, x) => a + x.spend, 0)) };
  const byNetwork = [];
  let follows = 0;
  for (const [n, label] of Object.entries(NETS)) {
    if (!daily.length || !(`${n}Spend` in daily[0])) continue;
    const sum = (k) => last30.reduce((a, x) => a + (x[`${n}${k}`] || 0), 0);
    const t = { network: n, label, spend30: round(sum('Spend')), seen30: round(sum('Seen'), 0), follows30: round(sum('Follows'), 0),
      seenAs: n === 'tiktok' ? 'views' : 'reached', boosts: rows.filter((r) => r.network === n).length };
    t.cpm30 = per1000(t.spend30, t.seen30);
    t.costPerFollow30 = perOne(t.spend30, t.follows30);
    follows += t.follows30;
    Object.assign(totals, { [`${n}Spend30`]: t.spend30, [`${n}Seen30`]: t.seen30, [`${n}Cpm30`]: t.cpm30, [`${n}Follows30`]: t.follows30 });
    byNetwork.push(t);
  }
  const since = day(Date.now() - 29 * DAY);
  Object.assign(totals, { follows30: follows, costPerFollow30: perOne(totals.spend30, follows),
    boosts30: rows.filter((r) => (r.end || '9999') >= since).length, running: rows.filter((r) => r.status === 'running').length });
  return { totals, byNetwork };
}

export function ads({ env, dataDir, collector, enabled, archiveTo }) {
  const token = env.META_ADS_TOKEN || '';
  const account = adAccount(env.META_AD_ACCOUNT_ID);
  const typed = enabled(env.ADS_TYPED);
  const on = enabled(env.ADS_STATS) && (typed || !!token || !!env.META_AD_ACCOUNT_ID);
  rerun = collector('ads', 'Boosts', on, Math.max(60, Number(env.ADS_STATS_MINUTES) || 180), 80, async (out, prev) => {
    Object.assign(out, { account: { metaAdAccount: account, typed }, ads: [], daily: [], totals: {}, byNetwork: [], metaDays: {} });
    let rows = [];
    if (token && account) {
      try { rows = await metaBoosts(env, account, token, prev, out, archiveTo); } catch (e) {
        out.errors.push(`Instagram boosts: ${e.message}`);
        rows = (prev.ads || []).filter((r) => r.source === 'meta'); // the last ones read
        out.metaDays = prev.metaDays || {};
        out.account = { ...prev.account, ...out.account };
      }
    } else if (token || env.META_AD_ACCOUNT_ID) {
      out.errors.push(!token ? 'Instagram boosts need META_ADS_TOKEN too' : `META_AD_ACCOUNT_ID "${text(env.META_AD_ACCOUNT_ID, 40)}" isn't an ad account id (act_<digits>)`);
    }
    if (typed) rows.push(...await typedBoosts(dataDir).catch((e) => { out.errors.push(`typed boosts: ${e.message}`); return []; }));
    const currency = env.ADS_CURRENCY || out.account.currency || 'USD';
    out.account.currency = currency;
    out.ads = rows.map((r) => ({ ...r, seen: seenOf(r.network, r) ?? null, cpm: per1000(r.spend, seenOf(r.network, r)), costPerFollow: perOne(r.spend, r.follows),
      currency, label: NETS[r.network], posted_ms: r.postTime ? String(r.postTime) : '' }))
      .sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    out.daily = dailyOf(out.ads, out.metaDays);
    Object.assign(out, totalsOf(out.ads, out.daily, currency));
  });
}

// ---------- boosted posts in the networks' own files ----------
// Before a network file is written (the collector loop and instagram.mjs): each post with a boost gets `boosted`
// (its paid numbers added up), and on TikTok `paidCounted` (its views include the paid ones) and `organicViews`.
export async function withBoosts(dataDir, network, out) {
  if (!['instagram', 'tiktok'].includes(network) || !Array.isArray(out.posts)) return out;
  try {
    const doc = await readJson(path.join(dataDir, 'ads.json'));
    const mine = (doc.ads || []).filter((r) => r.network === network && r.ref);
    const byRef = {};
    for (const r of mine) {
      const b = (byRef[r.ref] ||= { boosts: 0, start: r.start, end: r.end, currency: r.currency, sources: [] });
      b.boosts++;
      for (const k of KEYS) if (r[k] != null) b[k] = round((b[k] || 0) + r[k]);
      if (r.start && r.start < b.start) b.start = r.start;
      if (b.end && (!r.end || r.end > b.end)) b.end = r.end || ''; // '' = one still has no end
      if (r.status === 'running') b.running = true;
      if (!b.sources.includes(r.source)) b.sources.push(r.source);
    }
    for (const p of out.posts) {
      if (!p) continue;
      const b = byRef[p.ref];
      delete p.boosted; delete p.paidCounted; delete p.organicViews;
      if (!b) continue;
      b.seen = seenOf(network, b) ?? null;
      b.cpm = per1000(b.spend, b.seen);
      b.costPerFollow = perOne(b.spend, b.follows);
      p.boosted = b;
      if (network === 'tiktok') {
        p.paidCounted = true;
        if (p.views != null && b.views != null) p.organicViews = Math.max(0, p.views - b.views);
      }
    }
  } catch (e) { (out.errors ||= []).push(`boosts: ${e.message}`); }
  return out;
}

// ---------- the staff page for typed boosts: /ghost/social-preview/boosts/ ----------
const FIELDS = [
  ['spend', 'Spent', 'what the Promote cost so far'], ['budget', 'Budget', 'optional'], ['views', 'Views', 'the paid views'],
  ['likes', 'Likes', ''], ['follows', 'Follows', 'new followers'], ['profileVisits', 'Profile visits', ''], ['clicks', 'Link clicks', 'optional'],
];
const MAX = 1e10;

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 16 * 1024) return null; chunks.push(c); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function boostsHtml({ entries, videos, doc, edit, note, currency }) {
  const title = (ref) => videos.find((v) => v.ref === ref)?.text || ref;
  const e = entries.find((x) => x.id === edit) || {};
  const val = (k) => (e[k] == null ? '' : escAttr(e[k]));
  const options = videos.map((v) => `<option value="${escAttr(v.ref)}"${v.ref === e.ref ? ' selected' : ''}>${esc(v.date ? `${v.date.slice(0, 10)} · ` : '')}${esc(text(v.text, 80) || v.ref)}</option>`).join('');
  const rows = entries.slice().sort((a, b) => b.start.localeCompare(a.start)).map((x) => `<tr><td>${esc(text(title(x.ref), 60))}</td>
    <td>${esc(x.start)} to ${esc(x.end || 'running')}</td><td>${x.spend == null ? '' : esc(x.spend)}</td><td>${x.views == null ? '' : esc(x.views)}</td>
    <td>${x.follows == null ? '' : esc(x.follows)}</td>
    <td><a href="?edit=${escAttr(x.id)}">Edit</a>
    <form method="post" class="inline"><input type="hidden" name="id" value="${escAttr(x.id)}"><button name="action" value="delete">Delete</button></form></td></tr>`).join('');
  const meta = doc.account?.metaAdAccount
    ? `<p class="dim">Instagram boosts come from Meta by themselves (${esc(doc.account.metaAdAccount)}): ${(doc.ads || []).filter((r) => r.source === 'meta').length} so far.</p>` : '';
  const errors = (doc.errors || []).length ? `<p class="error">${doc.errors.map(esc).join('<br>')}</p>` : '';
  const fields = FIELDS.map(([k, label, hint]) => `<label>${esc(label)}${k === 'spend' || k === 'budget' ? ` (${esc(currency)})` : ''}
    <input name="${k}" inputmode="decimal" value="${val(k)}"${k === 'spend' ? ' required' : ''}>${hint ? `<span class="dim">${esc(hint)}</span>` : ''}</label>`).join('');
  return previewPage('Boosts', `<h1>Boosts</h1>
    <div class="meta">TikTok has no way to read a Promote's numbers, so copy them here from the app (the video's ··· > Promote > its results).
    They show on the Platforms dashboard's Boosts row and the video's Post page. <a href="${DRAFT_BASE}/">Shared posts</a></div>
    ${note ? `<p class="saved">${esc(note)}</p>` : ''}${errors}${meta}
    ${rows ? `<h2>Typed so far</h2><table class="list"><tr><th>Video</th><th>Dates</th><th>Spent</th><th>Views</th><th>Follows</th><th></th></tr>${rows}</table>` : ''}
    <h2>${e.id ? 'Change this Promote' : 'Add a Promote'}</h2>
    ${videos.length ? `<form method="post" class="boost">
      <input type="hidden" name="id" value="${val('id')}">
      <label>Video <select name="ref" required>${options}</select></label>
      <label>Started <input type="date" name="start" value="${val('start')}" required></label>
      <label>Ended <input type="date" name="end" value="${val('end')}"><span class="dim">empty while it's still running</span></label>
      ${fields}
      <button name="action" value="save">${e.id ? 'Save changes' : 'Add it'}</button>${e.id ? ` <a href="./">Cancel</a>` : ''}
    </form>` : '<p>No TikTok videos yet: the bridge lists them once TikTok\'s numbers come in (the TikTok channel in Postiz).</p>'}`);
}

// GET: the page; POST (a form from the page itself, so originOk): save or delete one, then back to the page
export async function serveBoosts(req, res, headers, { originOk }) {
  const dataDir = path.dirname(STATE_FILE);
  if ((process.env.ADS_TYPED || 'true') !== 'true') return res.writeHead(404, headers).end(previewPage('Not found', '<h1>Not found</h1><p>Typed boosts are off (ADS_TYPED).</p>'));
  const back = (note) => res.writeHead(303, { ...headers, Location: `${DRAFT_BASE}/boosts/${note ? `?note=${encodeURIComponent(note)}` : ''}` }).end();
  const tt = await readJson(path.join(dataDir, 'tiktok.json'));
  const videos = (tt.posts || []).filter((p) => p.ref).sort((a, b) => (b.time || 0) - (a.time || 0));
  if (req.method === 'POST') {
    if (!(await originOk())) return res.writeHead(403, headers).end(previewPage('Not allowed', '<h1>Not allowed</h1><p>Save from the Boosts page itself.</p>'));
    const f = await readForm(req);
    if (!f) return res.writeHead(413, headers).end(previewPage('Too big', '<h1>Too big</h1>'));
    const entries = await readTyped(dataDir);
    const id = f.get('id') || '';
    let note;
    if (f.get('action') === 'delete') {
      const left = entries.filter((x) => x.id !== id);
      if (left.length === entries.length) return back('That one was already gone.');
      await writeJson(typedFile(dataDir), { entries: left });
      note = 'Deleted.';
    } else {
      const e = { id: id && entries.some((x) => x.id === id) ? id : crypto.randomBytes(6).toString('hex'), ref: f.get('ref') || '',
        start: f.get('start') || '', end: f.get('end') || '', savedAt: new Date().toISOString() };
      const wrong = [];
      if (!videos.some((v) => v.ref === e.ref)) wrong.push('pick one of the videos');
      if (!isDate(e.start)) wrong.push('the start date');
      if (e.end && (!isDate(e.end) || e.end < e.start)) wrong.push('the end date (on or after the start)');
      if (isDate(e.start) && e.start > day(Date.now() + DAY)) wrong.push('a start date that has come');
      for (const [k, label] of FIELDS) {
        const raw = (f.get(k) || '').replace(/\s/g, '').replace(/^[^\w.-]+|[^\w.]+$/g, ''); // a currency sign
        if (!raw) { if (k === 'spend') wrong.push('what it cost'); continue; }
        // 1,250 or 1,250.50 = thousands; 12,50 = a decimal comma
        const v = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/,(\d{1,2})$/, '.$1'));
        if (!Number.isFinite(v) || v < 0 || v > MAX) wrong.push(`${label.toLowerCase()} (a number)`); else e[k] = v;
      }
      if (wrong.length) return back(`Not saved: check ${wrong.join(', ')}.`);
      const i = entries.findIndex((x) => x.id === e.id);
      if (i >= 0) entries[i] = e; else entries.push(e);
      await writeJson(typedFile(dataDir), { entries });
      note = i >= 0 ? 'Saved.' : 'Added.';
    }
    try { await rerun?.(); } catch {} // ads.json again before the page shows (a Meta poll: a few seconds)
    return back(note);
  }
  if (req.method !== 'GET') return res.writeHead(405, headers).end();
  const q = new URL(req.url, 'http://x').searchParams;
  const doc = await readJson(path.join(dataDir, 'ads.json'));
  const currency = process.env.ADS_CURRENCY || doc.account?.currency || 'USD';
  res.writeHead(200, headers).end(boostsHtml({ entries: await readTyped(dataDir), videos, doc, edit: q.get('edit') || '', note: q.get('note') || '', currency }));
}
