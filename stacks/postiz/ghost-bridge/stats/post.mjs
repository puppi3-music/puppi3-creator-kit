// stats/post.mjs: GET /post.json?network=<name>&id=<ref>, one post up close for Grafana's Post dashboard: its numbers
// now and over time, against the typical post at the same age, its verdict, and the site page it leads to.
// GET /page.json?path=/<slug>/, the other way round for the Page dashboard: every post that leads to one site page.

import path from 'node:path';
import { DAY, day, text, readJson, NETWORKS, NETWORK_ALIASES, LABELS, postKeys, postRef, storeFor, readHistory, thin, earlyAt,
  hoursOld, totalsByDate, median, sitePath, tbPipe, EARLY_HOURS } from './history.mjs';
import { SIGNALS, perfContext, performance } from './performance.mjs';

// "Typical" needs this many other posts with a number at the same age
const COMPARE_MIN = 3;

// Without a link: the Ghost post the caption names, else the newest one published in the week before the post
// (Instagram and TikTok captions can't carry links). Only a guess, and the dashboard says so.
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function guessPage(post, ghost) {
  const caption = words(post.caption || post.text || post.title);
  const named = ghost.find((g) => words(g.title).length >= 8 && caption.includes(words(g.title)));
  if (named) return { g: named, from: 'title' };
  const near = ghost.filter((g) => {
    const t = Date.parse(g.published_at);
    return post.time && t <= post.time + 3_600_000 && t >= post.time - 7 * DAY;
  }).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  return near ? { g: near, from: 'time' } : null;
}
// The site page a post leads to: a site post is its own page; else the Ghost post it links to (or its first site
// link), else guessPage's guess. { page ("-" = none), pageTitle, pageUrl, pageFrom (link, title, time or none), pageNote }.
// /post.json and /page.json both use it, so a post counts for the same page in both.
function pageFor(network, p, ghost, canGuess) {
  const bySlug = (page) => ghost.find((g) => `/${g.slug}/` === page);
  const links = p.links || [];
  if (network === 'ghost' && links.length) {
    return { page: links[0], pageTitle: p.title || links[0], pageUrl: p.permalink || '', pageFrom: 'link', pageNote: 'The post itself.' };
  }
  if (links.length) {
    const page = links.find(bySlug) || links[0];
    const g = bySlug(page);
    return { page, pageTitle: g?.title || (page === '/' ? 'Home page' : page), pageUrl: g?.url || '', pageFrom: 'link',
      pageNote: 'The post links to it.' };
  }
  const guess = guessPage(p, ghost);
  if (guess) {
    return { page: `/${guess.g.slug}/`, pageTitle: guess.g.title, pageUrl: guess.g.url || '', pageFrom: guess.from,
      pageNote: guess.from === 'title' ? 'A guess: the post has no link to the site, but names this post.'
        : 'A guess: the post has no link to the site; this is the newest post published in the week before it.' };
  }
  return { page: '-', pageTitle: '', pageUrl: '', pageFrom: 'none',
    pageNote: canGuess ? 'None found: no link to the site in the post, and no post published in the week before it.'
      : 'None found: no link to the site in the post (guessing needs GHOST_API_URL and GHOST_ADMIN_API_KEY).' };
}
// No backslashes in it: Grafana fills variables into a transformation's options as JSON text, where "\." is a bad
// escape that breaks the whole dashboard. "[.]" matches a dot in Grafana's regexes and MySQL's REGEXP alike.
const exact = (list) => `^(${list.map((s) => s.replace(/[^\w .-]/g, '').replace(/\./g, '[.]')).join('|')})$`;

