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

// the page's own look (the preview pages' colours): one field a row, numbers two a row (one on a phone), videos by cover
const BOOSTS_CSS = `<style>
main{max-width:860px}.boost [hidden]{display:none!important}h2{font-size:17px;margin:28px 0 10px}
.note{padding:10px 14px;border-radius:10px;margin:0 0 16px;background:var(--auto-bg);color:var(--auto)}
.note.err{background:var(--skip-bg);color:var(--skip)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.boost .step{font-weight:600;margin:0 0 8px}.boost .step .dim{font-weight:400;font-size:13px}
.boost .part{margin:0 0 22px}
.picks{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px;max-height:440px;overflow-y:auto;padding:2px}
.pick{position:relative;display:flex;flex-direction:column;gap:4px;cursor:pointer;font-size:12px;line-height:1.3;min-width:0}
.pick input{position:absolute;opacity:0;pointer-events:none}
.pick .pic{position:relative;aspect-ratio:9/16;border-radius:10px;overflow:hidden;background:var(--line);border:3px solid transparent;
display:grid;place-items:center;color:var(--dim);font-size:22px}
.pick .pic img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.pick:hover .pic{border-color:var(--dim)}.pick input:checked+.pic{border-color:var(--link)}
.pick input:checked+.pic::after{content:'✓';position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;
background:var(--link);color:#fff;font-size:14px;display:grid;place-items:center}
.pick input:focus-visible+.pic{outline:2px solid var(--link);outline-offset:2px}
.pick .play{position:absolute;z-index:2;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;
background:rgba(0,0,0,.55);color:#fff;font-size:18px;padding-left:3px;display:grid;place-items:center}
.pick .play:hover{background:rgba(0,0,0,.8)}.pick .play:focus-visible{outline:2px solid var(--link)}
dialog.player{border:0;border-radius:14px;padding:12px;background:var(--card);color:var(--text);width:min(400px,94vw)}
dialog.player::backdrop{background:rgba(0,0,0,.75)}
.player .frame{aspect-ratio:9/16;max-height:72vh;margin:0 auto;border-radius:10px;overflow:hidden;background:#000}
.player iframe{width:100%;height:100%;border:0;display:block}
.pacts{display:flex;gap:12px;align-items:center;margin-top:10px}.pacts .grow{flex:1}
.pacts .x{font:inherit;font-size:18px;background:none;border:0;color:var(--dim);cursor:pointer;padding:4px 6px}
.pick .when{color:var(--dim)}.pick .what{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px 16px}
@media (max-width:520px){.row2{grid-template-columns:1fr}}
.boost label.f{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:14px}
.boost label.f .dim{font-size:12px}
.boost input[type=date],.boost input[inputmode]{font:inherit;font-weight:400;padding:9px 11px;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--text);width:100%}
.boost input:focus{outline:2px solid var(--link);outline-offset:-1px}
.boost label.tick{display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer;margin-top:10px}
.boost label.tick input{width:18px;height:18px}
.go{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.btn{font:inherit;font-weight:600;font-size:16px;padding:11px 26px;border-radius:10px;border:0;background:var(--link);color:#fff;cursor:pointer}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:14px}
table.typed{border-collapse:collapse;width:100%;font-size:14px;white-space:nowrap}
.typed th,.typed td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line)}
.typed th:first-child,.typed td:first-child{text-align:left;white-space:normal;min-width:180px}
.typed th{font-size:12px;color:var(--dim);font-weight:600}.typed tr:last-child td{border-bottom:0}
.typed tr.on td{background:var(--manual-bg)}.typed tbody tr{cursor:pointer}.typed tbody tr:hover td{background:var(--bg)}
.typed .run{color:var(--auto);font-weight:600}
.typed .acts{display:flex;gap:12px;justify-content:flex-end;align-items:center}
.typed .acts form{margin:0}.typed .del{font:inherit;background:none;border:0;color:var(--skip);cursor:pointer;padding:0}
</style>`;
// "Still running" hides the end day; a row's click opens it in the form; Delete asks first
const BOOSTS_JS = `<script>(() => {
const run = document.querySelector('[name=running]'), end = document.querySelector('[data-end]');
const show = () => { if (run && end) { end.hidden = run.checked; if (run.checked) end.querySelector('input').value = ''; } };
run?.addEventListener('change', show); show();
for (const tr of document.querySelectorAll('tr[data-edit]')) tr.addEventListener('click', (e) => {
  if (!e.target.closest('a,button,form')) location.href = tr.dataset.edit;
});
const dlg = document.querySelector('dialog.player');
let playing = '';
const stop = () => { dlg.querySelector('.frame').textContent = ''; };
for (const b of document.querySelectorAll('[data-play]')) b.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation();
  playing = b.dataset.ref;
  const f = document.createElement('iframe');
  f.src = 'https://www.tiktok.com/player/v1/' + encodeURIComponent(b.dataset.play) + '?autoplay=1&rel=0&description=1';
  f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.title = 'TikTok video';
  dlg.querySelector('.frame').replaceChildren(f);
  const out = dlg.querySelector('.out');
  out.href = b.dataset.link || ('https://www.tiktok.com/video/' + b.dataset.play);
  dlg.showModal();
});
dlg?.addEventListener('close', stop);
dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg?.querySelector('[data-close]').addEventListener('click', () => dlg.close());
dlg?.querySelector('[data-pick]').addEventListener('click', () => {
  const r = [...document.querySelectorAll('input[name=ref]')].find((x) => x.value === playing);
  if (r) { r.checked = true; r.closest('.pick').scrollIntoView({ block: 'nearest' }); }
  dlg.close();
});
for (const f of document.querySelectorAll('form[data-ask]')) f.addEventListener('submit', (e) => { if (!confirm(f.dataset.ask)) e.preventDefault(); });
})();</script>`;

