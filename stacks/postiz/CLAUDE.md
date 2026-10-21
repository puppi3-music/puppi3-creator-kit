# stacks/postiz/

Postiz and `postiz-ghost-bridge` (the `social` module). Keep the Posting guide (`kit/docs/posting-guide.html`) current
when tags, captions, media rules or notifications change. Which Grafana panel shows each bridge file, and how:
`stacks/monitoring/grafana/CLAUDE.md`. A site may run a second, DRY_RUN bridge as a staging copy (it previews and
logs, never posts); some notes say what such a copy does.

These folders have a CLAUDE.md of their own: open it before working there. This file has the stack: `compose.yaml`,
the settings it passes, and Postiz.

| Folder | What it is |
|---|---|
| `ghost-bridge/` | The bridge: its modules and import rules, Ghost's webhook, SIGTERM, the image; `pages/` (the preview pages). Before opening a module, read `docs/bridge-map.md` |
| `ghost-bridge/share/` | Sharing a post: previews, captions, tagged links, photos, notifications, `/upnext.json`; seasonal profile pictures; the weekly summary |
| `ghost-bridge/stats/` | Every number: pets and clicks, each network's collector, the verdicts, `stats.db`, `/post.json`, `/page.json`, `/timing.json`, the archive |
| `ghost-bridge-test/` | The bridge's tests (Node's own runner) |

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
- postiz: Postiz (pinned `v2.24.0`: the bridge's photo rules were checked against it), Postgres, Redis, Temporal (+ Postgres, which also holds its searchable records: `ENABLE_ES=false` and `SKIP_ADD_CUSTOM_SEARCH_ATTRIBUTES=true`, unlike Postiz's own compose file; Elasticsearch held ~0.7 GB. Postgres has 3 searchable text fields, Postiz adds `postId` and `organizationId` at start and finds a post's running job by `postId`; jobs scheduled before the kit 1.3.1 switch aren't found by that search), and `postiz-ghost-bridge` (`ghost-bridge/`, its own CLAUDE.md): compose mounts the folder
  read-only at /app, so a new module (subfolders too) needs no compose line; `user: root` (as the kit's profile: an
  image built from `ghost-bridge/Dockerfile`, USER node, couldn't write `data/`; staging's bridge too); healthcheck every 5 s (Traefik routes
  only to healthy); `stop_grace_period: 5m` (the bridge finishes a share in progress); registration defaults closed
  (`POSTIZ_DISABLE_REGISTRATION:-true`).
- On Kubernetes the bridge's whole environment is this compose.yaml's, rendered by `k8s/up.sh`
  (`k8s/components/social/CLAUDE.md`), so settings added here reach it.
- Operating Postiz (the user-side steps: the Networks and Operations guides). Updating it: its release notes first
  (v2.12 brought Temporal; majors have needed compose changes), then the source the bridge relies on:
  `valid.url.path.ts`, `custom.upload.validation.ts`, the instagram/tiktok/threads/bluesky providers and their settings
  DTOs, `validatePosts` in `posts.service.ts`; after the new tag is up, restart postiz once Temporal is healthy, and
  check the calendar after the next post with photos. Temporal changes only with `gitroomhq/postiz-docker-compose`,
  keeping no Elasticsearch. The public API (`http://postiz:5000/api/public/v1`, header `Authorization: <key>`):
  `upload-from-url` takes only a public https address ending in .png/.jpg/.jpeg/.gif/.webp/.mp4 (`upload`, multipart,
  for the rest: the audio clips, converted photos); `POST /posts` (one per channel, so one failure doesn't stop the
  others) is limited to 30 an hour (`API_LIMIT`; a Ghost post uses up to 4); `GET /notifications` isn't limited.
  Add Channel with an account Postiz already has upserts on `(organizationId, internalId)`, so its posts stay
  attached; "Reconnect channel" shows only when Postiz flags a token. `postiz-temporal-ui` listens on the host's
  127.0.0.1:8233, no sign-in (an ssh tunnel from elsewhere).
