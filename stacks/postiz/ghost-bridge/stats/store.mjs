// Each post's numbers over time, in one SQLite file: data/stats.db (stats/history.mjs uses it).
// Every check of every post is kept for good: all of them in a post's first days and while it's taking off (what
// stats/post.mjs compares by the hour), and after that a row only when a number changed since the post's last one (an
// unchanged check just moves posts.last_checked), so an old post that hardly moves costs nothing. Tables:
//  - posts:  one row per post: when it went up, when it was last checked and its numbers then, when its per-day
//            numbers were last fetched (YouTube's and Ghost's: the API has real days)
//  - checks: every change: t (ms) and its numbers as JSON ({ <key>: n }); a post's numbers at any time = its last
//            row at or before it (good up to last_checked)
//  - days:   per UTC day: the day's last numbers (networks that only give totals), or the API's real per-day numbers
//            (YouTube, Ghost)
//  - surges: an older post taking off (stats/history.mjs trackEarly): from when, until when it's watched closely, on
//            which number, and where it was before
//  - account: each network's account totals (followers, members, all-time plays...) at every check, not just the day's
//            last: t (ms) and the numbers as JSON; the last ACCOUNT_CHECK_DAYS [90] days (the network files keep a
//            number per day for longer)
//  - meta:   the schema version and which old JSON files were brought in
// The SQL is plain on purpose (BIGINT ms, TEXT dates and JSON, ON CONFLICT upserts, nothing SQLite-only past the
// PRAGMAs at open), so moving to PostgreSQL later means copying the tables and changing only this file.
// Needs Node 22.13+ (node:sqlite without a flag); with an older one every call throws "needs Node 22.13+".

import fs from 'node:fs';
import path from 'node:path';

let sqlite = null;
let loadError = '';
try { sqlite = await import('node:sqlite'); } catch (e) { loadError = e.message; }

const SCHEMA = 1;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };

