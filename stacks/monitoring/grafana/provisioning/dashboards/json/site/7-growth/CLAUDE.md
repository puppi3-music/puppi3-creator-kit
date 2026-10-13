# Growth (`7-growth/`)

The Growth dashboard (uid puppi3-growth), kept as parts (`stacks/monitoring/grafana/parts.py`; format, staging, checks: `stacks/monitoring/grafana/CLAUDE.md`,
along with the Infinity/MySQL gotchas, the source labels and the shared look). Rows: where they come from, what they
read, one source up close.

- Headline stats (visitor->member = mixed panel, MySQL count / Infinity sum via a
  math expression referring to refIds, no variables), a daily chart with members, Sources / Campaigns / Content tables
  joining Infinity (api_top_sources / api_top_utm_campaigns / api_top_pages) with MySQL `members_created_events`
  (referrer_source / utm_campaign / attribution_id or attribution_url) via `joinByField` + `renameByRegex` "^(.*) A$"
  (Grafana suffixes the Infinity columns with the refId after a join) + `calculateField`, and a `$source` section variable (in its row)
  (Infinity query) for api_kpis/api_top_pages `source=`. Annotations "Ghost posts" (MySQL) and "Social posts" (Postiz),
  as on Overview and Traffic.
- "Tagged links, by network and link" = api_top_utm_sources twice (`utm_medium=social` / `bio`: Ghost's pipes filter on
  any utm_*), each with a computed Link column, `merge`d with members_created_events grouped by utm_source + utm_medium (one row per
  network and link: posts / bio link / "tagged by Instagram" for ig, which Instagram adds with utm_medium=social
  to plain profile links to the site), with Network mappings. The tags come from the bridge's short links (`TAG_LINKS`,
  `stacks/postiz/CLAUDE.md`) and the bio links in the site's redirects (`kit/redirects.yaml`).
- Growth hides outlier rows with Hide/Show custom section variables `hide_direct` (Sources' row, regex `^(null)?$`) and
  `hide_home` (Content's row, `^/$`) used in a filterByValue regex after the join (`${var:raw}`; Show = `(?!)`); its tables
  are `filterable` (column filters, per viewer). "Posts vs bio links" = api_top_utm_mediums + members_created_events.utm_medium (social = bridge + hand-shared `/d/`, `/y/` links, bio = short links);
  Campaigns: neither the bio links nor the bridge's links carry a campaign (Content shows the post), except posts tagged `#campaign-<name>`.