function boostsHtml({ entries, videos, doc, edit, note, currency, today }) {
  const video = (ref) => videos.find((v) => v.ref === ref);
  const e = entries.find((x) => x.id === edit) || {};
  const editing = !!e.id;
  const val = (k) => (e[k] == null ? '' : escAttr(e[k]));
  const pickedRef = e.ref || videos[0]?.ref;
  const picks = videos.map((v) => `<label class="pick" title="${escAttr(text(v.text, 200) || v.ref)}">
      <input type="radio" name="ref" value="${escAttr(v.ref)}"${v.ref === pickedRef ? ' checked' : ''} required>
      <span class="pic">${v.id ? `<button type="button" class="play" data-play="${escAttr(v.id)}" data-ref="${escAttr(v.ref)}" data-link="${escAttr(v.permalink || '')}" aria-label="Play this video">▶</button>` : '▶'}${v.cover ? `<img src="${escAttr(v.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
      <span class="when">${esc(v.date ? v.date.slice(0, 10) : '')}</span><span class="what">${esc(text(v.text, 90) || v.ref)}</span></label>`).join('');
  const n = (v, d = 0) => (v == null ? '' : esc(Number(v).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d })));
  const money = (v) => n(v, 2);
  const rows = entries.slice().sort((a, b) => b.start.localeCompare(a.start)).map((x) => {
    const cpm = per1000(x.spend, x.views);
    return `<tr data-edit="?edit=${escAttr(x.id)}#form"${x.id === e.id ? ' class="on"' : ''}>
    <td>${esc(text(video(x.ref)?.text || x.ref, 60))}</td>
    <td>${esc(x.start)} → ${x.end ? esc(x.end) : '<span class="run">running</span>'}</td>
    <td>${money(x.spend)}</td><td>${money(x.budget)}</td><td>${n(x.views)}</td><td>${money(cpm)}</td><td>${n(x.likes)}</td>
    <td>${n(x.follows)}</td><td>${n(x.profileVisits)}</td><td>${n(x.clicks)}</td>
    <td><div class="acts"><a href="?edit=${escAttr(x.id)}#form">Edit</a>
    <form method="post" data-ask="Delete this Promote's numbers?"><input type="hidden" name="id" value="${escAttr(x.id)}"><button class="del" name="action" value="delete">Delete</button></form></div></td></tr>`;
  }).join('');
  const meta = doc.account?.metaAdAccount
    ? `<p class="dim">Instagram boosts come from Meta by themselves (${esc(doc.account.metaAdAccount)}): ${(doc.ads || []).filter((r) => r.source === 'meta').length} so far.</p>` : '';
  const errors = (doc.errors || []).length ? `<p class="note err">${doc.errors.map(esc).join('<br>')}</p>` : '';
  const shown = note ? `<p class="note${/^Not saved/.test(note) ? ' err' : ''}">${esc(note)}</p>` : '';
  const field = ([k, label, hint]) => `<label class="f"><span>${esc(label)}${k === 'spend' || k === 'budget' ? ` (${esc(currency)})` : ''}</span>
      <input name="${k}" inputmode="decimal" autocomplete="off" value="${val(k)}"${k === 'spend' ? ' required' : ''}>
      <span class="dim">${esc(hint || (k === 'spend' ? '' : 'optional'))}</span></label>`;
  const running = editing ? !e.end : true;
  const form = videos.length ? `<form method="post" class="boost panel">
      <input type="hidden" name="id" value="${val('id')}">
      <div class="part"><p class="step">1. Which video <span class="dim">· newest first</span></p><div class="picks">${picks}</div></div>
      <div class="part"><p class="step">2. When</p><div class="row2">
        <label class="f">Started<input type="date" name="start" value="${editing ? val('start') : escAttr(today)}" max="${escAttr(day(Date.parse(today) + DAY))}" required><span class="dim"></span></label>
        <label class="f" data-end>Ended<input type="date" name="end" value="${val('end')}"><span class="dim">its last day</span></label></div>
        <label class="tick"><input type="checkbox" name="running" value="1"${running ? ' checked' : ''}> Still running</label></div>
      <div class="part"><p class="step">3. What it cost <span class="dim">· from TikTok's Promote page</span></p><div class="row2">${FIELDS.slice(0, 2).map(field).join('')}</div></div>
      <div class="part"><p class="step">4. What it brought</p><div class="row2">${FIELDS.slice(2).map(field).join('')}</div></div>
      <dialog class="player" aria-label="Video"><div class="frame"></div><div class="pacts">
        <a class="out" href="#" target="_blank" rel="noopener">Open on TikTok</a><span class="grow"></span>
        <button type="button" class="btn" data-pick>Pick this video</button><button type="button" class="x" data-close aria-label="Close">✕</button></div></dialog>
      <div class="go"><button class="btn" name="action" value="save">${editing ? 'Save changes' : 'Add this Promote'}</button>${editing ? '<a href="./">Cancel</a>' : ''}</div>
    </form>` : '<p class="panel">No TikTok videos yet: the bridge lists them once TikTok\'s numbers come in (the TikTok channel in Postiz).</p>';
  const table = rows ? `<h2>Typed so far</h2><div class="wrap"><table class="typed"><thead><tr><th>Video</th><th>Dates</th>
    <th>Spent</th><th>Budget</th><th>Views</th><th>Per 1000</th><th>Likes</th><th>Follows</th><th>Profile visits</th><th>Link clicks</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div><p class="dim small">Click a Promote to change its numbers. While one runs, type its new totals now and then; untick Still running when it's over.</p>` : '';
  const formPart = `<h2 id="form">${editing ? `Change: ${esc(text(video(e.ref)?.text || e.ref, 60))}` : 'Add a Promote'}</h2>${form}`;
  return previewPage('Boosts', `${BOOSTS_CSS}<h1>Boosts</h1>
    <div class="meta">TikTok has no way to read a Promote's numbers, so copy them here from Promote's dashboard: in the app (the video's ··· → Promote → its results) or
    <a href="https://www.tiktok.com/promote/web/main" target="_blank" rel="noopener">on the web</a> (its Order history).
    Instagram's boosts come by themselves; their own numbers are in <a href="https://adsmanager.facebook.com/" target="_blank" rel="noopener">Meta's Ads Manager</a>.
    They show on the Platforms dashboard's Boosts row and the video's Post page. <a href="${DRAFT_BASE}/">Shared posts</a></div>
    ${shown}${errors}${meta}
    ${editing ? formPart + table : table + formPart}${BOOSTS_JS}`);
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
        start: f.get('start') || '', end: f.get('running') ? '' : f.get('end') || '', savedAt: new Date().toISOString() };
      const wrong = [];
      if (f.has('running') === false && f.has('end') && !e.end) wrong.push('the end date (or tick Still running)');
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
  res.writeHead(200, headers).end(boostsHtml({ entries: await readTyped(dataDir), videos, doc, edit: q.get('edit') || '', note: q.get('note') || '', currency, today: day(Date.now()) }));
}
