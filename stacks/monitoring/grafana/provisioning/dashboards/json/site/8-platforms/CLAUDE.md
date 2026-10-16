# Platforms (`8-platforms/`)

The Platforms dashboard, kept as parts (`stacks/monitoring/grafana/parts.py`; format, staging, checks, v2 notes: `stacks/monitoring/grafana/CLAUDE.md`,
along with the Infinity gotchas and the shared look). One row folder per section, e.g. `04-instagram/panel-26.json`.

- Platforms (uid puppi3-platforms) = one expanded row per network
  (The site (Ghost) first, then the networks A-Z (user asked, so they're easy to find): Bluesky, Instagram, Mixcloud,
  SoundCloud, Threads, TikTok, YouTube; the hidden has_/every_ variables in the same order: text, totals + status, per day (post markers: an annotation per network from its bridge file, violet, `filter.ids` = its
  chart(s) + the site's panel 102, which also gets "Ghost posts" from MySQL; hidden toggles), posts table, with
  section dropdowns `sort_<network>` (custom: "Newest first" = Posted, or a number column's name -> a `sortBy` transformation,
  desc, nulls last; no table `sortBy` option) and `show_<network>` (all / range: root_selector
  `$append([], posts["${show_x}" = "all" or (time >= ${__from} and time <= ${__to})])`) + `organize` in the query's column order).
- Show/hide rules: hidden variables `has_<network>` (Infinity, yes/no:
  numeric `totals.*`, or any daily/posts/videos/tracks/uploads/history/followerHistory; `totals.*[$type($) = "number"]`,
  since Infinity's JSONata matches null loosely) and a row rule "has_<network> equals yes", so unset-up networks vanish but
  a broken one with earlier numbers keeps its error; hidden `every_<network>` (Infinity, the file's `checkedEvery`: `everyText(mins)` in stats/history.mjs, written by
  every collector and IG/YT/SC; "regularly" if absent) fill each section's "read by the bridge ${every_x}" text, so it follows `*_STATS_MINUTES`; "Networks not shown" (panel 9010, last row, headerless) lists the
  no's with `errors`, merged, with rule "Query result: has data", which Grafana 13 keeps only on an `AutoGridLayoutItem`
  (not GridLayout; rows only take variable/time-range rules); a repeat on an empty variable still shows the row once.
- Platforms dashboard: Instagram totals, status/errors, followers & reach per day, per-post table. Platforms rows Bluesky/Threads/TikTok/Mixcloud (Mixcloud uploads also in
  Social's top section like SoundCloud).
- Charts (user asked: lines, not bars, the same numbers for every network, as an analytics expert would): each network
  has two (Instagram and YouTube three), all lines, no stacking, no totals beside daily counts. Followers (totals,
  `text`; 107/19/76/67/52/38/47/87; the site's also Newsletter subscribers blue, Paid members green hour by hour only)
  and Reach & engagement (the old per-day ids 25/72/62/32/42/82; user asked: no engagement without someone seeing it, so
  one chart): each day's number thin dashed 1px, no fill, and its 7-day average `<key>7` bold; reach/views/plays in the
  network colour on the left axis, `engagement` blue on its own right axis (user turned down a log scale; both axes
  labelled, `custom.axisLabel`, the left one Reach/Views/Plays); `rate7` "Engagement rate, 7-day" (%) and the network's own
  likes/comments/shares/saves words are tooltip-only series (`hideFrom` legend+viz; fixed colours by meaning:
  Likes/Favorites yellow, Comments/Replies blue, Shares/Reposts text, Saves/Quotes #B28CFF, since a palette counts the
  hidden view's empty series). Threads' Link clicks (blue) on its chart too; YouTube's Minutes watched tooltip only.
  The site: "Site visitors & engagement" (102, linear; user asked for engagement there too: new members green, comments
  blue, link clicks text, live plays #FF4FA3 in the hover, rate per 100 visitors as %). Bluesky has no views: its 55 is engagement alone (linear) with "per
  100 followers" on the right axis. Instagram's 27 (profile views & link taps, linear) and YouTube's sources 34 sit in
  the same line. The 7-day numbers, engagement and rate are the bridge's (`WEEKLY`/`withWeekly` in stats/history.mjs:
  by date, 4 of 7 days needed; rate = the week's engagement / the week's reach, views or plays), not JSONata:
  jsonata-go can't be trusted with it. Layout: the charts at y 6, 8 high, w 12 each (Instagram, YouTube: three of w 8).
  Post markers (`filter.ids`) on all of a network's charts, + the site's 102.
- Every chart follows the time range (user asked: no dropdown): hidden dashboard variable `chart` (Infinity, inline `{}`,
  `refresh: onTimeRangeChanged`, root_selector `(${__to} - ${__from}) <= 608400000 ? "hour by hour" : "per day"`, i.e.
  7 days + 1 h of slack; value = text, in the titles as `${chart}`): query A (`daily`) and B (`GET /account.json?network=`
  `checks`) each gated in root_selector (`"${chart}" = "hour by hour" ? checks : []`; an empty array is 0 rows). Rendered
  on Grafana 13.2.3 + Infinity against fake data (Last 7 days = hour by hour, Last 30 days = per day). User asked: hour by hour shows what
  per day does, so B's columns carry A's names (A's byName overrides style both) from the bridge's `accountGains`:
  totals as they stood, gains = `new<Key>` or `<key>` (today-so-far differences), `engagement` = the WEEKLY `hourly` keys
  added up (Instagram's `newPost<Likes|Comments|Shares|Saves>` and Threads' `newPost<Likes|Replies|Reposts|Quotes>`: the posts'
  summed gains, since their account insights come in late and read flat); no 7-day lines or rate there. The last override, `byFrameRefID` B, makes B's lines linear, 2px, solid,
  fill 10 (else they'd be the faint dashed "each day" style; not stepped: user saw steps over mostly-0 hours as bars). Only YouTube's Minutes watched and Shares have no hourly
  (Analytics: per day, 2-3 days late). No panel `timeFrom`. Grids can't show/hide panels by variable, hence one panel
  per chart for both views.
- Stat tiles: each network's numbers are 2-3 tiles of 3-4 numbers (ids: the old one first, then 105/106, 17/18, 75, 66,
  56, 36/37, 45/46, 85/86), each an `organize` (Infinity's A-Z) and `text.titleSize` 12: one tile of 8-12 numbers in a
  row was unreadable on a phone (Grafana stacks panels full width there but keeps the height; the numbers don't wrap).
- Shown: Platforms
  posts tables' "vs your usual" + "vs industry" columns (regex value mappings on the label's start for colour, `color` mode thresholds so unmapped labels stay
  plain, tooltips `perf_tip` / hidden `industry_tip`, hidden `Score` for Sort by "Doing best first"), Social Recently
  published, Post.
- Shown on Platforms (user asked: useful without clutter): Instagram row's posts table (panel 26, "Instagram posts & Stories": `posts` + `stories` appended,
  Type Story, Replies/Taps/Profile visits columns; Story rows open Post too: `NETWORKS.instagram.stories`, kept as
  `instagram-stories`, compared only with Stories) + Stories/Story views tiles (`stories30`/`storyViews30`), posts table Follows + Avg watch (ms),
  a row of Followers by country/age/gender (horizontal barcharts 29/20/21, `audience` = `audienceLists`; barcharts, not bargauges: an empty bargauge draws its no-data text as a bar, a barchart centres it) + "When followers are online"
  (barchart 22, `onlineByHour`: IG's hours taken as Pacific, `zoneHour` -> SITE_TIMEZONE); Threads Link clicks (daily
  `linkClicks` from the archive's insights days, `linkClicks30`); YouTube "Where YouTube views come from" (barchart 34 beside
  the per-day chart, `sources28` from the archive's `trafficSources`, `YT_SOURCES` names); Bluesky Saves, Mixcloud Listeners,
  Ghost More/Less like this columns (+ sort options). Posts tables' columns `custom.minWidth` 70 so they fit.
- Platforms' "When to post" row (panels 90, 91, 92 "what kind of post": timing.json `kinds`, one row per network and
  kind, `vs average` + its `tip`/`style`, only networks with two kinds or more;
  before "Networks not shown", no rule) = `GET /timing.json` (the model: `stacks/postiz/ghost-bridge/stats/CLAUDE.md`). Low
  faded + striped, Medium a little faded, via each slot's hidden `<slot> style` (CSS object, table override `custom.styleField`; no posts = transparent, not
  the threshold's red) and `<slot> tip` (`custom.tooltip.field`: nested table options are their own override ids, not
  `custom.tooltip: {field}`; Grafana 13.2 opens it from the cell's corner triangle);
  `?<network>=<key>` picks another number, from dropdowns `cmp_<network>` (section variables: the row's `spec.variables`) filled from its `options.<network>` (numbers
  >= 3 posts have with a median > 0, else no ratio, main first; none = one '' "Not enough posts yet", as an empty list errors the dropdown); an `organize` transformation sets the column order, since Infinity returns them A-Z. The three tables (and
  "Networks not shown") start with a `sortBy` Network A-Z transformation (user asked: the bridge's rows come in its
  NETWORKS order; stable, so a network's kinds keep theirs), and the `cmp_` dropdowns are A-Z too (Ghost among them).