// Is this post doing well? Each number against the typical (median) post on the same network at the same age
// (days since posted), from the history kept for the others. The bridge only has a post's early days if it saw
// the post then, so for most networks this fills in as posts made after the history began get older; YouTube's
// history goes back to each upload, so it works at once. `pick` (?compare=<key>) chooses the number the chart draws,
// from `compareOptions` (the numbers this post has, the usual one first; never empty, for the dashboard's dropdown).
function compareWithOthers(doc, n, p, ref, histFile, list, pick) {
  const posted = p.time ? day(p.time) : '';
  if (!posted) { doc.compareNote = 'The post has no posting time.'; return; }
  const times = { ...histFile.times };
  for (const x of list) if (x.time) times[postRef(x.id)] = x.time;
  const keys = n.perDay ? n.dayKeys : postKeys(n);
  const mine = totalsByDate((histFile.posts || {})[ref], n.perDay);
  const others = Object.entries(histFile.posts || {}).filter(([r]) => r !== ref && times[r])
    .map(([r, h]) => { const totals = totalsByDate(h, n.perDay); return { start: Date.parse(day(times[r])), totals, dates: Object.keys(totals) }; });
  // another post's number at `age` days: that day, else the nearest day kept a day or so either side (as the verdicts'
  // numbersAt: 1 day under a week old, 2 under PERF_SETTLED's 4 weeks, then 3), since the history only covers the days
  // since it began, and few other posts had a day kept at exactly this age
  const otherAt = (o, k, age) => {
    const want = o.start + age * DAY;
    const exact = o.totals[day(want)]?.[k];
    if (exact != null) return exact;
    const tol = age < 7 ? 1 : age < 28 ? 2 : 3;
    let best = null;
    for (const d of o.dates) {
      const off = Math.abs(Date.parse(d) - want) / DAY;
      if (off <= tol && o.totals[d][k] != null && (!best || off < best.off)) best = { off, v: o.totals[d][k] };
    }
    return best ? best.v : null;
  };
  const atAge = (k, age) => {
    const xs = others.map((o) => otherAt(o, k, age)).filter((v) => v != null);
    return xs.length >= COMPARE_MIN ? { typical: median(xs), n: xs.length } : null;
  };
  const ages = Object.keys(mine).filter((d) => d >= posted).map((d) => [d, Math.round((Date.parse(d) - Date.parse(posted)) / DAY)]);
  const has = (k) => ages.some(([d]) => mine[d][k] != null);
  // its first days by the hour (stats.db's checks), against the others at the same minute; the days after those
  const pts = (histFile.early || {})[ref] || [];
  const otherPts = Object.entries(histFile.early || {}).filter(([r]) => r !== ref).map(([, v]) => v);
  const earlyTypical = (k, min) => {
    const xs = otherPts.map((e) => earlyAt(e, min)?.[k]).filter((v) => v != null);
    return xs.length >= COMPARE_MIN ? { typical: median(xs), n: xs.length } : null;
  };
  const lastEarly = pts.length ? p.time + pts[pts.length - 1][0] * 60_000 : -Infinity;
  const days = ages.filter(([d]) => Date.parse(d) > lastEarly);
  const hasEarly = (k) => pts.some(([, v]) => v[k] != null);
  const usual = n.main.find((k) => has(k) || hasEarly(k)) || n.main[0];
  const main = keys.includes(pick) && (has(pick) || hasEarly(pick)) ? pick : usual;
  doc.compareMetric = LABELS[main];
  doc.compareOptions = [usual, ...keys.filter((k) => k !== usual && (has(k) || hasEarly(k)))].map((k) => ({ key: k, label: LABELS[k] }));
  for (const [min, v] of pts) {
    const t = earlyTypical(main, min);
    doc.compare.push({ time: p.time + min * 60_000, 'This post': v[main] ?? null, 'Typical post': t ? t.typical : null });
  }
  for (const [d, age] of days) {
    const t = atAge(main, age);
    doc.compare.push({ time: Date.parse(d), 'This post': mine[d][main] ?? null, 'Typical post': t ? t.typical : null });
  }
  for (const k of keys) {
    // the latest age this post has the number and others have it at the same age: a day past its first days, else
    // its last early check
    const later = [...days].reverse().map(([d, age]) => ({ age: `day ${age}`, v: mine[d][k], t: mine[d][k] != null && atAge(k, age) })).find((x) => x.t);
    const hit = later || [...pts].reverse().map(([min, v]) => ({ age: hoursOld(min), v: v[k], t: v[k] != null && earlyTypical(k, min) })).find((x) => x.t);
    if (!hit) continue;
    doc.verdict.push({ metric: LABELS[k], age: hit.age, mine: hit.v, typical: hit.t.typical,
      ratio: hit.t.typical > 0 ? hit.v / hit.t.typical : null, posts: hit.t.n });
  }
  doc.compareNote = doc.verdict.length ? `Against the median of the other ${n.what || `${n.label} posts`} at the same age (hours since posted in its first ${EARLY_HOURS / 24} days, then days, the nearest day kept).`
    : `Not enough history yet: "typical" needs ${COMPARE_MIN} other ${n.what || `${n.label} posts`} with numbers kept at the same age, `
      + (n.perDay ? n.fewDays : 'which builds up as new posts get older (the bridge keeps each post\'s numbers from the day it first sees it).');
  // nothing to compare: the note alone, so the table (columns from the rows) shows just why, across its width
  if (!doc.verdict.length) doc.verdict.push({ note: doc.compareNote });
}

