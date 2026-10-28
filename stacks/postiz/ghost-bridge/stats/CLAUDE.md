# stacks/postiz/ghost-bridge/stats/

Every number the bridge collects, keeps and serves (each network's `*.json`, `stats.db`, `/post.json`, `/page.json`,
`/timing.json`, `/performance.json`, `/metrics`). Module paths (`share/…`, `stats/…`) are from `ghost-bridge/`, as in
`docs/bridge-map.md`. Which Grafana panel shows each, and how: `stacks/monitoring/grafana/CLAUDE.md`. The bridge as a
whole: `stacks/postiz/ghost-bridge/CLAUDE.md`; the settings compose passes: `stacks/postiz/CLAUDE.md`.

## Puppy pets and clicks
- Puppy pets: the theme's `puppies.js` batches pets (every 30 s + on hide/leave) to `POST /.puppy/pets?n=<pets>` (puppi3.yml route;
  staging: label on its bridge); the bridge adds them to one total in `data/pets.json` (200 per call, 2000 per X-Real-Ip
  per 10 min; saved every 5 s and on SIGTERM), served at `GET /pets.json` (not routed on prod; staging-social routes it),
  shown on Overview's "Puppies petted" stat via the `bridge-instagram` datasource, and as counter `puppi3_puppy_pets_total` (`<METRIC_PREFIX>_…`; all only with `PETS`)
  at `GET /metrics`, scraped by the monitoring module's Prometheus (job `<ID_PREFIX>-pets`, 1 m) for Overview's "per day" bars.
- Clicks and live shows are collectors (`live`, `clicks`), under "More numbers" below.
  `LIVE_STATS` is `${LIVE_STATS:-true}` in compose.yaml: a kit site without the `live` module gets false from kit/kit.sh,
  so nothing polls a TinyIce that isn't there (staging keeps its own `"true"`: it has its own TinyIce).
  `LIVE_MOUNT` is `${LIVE_MOUNT:-/stream-ogg}` the same way: kit/kit.sh sets it from TinyIce's config.
  `LIVE_RELAYS` (not in compose.yaml: only the kit on Kubernetes sets it, `k8s/up.sh`): a name whose addresses are the
  stream's relays; each relay is one listener on the main TinyIce, so listeners = main's - relays + the relays' own
  (each relay's `/status-json.xsl`, on LIVE_STATUS_URL's port). Unset = as before. On Kubernetes this compose.yaml is the bridge's
  whole environment (`stacks/postiz/CLAUDE.md`).