const stores = new Map();
// One store per data folder (production's /data; tests use their own)
export function openStore(dataDir, { backups = 7, log = () => {} } = {}) {
  if (stores.has(dataDir)) return stores.get(dataDir);
  if (!sqlite) throw new Error(`the stats database needs Node 22.13+ (rebuild the bridge image): ${loadError}`);
  const file = path.join(dataDir, 'stats.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS posts (network TEXT NOT NULL, ref TEXT NOT NULL, posted_ms BIGINT, last_checked BIGINT,
      last_vals TEXT, fetched_ms BIGINT, PRIMARY KEY (network, ref));
    CREATE TABLE IF NOT EXISTS checks (network TEXT NOT NULL, ref TEXT NOT NULL, t BIGINT NOT NULL, vals TEXT NOT NULL,
      PRIMARY KEY (network, ref, t));
    CREATE TABLE IF NOT EXISTS days (network TEXT NOT NULL, ref TEXT NOT NULL, date TEXT NOT NULL, vals TEXT NOT NULL,
      PRIMARY KEY (network, ref, date));
    CREATE TABLE IF NOT EXISTS surges (network TEXT NOT NULL, ref TEXT NOT NULL, start BIGINT NOT NULL, until BIGINT NOT NULL,
      metric TEXT NOT NULL, from_t BIGINT, from_v DOUBLE PRECISION, PRIMARY KEY (network, ref, start));
    CREATE TABLE IF NOT EXISTS account (network TEXT NOT NULL, t BIGINT NOT NULL, vals TEXT NOT NULL, PRIMARY KEY (network, t));
  `);
  const q = (sql) => db.prepare(sql);
  const st = {
    getMeta: q('SELECT value FROM meta WHERE name = ?'),
    setMeta: q('INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value'),
    post: q('SELECT posted_ms, last_checked, last_vals, fetched_ms FROM posts WHERE network = ? AND ref = ?'),
    posts: q('SELECT ref, posted_ms, last_checked, fetched_ms FROM posts WHERE network = ?'),
    upPost: q(`INSERT INTO posts (network, ref, posted_ms, last_checked, last_vals) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (network, ref) DO UPDATE SET posted_ms = COALESCE(excluded.posted_ms, posts.posted_ms),
        last_checked = excluded.last_checked, last_vals = excluded.last_vals`),
    upTime: q(`INSERT INTO posts (network, ref, posted_ms) VALUES (?, ?, ?)
      ON CONFLICT (network, ref) DO UPDATE SET posted_ms = COALESCE(excluded.posted_ms, posts.posted_ms)`),
    upFetched: q(`INSERT INTO posts (network, ref, fetched_ms) VALUES (?, ?, ?)
      ON CONFLICT (network, ref) DO UPDATE SET fetched_ms = excluded.fetched_ms`),
    addCheck: q(`INSERT INTO checks (network, ref, t, vals) VALUES (?, ?, ?, ?)
      ON CONFLICT (network, ref, t) DO UPDATE SET vals = excluded.vals`),
    addCheckKeep: q('INSERT INTO checks (network, ref, t, vals) VALUES (?, ?, ?, ?) ON CONFLICT (network, ref, t) DO NOTHING'),
    checks: q('SELECT t, vals FROM checks WHERE network = ? AND ref = ? AND t >= ? AND t <= ? ORDER BY t'),
    checkBefore: q('SELECT t, vals FROM checks WHERE network = ? AND ref = ? AND t < ? ORDER BY t DESC LIMIT 1'),
    checkAt: q('SELECT t, vals FROM checks WHERE network = ? AND ref = ? AND t <= ? ORDER BY t DESC LIMIT 1'),
    firstCheck: q('SELECT t, vals FROM checks WHERE network = ? AND ref = ? ORDER BY t LIMIT 1'),
    early: q(`SELECT c.ref, c.t, c.vals FROM checks c JOIN posts p ON p.network = c.network AND p.ref = c.ref
      WHERE c.network = ? AND p.posted_ms IS NOT NULL AND c.t <= p.posted_ms + ? ORDER BY c.ref, c.t`),
    upDay: q(`INSERT INTO days (network, ref, date, vals) VALUES (?, ?, ?, ?)
      ON CONFLICT (network, ref, date) DO UPDATE SET vals = excluded.vals`),
    addDayKeep: q('INSERT INTO days (network, ref, date, vals) VALUES (?, ?, ?, ?) ON CONFLICT (network, ref, date) DO NOTHING'),
    dropDays: q('DELETE FROM days WHERE network = ? AND ref = ?'),
    days: q('SELECT ref, date, vals FROM days WHERE network = ? ORDER BY ref, date'),
    surges: q('SELECT ref, start, until, metric, from_t, from_v FROM surges WHERE network = ? ORDER BY ref, start'),
    lastSurge: q('SELECT start, until, metric, from_t, from_v FROM surges WHERE network = ? AND ref = ? ORDER BY start DESC LIMIT 1'),
    addSurge: q(`INSERT INTO surges (network, ref, start, until, metric, from_t, from_v) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (network, ref, start) DO UPDATE SET until = excluded.until`),
    setUntil: q('UPDATE surges SET until = ? WHERE network = ? AND ref = ? AND start = ?'),
    active: q('SELECT DISTINCT ref FROM surges WHERE network = ? AND until >= ?'),
    count: q('SELECT COUNT(*) AS n FROM checks'),
    addAccount: q(`INSERT INTO account (network, t, vals) VALUES (?, ?, ?)
      ON CONFLICT (network, t) DO UPDATE SET vals = excluded.vals`),
    dropAccount: q('DELETE FROM account WHERE network = ? AND t < ?'),
    account: q('SELECT t, vals FROM account WHERE network = ? AND t >= ? ORDER BY t'),
    addAccountKeep: q('INSERT INTO account (network, t, vals) VALUES (?, ?, ?) ON CONFLICT (network, t) DO NOTHING'),
  };
  // several writes as one (all or nothing, and one disk sync)
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  if (!st.getMeta.get('schema')) st.setMeta.run('schema', String(SCHEMA));

  const store = {
    file,
    // A check of each item's numbers (`keys`, the ones it has) at t (its `checked` time, else now): a new row when
    // they differ from the post's last ones, or always in its first `everyFor` ms or when it's in `always` (refs).
    // Returns how many rows were added.
    recordChecks(network, items, keys, now = Date.now(), { everyFor = 0, always = new Set() } = {}) {
      return tx(() => {
        let added = 0;
        for (const { ref, time, checked, vals } of items.map((p) => ({ ...p, vals: Object.fromEntries(keys.filter((k) => p[k] != null).map((k) => [k, p[k]])) }))) {
          if (!ref || !Object.keys(vals).length) continue;
          const t = Number.isFinite(checked) && checked <= now ? checked : now;
          const text = JSON.stringify(vals);
          const was = st.post.get(network, ref);
          if (was?.last_checked != null && t < was.last_checked) continue; // an older reading than one already kept
          const posted = Number.isFinite(time) ? time : was?.posted_ms;
          if (was?.last_vals !== text || always.has(ref) || (posted != null && t - posted <= everyFor)) { st.addCheck.run(network, ref, t, text); added++; }
          st.upPost.run(network, ref, Number.isFinite(time) ? time : null, t, text);
        }
        return added;
      });
    },
    // The day's numbers for each item (networks that give only totals: the day's last check wins)
    recordDay(network, items, keys, date = day(Date.now())) {
      tx(() => {
        for (const p of items) {
          if (!p.ref || !keys.some((k) => p[k] != null)) continue;
          st.upDay.run(network, p.ref, date, JSON.stringify(Object.fromEntries(keys.map((k) => [k, p[k] ?? null]))));
          if (Number.isFinite(p.time)) st.upTime.run(network, p.ref, p.time);
        }
      });
    },
    // A post's real per-day numbers (YouTube's, Ghost's): replaces the days kept for it
    setDays(network, ref, days, fetched = Date.now()) {
      tx(() => {
        st.dropDays.run(network, ref);
        for (const [date, vals] of Object.entries(days)) st.upDay.run(network, ref, date, JSON.stringify(vals));
        if (fetched != null) st.upFetched.run(network, ref, fetched);
      });
    },
    setPostedTime(network, ref, time) { if (ref && Number.isFinite(time)) st.upTime.run(network, ref, time); },
    // { posts: { ref: { date: vals } }, times: { ref: ms }, fetched: { ref: ms }, checked: { ref: ms } }: the shape the
    // history files had
    history(network) {
      const posts = {};
      for (const r of st.days.all(network)) (posts[r.ref] ||= {})[r.date] = json(r.vals);
      const times = {};
      const fetched = {};
      const checked = {};
      for (const r of st.posts.all(network)) {
        times[r.ref] = r.posted_ms ?? null;
        if (r.fetched_ms != null) fetched[r.ref] = r.fetched_ms;
        if (r.last_checked != null) checked[r.ref] = r.last_checked;
      }
      return { posts, times, fetched, checked };
    },
    // Every check in each post's first `ms` after it went up: { ref: [[t, vals]] }
    early(network, ms) {
      const out = {};
      for (const r of st.early.all(network, ms)) (out[r.ref] ||= []).push([r.t, json(r.vals)]);
      return out;
    },
    // A post's checks from `from` to `to`, with the one before `from` first (its numbers at `from`)
    checks(network, ref, from = 0, to = Number.MAX_SAFE_INTEGER) {
      const before = from > 0 ? st.checkBefore.get(network, ref, from) : null;
      return [...(before ? [before] : []), ...st.checks.all(network, ref, from, to)].map((r) => [r.t, json(r.vals)]);
    },
    // A post's numbers at time t: [t of that check, vals], or null before its first check
    at(network, ref, t) { const r = st.checkAt.get(network, ref, t); return r ? [r.t, json(r.vals)] : null; },
    first(network, ref) { const r = st.firstCheck.get(network, ref); return r ? [r.t, json(r.vals)] : null; },
    post(network, ref) {
      const r = st.post.get(network, ref);
      return r ? { posted: r.posted_ms, lastChecked: r.last_checked, vals: json(r.last_vals), fetched: r.fetched_ms } : null;
    },
    // Take-offs: { ref: [{ start, until, key, from: [t, v] }] }
    surges(network) {
      const out = {};
      for (const r of st.surges.all(network)) (out[r.ref] ||= []).push({ start: r.start, until: r.until, key: r.metric, from: [r.from_t, r.from_v] });
      return out;
    },
    lastSurge(network, ref) {
      const r = st.lastSurge.get(network, ref);
      return r ? { start: r.start, until: r.until, key: r.metric, from: [r.from_t, r.from_v] } : null;
    },
    startSurge(network, ref, s) { st.addSurge.run(network, ref, s.start, s.until, s.key, s.from[0], s.from[1]); },
    extendSurge(network, ref, start, until) { st.setUntil.run(until, network, ref, start); },
    // The account's totals at this check (only the ones it has; nothing when it has none), and checks older than
    // `keepMs` dropped
    recordAccount(network, vals, keepMs, t = Date.now()) {
      const have = Object.fromEntries(Object.entries(vals).filter(([, v]) => v != null));
      tx(() => {
        if (Object.keys(have).length) st.addAccount.run(network, t, JSON.stringify(have));
        st.dropAccount.run(network, t - keepMs);
      });
    },
    // Days brought in from before the account table (stats/history.mjs importAccountDays): { t: vals }, added unless a row
    // is already there; done once per `name` (meta), so it returns false when it was done before
    importAccount(network, name, rows) {
      if (st.getMeta.get(`imported:${name}`)) return false;
      tx(() => {
        for (const [t, vals] of Object.entries(rows)) st.addAccountKeep.run(network, Number(t), JSON.stringify(vals));
        st.setMeta.run(`imported:${name}`, new Date().toISOString());
      });
      return true;
    },
    // The account's checks since `from`: [[t, vals]]
    account(network, from = 0) { return st.account.all(network, from).map((r) => [r.t, json(r.vals)]); },
    surging(network, now = Date.now()) { return new Set(st.active.all(network, now).map((r) => r.ref)); },
    size() {
      let bytes = 0;
      for (const f of [file, `${file}-wal`]) try { bytes += fs.statSync(f).size; } catch {}
      return { bytes, checks: st.count.get().n };
    },
    // A copy made safely while it runs (VACUUM INTO), once a UTC day, in data/backups/; the newest `backups` kept
    backup(now = Date.now()) {
      if (!(backups > 0)) return null;
      const dir = path.join(dataDir, 'backups');
      const to = path.join(dir, `stats-${day(now)}.db`);
      if (fs.existsSync(to)) return null;
      fs.mkdirSync(dir, { recursive: true });
      db.prepare('VACUUM INTO ?').run(to);
      const old = fs.readdirSync(dir).filter((f) => /^stats-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -backups);
      for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
      return to;
    },
    close() { db.close(); stores.delete(dataDir); },
    db,
  };
  stores.set(dataDir, store);
  importJson(store, st, tx, dataDir, log);
  return store;
}

// Brings the old JSON files in, once each (meta "imported:<file>"): <network>.history.json -> days (and posting times,
// when the per-day ones were fetched); <network>.early.json -> its first days' checks, and the take-offs with their
// checks. The files stay where they are, untouched (an older bridge can still read them), and are never written again.
function importJson(store, st, tx, dataDir, log) {
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((f) => /\.(history|early)\.json$/.test(f)); } catch { return; }
  // history files first: they have the posting times the early checks are counted from
  names.sort((a, b) => Number(a.endsWith('.early.json')) - Number(b.endsWith('.early.json')) || a.localeCompare(b));
  for (const name of names) {
    if (st.getMeta.get(`imported:${name}`)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')); } catch (e) { log(`stats db: couldn't read ${name} to bring it in: ${e.message}`); continue; }
    const network = name.replace(/\.(history|early)\.json$/, '');
    let rows = 0;
    tx(() => {
      if (name.endsWith('.history.json')) {
        for (const [ref, t] of Object.entries(data.times || {})) if (Number.isFinite(t)) st.upTime.run(network, ref, t);
        for (const [ref, t] of Object.entries(data.fetched || {})) if (t) st.upFetched.run(network, ref, t);
        for (const [ref, days] of Object.entries(data.posts || {})) {
          for (const [date, vals] of Object.entries(days || {})) { st.addDayKeep.run(network, ref, date, JSON.stringify(vals)); rows++; }
        }
      } else {
        const times = Object.fromEntries(st.posts.all(network).map((r) => [r.ref, r.posted_ms]));
        const add = (ref, t, vals) => {
          st.addCheckKeep.run(network, ref, t, JSON.stringify(vals));
          rows++;
          const was = st.post.get(network, ref);
          if (was?.last_checked == null || t > was.last_checked) st.upPost.run(network, ref, null, t, JSON.stringify(vals));
        };
        for (const [ref, pts] of Object.entries(data.posts || {})) {
          if (!Number.isFinite(times[ref])) continue; // no posting time to count its minutes from
          for (const [min, vals] of pts || []) add(ref, times[ref] + Math.round(min * 60_000), vals);
        }
        for (const [ref, list] of Object.entries(data.surges || {})) {
          for (const s of list || []) {
            const [first, ...rest] = s.pts || [];
            st.addSurge.run(network, ref, s.start, s.until, s.key, first?.[0] ?? s.start, first?.[1]?.[s.key] ?? null);
            for (const [t, vals] of rest) add(ref, t, vals);
          }
        }
      }
      st.setMeta.run(`imported:${name}`, new Date().toISOString());
    });
    log(`stats db: brought in ${name} (${rows} rows)`);
  }
}