export function postRoute({ dataDir, ghostPosts }) {
  const file = (name) => path.join(dataDir, `${name}.json`);
  // ---------- one post up close: GET /post.json?network=<name>&id=<ref> (Grafana's Post dashboard) ----------
  // The post as its network's file has it, its numbers now and per day (totals, and the gain each day), and the
  // site page it leads to. page is "-" when there's none, so the dashboard's site queries find nothing.
  // The dashboard's section dropdowns: `pages` (the page found first, then the post's other links, the home page
  // and Ghost's newest posts; ?page=<path> picks one by hand) and `compareOptions` (?compare=<key>). Both never empty:
  // Grafana's dropdown fails on no options.
  const NO_PAGES = [{ path: '-', title: 'No page found' }];
  const NO_COMPARE = [{ key: '', label: 'Nothing to compare yet' }];
  // the verdict's numbers, one row each; a row saying why when there are none (the table can't show an empty list's note)
  const CHART_POINTS = 3000;
  const NO_SIGNALS = [{ signal: 'Nothing to compare yet', mine: '', usual: '', percentile: null, weight: null, posts: null }];
  async function postDoc(network, ref, time, pick = {}) {
    const n = NETWORKS[network];
    const doc = { network, label: n?.label || network, from: n?.from || n?.label || network, ref, found: false, title: '', type: '', time: null, date: '',
      permalink: '', account: '', page: '-', pageTitle: '', pageUrl: '', pageFrom: 'none', pageNote: '', pages: NO_PAGES,
      sources: n ? n.sourceRegex || exact(n.sources) : '^$', numbers: [], totals: [], gains: [], historyNote: '',
      compare: [], verdict: [], compareMetric: '', compareOptions: NO_COMPARE, compareNote: '',
      performance: [], perfSignals: NO_SIGNALS, errors: [] };
    if (!n) {
      doc.errors.push(`The bridge doesn't collect numbers for "${network}" (only ${Object.values(NETWORKS).map((x) => x.label).join(', ')}), so there's nothing to show for this post.`);
      return doc;
    }
    const all = await readJson(file(network));
    let list = all[n.list] || [];
    // by its ref, else (Social's Postiz rows, the timeline markers: Postiz doesn't know the network's id) the post
    // closest to the time given, within 30 minutes
    let p = ref && list.find((x) => postRef(x.id) === ref);
    // an Instagram Story (by its ref only): its own history file, and compared with the other Stories
    let histName = network;
    const story = !p && ref && n.stories && (all[n.stories] || []).find((x) => postRef(x.id) === ref);
    if (story) { p = story; list = all[n.stories]; histName = `${network}-${n.stories}`; }
    if (!p && time) {
      p = list.filter((x) => x.time && Math.abs(x.time - time) <= 30 * 60_000)
        .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
      if (p) doc.ref = ref = postRef(p.id);
    }
    if (!p) {
      doc.errors.push(ref ? `no ${n.label} post "${ref}" in ${network}.json (it keeps only the newest)`
        : `no ${n.label} post within 30 minutes of ${time ? new Date(time).toISOString() : '(no time given)'} in ${network}.json`);
      return doc;
    }
    Object.assign(doc, { found: true, title: p.caption || p.text || p.title || (story ? 'Story' : ''), type: p.type || '', time: p.time,
      date: p.date || '', permalink: p.permalink || '', account: p.account || '' });
    for (const k of postKeys(n)) if (p[k] != null) doc.numbers.push({ metric: LABELS[k], value: p[k] });

    const histFile = await readHistory(dataDir, histName);
    const hist = (histFile.posts || {})[ref] || {};
    const dates = Object.keys(hist).sort();
    if (n.perDay) { // YouTube: real numbers per day; the totals add them up
      const sum = {};
      for (const d of dates) {
        const gain = { time: Date.parse(d) };
        const total = { time: Date.parse(d) };
        for (const k of n.dayKeys) {
          gain[LABELS[k]] = hist[d][k] ?? null;
          total[LABELS[k]] = sum[k] = (sum[k] || 0) + (hist[d][k] || 0);
        }
        doc.gains.push(gain);
        doc.totals.push(total);
      }
      if (dates.length) for (const k of n.dayTotals) doc.numbers.push({ metric: LABELS[k], value: sum[k] });
      doc.historyNote = dates.length ? n.days : n.noDays;
    } else { // the totals kept each day; a day's gain needs the day before (or it's the day it was posted)
      const posted = p.time ? day(p.time) : '';
      for (const d of dates) {
        const now = hist[d];
        const before = hist[day(Date.parse(d) - DAY)];
        const gain = { time: Date.parse(d) };
        const total = { time: Date.parse(d) };
        for (const k of n.keys) {
          const was = before ? before[k] : d === posted ? 0 : null;
          total[LABELS[k]] = now[k] ?? null;
          gain[LABELS[k]] = now[k] != null && was != null && now[k] >= was ? now[k] - was : null;
        }
        doc.totals.push(total);
        doc.gains.push(gain);
      }
      // how far back this post's days go: from when it went up, or only from when they started being recorded
      const long = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      doc.historyNote = !dates.length ? (story ? 'None: only its last numbers were kept (the bridge records a Story per day since October 2026)'
        : 'Not yet: they start with the next hourly check')
        : dates[0] <= posted ? `When it went up (${long(dates[0])})` : `${long(dates[0])} (earlier days weren't recorded)`;
    }

    // every check kept (stats.db), in place of the days they cover (per-day networks: only after the last day their
    // analytics have, since those run behind), so the totals chart has the curve of its first hours and of any
    // take-off; at most about CHART_POINTS (one per stretch, and the last), so a long-lived post's chart stays light
    const rows = storeFor(dataDir).checks(histName, ref);
    const last = histFile.checked[ref];
    if (rows.length && last > rows[rows.length - 1][0]) rows.push([last, rows[rows.length - 1][1]]);
    if (p.time && rows.length) {
      const keys = n.perDay ? n.dayKeys : n.keys;
      const cut = n.perDay && dates.length ? Date.parse(dates[dates.length - 1]) + DAY : -Infinity;
      const span = rows[rows.length - 1][0] - rows[0][0];
      const pts = thin(rows, () => span / CHART_POINTS);
      if (!n.perDay) doc.totals = doc.totals.filter((t) => t.time < rows[0][0] - DAY || t.time > rows[rows.length - 1][0]);
      for (const [time, v] of pts) {
        if (time > cut) doc.totals.push({ time, ...Object.fromEntries(keys.map((k) => [LABELS[k], v[k] ?? null])) });
      }
      doc.totals.sort((a, b) => a.time - b.time);
      const short = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      doc.historyNote += ` · every check since ${short(rows[0][0])}`;
      const surges = histFile.surges[ref] || [];
      if (surges.length) doc.historyNote += ` · took off again ${surges.map((x) => `from ${short(x.start)}`).join(', ')}`;
    }
    compareWithOthers(doc, story ? { ...n, what: `${n.label} Stories` } : n, p, ref, histFile, list, pick.compare);
    if (SIGNALS[network]) {
      const v = performance(perfContext(network, !!story, list, histFile, all), p);
      doc.performance = [{ label: v.label, score: v.score, why: v.why, basis: v.basis, industryLabel: v.industryLabel, industry: v.industry }];
      if (v.signals.length) {
        doc.perfSignals = v.signals.map(({ signal, mine, usual, percentile: pct, weight, posts, sameAge }) =>
          ({ signal, mine, usual, percentile: pct, weight, posts, sameAge: sameAge ? 'same age' : 'as now' }));
      } else doc.perfSignals = [{ ...NO_SIGNALS[0], signal: v.why || v.label }];
    }

    let ghost = [];
    if (ghostPosts) try { ghost = await ghostPosts(); } catch (e) { doc.errors.push(`Ghost: ${e.message}`); }
    const bySlug = (page) => ghost.find((g) => `/${g.slug}/` === page);
    const links = p.links || [];
    Object.assign(doc, pageFor(network, p, ghost, !!ghostPosts));
    const titled = (path) => bySlug(path)?.title || (path === '/' ? 'Home page' : path);
    const found = doc.page === '-' ? { path: '-', title: 'No page found' }
      : { path: doc.page, title: `${doc.pageTitle} (${network === 'ghost' ? 'this post' : doc.pageFrom === 'link' ? 'the post links here' : 'a guess'})` };
    const more = [...links, '/', ...ghost.map((g) => `/${g.slug}/`)].filter((x, i, all) => x !== doc.page && all.indexOf(x) === i);
    doc.pages = [found, ...more.map((x) => ({ path: x, title: titled(x) }))];
    const picked = pick.page && pick.page !== doc.page && (pick.page === '-' ? '-' : sitePath(pick.page).replace(/^\/\/.*/, ''));
    if (picked === '-') Object.assign(doc, { page: '-', pageTitle: '', pageUrl: '', pageFrom: 'picked', pageNote: 'None: picked by hand.' });
    else if (picked) {
      Object.assign(doc, { page: picked, pageTitle: titled(picked), pageUrl: bySlug(picked)?.url || '', pageFrom: 'picked',
        pageNote: 'Picked by hand in the dropdown.' });
    }
    return doc;
  }
  async function post(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    let doc;
    try {
      const network = String(q.get('network') || '').toLowerCase().replace(/[\s-]+/g, '');
      doc = await postDoc(NETWORK_ALIASES[network] || network, postRef(q.get('id')), Number(q.get('time')) || 0,
        { page: q.get('page') || '', compare: q.get('compare') || '' });
    } catch (e) {
      doc = { found: false, page: '-', pages: NO_PAGES, sources: '^$', numbers: [], totals: [], gains: [],
        compareOptions: NO_COMPARE, errors: [e.message] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc));
  }
  return post;
}

