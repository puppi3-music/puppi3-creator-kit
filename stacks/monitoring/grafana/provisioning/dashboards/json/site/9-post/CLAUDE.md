# Post (`9-post/`)

The Post dashboard, kept as parts (`stacks/monitoring/grafana/parts.py`; format, staging, checks, v2 notes: `stacks/monitoring/grafana/CLAUDE.md`,
along with the Infinity/MySQL gotchas and the shared look; the colour variable: style.py, there).

- Post (uid puppi3-post; not in the header nav: opened by a row link in each Platforms posts table,
  `var-network`/`var-post` = hidden `ref` column, `from` = hidden `posted_ms` (the bridge's own string copy of `time`, `withPostedMs` on every collector's file: a number field goes into a link as Grafana shows it, and a bad `from` sends Post's charts back to 1970); Social's "Recently
  published" rows too (Postiz rows: `ref` '' + `var-time`, the bridge picks that network's post within 30 min), and the
  "Social posts" annotation text on Overview/Traffic/Growth carries an `<a href>` the same way, only for networks the bridge
  collects (SQL `CASE`), and the magenta "Ghost posts" annotation's links `var-network=ghost&var-post=<id>`; `/post.json` maps Postiz's `instagram-standalone`/`tiktok-business` (`NETWORK_ALIASES`) and explains
  others): one post's numbers now, "vs your other <network> posts" + "vs the industry average" tiles, "Why", "What it was
  judged on" (panels 7, 10, 8, 9: post.json's `performance`/`perfSignals`, see the verdicts in `stacks/postiz/ghost-bridge/stats/CLAUDE.md`),
  "Number by number vs your usual <network> post" (panel 5: median of the network's other posts at the same age, by the
  hour in the first `POST_EARLY_HOURS`, then days; needs 3; chart of the
  number picked in the section's "Compare on" dropdown `compare` (from `compareOptions`, usual first; `&compare=<key>`) vs
  typical), gained per day, totals, and its site page's visitors/members (all and from that network), all keyed off the
  bridge's `GET /post.json?network=&id=&time=` (hidden dashboard variables `network`, `post`, `time`, `label`, `from` (the
  network's name, or for Ghost "the newsletter": the "…of them from" titles); the site
  section's dropdown `page` (from `pages`: found/guessed page first, marked, then the post's other links, home, Ghost's
  newest 100; "-" = none; title `${page:text}`; `&page=<path>` overrides in post.json, via `sitePath`) and hidden
  `sources` (regex of Ghost's source names for the network) -> Tinybird `pathname=`, MySQL `attribution_url`/`attribution_id`, `REGEXP`).
- The Post dashboard's Tinybird panels return no rows when `page` is empty (bridge unreadable), never the whole site's.
- "Number by number" (panel 5) takes its columns from post.json's `verdict` rows (no Infinity `columns`; an `organize`
  renames and orders them, widths set so all fit in the half-width panel): with nothing to compare the bridge sends a
  `{ note }` row alone, so the table shows only "Why it's empty" across its width (it used to be a row of "–" with the
  note cut off on the right, which looked blank).
- "Visitors to the page per day" (panel 15) has a panel link "Every post about this page" to the Page dashboard
  (`/d/puppi3-page?var-page=${page:percentencode}` + the time range; `stacks/monitoring/grafana/CLAUDE.md`).
