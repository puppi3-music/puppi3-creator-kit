// stats/timing.mjs: GET /timing.json, when posts do best on each network, by weekday and part of the day (the
// Platforms dashboard's "When to post").

import path from 'node:path';
import { DAY, day, readJson, NETWORKS, LABELS, POST_KIND, postRef, storeFor, totalsByDate,
  median } from './history.mjs';

// When do posts do best? For each network, its posts at least 3 days old and one number each (the main one, or the
// one picked: `picks` = {network: key}, from ?<network>=<key>), in one model per network, so each part is measured
// with the others held steady (weekday and part of the day in SITE_TIMEZONE [Etc/UTC]):
//  1. Same age: each post's number when it was AT_AGE (3) days old, from its days in stats.db (or 1-2 days
//     later over the growth between). Posts from before the history began: their total now / growth(age now), growth =
//     the median rise from day 3 to that age among posts the history has at both (rising only; past the oldest age
//     known, the last; none known yet: the total as it is), plus a model term for "estimated" in case that runs off.
//  2. Account growth: a smooth trend over posting time (straight + curved), so busy recent weeks with more followers
//     don't flatter their slots. It also soaks up what the age guess misses (a post's age follows from its time).
//  3. Weekday and part of the day together, so Fridays aren't credited for being mostly evenings.
//  4. The kind of post (POST_KIND: Reel/Photo/..., Short/Video/Live, Track/Mix) where a network has more than one.
// On a log scale (2x and 0.5x are as far from usual) against the network's median post, clamped to 0.05-20x. A
// Student-t fit (TIMING_NU) gives a one-off hit less pull than a plain average would. Slot effects start at 0 (no
// difference) with spread `spread`: measured from the data (empirical Bayes: the value in SPREAD_GRID that best explains
// every network's posts at once, each on its main number so one dropdown doesn't move the other networks; nudged toward
// SLOT_SPREAD, all of it with fewer than SPREAD_MIN_POSTS). That pull toward "no difference" also keeps the many cells
// from throwing up a lucky winner. Each cell = that slot (or kind) against the average of its table's cells with posts:
// exp(estimate), and the confidence = how likely it's really on that side, High and Medium against bars set per table
// by chance (chanceFor): a table has up to 11 cells, so even a strict 95% per cell lit some cell in about 1 network in 3
// for made-up posts with no pattern. The bars are how sure the surest cell gets when the posts' slots are shuffled
// (PERM_RUNS times, in the background): High = surer than 95% of those, Medium = 80%, never under 95% / 80%; until
// they're worked out, 95% / 80%. 1 post is always Low. Each cell also has "<cell> tip" (a tooltip: estimate, posts,
// plain median, confidence, how often chance does as well) and "<cell> style" (CSS for Grafana's "Styling from field":
// Low faded and striped, Medium a little faded, no posts uncoloured); "Posts tip" says how many were measured at day 3
// and what was allowed for. `kinds` = the kind of post table, one row per network and kind (networks with two kinds or
// more). `options` lists each network's numbers
// with 3 posts and a median above 0, main first, for the dashboard's dropdowns (a network with none gets one
// empty-key "Not enough posts yet").
const AT_AGE = 3;
const SLOT_SPREAD = 0.3; // log scale: before the data, slots differ by about 1.35x either way
const SPREAD_GRID = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
const SPREAD_MIN_POSTS = 30;
const TIMING_NU = 4; // Student-t degrees of freedom: lower = hits count for less
const KIND_SPREAD = 0.7; // kinds of post can differ a lot (a Reel and a photo)
const PERM_RUNS = 200; // shuffles per table for the chance bars

