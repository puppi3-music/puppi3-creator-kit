// stats/performance.mjs: is a post doing well? Each post's "vs your usual" verdict (against the account's own posts)
// and "vs industry" one, added to every network's file, and GET /performance.json (the Overview dashboard).

import path from 'node:path';
import { DAY, day, text, readJson, NETWORKS, LABELS, POST_KIND, historyKeys, postRef, readHistory, earlyAt, hoursOld,
  totalsByDate, median, EARLY_HOURS } from './history.mjs';

// ---------- is a post doing well? ----------
// Judged the way social media researchers do it, per network:
//  - on what that network says it ranks posts by (SIGNALS, each with a weight): Instagram (Mosseri, 2025) watch time,
//    likes per reach and sends per reach; TikTok shares, comments, likes (it gives no watch time); YouTube how much of a
//    video is watched, then engagement; Threads conversation (replies, reposts); Bluesky reposts and replies (no views,
//    so per follower); SoundCloud/Mixcloud plays and likes/reposts per play; the site visitors, sign-ups per visitor
//    and newsletter clicks (opens count little: Apple Mail opens every email by itself).
//  - as rates per person reached, not raw counts (3 likes out of 40 reached beats 30 out of 4,000), with small numbers
//    pulled toward the account's usual rate (empirical Bayes: `prior` people's worth of the usual), so 2 likes out of
//    6 views isn't "33%, amazing". Counts (reach, views, plays) only at the same age: they grow for days.
//  - against the account's own posts, never other people's: the PERF_BASE posts nearest in time (a growing account
//    doesn't make every new post look great), of the same kind (POST_KIND) when there are PERF_MIN of it.
//  - as a percentile: each signal ranks the post among those, the ranks are averaged with the signals' weights, and
//    the post is ranked again on that average among the same posts (each given its own average), so "Doing great"
//    means better overall than about 4 in 5 of them however much the signals go together; pulled toward 50 when there
//    are few to compare with (5 posts can't show "best of the lot" for sure).
// INDUSTRY is a second line only, never part of the score: published averages are mostly big brand accounts.
const PERF_BASE = 20;
const PERF_MIN = 5;
const PERF_SETTLED = 28; // days: a post this old hardly moves, so any two this old compare as they are now
const PERF_TOO_SOON = 12 * 3_600_000;
const PERF_LABELS = [[80, 'Doing great'], [60, 'Above usual'], [40, 'Usual'], [20, 'Below usual'], [0, 'Well below usual']];
const sumOf = (x, keys) => keys.reduce((a, k) => (x[k] == null ? a : (a ?? 0) + x[k]), null);
// a rate: num (keys added up, or a function) per den (a key, or a function); shown x100 (%) unless scale says
const rate = (id, label, num, den, weight, o = {}) => ({ id, label, num, den, weight, prior: 50, scale: 100, unit: '%', ...o });
// a count, compared only at the same age (aged), unless it's an average that doesn't grow (aged: false)
const count = (id, label, key, weight, o = {}) => ({ id, label, num: [key], den: null, weight, aged: true, scale: 1, unit: '', ...o });
const perFollower = (id, label, num, weight) => rate(id, label, num, (x, p, ctx) => ctx.followersAt(p.time), weight, { prior: 0 });
export const SIGNALS = {
  instagram: [
    count('watch', 'Avg watch time', 'avgWatchMs', 3, { aged: false, scale: 0.001, unit: ' s' }),
    rate('sends', 'Sends per reach', ['shares'], 'reach', 3),
    rate('likes', 'Likes per reach', ['likes'], 'reach', 3),
    rate('saves', 'Saves per reach', ['saved'], 'reach', 1),
    rate('comments', 'Comments per reach', ['comments'], 'reach', 1),
    rate('follows', 'Follows per reach', ['follows'], 'reach', 1),
    count('reach', 'Reach', 'reach', 2),
  ],
  // a Story's numbers are final once it's down (24 hours), so it compares as it is
  'instagram-stories': [
    count('reach', 'Reach', 'reach', 3, { aged: false }),
    rate('replies', 'Replies per reach', ['replies'], 'reach', 2),
    rate('sends', 'Sends per reach', ['shares'], 'reach', 2),
    rate('follows', 'Follows per reach', ['follows'], 'reach', 1),
    rate('visits', 'Profile visits per reach', ['profileVisits'], 'reach', 1),
  ],
  tiktok: [
    rate('shares', 'Shares per view', ['shares'], 'views', 3),
    rate('comments', 'Comments per view', ['comments'], 'views', 2),
    rate('likes', 'Likes per view', ['likes'], 'views', 2),
    count('views', 'Views', 'views', 3),
  ],
  // all from YouTube's real days (stats.db), so all at the same age
  youtube: [
    rate('watched', 'Avg % watched', (x, p) => (p.duration && x.minutesWatched != null ? (x.minutesWatched * 60) / p.duration : null),
      'views', 4, { aged: true, prior: 20 }),
    rate('likes', 'Likes per view', ['likes'], 'views', 2, { aged: true }),
    rate('shares', 'Shares per view', ['shares'], 'views', 2, { aged: true }),
    rate('comments', 'Comments per view', ['comments'], 'views', 1, { aged: true }),
    rate('subs', 'Subscribers per 1k views', ['subscribersGained'], 'views', 2, { aged: true, scale: 1000, unit: '', prior: 200 }),
    count('views', 'Views', 'views', 3),
  ],
  threads: [
    rate('replies', 'Replies per view', ['replies'], 'views', 3),
    rate('shares', 'Reposts & shares per view', ['reposts', 'quotes', 'shares'], 'views', 3),
    rate('likes', 'Likes per view', ['likes'], 'views', 2),
    count('views', 'Views', 'views', 3),
  ],
  bluesky: [
    perFollower('reposts', 'Reposts per follower', ['reposts', 'quotes'], 3),
    perFollower('replies', 'Replies per follower', ['replies'], 3),
    perFollower('likes', 'Likes per follower', ['likes'], 2),
    perFollower('saves', 'Saves per follower', ['bookmarks'], 1),
  ],
  soundcloud: [
    count('plays', 'Plays', 'plays', 3),
    rate('likes', 'Likes & reposts per play', ['likes', 'reposts'], 'plays', 3),
    rate('comments', 'Comments per play', ['comments'], 'plays', 1),
    rate('downloads', 'Downloads per play', ['downloads'], 'plays', 1),
  ],
  mixcloud: [
    count('plays', 'Plays', 'plays', 3),
    rate('favorites', 'Favorites per play', ['favorites'], 'plays', 3),
    rate('reposts', 'Reposts per play', ['reposts'], 'plays', 2),
    rate('comments', 'Comments per play', ['comments'], 'plays', 1),
  ],
  ghost: [
    count('visitors', 'Visitors', 'visitors', 3),
    rate('signups', 'Sign-ups per 1k visitors', ['signups'], 'visitors', 3, { scale: 1000, unit: '', prior: 200 }),
    rate('clicks', 'Newsletter click rate', ['emailClicks'], 'emailRecipients', 2),
    rate('opens', 'Newsletter open rate', ['opens'], 'emailRecipients', 1),
  ],
};
// Published averages, measured the way each report does. typical: one number, or a [low, high] range; the post is
// "about typical" within it (or within 0.67-1.5x of one number). Checked October 2026; update them yearly.
const INDUSTRY = {
  // Socialinsider's reach study (socialinsider.io/blog/social-media-reach, Sep 2026): Instagram engagement by reach
  // (likes, comments, shares, saves) 3.20% in Aug 2026. Not their headline 0.45%: that one is per follower.
  instagram: { what: 'engagement per reach', num: ['likes', 'comments', 'shares', 'saved'], den: 'reach', typical: () => 3.2,
    source: 'Socialinsider, Aug 2026' },
  // Socialinsider's TikTok benchmarks (socialinsider.io/social-media-benchmarks/tiktok): engagement by views 3.85% in
  // Q2 2026 (4.20-4.30% the five quarters before). Not their headline 2.60%: that one is per follower. They also count
  // saves, which TikTok's API doesn't give us, so ours runs a little low; the verdict says so.
  tiktok: { what: 'engagement per view', num: ['likes', 'comments', 'shares'], den: 'views', typical: () => 3.85,
    source: 'Socialinsider, Q2 2026, which also counts saves: TikTok doesn\'t give us those' },
  // Every kind of channel, not one niche: CreatorDB's study of 1.46M channels (creatordb.app/research/
  // youtube-view-count-change, Aug 2026): long-form likes + comments per view, middle half 1.90-6.44% (median 3.67%),
  // measured before YouTube's Aug 24 2026 change to counting views from the first frame (more views, so rates read
  // a little lower since); Shorts' median 2.59% there and 3.8% in SociaVault's 75,000 channels (Apr 2026)
  youtube: { what: 'likes + comments per view', num: ['likes', 'comments'], den: 'views',
    typical: (p) => (POST_KIND.youtube(p) === 'Short' ? [2.5, 4] : [2, 6]), source: 'CreatorDB and SociaVault, 2026 (all channels)' },
  // Mailchimp's email benchmarks: media & publishing click rate 4.0% (opens aren't used: Apple Mail inflates them)
  ghost: { what: 'newsletter click rate', num: ['emailClicks'], den: 'emailRecipients', typical: () => 4.0, source: 'Mailchimp (media)' },
};
const INDUSTRY_MIN = 50; // people reached / viewers / recipients before a rate means anything
const fmtValue = (s, v) => {
  if (v == null) return '–';
  const x = v * s.scale;
  const digits = s.unit === '%' ? (x < 1 ? 2 : 1) : s.den || s.unit ? 1 : 0;
  return `${x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: s.den ? digits : 0 })}${s.unit}`;
};
const ratioText = (mine, usual) => {
  if (!(usual > 0) || mine == null) return mine > 0 ? 'above usual (usually 0)' : 'usual';
  const r = mine / usual;
  return `${r.toFixed(r >= 10 ? 0 : r < 0.1 ? 2 : 1)}× usual`;
};