## Instagram, YouTube, SoundCloud numbers
- Instagram numbers (posts are made by hand, so Postiz doesn't know them): `IG_STATS` [true] polls every `IG_STATS_MINUTES`
  [60, min 10] (needs `POSTIZ_KEY`; read-only, runs in DRY_RUN too): account new followers/reach per day + 30-day totals from
  Postiz's analytics (Instagram's `follower_count` = new follows per day, absent under 100 followers: stored as `newFollowers`),
  the follower total per day (`followerHistory`, kept from poll to poll in instagram.json, 400 days; needs the db token below,
  so staging has none), profile views + profile link taps per day (`igProfileDays`: Graph `/me/insights?metric=profile_views,
  profile_links_taps&metric_type=total_value`, one UTC day per call: today + yesterday each poll, the rest of the last 30
  once, `profileHistory`; Postiz's own "profile" series are skipped so they can't land in `views`), and, with `POSTIZ_DB_PASSWORD` (`POSTIZ_DB_HOST/USER/NAME/PORT`), every
  post's numbers straight from graph.instagram.com with the channel's token (one SELECT on Postiz's `"Integration"`, never
  saved/logged; without the password, Instagram, Threads and TikTok put "followers and posts" / "videos need
  POSTIZ_DB_PASSWORD set" in their `errors`, the status tiles' Problems). Written to `data/instagram.json`, served at `GET /instagram.json` (not routed by Traefik on prod; the bridge
  joined the `monitoring` network so Grafana's Infinity datasource `bridge-instagram` reads it).
- YouTube numbers: `YT_STATS` [true] every `YT_STATS_MINUTES`
  [60]: the bridge reads the YouTube channel's `refreshToken` from Postiz's `"Integration"` (needs `POSTIZ_DB_PASSWORD`), swaps it
  at Google with `YOUTUBE_CLIENT_ID/SECRET` (also Postiz's, required to connect YouTube there; Google app must be "In production"
  or sign-ins die in 7 days), reads the Data API (subscribers, views, every upload) and Analytics API (per day,
  `YT_STATS_DAYS` [365]; subscribers per day worked back from today's count) into `data/youtube.json`, `GET /youtube.json`, same
  `bridge-instagram` datasource; Platforms dashboard's YouTube section. Postiz's own YouTube analytics lack views/subscribers.
  Staging's bridge can't reach Postiz's db, so its youtube.json only reports that.
- SoundCloud numbers: `SC_STATS` [true] every
  `SC_STATS_MINUTES` [60]: Postiz has no SoundCloud, so the bridge uses its own SoundCloud app (`SOUNDCLOUD_CLIENT_ID/SECRET`,
  client credentials = public data only; 50 sign-ins/12 h per app, token kept until it expires) for `SOUNDCLOUD_USER` (profile
  address): followers etc. + every public track's plays/likes/reposts/comments into `data/soundcloud.json`, `GET /soundcloud.json`;
  the API has no per-day numbers, so the bridge keeps each UTC day's totals in `history` (`SC_STATS_DAYS` [400]) and `daily` gets
  the gain vs the day before (null if that day's missing or it went down). Platforms dashboard's SoundCloud section, and SoundCloud
  uploads count in Social's top section (Published, per day, by network, Recently published). Staging collects too (same app, own
  history; staging-social routes `/soundcloud.json`).

## "vs your usual" and "vs industry" verdicts
- Two verdicts per post, "vs your usual" and "vs industry" (user asked: judged
  like social media researchers would, per network, and against industry standards too, shown as its own verdict): `withPerformance` (stats/performance.mjs) runs before every network file is written (collector(); IG/YT/SC writes in
  stats/instagram, youtube, soundcloud.mjs), reads that poll's history file and adds `perf` (0-100/null), `perf_label`, `perf_why` (= `perf_tip`),
  `perf_industry_label` (Well above/Above/About/Below/Well below typical + "· 7.4% vs 3.2%", or Too few to tell, Too soon, No numbers yet,
  No benchmark, Not a newsletter: `industryVerdict`, never blank, the reason in `perf_industry`; Post's tiles say why when there's no verdict at all; `perf_label` = level + "· better than k in 10"), `perf_industry` to each post (IG `stories` among Stories). `SIGNALS[network]` = what the network ranks on, weighted: rates per
  reach/view/play/follower (`rate()`, follower count at posting time interpolated from the file's history) and counts at the
  same age (`count()`, `numbersAt` ±1-3 days; all "as now" past `PERF_SETTLED` 28 d); vs the `PERF_BASE` 20 posts nearest in
  time (same `POST_KIND` if `PERF_MIN` 5), rates shrunk by `prior` exposures toward the group's pooled rate, percentile per
  signal, weighted mean ranked among the compared posts' own means (calibrated: no-pattern data gives ~1/5 per label), pulled
  to 50 by n/(n+2); labels 80/60/40/20 (`PERF_LABELS`), "Too soon" <12 h (unless judged by the hour on the first-days checks from 2 h), "Not enough posts yet" <5. `INDUSTRY` = published
  averages (Socialinsider: IG 3.2%/reach Aug 2026, TikTok 3.85%/view Q2 2026 (theirs counts saves, TikTok's API has none); never their per-follower headline figures; YouTube 2-6% videos, 2.5-4% Shorts (CreatorDB/SociaVault 2026, all channels); Mailchimp media click 4%;
  update yearly; About = 0.67-1.5× or inside a range, Well past 2× its top / under half its bottom, `INDUSTRY_MIN` 50), its own verdict, never in perf.
- `GET /performance.json` (`performanceDoc(dataDir)`, last 30 days all networks, best first, `summary`; not routed): Overview's
  "Posts doing well" and "Best posts lately"; the weekly summary's best posts too. Owner's
  explanation: analytics guide `#post-is-it-doing-well`.

## Per-post history (`data/stats.db`)
- Per-post history: `data/stats.db` (`stats/store.mjs`, SQLite via `node:sqlite`, needs Node >= 22.13; the image's
  Node 24 doesn't warn it's experimental; `storeFor(dataDir)`; all SQL there, plain enough for PostgreSQL: BIGINT ms,
  JSON in TEXT, ON CONFLICT):
  `checks` (every check in a post's first `POST_EARLY_HOURS` [96] and during a take-off, else only changes: `recordChecks`;
  `posts.last_checked` moves on an unchanged one), `days` (UTC day's last numbers via `trackPosts` -> `recordDay`, all kept;
  YouTube's/Ghost's real per-day numbers via `setDays`: `ytVideoDays`, Analytics per video back to its upload, refetched after
  6 h, 24 h past a month old, 50 a poll), `posts` (posted/last checked/fetched), `surges`, `account` (each network's running
  totals, `ACCOUNT_KEYS` in stats/history.mjs, at every poll: `trackAccount` in `collector()` and before IG/YT/SC's writes ->
  `recordAccount`, rows older than `ACCOUNT_CHECK_DAYS` [90] dropped; earlier days brought in once per network at start,
  `importAccountDays` (meta `imported:account:<n>`): a point at each UTC day's end from the file's `history`/IG
  `followerHistory`/YT `daily` subscribers, archive `days[d].totals` winning, not today or days with checks; `GET /account.json?network=` (not routed; `accountGains` adds each check's
  `new<Key>` gain on the check before and, for the `<key>Today` keys (what networks give only per day, so far today:
  Ghost visitors, IG reach/profile views/link taps, Threads views/clicks/likes...; from totals or the file's `daily`
  today), `<key>` = the difference within the UTC day; null on the first check or a drop) -> Platforms' charts' "hour by
  hour" view (time ranges of 7 days or less); with the network, each check's `engagement` = its `WEEKLY[n].hourly` gains
  added up; Bluesky's totals `likes`/`reposts`/`replies`/`quotes`, TikTok's `views`/`comments`/`shares` and YouTube's
  `likesAllTime`/`commentsAllTime` Instagram's `postLikes`/`postComments`/`postShares`/`postSaves` and Threads' `postLikes`/`postReplies`/`postReposts`/`postQuotes` = all posts' sums for it;
  Instagram's and Threads' hourly engagement use those, not the `likesToday`-style account insights, which come late (after the UTC day, lost to the hourly view) and read flat), `meta` (old `<network>.history.json`/
  `.early.json` brought in once at start, left untouched). Daily `VACUUM INTO data/backups/` (`STATS_DB_BACKUPS` [7]);
  `/metrics` `puppi3_stats_db_bytes`/`puppi3_stats_checks`. `readHistory` returns the old files' shape + `early` (first-days
  checks as minutes since posted, thinned 15/30/60/180) + `surges`.
- Looking after `stats.db`: while the bridge runs, `stats.db-wal` and `-shm` sit beside it, so never copy `stats.db`
  itself then: take a file from `data/backups/`. Putting one back: stop the bridge, replace `stats.db`, delete the
  `-wal` and `-shm`, start it. A check is ~140 bytes and an unchanged one of an older post adds nothing: the worst
  case, 150 posts all changing at every 10-minute check, is ~135 MB per network every 90 days. A bridge from before
  stats.db reads the old history files again, so going back to one misses the days since. To PostgreSQL later: copy
  the tables (pgloader reads SQLite), then a Postgres client in place of `DatabaseSync` in `stats/store.mjs`.
- A count back at 0 from 5 or more (`keepLastOverZero`, stats/history.mjs; user saw every TikTok video "taking off" from
  one check where TikTok answered 0 views, 2026-10-28, and asked for it on every collector): keeps its last number, logged.
  Each post's numbers against its last check in stats.db (`trackPosts`, `trackEarly`: every network's posts; trackPosts
  returns how many, and `keepPosts` puts a note in the file's `errors`); the account totals against the last day kept
  (`withHistory`: Bluesky, Threads, TikTok, Mixcloud, Ghost) or the last file's `totals` (Instagram followers, YouTube
  subscribers and views, SoundCloud's totals).
- Every collector lists all the account's posts (paged, 50 pages max;
  `withOlder`: a short listing keeps the last file's older ones, a full one drops deleted posts from the list, not the history);
  `trackEarly` records the check, then for posts past their first days looks up the main number 4 h/18 h/8 d ago (`store.at`):
  gain >= 5% and >= 10 and >= 3x the week's usual, from the most it had by then (a dip that comes back is no gain) -> `surges` (72 h+, every check kept)
  (`surgingRefs` -> `toCheck`'s `also`: IG/Threads ask it every poll; a new one -> ntfy "📈 … is taking off" via
  `setTakeOffNotice`, `TAKEOFF_NTFY` [true], button to the Post dashboard at `GRAFANA_URL` (none without it),
  `-staging` uid under DRY_RUN; posting guide `#notifications-taking-off`); compose passes every `*_STATS_MINUTES` (min 10),
  `IG_/THREADS_STATS_POSTS` (prod only: staging reads no per-post insights), `META_CALLS_PER_HOUR`, `POST_EARLY_HOURS`, `STATS_DB_BACKUPS`, `ACCOUNT_CHECK_DAYS`, `TAKEOFF_NTFY`, `GRAFANA_URL` from .env (both stacks); `/post.json` totals (every check, <= ~3000 points)/compare/verdict and the "vs your
  usual" verdict use them (`judge` by the hour from 2 h, else the day rules); YouTube/Ghost pollers call it themselves.
- IG/Threads insights are a call per post, so `toCheck` asks the newest `postsPerPoll` (what's left of `META_CALLS_PER_HOUR` [120]
  per poll after the account's counted calls `igCalls`/`thCalls` and surging posts, halved, 1 to `IG_STATS_POSTS`/`THREADS_STATS_POSTS`
  [25, max 50]; `checking` in the file) plus as many older ones by oldest `checked` each poll (IG `igProfileDays` at most hourly, `profileFetched`); the rest keep their last numbers.
- Posts carry `ref` (`postRef`) and `links`
  (`siteLinks`: site paths, short/bio links resolved; Mixcloud's from each upload's description, looked up once
  (`MC_LINK_LOOKUPS` 10 a poll) and kept in mixcloud.json's `linksByRef`); history files also keep `times` (posting time per ref) for
  `compareWithOthers` (age-matched; `NETWORKS[n].main` picks the number). Every collector's file gets `posted_ms` on each
  post (`withPostedMs`: the bridge's own string copy of `time`, for Grafana's row links to Post).

## `/post.json`, `/page.json` and `/timing.json`
- `/post.json` (stats/post.mjs `postDoc`, not routed by Traefik): one post's numbers for the Post dashboard. Its page is
  `pageFor` (a Ghost post is its own page; else the Ghost post it links to, or its first site link), which guesses the
  page when there's no link (`guessPage`: Ghost title in caption, else newest Ghost post in the week before; `ghostPosts`
  = `ghostPublished`, 10-min cache, needs the Admin key). It maps Postiz's `instagram-standalone`/`tiktok-business`
  (`NETWORK_ALIASES`) and explains others; compares with the median of the network's other posts at the same age, by the
  hour in the first `POST_EARLY_HOURS`, then days (each other post's nearest day kept within 1 day under a week old, 2
  under 4 weeks, then 3, as the verdicts' `numbersAt`: the history only began 2026-10-06, so exact days rarely had 3;
  needs 3; nothing to compare = one `verdict` row `{ note }` alone; `compareOptions`, usual first); lists `pages` (found/guessed page
  first, then the post's other links, home, Ghost's newest 100; `&page=<path>` overrides, via `sitePath`) and `sources`
  (a regex of Ghost's source names for the network).
- `GET /page.json?path=/<slug>/&from=&to=&timezone=` (stats/post.mjs `pageRoute`, not routed; the Page dashboard): every
  post in every network file (IG `stories` too, the Ghost post itself as "The post itself") whose `pageFor` page is that
  path (so the same rules as Post, guesses marked), oldest first, each with `main` = its `NETWORKS[n].main[0]` and its
  verdict from the file (`perf_label`, `perf_tip`); `visitors` = Tinybird `api_top_sources?pathname=` for from..to (YYYY-MM-DD,
  default the last 90 days) grouped into networks by `SOURCE_RULES` (each network's `sourceRegex || exact(sources)`, as
  post.json's `sources`; ghost = "Newsletter"; '' / Direct = "Direct / unknown"; others by their own name; `isNetwork`);
  `rules` = `SOURCE_RULES` as JSON (the dashboard's members query maps sources with it); `pages` = Ghost's newest 100 + home
  (never empty). No ?path = an error and no posts. Tinybird for it, the Ghost collector and the weekly summary:
  `TB`/`tbPipe` in stats/history.mjs.
- `GET /timing.json` (stats/timing.mjs `timingDoc`; per network, posts >= 3 days old, each
  post's number at `AT_AGE` 3 days from its history file (`numbersByAge`; older posts: total now / the median growth
  from day 3 to that age among tracked posts, rising only; + an "estimated" term), log ratio to the network median;
  `fitModel` = one Bayesian linear model per network (Student-t by reweighting, `TIMING_NU` 4) with trend + curve over
  posting time (account growth), weekday and part of the day (in `SITE_TIMEZONE` [Etc/UTC]) together, and kind
  of post (`POST_KIND`: IG/Threads type, YouTube Short/Video/Live, SoundCloud Track/Mix, Ghost Post/Post + newsletter, Bluesky
  Images/Video/Link/Text (quotes as text), TikTok Short video/Long video (60 s)/Photo (no duration), Mixcloud Clip/Full mix
  (30 min); also the verdicts' same-kind groups); slot prior sd = `spread`, picked
  per minute from `SPREAD_GRID` by summed log marginal likelihood over all networks' main numbers, nudged to `SLOT_SPREAD`
  0.3 (used alone under `SPREAD_MIN_POSTS` 30); cell = slot (or kind) vs the average of its table's cells with posts
  (`cellsOf`; tables `TABLES`: weekday, daypart, kind); confidence = P(really on that side), High/Medium against chance
  bars per network, table, number and day (`chanceFor`, user asked: no cell High by luck): the surest cell (2+ posts)
  over `PERM_RUNS` 200 shuffles of the posts' cells, 95th/80th percentile, never under 95%/80%; worked out in the
  background a fit at a time (`setImmediate`; ~5 s for 8 networks x 60 posts, ~15 s at 200), 95%/80% until then
  (Posts tip says so); on no-pattern test data a table with any High went from 22% to 5% at 200 posts a network (at 60
  the shrinkage already holds it to 1-3%); 1 post = Low; tips add how often shuffles do as well; `kinds` = one row per
  network and kind (2+ kinds); `Posts tip` (tooltip on Posts) = measured/worked-back counts, what was allowed for (kinds
  with counts), the spread, the High bars; files cached 60 s): Platforms' "When to post" row.

## Archive and extra numbers
- Archive (`archive()` in stats/history.mjs, user asked: log everything each network offers, shown or not): every collector also keeps,
  for good and untrimmed, `data/archive/<name>.json` (not served, nothing reads it yet): `days[date]` (`totals` = the day's last
  poll's, + per network: IG/Threads account insights per day with breakdowns (IG `profileHistory` also has them, `by`), `audience`
  once a day, IG `onlineFollowers`; YouTube's breakdowns once a day (`ytBreakdowns`, `meta.breakdownsDay`) + `channel` days;
  Cloudflare's whole day (`CF_QUERY_ALL`); Search Console's per-day queries/pages/countries/devices/types once final
  (`meta.finalThrough`, first poll 16 months); Ghost's newsletters + Tinybird rows; Postiz series), `posts[ref]` (whole API
  object, merged field by field; IG Stories too), `account`, `meta`; picture/media addresses dropped (`ARCHIVE_DROP`). Extra
  per-post numbers go into the history files too (`NETWORKS[n].more`, `historyKeys`; post.json lists/compares `postKeys` = keys + the
  `more` with a `LABELS` name (IG follows/profile visits/interactions, Bluesky saves, Mixcloud listeners); timing.json only `keys`).
- Instagram/Threads refuse a whole insights call over one unknown metric: `askLearned` finds which they give per kind (IG
  `media:REELS|FEED|STORY`, `day`; Threads `user`), saved as `metricsOk` in the file, relearned weekly. YouTube's reports
  (`ytReport`), Cloudflare's query, Ghost's `include`, IG `/me` and Threads' post fields fall back to the dashboards' set when
  refused. IG also keeps `stories` (Stories seen while up: no numbers after 24 h); SoundCloud `playlists`
  (+ `soundcloud-playlists` in stats.db); `postiz` collector (`POSTIZ_STATS` [360 min]): every Postiz channel's analytics -> archive.

## More numbers (other collectors)
- More numbers, `stats/stats.mjs` (`startStats`, started by ghost-bridge.mjs; generic `collector()`, each network's in stats/social, site or live.mjs: data/<name>.json every
  `<X>_STATS_MINUTES` [60], served at `/<name>.json` like instagram.json, `history` per UTC day where the API has only
  totals): `ghost` (the site as a network, in `NETWORKS` like the others, so Platforms' "The site (Ghost)" row, Post and When
  to post take it: Admin API via `ghostAdmin` (services.mjs, `GHOST_ADMIN_API_KEY`): members/paid/subscribers (`history`
  -> newMembers), every published post with `count.signups`/`paid_conversions`/`clicks` and `email` opens, all posts' comments
  (`totals.comments`: the Members API's `/comments/counts/` via `ghostMembers`, 50 ids a call; `history` -> newComments), clicks.json's
  `perDay` as `daily` linkClicks/livePlays and its all-time totals as `totals.linkClicks`/`livePlays` (for the hourly gains); Tinybird
  (`TINYBIRD_URL` [http://tinybird-local:7181, monitoring network], `TINYBIRD_TOKEN` = the monitoring .env's `TINYBIRD_STATS_TOKEN`, else `tinybird__adminToken` (staging: its own Tinybird's tokens.env; a kit site: its tokens.env, the kit's profile), `TINYBIRD_SITE_UUID` else
  Ghost's `/site/` `site_uuid`, `timezone=Etc/UTC`): site `api_kpis` per day from its first day with a visitor
  (`analyticsSince`), and per post `api_kpis?pathname=` one call each (`ghostPostDays`, like YouTube's: perDay
  days in stats.db with `fetched`, hourly under 30 days old then daily, 100 a poll; zero days only in a post's first
  14); post.json: page = the post itself, `sources` = `sourceRegex` `[Nn]ewsletter`; staging: own Ghost, prod Tinybird if
  its .env has the token), `bluesky` (public API, `BLUESKY_HANDLE` else Postiz's Bluesky channel; no per-day numbers, so `daily` likes/reposts/
  replies/quotes = what all posts gained each UTC day, `gainsByDay` over stats.db's `days`: a post first kept a day+ after
  posting starts there), `threads` (Postiz analytics: views/likes/replies/reposts/quotes per day + 30-day totals; with the
  db token: `followers_count`, posts' insights, and the account's insights per day (`thDays`: likes etc. + link clicks,
  winning over Postiz's); `daily` keeps the last file's days, so nothing drops off past 30 days), `tiktok` (Postiz analytics first: Postiz's
  `checkAnalytics` renews the 23 h token; then the db token: user/info + video/list; Postiz's app has user.info.stats +
  video.list; `daily` views/comments/shares = what the videos gained each UTC day, `gainsByDay` as Bluesky's (from the most each had: a day kept at 0 gains nothing); likes per
  day = `newLikes` from the account total), `mixcloud` (`MIXCLOUD_USER`, public; `history` keeps followers, plays,
  favorites, reposts, comments -> `new<Key>`), `cloudflare` (GraphQL httpRequests1dGroups, `CLOUDFLARE_API_TOKEN`
  Zone Analytics Read + `CLOUDFLARE_ZONE_ID`; 30 days first run, then 3), `search` (Search Console, service account JWT
  signed with node crypto, `SEARCH_CONSOLE_KEY` = JSON key base64'd, `SEARCH_CONSOLE_SITE` [sc-domain:<SITE_HOST>]),
  `live` (TinyIce `LIVE_STATUS_URL` every 30 s, prod `http://tinyice:8080/status-json.xsl`, staging its own; shows with
  peak/avg listeners, listener-hours, bar plays, `stalls`/`reconnects` (bar hiccups during the show), setlist; gap <5 min continues, <3 min dropped; `inProgress` survives
  restarts), `clicks` (theme `sendClick` beacons, `core.js`: `POST /.puppy/click?kind=out&to=&from=` (`/.site/click` too, the kit theme's path) for links to other
  hosts, `kind=play` when a visitor presses play on the LIVE NOW bar, not reconnects; per day by page/service/link, 60 per
  X-Real-Ip per 10 min, 3000 keys/day; counters `puppi3_link_clicks_total{service}`, `puppi3_live_plays_total` at /metrics;
  `kind=stall|reconnect&why=&hidden=&device=&browser=` = the bar's hiccups (theme `hiccup()`; values outside `HICCUPS`/`DEVICES`/`BROWSERS`
  get 400), all-time only, in clicks.json `totals.hiccups` (key kind\twhy\ttab\tdevice\tbrowser) and as counters
  `puppi3_live_stalls_total` / `puppi3_live_reconnects_total{why,tab=shown|hidden,device,browser}` (Health's live stream panels);
  staging: label `puppi3-staging-clicks`).
- Every network file's `daily` also gets, just before it's written (`withWeekly(network, out)` beside each
  `trackAccount`), what Platforms' charts draw (`WEEKLY` in stats/history.mjs): `<key>7` = the 7-day average of each
  `avg` key (the days kept among the 7 ending that day, by date; null under 4 of them), `engagement` = the network's
  likes/comments/shares/saves added up, `engagement7`, and `rate7` = the 7 days' engagement / the 7 days' `per` (reach,
  views or plays) in %, Bluesky's per 100 followers (that day's count). The site's engagement = newMembers + newComments +
  linkClicks + livePlays, per visitors. Instagram's `daily` carries
  likes/comments/shares/saves from `profileHistory` (`IG_PROFILE_KEYS`).
- Each `*.json` file also gets `checkedEvery` (`everyText(mins)` in stats/history.mjs), which Platforms' "read by the
  bridge every …" text shows. The six newer files and ghost.json have stale-file alerts (`stacks/monitoring/grafana/alerts.yml`).