// ---------- every post about one site page: GET /page.json?path=/<slug>/&from=<YYYY-MM-DD>&to=<YYYY-MM-DD> ----------
// For Grafana's Page dashboard, the other way round from /post.json: every post that leads to the page by the same
// rules (pageFor: the post itself, a link, else a guess), each with its network's main number and its verdict; the
// page's visitors from..to by network (Ghost's analytics' sources, grouped with each network's source names as the
// Post dashboard's "…of them from" tiles do; other sources by their own name); `rules`, those source names as JSON
// for the dashboard's members-by-network query; and `pages` for its dropdown (Ghost's newest posts and the home page;
// never empty: Grafana's dropdown fails on no options). Several posts on one network leading to the page can't be
// told apart in Ghost's numbers, so visitors and members are per network, not per post.
const sourceName = (n) => (n === NETWORKS.ghost ? 'Newsletter' : n.label);
const SOURCE_RULES = Object.values(NETWORKS).map((n) => ({ n: sourceName(n), r: n.sourceRegex || exact(n.sources) }));
function networkOfSource(source) {
  if (!source || source === 'Direct') return 'Direct / unknown';
  return SOURCE_RULES.find((x) => new RegExp(x.r).test(source))?.n || source;
}
export function pageRoute({ dataDir, ghostPosts }) {
  const file = (name) => path.join(dataDir, `${name}.json`);
  const HOW = { link: 'Links here', title: 'A guess: names the post', time: 'A guess: posted in the week after it' };
  async function pageDoc(q) {
    const doc = { updatedAt: new Date().toISOString(), path: '', title: '', url: '', published: null, found: false,
      posts: [], visitors: [], rules: JSON.stringify(SOURCE_RULES), pages: [{ path: '/', title: 'Home page' }], errors: [] };
    let ghost = [];
    if (ghostPosts) try { ghost = await ghostPosts(); } catch (e) { doc.errors.push(`Ghost: ${e.message}`); }
    doc.pages = [...ghost.map((g) => ({ path: `/${g.slug}/`, title: g.title || `/${g.slug}/` })), ...doc.pages];
    const page = q.get('path') ? sitePath(q.get('path')).replace(/^\/\/.*/, '') : '';
    if (!page) { doc.errors.push('no page: give ?path=/<slug>/'); return doc; }
    const g = ghost.find((x) => `/${x.slug}/` === page);
    Object.assign(doc, { path: page, title: g?.title || (page === '/' ? 'Home page' : page), url: g?.url || '',
      published: g?.published_at ? Date.parse(g.published_at) : null });

    for (const [network, n] of Object.entries(NETWORKS)) {
      const all = await readJson(file(network));
      for (const [key, story] of [[n.list, false], ...(n.stories ? [[n.stories, true]] : [])]) {
        for (const p of all[key] || []) {
          if (!p) continue;
          const pf = pageFor(network, p, ghost, !!ghostPosts);
          if (pf.page !== page) continue;
          const main = n.main[0];
          doc.posts.push({ network: n.label, key: network, time: p.time || null, posted_ms: p.time ? String(p.time) : '',
            title: text(p.caption || p.text || p.title || (story ? 'Story' : ''), 120), type: story ? 'Story' : p.type || '',
            ref: p.ref || postRef(p.id), permalink: p.permalink || '',
            how: network === 'ghost' ? 'The post itself' : HOW[pf.pageFrom] || pf.pageFrom, guess: pf.pageFrom !== 'link',
            main: p[main] ?? null, mainLabel: LABELS[main] || main, perf: p.perf ?? null, verdict: p.perf_label || '', why: p.perf_tip || '' });
        }
      }
    }
    doc.posts.sort((a, b) => (a.time || 0) - (b.time || 0));
    doc.found = !!(g || doc.posts.length);

    // the page's visitors by where they came from (Ghost's analytics), grouped into networks
    const to = /^\d{4}-\d\d-\d\d$/.test(q.get('to') || '') ? q.get('to') : day(Date.now());
    const from = /^\d{4}-\d\d-\d\d$/.test(q.get('from') || '') ? q.get('from') : day(Date.parse(to) - 90 * DAY);
    const tz = /^[\w/+-]+$/.test(q.get('timezone') || '') ? q.get('timezone') : 'Etc/UTC';
    try {
      const rows = await tbPipe('api_top_sources', { date_from: from, date_to: to, timezone: tz, pathname: page, limit: '1000' });
      const by = {};
      for (const r of rows) {
        const name = networkOfSource(String(r.source ?? ''));
        by[name] = (by[name] || 0) + (Number(r.visits) || 0);
      }
      const networks = new Set(SOURCE_RULES.map((x) => x.n));
      doc.visitors = Object.entries(by).map(([network, visitors]) => ({ network, visitors, isNetwork: networks.has(network) }))
        .sort((a, b) => b.visitors - a.visitors);
    } catch (e) { doc.errors.push(`visitors: ${e.message}`); }
    return doc;
  }
  async function page(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const doc = await pageDoc(q).catch((e) => ({ path: '', posts: [], visitors: [], rules: '[]', pages: [{ path: '/', title: 'Home page' }], errors: [e.message] }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(doc));
  }
  return page;
}