// Everything about one network's list that every post's verdict needs, worked out once
export function perfContext(network, story, list, histFile, file) {
  const n = NETWORKS[network];
  const now = Date.now();
  const histKeys = n.perDay ? n.dayKeys : historyKeys(network);
  const blank = Object.fromEntries(histKeys.map((k) => [k, null]));
  const totals = {};
  for (const p of list) {
    const h = (histFile.posts || {})[postRef(p.id)];
    if (!h || !p.time) continue;
    const t = totalsByDate(h, n.perDay);
    const dates = Object.keys(t);
    // per-day history only adds up when it reaches back to the post's first day
    if (!dates.length || (n.perDay && dates[0] > day(p.time + DAY))) continue;
    totals[p.ref || postRef(p.id)] = { t, dates };
  }
  // followers on a day: the file's per-day history (Bluesky/Threads `history`, Instagram `followerHistory`), else now
  const fh = Object.entries(file.followerHistory || {}).map(([d, v]) => [d, v])
    .concat(Object.entries(file.history || {}).map(([d, v]) => [d, v?.followers]))
    .filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b));
  // (in between two days kept: the straight line between them; before the first: the first)
  const followersAt = (t) => {
    if (!fh.length) return file.totals?.followers || null;
    const at = Date.parse(day(t || now));
    const i = fh.findIndex(([date]) => Date.parse(date) >= at);
    if (i === 0) return fh[0][1];
    if (i < 0) return fh[fh.length - 1][1];
    const [[d0, v0], [d1, v1]] = [fh[i - 1], fh[i]];
    return v0 + ((v1 - v0) * (at - Date.parse(d0))) / (Date.parse(d1) - Date.parse(d0));
  };
  return { network, n, story, signals: SIGNALS[story ? `${network}-stories` : network] || [], list, totals, blank, now, followersAt,
    early: histFile.early || {},
    kindOf: story ? () => 'Story' : POST_KIND[network] || (() => '') };
}
const ageDays = (from, to) => Math.round((Date.parse(day(to)) - Date.parse(day(from))) / DAY);
// a post's numbers as they are now: its listing, with what only its history has (YouTube's minutes watched)
function nowNumbers(ctx, p) {
  const h = ctx.totals[p.ref || postRef(p.id)];
  const last = h ? h.t[h.dates[h.dates.length - 1]] : {};
  const x = { ...p };
  for (const [k, v] of Object.entries(last)) if (x[k] == null) x[k] = v;
  return x;
}
// ...and at `age` days old (the nearest day kept, a day or two either side), or null
function numbersAt(ctx, p, age) {
  const h = ctx.totals[p.ref || postRef(p.id)];
  if (!h) return null;
  const want = Date.parse(day(p.time)) + age * DAY;
  const tol = age < 7 ? 1 : age < PERF_SETTLED ? 2 : 3;
  let best = null;
  for (const d of h.dates) {
    const off = Math.abs(Date.parse(d) - want) / DAY;
    if (off <= tol && (!best || off < best.off)) best = { d, off };
  }
  return best ? { ...p, ...ctx.blank, ...h.t[best.d] } : null;
}
function signalParts(s, x, p, ctx) {
  if (!x) return null;
  const k = typeof s.num === 'function' ? s.num(x, p, ctx) : sumOf(x, s.num);
  if (k == null) return null;
  if (s.den == null) return { k, d: null };
  const d = typeof s.den === 'function' ? s.den(x, p, ctx) : x[s.den];
  return d > 0 ? { k, d } : null;
}
// the post's place (0-100) among the others: half of the ties count as below
const percentile = (v, xs) => (100 * (xs.filter((x) => x < v).length + 0.5 * xs.filter((x) => x === v).length)) / xs.length;

