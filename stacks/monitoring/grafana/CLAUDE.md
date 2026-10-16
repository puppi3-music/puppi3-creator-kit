# stacks/monitoring/grafana/

The site's Grafana dashboards and alert rules, for the `monitoring` module (`kit/monitoring/`'s Grafana on Compose,
`k8s/components/monitoring/` on Kubernetes). The dashboards' source is `provisioning/dashboards/json/site/` (render.py's
`SRC_FOLDER`), the alert rules' `alerts.yml`; neither names a site (Placeholders, below): `render.py` makes a site's
copies each time `kit.sh` or `up.sh` runs. What each bridge file (`/post.json`, `/page.json`, `/timing.json`,
`/performance.json`, `/<network>.json`) computes: `stacks/postiz/ghost-bridge/stats/CLAUDE.md` (`/upnext.json`:
`stacks/postiz/ghost-bridge/share/CLAUDE.md`); this file says which panel shows it, and how. For the owner: keep the
Analytics guide (`kit/docs/analytics-guide.html`) current when dashboards, panels, source labels or what's collected
change.
Growth, Platforms and Post have a CLAUDE.md of their own, in their folders (`provisioning/dashboards/json/site/7-growth/`,
`8-platforms/`, `9-post/`), with what's particular to that dashboard: open it before working on one. This file has the
other seven (Page included), and everything the dashboards share (files, gotchas, source labels, shared look).

## Files
- `provisioning/dashboards/json/site/`: the seven classic dashboards are single `*.json` files; the three v2 ones
  (Growth, Platforms, Post) are folders of parts, since Platforms alone was 607 KB: `7-growth/`, `8-platforms/`,
  `9-post/`, each `dashboard.json` (everything but `spec.layout`/`spec.elements`) + one folder per row,
  `NN-<row title>/` (`row.json`: title, section variables, show/hide rule, grid items; `panel-<id>.json` per panel in
  it), and the dashboard's `CLAUDE.md` (parts.py only reads `*.json`: never removed by a split). Edit the part; rows go
  in folder-name order; a new panel = a new `panel-<id>.json` + its grid item in `row.json`. `parts.py` puts them
  together (render.py runs its build first); style.py, ro-tables.py and render.py read every dashboard through
  `parts.load`, so a broken JSON part, a panel `row.json` names that isn't there, a `panel-*.json` no row shows, or a
  dashboard both as file and folder fails them (and so the commit). style.py's fixes rewrite only the parts that
  change. A dashboard exported from Grafana (v2): put the site's own values back as placeholders, then
  `python3 stacks/monitoring/grafana/parts.py split <export.json> stacks/monitoring/grafana/provisioning/dashboards/json/site/<n>-<name>`
  (rewrites only changed parts, removes gone ones). To make another v2 dashboard a folder: `parts.py split <its .json>`
  (removes the file).
- `tests/`: parts.py's and render.py's (`python3 -m unittest discover -s stacks/monitoring/grafana/tests`; `kit/check.sh`
  runs them, and GitHub with it): each folder dashboard is exactly what `split` writes, split and build round-trip, a
  broken folder names what's wrong; a kit render (made-up site `radio.test`, ID_PREFIX `test-radio`) fills every
  placeholder and leaves no `puppi3`, networks and modules switched off drop their rows, rules (listed in `deleteRules`)
  and dashboards, `NTFY_URL` empty, the cloud profile, `by_workload`'s pod names. Not puppi3.py (not in the kit).