const LOW_CELL = { opacity: '0.6', fontStyle: 'italic',
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.28) 0 5px, transparent 5px 10px)' };
const MEDIUM_CELL = { opacity: '0.85' };
const EMPTY_CELL = { background: 'transparent', color: 'inherit' }; // no posts: not the threshold's red
// standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7)
const normCdf = (z) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
};
const logRatio = (r) => Math.log(Math.min(20, Math.max(0.05, r))); // a 0 (or a fluke) can't run off to infinity
const sd = (xs) => {
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
// small dense linear algebra (a model has ~20 terms, a few hundred posts)
function chol(A) {
  const L = A.map(() => new Array(A.length).fill(0));
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}
function cholSolve(L, b) {
  const y = [...b];
  for (let i = 0; i < y.length; i++) { for (let k = 0; k < i; k++) y[i] -= L[i][k] * y[k]; y[i] /= L[i][i]; }
  for (let i = y.length - 1; i >= 0; i--) { for (let k = i + 1; k < y.length; k++) y[i] -= L[k][i] * y[k]; y[i] /= L[i][i]; }
  return y;
}
const cholInverse = (L) => L.map((_, i) => cholSolve(L, L.map((__, j) => (i === j ? 1 : 0))));
// Bayesian linear model with a Student-t likelihood (by reweighting): y ~ X b, b_i ~ N(0, prior_i^2). Returns the
// posterior mean and covariance, the noise and each post's weight, and how well this prior explains y (log marginal
// likelihood, Gaussian at the final weights), for choosing the slot spread.
function fitModel(X, y, prior) {
  const n = y.length;
  const p = prior.length;
  // the posterior for given weights and noise: precision A = prior^-2 + X'WX/s2, mean = A^-1 X'Wy/s2
  const solve = (w, s2) => {
    const A = prior.map((ps, i) => prior.map((_, j) => (i === j ? 1 / ps ** 2 : 0)));
    const b = new Array(p).fill(0);
    for (let r = 0; r < n; r++) {
      for (let i = 0; i < p; i++) {
        if (!X[r][i]) continue;
        b[i] += w[r] * X[r][i] * y[r] / s2;
        for (let j = 0; j < p; j++) A[i][j] += w[r] * X[r][i] * X[r][j] / s2;
      }
    }
    const L = chol(A);
    return { L, b, mu: cholSolve(L, b), cov: cholInverse(L) };
  };
  let w = y.map(() => 1);
  let s2 = Math.max(0.04, sd(y) ** 2);
  for (let it = 0; it < 25; it++) {
    const { mu, cov } = solve(w, s2);
    const res = X.map((x, r) => y[r] - x.reduce((a, v, i) => a + v * mu[i], 0));
    // fitted terms' worth of freedom used up (trace of the hat matrix), so the noise isn't underestimated
    const used = p - prior.reduce((a, ps, i) => a + cov[i][i] / ps ** 2, 0);
    const next = Math.max(0.04, res.reduce((a, r, i) => a + w[i] * r * r, 0) / Math.max(1, n - used));
    w = res.map((r) => (TIMING_NU + 1) / (TIMING_NU + r * r / next));
    const done = Math.abs(next - s2) < 1e-6;
    s2 = next;
    if (done) break;
  }
  const { L, b, mu, cov } = solve(w, s2);
  // y ~ N(0, C), C = X P X' + D (D = s2/w), worked out in the model's terms rather than the posts' (fast with
  // hundreds of posts): log|C| = log|D| + log|P| + log|A|, y'C^-1 y = y'D^-1 y - b'A^-1 b
  const logdet = y.reduce((a, _, i) => a + Math.log(s2 / w[i]), 0) + prior.reduce((a, ps) => a + 2 * Math.log(ps), 0)
    + 2 * L.reduce((a, row, i) => a + Math.log(row[i]), 0);
  const quad = y.reduce((a, v, i) => a + w[i] * v * v / s2, 0) - b.reduce((a, v, i) => a + v * mu[i], 0);
  const logml = -0.5 * (quad + logdet + n * Math.log(2 * Math.PI));
  return { mu, cov, s2, logml };
}
const DAYPARTS = [[0, 'Night (0-6)'], [6, 'Morning (6-12)'], [12, 'Afternoon (12-18)'], [18, 'Evening (18-24)']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// A post's number at each age the history has it: {age in days: total}, ages counted between UTC days as
// compareWithOthers does. YouTube's per-day history only adds up right when it reaches back to the upload.
function numbersByAge(p, h, key, perDay) {
  const totals = totalsByDate(h, perDay);
  const dates = Object.keys(totals);
  if (!dates.length || (perDay && dates[0] > day(p.time + DAY))) return {};
  const start = Date.parse(day(p.time));
  const out = {};
  for (const d of dates) {
    const age = Math.round((Date.parse(d) - start) / DAY);
    if (age >= 0 && totals[d][key] != null) out[age] = totals[d][key];
  }
  return out;
}
// Each post's number at AT_AGE days (measured, or worked back from its total now), with its slot and kind
function timingPosts(network, n, list, hist, key, fmt, now) {
  const ages = list.map((p) => numbersByAge(p, hist.posts?.[postRef(p.id)], key, n.perDay));
  // growth from day AT_AGE to each later age: the median rise among posts known at both, never falling
  const rise = [];
  let curvePosts = 0;
  for (const a of ages) if (a[AT_AGE] > 0 && Object.keys(a).some((x) => x > AT_AGE)) curvePosts++;
  // (reduce, not Math.max(...): spreading thousands of values overflows the stack)
  const oldest = ages.reduce((m, a) => Object.keys(a).reduce((x, k) => Math.max(x, Number(k)), m), AT_AGE);
  let g = 1;
  let known = AT_AGE;
  for (let age = AT_AGE; age <= oldest; age++) {
    const r = ages.filter((a) => a[AT_AGE] > 0 && a[age] != null).map((a) => a[age] / a[AT_AGE]);
    if (r.length >= 3) { g = Math.max(g, median(r)); known = age; }
    rise[age] = g;
  }
  const growth = (age) => rise[Math.min(Math.max(age, AT_AGE), known)] || 1;
  const kindOf = POST_KIND[network] || (() => '');
  const out = [];
  list.forEach((p, i) => {
    const a = ages[i];
    const near = [AT_AGE, AT_AGE + 1, AT_AGE + 2].find((x) => a[x] != null);
    let v;
    let measured = false;
    if (near != null) { v = a[near] / growth(near); measured = true; } else if (p[key] != null) {
      v = p[key] / growth(Math.round((Date.parse(day(now)) - Date.parse(day(p.time))) / DAY));
    } else return;
    const parts = Object.fromEntries(fmt.formatToParts(new Date(p.time)).map((x) => [x.type, x.value]));
    const hour = Number(parts.hour) % 24;
    out.push({ time: p.time, v, measured, weekday: parts.weekday,
      daypart: [...DAYPARTS].reverse().find(([h]) => hour >= h)[1], kind: kindOf(p) || 'Other' });
  });
  return { posts: out, curvePosts, known };
}
// The model's columns and each post's row, for one network's posts
function timingModel(posts, spread) {
  const mid = median(posts.map((p) => p.v));
  const base = mid > 0 ? mid : posts.reduce((a, p) => a + p.v, 0) / posts.length;
  if (!(base > 0)) return null;
  const t0 = posts.reduce((m, p) => Math.min(m, p.time), Infinity);
  const span = posts.reduce((m, p) => Math.max(m, p.time), -Infinity) - t0;
  const ts = posts.map((p) => (span > DAY ? (p.time - t0) / span - 0.5 : 0));
  const tt = ts.reduce((a, t) => a + t * t, 0) / ts.length;
  const kinds = [...new Set(posts.map((p) => p.kind))];
  const slots = [...WEEKDAYS, ...DAYPARTS.map(([, s]) => s)];
  const cols = [['intercept', 2], ['trend', 1.5], ['trend curve', 1], ['estimated', 0.5],
    ...slots.map((s) => [s, spread]), ...(kinds.length > 1 ? kinds.map((k) => [`kind ${k}`, KIND_SPREAD]) : [])];
  const at = Object.fromEntries(cols.map(([c], i) => [c, i]));
  const X = posts.map((p, r) => {
    const x = new Array(cols.length).fill(0);
    x[0] = 1;
    x[1] = ts[r];
    x[2] = ts[r] * ts[r] - tt;
    x[3] = p.measured ? 0 : 1;
    x[at[p.weekday]] = 1;
    x[at[p.daypart]] = 1;
    if (kinds.length > 1) x[at[`kind ${p.kind}`]] = 1;
    return x;
  });
  const y = posts.map((p) => logRatio(p.v / base));
  return { X, y, prior: cols.map(([, s]) => s), at, base, kinds };
}
// The three tables: which cells, the post's field, the model's column for a cell, and how a tip names the average
const TABLES = {
  weekday: { names: () => WEEKDAYS, col: (s) => s, what: 'weekday' },
  daypart: { names: () => DAYPARTS.map(([, s]) => s), col: (s) => s, what: 'part of the day' },
  kind: { names: (m) => m.kinds, col: (k) => `kind ${k}`, what: 'kind of post' },
};
// Each cell of a table against the average of the table's cells with posts: posts, estimate (log scale) and how
// likely it's really on that side
function cellsOf(fit, m, posts, table) {
  const { names, col } = TABLES[table];
  const count = {};
  for (const p of posts) count[p[table]] = (count[p[table]] || 0) + 1;
  const idx = names(m).filter((s) => count[s]).map((s) => m.at[col(s)]);
  return Object.fromEntries(names(m).map((s) => {
    if (!count[s]) return [s, { n: 0 }];
    const c = new Map(idx.map((i) => [i, -1 / idx.length]));
    c.set(m.at[col(s)], (c.get(m.at[col(s)]) || 0) + 1);
    let est = 0;
    let vari = 0;
    for (const [i, ci] of c) {
      est += ci * fit.mu[i];
      for (const [j, cj] of c) vari += ci * fit.cov[i][j] * cj;
    }
    return [s, { n: count[s], est, sure: normCdf(Math.abs(est) / Math.sqrt(Math.max(vari, 1e-12))) }];
  }));
}
// Chance bars: how sure the surest cell (of 2 posts or more) of a table gets when its posts' cells are shuffled, the
// rest of each post kept. Worked out in the background, a shuffle at a time so the bridge keeps answering; cached by
// network, table, number, post count, spread and day. null until ready.
const chance = new Map();
const chanceQueue = [];
let chanceBusy = false;
const mulberry32 = (a) => () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function chanceFor(key, posts, spread, table) {
  const got = chance.get(key);
  if (got) return got.pending ? null : got;
  if (chance.size > 300) chance.delete(chance.keys().next().value);
  chance.set(key, { pending: true });
  chanceQueue.push({ key, posts, spread, table });
  if (!chanceBusy) runChance();
  return null;
}
async function runChance() {
  chanceBusy = true;
  try {
    while (chanceQueue.length) {
      const { key, posts, spread, table } = chanceQueue.shift();
      try {
        const rand = mulberry32(posts.length * 31 + table.length);
        const labels = posts.map((p) => p[table]);
        const maxima = [];
        for (let r = 0; r < PERM_RUNS; r++) {
          for (let i = labels.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [labels[i], labels[j]] = [labels[j], labels[i]];
          }
          const shuffled = posts.map((p, i) => ({ ...p, [table]: labels[i] }));
          const m = timingModel(shuffled, spread);
          const cells = Object.values(cellsOf(fitModel(m.X, m.y, m.prior), m, shuffled, table));
          maxima.push(cells.reduce((a, c) => (c.n >= 2 ? Math.max(a, c.sure) : a), 0));
          await new Promise((ok) => setImmediate(ok));
        }
        maxima.sort((a, b) => a - b);
        const q = (f) => maxima[Math.min(maxima.length - 1, Math.floor(f * maxima.length))];
        chance.set(key, { maxima, high: Math.max(0.95, q(0.95)), medium: Math.max(0.8, q(0.8)) });
      } catch { chance.set(key, { pending: true }); } // plain bars for it from now on
    }
  } finally { chanceBusy = false; }
}
// Keeps the files read for a minute: Grafana asks for timing.json once per panel and dropdown
let timingCache = { at: 0, dir: '', data: null };
async function timingData(dataDir) {
  if (timingCache.dir === dataDir && Date.now() - timingCache.at < 60_000) return timingCache.data;
  const data = {};
  for (const [network, n] of Object.entries(NETWORKS)) {
    data[network] = { list: ((await readJson(path.join(dataDir, `${network}.json`)))[n.list] || []).filter((p) => p.time),
      hist: storeFor(dataDir).history(network) };
  }
  timingCache = { at: Date.now(), dir: dataDir, data, spread: null };
  return data;
}
async function timingDoc(dataDir, tz, picks = {}) {
  const now = Date.now();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const doc = { updatedAt: new Date(now).toISOString(), timezone: tz, spread: SLOT_SPREAD, spreadFrom: 'default',
    options: {}, weekdays: [], dayparts: [], kinds: [], errors: [] };
  const data = await timingData(dataDir);
  const nets = [];
  for (const [network, n] of Object.entries(NETWORKS)) {
    const list = data[network].list.filter((p) => p.time < now - AT_AGE * DAY);
    // a number counts once 3 posts have it and the usual post's isn't 0 (nothing to compare against)
    const usable = [...new Set([...n.main, ...n.keys])].filter((k) => {
      const v = list.filter((p) => p[k] != null).map((p) => p[k]);
      return v.length >= 3 && median(v) > 0;
    });
    // never empty: Grafana's dropdown fails on no options ("Unexpected field for variable")
    doc.options[network] = usable.length ? usable.map((k) => ({ key: k, label: LABELS[k] })) : [{ key: '', label: 'Not enough posts yet' }];
    const usual = n.main.find((k) => usable.includes(k));
    if (!usual) continue;
    const main = usable.includes(picks[network]) ? picks[network] : usual;
    const at = (key) => timingPosts(network, n, list, data[network].hist, key, fmt, now);
    nets.push({ network, n, main, usual: at(usual), picked: main === usual ? null : at(main) });
  }
  // the slot spread that best explains all networks' posts (on their main numbers), nudged toward SLOT_SPREAD
  const pooled = nets.reduce((a, x) => a + x.usual.posts.length, 0);
  if (pooled >= SPREAD_MIN_POSTS) {
    if (timingCache.spread == null) {
      let best = -Infinity;
      for (const s of SPREAD_GRID) {
        let score = -0.5 * (Math.log(s / SLOT_SPREAD) / 0.5) ** 2;
        for (const x of nets) {
          const m = x.usual.posts.length >= 3 && timingModel(x.usual.posts, s);
          if (m) score += fitModel(m.X, m.y, m.prior).logml;
        }
        if (score > best) { best = score; timingCache.spread = s; }
      }
    }
    doc.spread = timingCache.spread;
    doc.spreadFrom = 'data';
  }
  const fx = (v) => `${v.toFixed(1)}×`;
  const today = day(now);
  for (const { network, n, main, usual, picked } of nets) {
    const { posts, curvePosts, known } = picked || usual;
    const m = posts.length >= 3 && timingModel(posts, doc.spread);
    if (!m) continue;
    const fit = fitModel(m.X, m.y, m.prior);
    const measured = posts.filter((p) => p.measured).length;
    const kindCount = (k) => posts.filter((p) => p.kind === k).length;
    const allowed = ['account growth over time', 'the other table\'s slots', ...(m.kinds.length > 1 ? [`the kind of post (${m.kinds.map((k) => `${k} ${kindCount(k)}`).join(', ')})`] : [])];
    // each table's bars, and how often chance does as well as a cell
    const bars = Object.fromEntries(Object.keys(TABLES).map((t) => [t, (t !== 'kind' || m.kinds.length > 1)
      && chanceFor([network, t, main, posts.length, doc.spread, today].join('|'), posts, doc.spread, t)]));
    const postsTip = `${posts.length} posts at least ${AT_AGE} days old: ${measured} measured at ${AT_AGE} days old`
      + (posts.length > measured ? `, ${posts.length - measured} worked back from their total now `
        + (curvePosts >= 3 ? `(growth after day ${AT_AGE} from ${curvePosts} posts, known to day ${known})` : '(no growth curve yet: their totals as they are)') : '')
      + `. Allowing for ${allowed.join(', ')}. Slot spread ${doc.spread} (${doc.spreadFrom === 'data' ? 'measured from all networks\' posts' : 'default: too few posts to measure'}).`
      + ` High needs ${['weekday', 'daypart'].map((t) => (bars[t] ? `${Math.floor(bars[t].high * 1000) / 10}%` : '95% (not yet checked against chance)')).join(' by weekday, ')} by part of the day.`;
    // one cell's value, tooltip and style
    const cell = (table, s, c) => {
      if (!c.n) return [null, 'No posts at this time yet', EMPTY_CELL];
      const b = bars[table] || { high: 0.95, medium: 0.8 };
      const level = c.n < 2 ? 'Low' : c.sure >= b.high ? 'High' : c.sure >= b.medium ? 'Medium' : 'Low';
      const mine = posts.filter((p) => p[table] === s);
      const plain = median(mine.map((p) => p.v / m.base));
      const luck = bars[table] && 100 * bars[table].maxima.filter((x) => x >= c.sure).length / bars[table].maxima.length;
      const tip = `${fx(Math.exp(c.est))} the average ${TABLES[table].what}, from ${c.n === 1 ? '1 post' : `${c.n} posts`}`
        + (c.n > 1 ? ` (their plain median: ${fx(plain)} the usual post)` : ` (it got ${fx(plain)} the usual post)`)
        + `. Confidence: ${level}, ${Math.floor(c.sure * 100)}% likely ${c.est >= 0 ? 'above' : 'below'} average.`
        + (luck == null || c.n < 2 ? '' : ` With the posts' ${table === 'kind' ? 'kinds' : 'times'} shuffled, some cell is this sure in ${luck < 1 ? 'fewer than 1' : `about ${Math.round(luck)}`} of 100 tables.`);
      return [Math.exp(c.est), tip, level === 'Low' ? LOW_CELL : level === 'Medium' ? MEDIUM_CELL : {}];
    };
    const row = (table) => {
      const cells = cellsOf(fit, m, posts, table);
      return { Network: n.label, Metric: LABELS[main], Posts: posts.length, 'Posts tip': postsTip,
        ...Object.fromEntries(Object.entries(cells).flatMap(([s, c]) => {
          const [v, tip, style] = cell(table, s, c);
          return [[s, v], [`${s} tip`, tip], [`${s} style`, style]];
        })) };
    };
    doc.weekdays.push(row('weekday'));
    doc.dayparts.push(row('daypart'));
    // the kind of post: one row per kind (kinds differ by network)
    if (m.kinds.length > 1) {
      for (const [k, c] of Object.entries(cellsOf(fit, m, posts, 'kind'))) {
        const [v, tip, style] = cell('kind', k, c);
        doc.kinds.push({ Network: n.label, Metric: LABELS[main], Kind: k, Posts: c.n, 'vs average': v, 'vs average tip': tip, 'vs average style': style });
      }
    }
  }
  return doc;
}

export function timingRoute({ dataDir, env }) {
  async function timing(req, res) {
    let doc;
    const q = new URL(req.url, 'http://x').searchParams;
    const picks = Object.fromEntries(Object.keys(NETWORKS).map((n) => [n, q.get(n) || '']));
    try { doc = await timingDoc(dataDir, env.SITE_TIMEZONE || 'Etc/UTC', picks); } catch (e) { doc = { options: {}, weekdays: [], dayparts: [], kinds: [], errors: [e.message] }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc));
  }
  return timing;
}