// The industry verdict: the post against the network's published average (INDUSTRY), its own column. Always
// says something, with why in industry (the tooltip and Post's Why), never a blank cell.
function industryVerdict(ctx, p, out) {
  const ind = !ctx.story && INDUSTRY[ctx.network];
  const say = (label, text) => { out.industryLabel = label; out.industry = text; };
  if (!ind) {
    return say('No benchmark', ctx.story ? 'There\'s no published average for Stories.'
      : `There's no reliable published average for ${ctx.n.label}, so only your own posts are a yardstick.`);
  }
  if (p.time && ctx.now - p.time < PERF_TOO_SOON) {
    return say('Too soon', `Posted under 12 hours ago: its ${ind.what} still swings a lot. Check back tomorrow.`);
  }
  const mineNow = nowNumbers(ctx, p);
  const d = mineNow[ind.den];
  const k = sumOf(mineNow, ind.num);
  const per = ind.den === 'reach' ? 'people reached' : ind.den === 'emailRecipients' ? 'recipients' : 'views';
  if (ctx.network === 'ghost' && !d) return say('Not a newsletter', 'The published average is for newsletters (click rate), and this post wasn\'t emailed.');
  if (d == null || k == null) {
    const missing = d == null ? { reach: 'reach', emailRecipients: 'recipient count' }[ind.den] || 'view count' : ind.num.map((x) => LABELS[x].toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' or $1');
    return say('No numbers yet', `${ctx.n.label} hasn't given this post's ${missing} yet, so there's no ${ind.what} to compare`
      + ' with the published average. It fills in after the next check that gets them.');
  }
  if (d < INDUSTRY_MIN) return say('Too few to tell', `Only ${d} ${per} so far: under ${INDUSTRY_MIN}, the rate means too little to compare with the published average.`);
  const r = (100 * k) / d;
  const t = ind.typical(p);
  // five steps like vs your usual: About within the range (or 0.67-1.5x one number), Well above/below past twice its edge
  const [lo, hi] = Array.isArray(t) ? t : [t / 1.5, t * 1.5];
  const where = r >= 2 * hi ? 'Well above' : r > hi ? 'Above' : r < lo / 2 ? 'Well below' : r < lo ? 'Below' : 'About';
  const typ = Array.isArray(t) ? `${t[0]}-${t[1]}%` : `${t}%`;
  const mine = `${r.toFixed(r < 1 ? 2 : 1)}%`;
  out.industryLevel = `${where} typical`;
  say(`${where} typical · ${mine} vs ${typ}`,
    `${mine} ${ind.what}; typical ${ctx.network === 'youtube' ? `for a ${POST_KIND.youtube(p)} ` : ''}is ${typ} (${ind.source})`);
}
// One post's verdict: { score, label, why, basis, industry, signals: [{ signal, mine, usual, percentile, weight, posts }] }
// In its first EARLY_HOURS every number is compared at the same age to the hour, from the checks stats.db keeps
// (from 2 hours old: PERF_EARLY_MIN); after that, or when too few other posts have checks from their first hours, at
// the same age in days (from 12 hours old: PERF_TOO_SOON).
const PERF_EARLY_MIN = 2 * 3_600_000;
export function performance(ctx, p) {
  const out = { score: null, level: '', label: '', why: '', basis: '', industry: '', industryLevel: '', industryLabel: '', signals: [] };
  industryVerdict(ctx, p, out);
  if (!p.time) { out.label = 'No posting time'; out.why = 'The network didn\'t say when it went up, so there\'s no telling which posts to compare it with.'; return out; }
  const ref = p.ref || postRef(p.id);
  const kind = ctx.kindOf(p);
  // the others old enough, of the same kind when there are enough of it
  const othersFrom = (minAge) => {
    const others = ctx.list.filter((o) => o !== p && o.time && (o.ref || postRef(o.id)) !== ref && ctx.now - o.time >= minAge);
    const same = kind ? others.filter((o) => ctx.kindOf(o) === kind) : [];
    return same.length >= PERF_MIN ? same : others;
  };
  const pts = ctx.early[ref];
  const young = ctx.now - p.time < EARLY_HOURS * 3_600_000;
  if (young && pts?.length && pts[pts.length - 1][0] * 60_000 >= PERF_EARLY_MIN) {
    const [min, last] = pts[pts.length - 1];
    const mine = { ...p, ...ctx.blank, ...last };
    const at = (o) => { const v = earlyAt(ctx.early[o.ref || postRef(o.id)], min); return v && { ...o, ...ctx.blank, ...v }; };
    if (judge(ctx, p, out, kind, othersFrom(min * 60_000), () => mine, () => at, () => true, `at ${hoursOld(min)} old`)) return out;
  }
  if (ctx.now - p.time < PERF_TOO_SOON) {
    out.label = 'Too soon';
    out.why = ctx.now - p.time < PERF_EARLY_MIN || !pts?.length ? 'Posted under 2 hours ago: check back in a few hours.'
      : `Under 12 hours old, and fewer than ${PERF_MIN} other ${ctx.story ? 'Stories' : `${ctx.n.label} posts`} have numbers from the same hour of their`
        + ' first days to compare with (kept since October 2026, so this fills in as you post). Check back tomorrow.';
    return out;
  }
  const ageNow = ageDays(p.time, ctx.now);
  // its own age: the last day its history has (YouTube's runs 2-3 days behind), else today
  const h = ctx.totals[ref];
  const settled = ageNow >= PERF_SETTLED;
  const age = settled || !h ? ageNow : ageDays(p.time, Date.parse(h.dates[h.dates.length - 1]));
  const mineNow = nowNumbers(ctx, p);
  const mineAt = settled ? mineNow : numbersAt(ctx, p, age) || mineNow;
  const sameAge = (s) => s.aged && !settled;
  // counts only at the same age: the day kept nearest it, or (both settled) as they are now
  const numbers = (s) => (o) => (!s.aged ? nowNumbers(ctx, o) : sameAge(s) ? numbersAt(ctx, o, age)
    : ageDays(o.time, ctx.now) >= PERF_SETTLED ? nowNumbers(ctx, o) : null);
  if (judge(ctx, p, out, kind, othersFrom(PERF_TOO_SOON), (s) => (sameAge(s) ? mineAt : mineNow), numbers, sameAge, `at day ${age}`)) return out;
  out.label = 'Not enough posts yet';
  out.why = `Needs ${PERF_MIN} other ${ctx.story ? 'Stories' : `${ctx.n.label} posts${kind ? ' of the same kind' : ''}`} with these numbers`
    + `${ctx.signals.some((s) => s.aged) && !settled ? ' (counts: at the same age)' : ''} to compare with.`;
  return out;
}
// Ranks the post among `others` on each signal (its numbers: mineFor(s); theirs: numbersFor(s)(o)) and fills in
// out's score, label and why; false (out untouched) when no signal has PERF_MIN posts to compare with
function judge(ctx, p, out, kind, others, mineFor, numbersFor, sameAge, ageText) {
  const near = (a, b) => Math.abs(a.o.time - p.time) - Math.abs(b.o.time - p.time);
  const used = []; // per signal: its weight, this post's value and each compared post's
  const signals = [];
  let aged = false;
  for (const s of ctx.signals) {
    const mine = signalParts(s, mineFor(s), p, ctx);
    if (!mine) continue;
    const numbers = numbersFor(s);
    const base = others.map((o) => ({ o, v: signalParts(s, numbers(o), o, ctx) })).filter((x) => x.v).sort(near).slice(0, PERF_BASE);
    if (base.length < PERF_MIN) continue;
    let val = (x) => x.k;
    if (s.den != null) {
      const sumK = base.reduce((a, x) => a + x.v.k, 0);
      const sumD = base.reduce((a, x) => a + x.v.d, 0);
      const r0 = sumD > 0 ? sumK / sumD : 0;
      val = (x) => (x.k + s.prior * r0) / (x.d + s.prior);
    }
    const xs = base.map((x) => val(x.v));
    const mineV = val(mine);
    const pct = percentile(mineV, xs);
    const usualV = median(xs);
    const raw = mine.d == null ? mine.k : mine.k / mine.d;
    const usual = median(base.map((x) => (x.v.d == null ? x.v.k : x.v.k / x.v.d)));
    signals.push({ id: s.id, signal: s.label, mine: fmtValue(s, raw), usual: fmtValue(s, usual), percentile: Math.round(pct),
      weight: s.weight, posts: base.length, sameAge: sameAge(s), value: mineV, usualValue: usualV });
    used.push({ w: s.weight, pct, by: new Map(base.map((x, i) => [x.o, percentile(xs[i], xs.filter((_, j) => j !== i))])) });
    aged ||= sameAge(s);
  }
  if (!used.length) return false;
  out.signals = signals;
  // each compared post's own weighted average (over the signals it has), and this post's place among them
  const avg = (get) => {
    let w = 0;
    let t = 0;
    for (const u of used) { const v = get(u); if (v != null) { w += u.w; t += u.w * v; } }
    return w ? t / w : null;
  };
  const mineAvg = avg((u) => u.pct);
  const pool = [...new Set(used.flatMap((u) => [...u.by.keys()]))].map((o) => avg((u) => u.by.get(o))).filter((v) => v != null);
  const raw = percentile(mineAvg, pool);
  // fewer posts to compare with = less sure: pulled toward the middle (5 posts -> 71% of the way, 20 -> 91%)
  const n = pool.length;
  out.score = Math.round(50 + (raw - 50) * (n / (n + 2)));
  out.level = PERF_LABELS.find(([min]) => out.score >= min)[1];
  // and by how much: the score as "better than k in 10" of the posts it was compared with
  const k = Math.round(out.score / 10);
  out.label = `${out.level} · ${k >= 10 ? 'better than nearly all' : k <= 0 ? 'below nearly all' : `better than ${k} in 10`}`;
  const ranked = [...out.signals].sort((a, b) => b.percentile - a.percentile);
  // what lifted it and what held it back, the side the verdict is on first
  const up = out.score >= 50;
  const best = ranked.filter((s) => s.percentile >= 65).slice(0, up ? 2 : 1);
  const worst = ranked.reverse().filter((s) => s.percentile <= 35).slice(0, up ? 1 : 2);
  const say = (s) => `${s.signal.toLowerCase()} ${ratioText(s.value, s.usualValue)}`;
  const parts = (up ? [...best, ...worst] : [...worst, ...best]).map(say);
  out.basis = `vs your ${n} nearest ${ctx.story ? 'Stories' : `${ctx.n.label} posts${kind ? ` of the same kind (${kind})` : ''}`}${aged ? `, ${ageText}` : ''}`;
  out.why = `${parts.length ? parts.join(', ') : 'close to your usual on every number'} (${out.basis})`;
  out.why = out.why[0].toUpperCase() + out.why.slice(1);
  return true;
}
// perf_tip: the dashboards' tooltip on the verdict (why, then the industry line)
// perf_tip / perf_industry: the dashboards' tooltips on the two verdicts
const perfFields = (v) => ({ perf: v.score, perf_label: v.label, perf_why: v.why, perf_tip: v.why,
  perf_industry_label: v.industryLabel, perf_industry: v.industry });

