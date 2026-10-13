# Bridge module map

For Claude: which file of `stacks/postiz/ghost-bridge/` has what, so you can open the right one or two instead of all
~6,500 lines. Paths are relative to that folder.
Not deployed and not a guide. Kept current by the pre-commit hook (`.githooks/bridge-check.mjs`): every module needs
a `### \`<path>\`` heading here, and every name on an `- Exports:` line must still be exported. Update this file when
you add, move or rename a module or an export it lists. No line numbers here: they'd go stale on every edit.

## Where to look

| Topic | File |
|---|---|
| Env vars, defaults, the log, `previewStore`, posted.json / custom.json | `config.mjs` |
| Start-up, every HTTP route, Ghost's webhook (signature, 8 MB limit, one share per post), SIGTERM | `ghost-bridge.mjs` |
| Postiz API (posts, uploads, channels), Postiz alerts -> ntfy, Postiz's Postgres (channel tokens), Ghost Admin API | `services.mjs` |
| What gets shared where (`handlePost`), `musicRouting`, #bigdrop / #story / #autopost rules, `/upnext.json` | `share/share.mjs` |
| Reading the post (`bodyText`, video, audio card, gallery, `postLinks`, `findListenLink`), #clip | `share/content.mjs` |
| Captions (`buildLines`, `fitLines`, `withLinks`), short tagged links (`tagLink`, `SHORT_LINK_PREFIX`), `#campaign-` | `share/content.mjs` |
| `IMAGE_RULES`, fitting photos per platform, Instagram crop / frames, audiogram (ffmpeg) | `share/media.mjs` |
| ntfy notifications (IG/TikTok "post in the app", #bigdrop Story, take-off notice, `NTFY_STORY_GAP`) | `share/ntfy.mjs` |
| Seasonal profile pictures (ntfy reminder per season, data/pfp.json) | `share/pfp.mjs` |
| Weekly summary on the phone (`WEEKLY_SUMMARY_AT`, `weekDoc`, data/weekly.json) | `share/weekly.mjs` |
| Preview page HTML/CSS/JS (draws only; reads and writes nothing) | `pages/preview-render.mjs` |
| Dry-run previews, "All N photos" pages (photos.json), draft Social preview + its saves, `staffSignedIn` | `pages/preview-routes.mjs` |
| Starting collectors (`collector()`), `/account.json`, `/metrics` text, `*_STATS_MINUTES` | `stats/stats.mjs` |
| stats.db history (`trackPosts`, `trackEarly`, `readHistory`), `NETWORKS`, `POST_KIND`, take-offs (`surgingRefs`) | `stats/history.mjs` |
| Shared stats helpers: dates, JSON files, `archive()`, IG/Threads insights (`askLearned`), `withHistory`, `siteLinks`, Tinybird (`tbPipe`) | `stats/history.mjs` |
| "vs your usual" / "vs industry" verdicts (`SIGNALS`, `INDUSTRY`, `judge`), `/performance.json` (`performanceDoc`) | `stats/performance.mjs` |
| When to post (`fitModel`, `numbersByAge`, `SPREAD_GRID`), `/timing.json` | `stats/timing.mjs` |
| One post up close: `/post.json`, `guessPage`, `pageFor`, `compareWithOthers`, `compareOptions` | `stats/post.mjs` |
| Every post about one site page: `/page.json`, visitors by network (`SOURCE_RULES`) | `stats/post.mjs` |
| SQL / tables of stats.db, backups | `stats/store.mjs` |
| Instagram / YouTube / SoundCloud numbers (each starts itself) | `stats/instagram.mjs`, `stats/youtube.mjs`, `stats/soundcloud.mjs` |
| Bluesky, Threads, TikTok, Mixcloud numbers | `stats/social.mjs` |
| The site as a network (Ghost + Tinybird, `ghostPostDays`), Cloudflare, Search Console | `stats/site.mjs` |
| Live shows (TinyIce), link clicks / LIVE NOW plays (`/.puppy/click`, or the kit's `/.site/click`), puppy pets (`/.puppy/pets`) | `stats/live.mjs` |

## Import rules (no cycles that break loading)

- `config.mjs` imports nothing of the bridge's; everything may import it.
- `stats/history.mjs` holds the helpers every stats module uses; no stats module imports `stats/stats.mjs`
  (it imports them all), so helpers never go there.
- `share/ntfy.mjs` must not import `services.mjs` (services' Postiz alerts import ntfy).
- `pages/preview-render.mjs` and `stats/store.mjs` import nothing of the bridge's.
- ESM allows the remaining cycle (ntfy -> pages/previews -> share/share -> ntfy) because none of them uses an
  import while loading; keep top-level code free of imported calls. The pre-commit load check catches a break.

## Files

### `ghost-bridge.mjs`
Start-up (alerts, pets, collectors), the HTTP server and every route, Ghost's webhook, stopping on SIGTERM.
- Exports: `receiveWebhook`, `sharing` (exported, used only here)
- Imports: config, services, share/share, share/ntfy, share/pfp, share/weekly, pages/previews, stats/stats, stats/instagram, stats/youtube,
  stats/soundcloud, stats/live
- Routes: `GET /health`; `POST <HOOK_PATH>` (webhook); `GET /post.json`, `/page.json`, `/performance.json`, `/timing.json`,
  `/account.json` (handed to stats/); `GET /upnext.json`; `GET /<name>.json` (numbers files); `POST /.puppy/pets`,
  `POST /.puppy/click` (or `/.site/click`), `GET /pets.json`, `GET /metrics`; `GET <PHOTOS_BASE>/...`; `GET|POST /(ghost/)social-preview/...`;
  `GET /previews/...` (DRY_RUN previews)

### `config.mjs`
Every setting from the environment (UPPER_CASE exports, one per variable or derived list such as `LIMITS`,
`IMAGE_LIMITS`, `INSTAGRAM_IDS`, `TIKTOK_IDS`), the log, and posted.json / custom.json.
- Exports: `env`, `log`, `isDry`, `previewStore`, `loadState`, `recordShared`, `loadCustom`, `editCustom`, `setCustom`, `setFrame`, `channelKey`
- Exports: `SITE_HOST`, `SITE_NAME`, `ID_PREFIX`, `METRIC_PREFIX`, `SITE_HOSTS`, `LIVE_HOSTS`, `PETS`, `networkOn`, `GRAFANA_URL` (the site's
  values from its instance profile; neutral defaults, `GRAFANA_URL` empty = no buttons: kit step A4)
- Imports: nothing of the bridge's

### `services.mjs`
Postiz's public API and its notifications passed on to ntfy; a minimal Postgres client for Postiz's database; Ghost's
Admin API (JWT from `GHOST_ADMIN_API_KEY`).
- Exports: `postiz`, `postizChannels`, `uploadMedia`, `uploadFile`, `startPostizAlerts`, `PG`, `pgQuery`, `ghostToken`, `GHOST_KEY_FIX`, `ghostPostByUuid`, `ghostSiteOrigin`, `ghostAdmin`, `ghostMembers`, `checkGhostKey`, `ghostPublished`
- Imports: config, share/ntfy

### `share/share.mjs`
`handlePost`: channels, media, captions, auto-post vs draft + ntfy, recording; `musicRouting` (IG/TikTok mode);
`upNextDoc` for `/upnext.json` (same rules, nothing uploaded).
- Exports: `handlePost`, `musicRouting`, `upNextDoc`
- Imports: config, services, share/content, share/media, share/ntfy

### `share/content.mjs`
Reading Ghost's HTML, then each channel's caption fitted to its limits, the featured link's line (`featuredLine`), tagged links.
- Exports: `bodyText`, `LINK_RE`, `findVideo`, `findAudio`, `findAudioThumb`, `findGalleryImages`, `clipFromTags`, `cleanLink`, `postLinks`, `findListenLink`, `chosenListen`, `featuredLine`, `splitHashtags`, `channelText`, `buildLines`, `buildContent`, `tagLink`, `campaignOf`, `stickerLink`
- Imports: config, pages/preview (`esc`)

### `share/media.mjs`
Photos converted only where a platform needs it (`IMAGE_RULES`, `POSTABLE`), Instagram's crop at the saved framing,
the audiogram clip.
- Exports: `IMAGE_RULES`, `POSTABLE`, `fitImages`, `fitContext`, `uploadAsJpeg`, `makeAudiogram`, `pathOf`
- Imports: config, services (`uploadFile`), share/content

### `share/ntfy.mjs`
Sending to ntfy (4096-byte cut), the "finish in the app" and #bigdrop Story notifications, take-off notices.
- Exports: `notify`, `notifyManual`, `notifyBigDrop`, `fitMessage`, `STORY_GAP_MS`, `startTakeOffNotices`
- Imports: config, pages/previews (`photoPage`), share/content (`stickerLink`), stats/history

### `share/pfp.mjs`
Seasonal profile pictures: every hour reads the theme's `seasons.json` from Ghost, and when today's season (in
`SITE_TIMEZONE`) starts or ends, sends the ntfy reminder listing `PFP_NETWORKS`; state in `data/pfp.json` (no `seasons.json`, as
with the kit's theme: logged once, no reminders).
- Exports: `PFP_SEASONS`, `PFP_NETWORKS`, `today`, `seasonOn`, `checkSeason`, `startSeasonalPfp`
- Imports: config, services (`ghostSiteOrigin`), share/ntfy (`notify`), stats/history

### `share/weekly.mjs`
The weekly summary: every 15 min checks whether `WEEKLY_SUMMARY_AT` (in `SITE_TIMEZONE`) has passed since the last one
sent (`data/weekly.json`), and sends the week before's visitors, new members, followers gained (stats.db account
checks), best posts (`performanceDoc`), most-read pages (Tinybird) and live shows to ntfy. Read only.
- Exports: `WEEKLY_SUMMARY`, `parseAt`, `lastDue`, `weekDoc`, `weekMessage`, `checkWeekly`, `startWeeklySummary`
- Imports: config, share/ntfy (`notify`), stats/history, stats/performance (`performanceDoc`)

### `pages/preview-render.mjs`
Renders preview pages (each channel's mock-up) and the photos page, each with the kit's "Source" link (`SOURCE_URL`, the AGPL's offer); rendering only.
- Exports: `esc`, `escAttr`, `previewPage`, `photosPage`, `renderPreview`
- Imports: nothing of the bridge's

### `pages/preview-routes.mjs`
Dry-run previews written to `data/previews/` and served; photo pages (photos.json, `PHOTO_PAGE_DAYS`); the draft
Social preview (`staffSignedIn` via Ghost's session cookie, cached per a hash of the post Ghost sends) and its saves (custom text,
featured link, frames).
- Exports: `writePreview`, `servePreview`, `serveFile`, `PREVIEW_SETTINGS`, `draftPage`, `photoPage`, `servePhotos`, `serveDraftPreview`, `cleanDraftMedia`, `sendJson`
- Imports: config, services, pages/preview, share/content, share/share (`handlePost`, run fully dry)
- Routes (called from ghost-bridge.mjs): `/previews/...`, `<PHOTOS_BASE>/<id>/[n]`, `/ghost/social-preview/<uuid>/` +
  `POST .../custom`, `.../listen`, `.../frame`

### `stats/stats.mjs`
`startStats`: the generic `collector()` loop, Postiz channels/analytics for the collectors, runs the grouped
collectors, and answers the stats routes; `/metrics` lines; `/account.json` itself.
- Exports: `startStats`
- Imports: config (`METRIC_PREFIX`, `networkOn`), stats/history, stats/performance, stats/timing, stats/post, stats/social, stats/site, stats/live

### `stats/history.mjs`
Helpers (dates, JSON files, Tinybird, `archive()`, insights, per-day records) and each post over time in stats.db: `NETWORKS`,
`LABELS`, `POST_KIND`, tracking, account checks, first-days checks, take-offs, site links.
- Exports: `DAY`, `day`, `num`, `text`, `readJson`, `writeJson`, `writeJsonSync`, `fetchJson`, `TB`, `tbPipe`, `archive`, `archiveFile`, `archiveRead`, `askLearned`, `insightValue`, `insightBreakdown`, `audienceLists`, `zoneHour`, `withHistory`, `last30`, `posts30`, `perDay`, `gainsByDay`, `mergeDaily`
- Exports: `storeFor`, `setStoreLog`, `NETWORKS`, `NETWORK_ALIASES`, `LABELS`, `POST_KIND`, `historyKeys`, `postKeys`, `postRef`, `withPostedMs`, `everyText`, `trackPosts`, `trackAccount`, `importAccountDays`, `ACCOUNT_KEYS`, `ACCOUNT_DAYS`, `accountGains`, `WEEKLY`, `withWeekly`, `EARLY_HOURS`, `trackEarly`, `setTakeOffNotice`, `takeOffWords`, `surgingRefs`, `earlyAt`, `readHistory`, `thin`, `hoursOld`, `withOlder`, `toCheck`, `META_CALLS_PER_HOUR`, `postsPerPoll`, `totalsByDate`, `median`, `addSiteHosts`, `sitePath`, `siteLinks`
- Imports: config (`SITE_HOSTS`), stats/store

### `stats/performance.mjs`
"vs your usual" and "vs industry" verdicts added to every network file; `/performance.json` (`performanceDoc`, also
the weekly summary's best posts).
- Exports: `SIGNALS`, `perfContext`, `performance`, `withPerformance`, `performanceDoc`, `performanceRoute`
- Imports: stats/history

### `stats/timing.mjs`
When to post: one Bayesian model per network (weekday, part of the day, kind of post), High/Medium bars checked against shuffled posts in the background; `/timing.json`.
- Exports: `timingRoute`
- Imports: stats/history

### `stats/post.mjs`
One post up close for the Post dashboard: numbers over time, vs typical at the same age, verdict, its site page
(`pageFor`). And `/page.json` for the Page dashboard: every post whose `pageFor` page is the one asked for, and the
page's visitors by network (Tinybird `api_top_sources`, grouped with `SOURCE_RULES`, which it also hands the
dashboard's members query as `rules`).
- Exports: `postRoute`, `pageRoute`
- Imports: stats/history, stats/performance

### `stats/store.mjs`
stats.db through `node:sqlite`: tables posts / checks / days / surges / account / meta, daily `VACUUM INTO` backups.
All SQL lives here.
- Exports: `openStore`
- Imports: nothing of the bridge's

### `stats/instagram.mjs`
Instagram account + posts + Stories + profile days, straight from Graph with Postiz's token; writes instagram.json.
- Exports: `IG_STATS`, `IG_STATS_FILE`, `startInstagramStats`
- Imports: config, services (`PG`, `pgQuery`, `postiz`), stats/history, stats/performance

### `stats/youtube.mjs`
YouTube Data + Analytics APIs (token swapped from Postiz's refresh token), per-video days (`ytVideoDays`).
- Exports: `YT_STATS`, `YT_STATS_FILE`, `startYouTubeStats`
- Imports: config, services (`PG`, `pgQuery`), stats/history, stats/performance

### `stats/soundcloud.mjs`
SoundCloud with the bridge's own app (client credentials), daily history from totals.
- Exports: `SC_STATS`, `SC_STATS_FILE`, `startSoundCloudStats`
- Imports: config, stats/history, stats/performance

### `stats/social.mjs`
Collectors run by stats/stats.mjs, one function each.
- Exports: `bluesky`, `threads`, `tiktok`, `mixcloud`
- Imports: stats/history

### `stats/site.mjs`
Collectors for the site: Ghost (Admin API + Tinybird, per-post days), Cloudflare (GraphQL), Search Console (JWT).
- Exports: `ghost`, `cloudflare`, `search`
- Imports: config (`SITE_HOST`), stats/history

### `stats/live.mjs`
Live shows from TinyIce's status (and the relays', with LIVE_RELAYS: k8s), theme click beacons (clicks.json, counters; also the LIVE NOW bar's hiccups), puppy pets (pets.json).
- Exports: `liveShows`, `siteClicks`, `pets`, `countPets`, `savePets`, `startPets`
- Imports: config, stats/history