- **Placeholders: the source names no site.** Where a site's own value goes, the dashboards and the alert rules'
  source (`alerts.yml`) say `@NAME@`: `@SITE_HOST@`, `@LIVE_HOST@`, `@SITE_NAME@` (the Grafana folder),
  `@SITE_TIMEZONE@`, `@TZ_NAME@` ("@TZ_NAME@ time"), `@TZ_HOURS@` (the MySQL fallback's `INTERVAL @TZ_HOURS@ HOUR`),
  `@GHOST_SITE_UUID@`, `@DISK_MOUNT@`, `@DJ_SOFTWARE@`, `@NTFY_URL@`, `@NTFY_TOPIC@` (render.py's `PLACEHOLDERS`; a new
  one goes there and in the kit's `values`). So a site's link is `https://@SITE_HOST@/...`, a query's time zone
  `@SITE_TIMEZONE@`. Every profile fills them in (`render.fill`); one with no value stops it. The kit's render also
  stops on a real site's values left in the source (`SOURCE_PRIVATE`), as does the commit hook (a render for
  `instances/example.env`). The uids, counters and container names keep the ID_PREFIX default `puppi3`, which the
  kit's swaps rename. The `@` form, because Grafana already uses `${}`, `$x`, `[[x]]` and `{{x}}`.
- Health's router list is `puppi3-[a-z-]+@file|live-status@docker|puppi3-social-preview@docker` in the source (the
  kit's swaps rename `puppi3`); a new site router needs adding there and in the 5xx alert (and the cloud swap, below).
- A kit site's copies: `render.py --profile kit --site <site.env> [--site …]` (kit/kit.sh runs it; `kit/CLAUDE.md`)
  writes `<out>/dashboards/*.json` and `<out>/alerting/<ID_PREFIX>.yml` (from `alerts.yml`). The rules of switched-off
  parts are dropped and listed under `deleteRules` (Grafana keeps a provisioned rule whose entry is gone, and its UI
  can't delete one; it skips a uid it doesn't have: checked on 13.2.3). `NTFY_URL` set but empty: no contact point,
  the rules' `notification_settings` left out (Grafana's own policy, nothing set up = nothing sent) and
  `deleteContactPoints` for `<ID_PREFIX>-ntfy`.
  Swaps (`kit_values`): uids and `/d/` links `puppi3-` -> `<ID_PREFIX>-`, the placeholders filled from the profile
  (`SITE_HOST`, `LIVE_HOST` or `live.<SITE_HOST>`, `SITE_NAME` or SITE_HOST, `SITE_TIMEZONE` (`TZ_NAME` too, and
  `TZ_HOURS` its winter offset), `GHOST_SITE_UUID`, `DISK_MOUNT` (`/`), "the streaming software", `NTFY_URL`/`NTFY_TOPIC`),
  Health's containers and routers, Social's Postiz containers (compose project = `ID_PREFIX`), `puppi3_` counters ->
  `METRIC_PREFIX`, "NAS disk" -> "Disk", Content's "Clicks to music" -> "Clicks to watch or listen" (Vimeo, Twitch and Apple
  Podcasts added to its services: the kit is for any creator), "the postiz .env" -> "secrets/postiz.env", then any `puppi3` left -> `ID_PREFIX`; value-mapping keys too ("@SITE_HOST@":
  "Your own site"). Drops (`OFF`, matched on the source's text, placeholders and all): panels, variables, annotations and alert rules of a module that's off (analytics: `ghost-analytics`; social:
  `postiz-pg`, `bridge-instagram`, the bridge's job and counters; live: `tinyice_`, live counters, `/live.json`; pets
  with `PETS` not true), Platforms rows/variables/annotations and stats rules of networks not in `NETWORKS` (empty =
  all), rows and alert groups left empty, dashboards with nothing left to show (and their header nav/top links).
  `LEFTOVERS_KIT` stops it on any `puppi3`, `Puppi3` or `website-` left. A site's own value in a dashboard is a
  placeholder; a new kind of ID_PREFIX reference needs a swap here. style.py and ro-tables.py check the
  source; the kit's copies only lose and rename things, so they aren't run on them.
- A kit site on Kubernetes: `render.py --profile cloud --site …` (k8s/up.sh runs it; `k8s/components/monitoring/CLAUDE.md`) = kit plus
  `cloud_swaps`, put ahead of the kit's (matched on the source's text, so `@DISK_MOUNT@` where the disk is named): Health's container CPU/memory -> the kubelet's
  cAdvisor for the site's namespace, every pod, `sum by (name)` with `name` = the pod's Deployment/StatefulSet
  (`by_workload`: three `label_replace`s strip `-0` or `-<hash>-<5>` in Kubernetes' own letters, `SAFE`), Social's
  Postiz containers -> `pod=~"postiz.*"`; the disk tile and alert -> `min(kubelet_volume_stats_available_bytes /
  capacity)` (the fullest PVC); Health's router list -> `<ID_PREFIX>-[a-z-]+@file|live-status@file` (all routers are
  @file there); Listeners now / per mount -> TinyIce's minus one per relay that has the stream plus the relays' own
  (`icecast_relay_listeners`, json-exporter's, `or vector(0)` / `or … * 0` when there are none); and those panels'
  and the alert's texts. `LEFTOVERS_CLOUD` stops it on `node_filesystem`, `@docker`, `compose_project`, a stack manager's name, a
  `container_…{name` selector or "docs site" left. Writes compact JSON (a dashboard is one ConfigMap, 1 MiB at most:
  Platforms ~280 KB). A change to one of those panels' queries or texts needs its cloud swap changed too.
- Growth, Platforms and Post are in Grafana's v2 file format (`apiVersion dashboard.grafana.app/v2`, metadata.name = uid, spec
  elements/layout; file provisioning reads it), for section variables (a row's `spec.variables`: shown at the top of that
  section, seen only by its panels/title, still `var-<name>` in URLs; can be hidden; Growth/Post were converted by Grafana
  13.2.3 itself via `/apis/dashboard.grafana.app/v2/namespaces/default/dashboards/<uid>`) and Platforms' show/hide rules (`8-platforms/CLAUDE.md`).
  v2 queries name the datasource `{"name": uid}` (render.py swaps that and handles v2's metadata/alertlist elements);
  export from Grafana in v2 or the rules and section variables are lost (then `parts.py split` it, as above).
- Alert rules link panels by `__dashboardUid__`/`__panelId__`, so keep panel ids when moving panels and update the uid there.

## Infinity / Grafana gotchas
- Ghost analytics panels use the Infinity
  datasource (`ghost-analytics`, Tinybird pipes). Gotchas, tested on Grafana 13 + Infinity 4: Infinity fills in
  `${__from}`/`${__to}` (incl. `:date:seconds`) in URLs, summarize/filter expressions and root_selector but NOT `${__range_s}`;
  an ISO time with a `+0000` offset (Instagram's) parses as empty: use epoch ms + column type `timestamp_epoch`;
  a JSONata root_selector building an object (`{"x": $count(...)}`) with columns comes back empty (jsonata-go's
  object literal isn't a plain map): wrap it, `$merge([{...}])` (the status panels do), or use a bare `$count(...)` with no
  columns, or filterExpression + summarizeExpression/summarizeBy; computed columns and filter
  expressions name columns by their `text`, not the JSON selector; JSONata that comes out undefined (`$max([])`, a missing key) fails the whole query with "no results found" (pad: `$max([0, ...])`;
  an empty array is fine, 0 rows); Grafana
  math expressions don't fill in variables at all (`${x}` is read as a query refId). A variable in a transformation's options is filled in as
  JSON text (stringify, replace, parse), so a value with a backslash (`\.`) is a bad escape that crashes the whole
  dashboard ("JSON.parse: bad escaped character"): regexes there go without backslashes (`[.]`, as the bridge's `sources`).
- Infinity's `a ? b : c ? d : e` doesn't chain: parenthesise each nested branch.
- Infinity frames come A-Z: an `organize` transformation sets the column order wherever it matters.
- MySQL: `grafana_ro` may read only the tables in `TABLES` of `stacks/ghost/grafana-ro.sh` (`stacks/ghost/CLAUDE.md`).
  `stacks/monitoring/grafana/ro-tables.py --check` (pre-commit hook) fails when a ghost-mysql query in the dashboards
  or alert rules reads a table not listed (a new one: add it, rerun the script; else "query failed"). Variables in MySQL SQL go only as `"${x:percentencode}"`
  (URL-encoded in a double-quoted literal: never a raw `"` or `\`), decoded in the query by a `WITH v AS (SELECT REPLACE(...))`
  (Post's member queries); `ro-tables.py --check` fails on any other form. Not `:json` (Grafana 13 leaves a plain value
  unquoted: SQL error), nor `:sqlstring`/`:singlequote`/`:doublequote` (no backslash escaping: `\'` breaks out; the Post
  dashboard's `page`/`sources` take any value from the URL).
- Ghost stores `referrer_source` 'Direct' when there's no referrer, Tinybird
  ''; the MySQL source queries map 'Direct'/NULL to '' (Members: 'Direct / unknown') so the join lines up.

## Traffic, Members (Growth: `7-growth/CLAUDE.md`; source labels are shared)
- "Unique visitors" = sum of
  daily `visits` (Ghost can't link days); Traffic's "per day" divides by the range's days, "Bounce rate" and "Avg visit
  length" weight each day by its visits (computed column + summarize; api_kpis gives empty days as 0), "Pages per visitor"
  = sum(pageviews)/sum(visits), both via `summarizeExpression`.
- Members rows: Newsletters, Email health.
- Source labels (value
  mappings wherever sources are listed): Facebook -> "Facebook (mostly Instagram links)" (Meta's link redirect),
  the site's own host (`@SITE_HOST@`) -> "Your own site" (Growth's Top network tile leaves it and Direct out (`filterExpression`), groups by network with a
  computed column (Facebook/Instagram/instagram/ig -> Instagram, tags capitalised) + `summarizeBy`, then sortBy + limit 1, shown as two stacked values (fields `/^(Source|Visitors)$/`, orientation horizontal)),
  empty -> "Direct / unknown", plus the tag names as "<Network> (tag: <tag>)" (ig -> "Instagram (tag: ig, set by Instagram)": Instagram's app adds it) so
  a tag can't be mistaken for Ghost's referrer of the same name; "Tagged links" keeps plain network names, since Ghost lists utm_source values as sources; the `$source` dropdown gets the same labels as `__text` computed columns (titles use
  `${source:text}`).
- Members "Email health"
  (members_subscribe_events, email_recipient_failures, email_spam_complaint_events, members.email_disabled).
- Traffic sections Google Search + Cloudflare, Content sections "Links people follow off
  the site" (click rows have `time`/`end` so `filterExpression` `end > ${__from}` picks overlapping days; Grafana
  `groupBy` transformation, not Infinity summarize, for multi-column groups) + "Live shows".

## Overview, Health, Social
- Overview, Traffic and Growth have annotations "Ghost posts" (MySQL) and "Social posts" (Postiz) (their links open Post:
  `9-post/CLAUDE.md`).
- All 10 dashboards share the header nav and top links (Post and Page too, though not listed in them; Overview, Health, Traffic, Growth, Members, Content, Social, Platforms).
- Page (`10-page.json`, uid puppi3-page, classic; not in the nav: style.py's `EXTRA_NAV` marks "Page: ${page:text}"):
  one site page, from the bridge's `GET /page.json` (`stacks/postiz/ghost-bridge/stats/CLAUDE.md`). `page` dropdown (page.json `pages`,
  custom values allowed: links pass `var-page=<path>`), hidden `rules` (page.json?path=); tiles Posts that led here
  (`$count(posts[key != "ghost"])`), Visitors to the page (Tinybird `api_kpis?pathname=`, as Post's 11), …of them from the
  networks (page.json `visitors[isNetwork]`), New members who joined there (Post's 13 SQL); "Posts that led here" table
  (row link to Post, `posted_ms` as `from`; guesses orange), visitors per day (Post's 15) with the posts as violet
  annotations (page.json `posts`), Visitors by network (page.json `visitors`, from/to/timezone from the range), Members by
  network (MySQL: Post's 17 grouped with `${rules:percentencode}` decoded (+ `%22 %7B %7D`) through `JSON_TABLE` and
  `REGEXP_LIKE`, everything `COLLATE utf8mb4_bin`: Ghost's tables, Grafana's connection and JSON_TABLE differ and MySQL
  refuses the mix; ro-tables.py skips `json_table`). Linked from Content's "Post performance" (Post column, 2nd link) and
  "Top pages" (Page column), Growth's Content table (Path column) and Post's "Visitors to the page per day" (panel link),
  each with the time range. Rendered on Grafana 13.2.3 + Infinity against fake data before it went in.
- Overview's "Puppies petted" stat reads the bridge's `/pets.json` (`bridge-instagram`); its "per day" bars come from
  Prometheus's `puppi3_puppy_pets_total` (per bar: the day's highest total minus the day before's, `offset -$__interval` because Grafana aligns a bar's
  window to end at its own midnight; interval 1d; exact, unlike `increase()`; history only from when the job went live).
- Overview "Posts doing well (last 30 days)" (501: doing well, above industry, judged) + "Best posts lately" (502)
  from `GET /performance.json`. Overview's "Alerts firing now" (panel 9001) lists the `project="puppi3"` rules.
- Health also shows the live stream (probe; On air = audio coming in on `/stream-ogg`, `rate(tinyice_stream_bytes_in_total)`,
  not `tinyice_sources_total`, which the always-on /stream-mp3 transcode keeps at 1; listeners), bridge `up{job="puppi3-pets"}`, 5xx share and the disk's free space (`@DISK_MOUNT@`). Under "Live stream listeners":
  listeners' pauses and reconnects by why (118, bars) and by tab/device/browser (121, table), from the bridge's
  `puppi3_live_stalls_total`/`puppi3_live_reconnects_total` (sparse counters whose label sets appear mid-range, so not
  `increase()`, which misses a series' first count: `sum by (x) (c) - (sum by (x) (c offset $__interval) or sum by (x) (c) * 0)`,
  min interval 1m), TinyIce's bytes in per mount (119: /stream-ogg = the DJ software, /stream-mp3 = the transcode; a dip = the
  sending side) and bytes skipped for slow listeners (120). Content's Past shows has the per-show Pauses/Reconnects.
- Social = Postiz queue + drafts;
  its "Up next" (panel 9) = Ghost's scheduled posts from the bridge's `GET /upnext.json`
  merged with Postiz-only scheduled posts; "Scheduled" (panel 2) = both, a math expression
  (+ collapsed Postiz containers row); Social's Postiz containers section is a collapsed row.
- Social dashboard: "Drafts to
  post in the app" section (Postiz drafts tagged "Post in app" via postiz-pg, whose `grafana_ro` needs SELECT on "Tags" + "TagsPosts" too).
- Social's top section (Published, per day, by network, Recently published) is
  mixed: Postiz's posts minus Instagram (`providerIdentifier NOT IN ('instagram','instagram-standalone')`) plus the
  account's own posts from instagram.json (`posts[].time` ms + `network`/`account` for Recently published, `postsPerDay` UTC; Published = bare JSONata `$count(posts[time >= ${__from} and time <= ${__to}])`, by network =
  filterExpression on `time` + summarize by `network`),
  since IG posts go out by hand and Postiz never marks them published. Recently published also swaps Postiz's YouTube
  rows for youtube.json's `videos[]` (same fields, `title` as Post), so uploads made outside Postiz show too, and Bluesky,
  Threads, TikTok (`tiktok-business` too) rows for those files' `posts` (`text` as Post), for their verdicts; an `organize` sets
  the column order (Infinity frames come A-Z). SoundCloud and Mixcloud uploads count there too.

## Shared look, refresh
- All auto-refresh (`"refresh"`: Health 1m, the rest 5m; staging copies inherit it).
- Shared look: `stacks/monitoring/grafana/style.py` (pre-commit `--check`; run it to fix) sets the same top links + header nav (panel 9000,
  from `NAV`, links carry `?${__url_time_range}`; Post's (`OWN_TIME`) don't, nor keepTime: its range is the post's), shared crosshair, time series tooltip multi/desc, legend list bottom,
  bars fill 60, lines 2 px fill 10 (0 over bars), tables `cellHeight` sm, `value_and_name` stats `orientation`
  vertical, `wideLayout` false, `justifyMode` center (auto's grid puts a number over the next row's name; wide layout puts it
  at the cell's right edge, beside the next name); it only checks colours: a fixed colour not in
  `COLOURS` (one meaning each, listed for the owner in the analytics guide's Colours section) fails. Post's numbers and
  line are the network's Platforms colour: fieldConfig colours don't take variables, so style.py's `NETWORK_COLOURS` fills
  Post's hidden `colour` variable (post.json `network` lookup, else `#B28CFF`), and panels 2/3/4/6 take it via an inline
  Infinity query `Colour` + `configFromData` (applyTo numeric, hidden `main` = the usual number on 3/4, the rest shades of
  `text`, or "This post" on 6).
