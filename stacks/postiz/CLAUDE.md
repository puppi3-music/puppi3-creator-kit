# stacks/postiz/

Postiz and `postiz-ghost-bridge` (the `social` module). Before opening bridge modules, read `docs/bridge-map.md`. Keep
the Posting guide (`kit/docs/posting-guide.html`) current when tags, captions, media rules or notifications change.
Which Grafana panel shows each bridge file, and how: `stacks/monitoring/grafana/CLAUDE.md`. A site may run a second,
DRY_RUN bridge as a staging copy (it previews and logs, never posts); some notes below say what such a copy does.

## The stack
- The site's values (`config.mjs`, from the instance profile via compose; neutral defaults,
  `SITE_HOST` required by compose): `SITE_HOST`
  (Search Console's default property, the host lists' default), `SITE_NAME` (weekly summary's title), `ID_PREFIX`
  (Grafana uids `<ID_PREFIX>-overview`/`-post` in the notices' buttons; `METRIC_PREFIX` = it with `-` as `_`, the
  `/metrics` counters `<prefix>_puppy_pets_total`, `_link_clicks_total`, `_live_*`, `_stats_*`; the Social preview router
  `<ID_PREFIX>-social-preview`, a compose label), `SITE_HOSTS` (the site's
  names: links there are its pages, not clicks off it; compose adds staging's), `LIVE_HOSTS` ("Live stream" clicks),
  `PETS` (false: `/.puppy/pets`, `/pets.json` and the counter all 404/absent), `NETWORKS` (empty = all; a network left
  out is off like its `<NAME>_STATS=false`: `networkOn`, in `collector()` and IG/YT/SC's flags), `GRAFANA_URL` (empty =
  no Grafana buttons on the notices). Compose passes them all (both stacks; staging's compose keeps puppi3's values as
  its own defaults and lists staging's names in `SITE_HOSTS`); empty `SITE_HOSTS`/`LIVE_HOSTS` = `SITE_HOST`'s (and www.)
  and `LIVE_HOST`'s.
- How posts are shared: the bridge's 28 posting settings (compose's block from `CHANNELS` to
  `TIKTOK_PRIVACY`) are `${VAR:-<default>}`, and a kit
  site sets them in `site.env` (documented, `#KEY=default`, in `instances/example.env`; the Settings reference's
  check stops the build when a default there differs from compose's). `DRAFT_TAG` is `${DRAFT_TAG-…}`: empty = no tag.
  Staging's bridge reads the same variables with the same defaults. The collectors' `<NAME>_STATS` switches and
  `POSTIZ_STATS*` stay fixed (`NETWORKS` picks networks per site).
- postiz: Postiz (pinned `v2.24.0`: the bridge's photo rules were checked against it), Postgres, Redis, Temporal (+ Postgres, which also holds its searchable records: `ENABLE_ES=false` and `SKIP_ADD_CUSTOM_SEARCH_ATTRIBUTES=true`, unlike Postiz's own compose file; Elasticsearch held ~0.7 GB. Postgres has 3 searchable text fields, Postiz adds `postId` and `organizationId` at start and finds a post's running job by `postId`; jobs scheduled before the kit 1.2.4 switch aren't found by that search), `postiz-ghost-bridge`
  (`ghost-bridge/`: 23 modules in folders by purpose. Before opening bridge modules, read `docs/bridge-map.md` (which
  file has what, exports, import rules); keep it current when files or exports change (pre-commit checks it). Top level:
  `ghost-bridge.mjs` (start-up, routes, webhook), `config.mjs` (settings, log, posted/custom.json), `services.mjs`
  (Postiz API + alerts, its db, Ghost Admin API); `share/` (share = handlePost + upNextDoc, content = post + captions,
  media = `IMAGE_RULES`, ntfy, pfp = seasonal profile pictures, weekly = the weekly summary), `pages/` (preview-render draws, preview-routes = dry-run/photo/draft pages), `stats/` (stats =
  startStats + routes, history = posts over time + helpers, performance, timing, post, store, instagram, youtube,
  soundcloud, social = Bluesky/Threads/TikTok/Mixcloud, site = Ghost/Cloudflare/Search, live = shows/clicks/pets);
  never `data/`. Import rules: helpers in stats/history.mjs (no stats module imports stats/stats.mjs), ntfy never
  imports services. compose mounts the folder read-only at /app, so a new module (subfolders too) needs no compose
  line; the commit hook checks that every module loads (no import of a name another doesn't export) and the map
  (`.githooks/bridge-check.mjs`); healthcheck every 5 s
  (Traefik routes only to healthy); SIGTERM exits at once, or after a share in progress (`stop_grace_period: 5m`); webhook: fails closed
  without `GHOST_WEBHOOK_SECRET` (compose requires it too), bodies >8 MB get 413; registration defaults closed
  (`POSTIZ_DISABLE_REGISTRATION:-true`); `pages/preview-render.mjs` only
  renders the preview pages, from what the bridge collected and the settings it passes in).

## Sharing posts
- Draft social previews: the theme
  (`post.hbs`) adds a "Social preview" button on Ghost's `/p/<uuid>/` preview pages, linking to
  `https://<SITE_HOST>/ghost/social-preview/<uuid>/` (`DRAFT_BASE`; old `/social-preview/<uuid>/` 301s there),
  which Traefik routes to the bridge (label on the bridge, priority 100). Staff only: under /ghost/ so the browser
  sends Ghost's `ghost-admin-api-session` cookie (path /ghost), which `staffSignedIn` passes to Ghost's
  `/users/me/` with Origin = the site (from `/site/`), cached 1 min; page, media and saves all need it, and saves
  also need Origin = the site. The bridge reads the draft via the Admin API (`GHOST_API_URL` = Ghost on
  `http://website-puppi3:2368` over the `proxy` network, `GHOST_ADMIN_API_KEY` in the postiz `.env`, e.g. the "Postiz" integration's
  key; a key Ghost turns down (401) gets a page and a start-up log WARNING (`checkGhostKey`) naming
  `GHOST_ADMIN_API_KEY` and how to fix it, plus "staging has its own keys" on a DRY_RUN bridge), runs the publish logic fully dry (never posts or notifies), caches per a hash of the post Ghost sends (not `updated_at`: a tag-only save can leave it as it was). Each card has
  a "Modify text for <channel>" checkbox + textarea: saved via `POST /ghost/social-preview/<uuid>/custom` to
  `data/custom.json` (post id -> channel -> text), used instead of the post text on publish. A featured-link menu above the cards (`FEATURED_LABEL`
  after `FEATURED_LINE`'s first emoji: the kit's "🔗 Featured link", puppi3's "🎧 Listen link"; `POST .../listen`, `listen` in
  `custom.json`: '' auto, 'none' or any address) overrides the automatic one: `postLinks` (a hrefs + YouTube embeds)
  -> `findListenLink`, preferring the earliest service in `FEATURED_DOMAINS` (puppi3's YouTube, SoundCloud, Mixcloud; the
  kit's default adds Vimeo, Spotify, Apple Podcasts/Music, Bandcamp, Twitch). Its caption lines are `FEATURED_LINE`
  (Bluesky/Threads) and `FEATURED_BIO_LINE` (Instagram/TikTok), `[name]`/`[url]` filled in (`featuredLine`); puppi3's
  wording ("🎧 Listen: …", "🎧 Full set on …") is in her own instance profile, the neutral defaults in the compose files
  (`[…]`, not `{…}`: compose's defaults and settings_reference's parser end at `}`). On the Instagram
  card you drag photos within the frame (`POST .../frame`, saved as `frames` in `custom.json`); on publish
  the bridge crops Instagram's feed photos (ffmpeg) to the first photo's shape (4:5-1.91:1) at that framing
  (centred otherwise). It also fits every channel's photos to what Postiz and the platform accept (`IMAGE_RULES`:
  Postiz posts only png/jpg/gif/webp; Instagram JPEG <=1440 wide; Threads JPEG/PNG; TikTok JPEG/WebP, shorter
  side <=1080): ffmpeg converts only the ones that don't fit and uploads them; the rest go as they are.
- Captions (`bodyText`): bullets "• ", numbered lists "1. ", quotes in “ ”; links in the text become "text (address)" on
  Bluesky/Threads only when the whole caption still fits (`buildLines` -> `fitLines`), else link text only (always on
  IG/TikTok); the preview's "Modify text" box starts from each channel's version (`autoText` per channel key).
- `TAG_LINKS` (default true): `tagLink()` turns site links in captions (`buildLines`, `withLinks`) and the Instagram
  link-sticker link (`stickerLink()`) into short tagged links `https://<site>/<b|t|i|k>/<path>` (`SHORT_LINK_PREFIX`:
  bluesky, threads, instagram, tiktok; must match the theme's redirects.yaml (which also has `/d/` Discord and `/y/` YouTube, shared by hand), which 302s them to
  `/<path>/?utm_source=<network>&utm_medium=social`; Ghost's redirects can't copy the slug into the query, so no
  utm_campaign: the landing page tells the post). Other networks, or links with a #fragment, get the long query form
  (featured links untouched; a link already carrying utm_source is kept). Growth's "Tagged links" table reads it back.
  The redirects themselves: `kit/redirects.yaml`.
- Internal tag `#campaign-<name>` (`CAMPAIGN_TAG`, `campaignOf`): that post's site links and IG sticker get the long
  form plus `&utm_campaign=<name>` (even with TAG_LINKS off), for Growth's Campaigns table.
- Instagram/TikTok notifications with several photos get an "All N photos" button (instead of "Open Postiz") to
  `https://<site>/social-preview/photos/<id>/` (already routed to the bridge; no sign-in, random 24-char id, saved in
  `data/photos.json`, `PHOTO_PAGE_DAYS` [14]; not made for draft previews): each photo as that app gets it, served
  through the bridge (site images via `GHOST_API_URL`), "Share all" (`navigator.share` files: https + phone browser)
  and "Save" (one photo per tap: browsers allow one download per tap). If it can't be saved, the old one-notification-per-photo fallback is used. `#story` sends IG one
  photo, so no page. Story notifications come in first (the #bigdrop one, then an IG #story one, then the rest; queue failures last), each followed by a `NTFY_STORY_GAP` [2 s] pause when more follow, so the phone gets them in that order. #bigdrop gets its own link-Story notification when an IG channel exists (`notifyBigDrop`: first photo uncropped via
  `igStory[0]`, or the video; Copy sticker link / Open Instagram / Open the featured link or post), except #story + #bigdrop by
  hand, where the IG Story notification carries the sticker link.
- `GET /upnext.json` (`upNextDoc`: Admin API `status:scheduled`, then handlePost's rules without uploading: `musicRouting` shared with handlePost, media kind, channels
  -> Posts itself to / You post in the app / Left out, link to the Social preview; 1-min cache; not routed by Traefik):
  Ghost's scheduled posts, for Social's "Up next".

## Seasonal profile pictures
- `share/pfp.mjs` (`startSeasonalPfp`, `PFP_SEASONS` [true]; user asked: the site's seasonal outfits on the social
  profile pictures too, as a phone reminder for every network, Bluesky included: nothing changed by API). The theme is
  the source: `npm run dev:pfp` there writes `assets/images/pfp/<season>.png` (1000×1000) + `seasons.json` (puppies.js's
  SEASONS), shipped in the zip; the bridge reads seasons.json from Ghost (`GHOST_API_URL` + `/assets/images/pfp/`,
  `X-Forwarded-Proto: https`), so no mount and staging gets staging's theme. 20 s after start, then hourly: today in
  `SITE_TIMEZONE` (`PFP_TODAY` YYYY-MM-DD/MM-DD pretends, staging only), matched like puppies.js (month*100+day, last match
  wins; newyear's two entries = one season by name). A seasons.json it can't read changes nothing; none at all (404:
  a theme without the pictures, like the kit's) is logged once and means no reminders.
- On a change (state `data/pfp.json`: season, since, from, notified; saved after each step, so restarts repeat nothing; an
  unsent reminder is retried hourly; no NTFY_URL or DRY_RUN without DRY_RUN_NTFY counts as sent): "🐶 <Season> puppy pfp"
  with the PNG (site's public URL from `ghostSiteOrigin`) attached + Save picture, or "🐶 Back to the usual pfp" when it
  ends. Both list `PFP_NETWORKS` (comma list, default bluesky, instagram, threads, tiktok, youtube, soundcloud, mixcloud, discord; the
  user's per-network on/off: remove one to stop it), its first two known ones get "Open <network>" buttons (`NETWORKS`
  in pfp.mjs has the names and addresses; an unknown name is listed as written). Empty = off.

## Weekly summary
- `share/weekly.mjs` (`startWeeklySummary`, `WEEKLY_SUMMARY` [true]; user asked: how the week went, on the phone, without
  opening Grafana). Every 15 min (first ~3 min after start, after the collectors' first polls, since the Ghost one fills in
  Tinybird's site_uuid): `lastDue` = the latest `WEEKLY_SUMMARY_AT` [`Mon 09:00`, "<weekday> HH:MM", bad = default] in
  `SITE_TIMEZONE`; state `data/weekly.json` `{ sent: <local date> }`, saved after a send (first run: set without sending;
  a missed one is sent at the next check, only the latest; no NTFY_URL or DRY_RUN without DRY_RUN_NTFY counts as sent).
- `weekDoc(due)` = the 7 local days before `due`, read only: site visitors (+ % on the week before) and new members from
  ghost.json's `daily` (UTC days); followers gained per network (`ACCOUNT_KEYS[n][0]`, stats.db account checks: the last
  before the week, else its first, to the last in it; ghost left out); posts made that week and the best 3 judged
  (`performanceDoc`); top 3 pages (`tbPipe` `api_top_pages`, titles from ghost.json's posts); live shows (live.json).
  `weekMessage` writes it as short lines with emoji; title "📊 Your week on <SITE_NAME> (<from> – <to>)", "Open Grafana"
  to Overview (`<ID_PREFIX>-overview`) at `GRAFANA_URL` (`-staging` uid under DRY_RUN). A part that fails is left out and logged.
  `WEEKLY_SUMMARY_NOW=true` sends last week's once ~3 min after start (staging, to try it).

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
  (each relay's `/status-json.xsl`, on LIVE_STATUS_URL's port). Unset = as before. On Kubernetes the bridge's whole
  environment is this compose.yaml's, rendered by `k8s/up.sh` (`k8s/CLAUDE.md`), so settings added here reach it.

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
- `ghost-bridge/Dockerfile` (+ `.dockerignore`: only the `.mjs` files): the bridge with its code inside, which the kit
  publishes and Kubernetes runs; the NAS's stack keeps its `dockerfile_inline` base with the code mounted (the same
  Node: `image-pins.py`). deploy.sh sends both files with the stack; the NAS doesn't use them.
- Per-post history: `data/stats.db` (`stats/store.mjs`, SQLite via `node:sqlite`, works in node:22-alpine >= 22.13 with an
  ExperimentalWarning; `storeFor(dataDir)`; all SQL there, plain enough for PostgreSQL: BIGINT ms, JSON in TEXT, ON CONFLICT):
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
- Every collector lists all the account's posts (paged, 50 pages max;
  `withOlder`: a short listing keeps the last file's older ones, a full one drops deleted posts from the list, not the history);
  `trackEarly` records the check, then for posts past their first days looks up the main number 4 h/18 h/8 d ago (`store.at`):
  gain >= 5% and >= 10 and >= 3x the week's usual -> `surges` (72 h+, every check kept)
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
  video.list; `daily` views/comments/shares = what the videos gained each UTC day, `gainsByDay` as Bluesky's; likes per
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