// Adds each post's verdicts (perf 0-100, perf_label, perf_why = perf_tip; perf_industry_label, perf_industry) to a network's file before it's written,
// reading the history trackPosts (or ytVideoDays, ghostPostDays) just kept. Instagram's Stories are judged among Stories.
export async function withPerformance(dataDir, network, out) {
  const n = NETWORKS[network];
  if (!n || !SIGNALS[network]) return out;
  try {
    for (const [key, histName, story] of [[n.list, network, false], ...(n.stories ? [[n.stories, `${network}-${n.stories}`, true]] : [])]) {
      const list = out[key];
      if (!Array.isArray(list) || !list.length) continue;
      const ctx = perfContext(network, story, list, await readHistory(dataDir, histName), out);
      for (const p of list) if (p) Object.assign(p, perfFields(performance(ctx, p)));
    }
  } catch (e) { (out.errors ||= []).push(`performance: ${e.message}`); }
  return out;
}

// The last 30 days' posts on every network, best first, from the verdicts withPerformance put in each file
// (GET /performance.json; the weekly summary picks its best posts from it too)
export async function performanceDoc(dataDir) {
  const file = (name) => path.join(dataDir, `${name}.json`);
  const since = Date.now() - 30 * DAY;
  const posts = [];
  for (const [network, n] of Object.entries(NETWORKS)) {
    const f = await readJson(file(network));
    for (const [key, story] of [[n.list, false], ...(n.stories ? [[n.stories, true]] : [])]) {
      for (const p of f[key] || []) {
        if (!p || !(p.time >= since)) continue;
        posts.push({ network: n.label, key: network, title: text(p.caption || p.text || p.title || (story ? 'Story' : ''), 120),
          type: p.type || '', time: p.time, posted_ms: String(p.time), ref: p.ref || postRef(p.id), permalink: p.permalink || '',
          perf: p.perf ?? null, label: p.perf_label || '', why: p.perf_why || '', industryLabel: p.perf_industry_label || '', industry: p.perf_industry || '', tip: p.perf_tip || '' });
      }
    }
  }
  posts.sort((a, b) => (b.perf ?? -1) - (a.perf ?? -1) || b.time - a.time);
  const judged = posts.filter((p) => p.perf != null);
  return { updatedAt: new Date().toISOString(), posts,
    summary: { posts: posts.length, judged: judged.length, doingWell: judged.filter((p) => p.perf >= 60).length,
      aboveIndustry: posts.filter((p) => /^(Well )?above/i.test(p.industryLabel)).length } };
}

export function performanceRoute({ dataDir }) {
  // ---------- every recent post's verdict: GET /performance.json (the Overview dashboard) ----------
  async function performanceJson(req, res) {
    const doc = await performanceDoc(dataDir).catch((e) => ({ posts: [], summary: {}, errors: [e.message] }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc));
  }
  return performanceJson;
}
