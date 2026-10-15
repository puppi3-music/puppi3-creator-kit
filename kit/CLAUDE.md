# kit/

Puppi3's Creator Kit: the Compose kit, its theme, its guides and its checks. `CLAUDE.md` at the top maps the rest
(`k8s/`, `stacks/`, `instances/`).

`README.md` (at the top) is the kit's front page (for someone setting up a site, no repo knowledge): what it does,
Compose and Kubernetes in short, the licence notice and credit. `LICENSE`: AGPL-3.0 (gnu.org's text, unchanged) under a
header with the copyright, what it covers, and the section 7(b) term (keep the theme footer's credit line and the
copyright line). `CONTRIBUTING.md`: where things are, what goes with a change, which test fits.

`scrub.py`: no secrets and no private names in the kit. It runs gitleaks (Docker, pinned) over the repo's whole history
and every file, then looks in every file for `PRIVATE_WORDS` (settings_reference's) plus `EXTRA` (more names,
addresses and paths that mustn't be in it), apart from what `ALLOW` keeps on purpose (the copyright and author credit,
the checks' own word lists, the guides' swaps); then the repo's whole history the same way (every version of every
file, the messages, author and committer both the theme's author). `--names` skips Docker, `-v` prints each line. It
only reports; a mention meant to stay goes in `ALLOW` with its reason.

`check.sh [--here <repo>]`: the checks that need no Docker, in seconds: `check_refs.py` (every repo path a file names
is in the repo, every Traefik plugin a file loads is there: one missing turns them all off; `ALLOW` for a mention
that's fine), the guides' build, the dashboards' checks and a render for the example profile, the dashboard scripts'
tests (`stacks/monitoring/grafana/tests/`), the bridge's modules and its tests (`stacks/postiz/ghost-bridge-test/`),
every shell script's syntax. `.github/workflows/check.yml` runs it in the kit's repo on every push and pull request
(the Node of the bridge's Dockerfile, the runner's Python 3; only there, like release.yml). A site repo that sends the kit runs it on the kit's copy with `--here` itself, so a path
only that site has counts as missing. A site's own notes for a folder may be in a `CLAUDE.site.md` beside its
CLAUDE.md (never in the kit's repo).

**For any creator.** The kit is for artists, podcasters, writers, makers and musicians alike: keep its words neutral
("streaming software", "the featured link", "your other platforms", made-up creators in examples). A site's own
wording goes in its `site.env` (the bridge's `FEATURED_*` lines).

- `docs/`: the kit's own guides, built by `docs/build-docs.py` (`KIT_PAGES`: the shared styles and script, their own
  neutral header, a blue palette and Puppi3's puppy as the mark: her theme's `puppi3-icon.png`, the headphones puppy,
  drawn flat (`docs/images/kit-puppy.svg`; the same SVG is each page's header mark and, inline, its tab icon, and the
  README's top); build-docs also fails on `PRIVATE_WORDS` anywhere in a kit page or the shared assets). `index.html` is
  their front page: a card per guide, each with her puppy on a sitting body in her own colours (inline SVG, shared
  `#kp-*` parts in a hidden defs block after `<body>`; no headphones there, only on the mark) in that guide's outfit; the tail wags and the head tilts on hover, props float or spin
  (all off under reduced motion). `setup-guide.html` (by hand): requirements, Cloudflare or not, the
  folder (setup's questions), Compose, finishing by hand (mail, theme, redirects, Postiz, webhook, ntfy, streaming,
  Grafana), Kubernetes (overlays, images, up), EKS/GKE (what to make, neutral: no
  one site's own commands), the tests: keep it current with `setup.sh`'s questions and printed steps, `up.sh` and the overlays.
  `operations-guide.html` (by hand): updating (git pull, `pull --ignore-buildable`, images, theme and redirects by
  `git diff` from the noted version), backups (the folder plus Compose's four Tinybird volumes,
  `<ID_PREFIX>_tinybird_*`/`_traffic_analytics_data`, which `down -v` deletes; stopped tar, running dumps, restore
  through `kit.sh create` so Compose owns the volumes; Kubernetes), moving (another machine; `to-cloud.sh`/`to-nas.sh`
  for a kit site: a second folder for the cluster, same `ID_PREFIX` and secrets), troubleshooting, commands. Its
  backup and restore commands were tried on a throwaway site: keep them true to `kit.sh`, the stacks' volumes and
  `k8s/migrate/`.
  `theme-guide.html` (by hand, for the site's owner): the kit's theme (Source plus the kit's parts; installing and
  updating it), Source's settings as Ghost Admin shows them (`theme/package.json`'s `config.custom`), the LIVE NOW bar,
  the Social preview button, the platforms `kit.js` gives icons ("Links to your other platforms", `#platforms`), the short links (`redirects.yaml`), and another
  theme (what it lacks, adding the kit's parts from `theme/KIT.md`). Keep it current with `theme/` and `redirects.yaml`.
  `posting-guide.html` (for whoever posts: the bridge's tags, captions, media, notifications, finishing Instagram and
  TikTok) and `analytics-guide.html` (each dashboard, the verdicts, When to post) are by hand too: keep them current
  with the bridge (`stacks/postiz/CLAUDE.md`) and the dashboards.
  `settings-reference.html` is written by
  `settings_reference.py` between its `generated` markers (the rest of the page is by hand): `site.env` from
  `instances/example.env`, each `secrets/<stack>.env` from its examples, k8s's files from `k8s/examples/` and the
  overlays' `cloud.env.example`, the bridge's fixed settings (literal values in `stacks/postiz/compose.yaml`, with the
  comment beside each), and which keys setup asks for, makes or fills in (read from `setup.sh`; a fixed value it writes, like
  `database__connection__database=ghost`, is shown instead of the stack example's own). Its checks stop
  build-docs (and the pre-commit hook, which runs when any of those files are staged): a `${VAR}` in a kit compose
  file, profile or Traefik template that no example documents (or `SET_FOR_YOU` lists), a documented key nothing
  reads (git grep outside the examples), private names (`PRIVATE_WORDS`). So a new setting needs a commented line in
  its example; the comments there are the reference's text: plain words, one comment block per group of keys, a
  blank line after a file's header.
- `examples/`: the kit-only parts of a site's secrets files (`icecast.env.example`, `monitoring.env.example`), and
  `ghost-mail.env.example`, a file of its own the site's owner copies to `secrets/ghost-mail.env` (Ghost's `mail__*`;
  Compose's Ghost reads it through `profiles/ghost.yaml`'s `env_file`, Kubernetes' as Secret `ghost-mail`), so the SMTP
  password is in `secrets/` (600), never in `config.production.json` (644: Ghost's user must read it on Linux).

A kit site is a folder (`kit/sites/<name>/`, git-ignored, or anywhere): `site.env` (the instance profile),
`secrets/<stack>.env` (each stack's secrets), `data/` (everything it keeps: `DATA_DIR`; Ghost's stack in `data/ghost/`,
`GHOST_DATA_DIR`). A site made before kit 1.2.0 has the Ghost stack's old name, `secrets/puppi3.env` and `data/puppi3/`:
`kit.sh`, `setup.sh`, `k8s/up.sh` and `k8s/migrate/` keep using those (`g=puppi3` when either is there), so nobody has
to move anything. Nothing of a site goes in
`stacks/`: a stack run on its own reads its folder's `.env`, so one there could end up as another site's.

- `setup.sh <folder> [--yes]`: makes the folder, asking for the few values. First whether it's a try-out (`TRYOUT=yes`:
  before the domain points here; `TLS_RESOLVER=self`, `BEHIND_CLOUDFLARE=false`, `NTFY_URL` empty = no phone alerts,
  Ghost's `staffDeviceVerification` false (no mail yet), and the printed steps say how to reach it through a hosts
  file); `NETWORKS` asked with social (default `ghost`: one listed but not set up is an alert error), and `CHANNELS`
  from it (the posting ones; none named = the default list); the Let's Encrypt email only for `cf`/`le`. `setkey`
  fills a commented-out `#KEY=` default in place; `rand` is Python's `secrets` (tr|head spun when SIGPIPE was
  ignored); no folder or `-…` prints the usage. site.env gets its own header
  (the example's is about `instances/`). (`TLS_RESOLVER` defaults to `cf` behind
  Cloudflare, `le` otherwise: Let's Encrypt's TLS challenge can't pass Cloudflare's proxy; with `cf` and no token it
  prints a step for `CLOUDFLARE_DNS_API_TOKEN`) (or taking them from the environment, e.g.
  `SITE_HOST=… kit/setup.sh <folder> --yes`); `secrets/<stack>.env` from `stacks/<stack>/.env.example` with its comments
  (less its first line, its "Site values" part, which site.env has, and `NTFY_URL`, which kit.sh passes from site.env) plus `examples/<stack>.env.example` as it is (the kit-only ones: icecast's TinyIce passwords, monitoring's
  file), with random passwords and secrets filled in; every data folder made up front (Docker
  makes them root's); Ghost's `config.production.json` (it replaces the image's own, so it repeats what that sets:
  listen on `::`, the content path; `STAFF_DEVICE_VERIFICATION=false` for tests); TinyIce's `config.json`, set up
  (`/stream-ogg` -> `/stream-mp3` transcoder, puppi3's burst sizes, bcrypt passwords; the plain ones in
  `secrets/icecast.env`), else TinyIce waits for its web setup page; the site's own `lan-only.yml` (private ranges
  less `172.16.0.0/12`, Docker's own: a connection Docker relays itself, e.g. any over IPv6 to an IPv4-only network,
  arrives from its network's gateway, so that range let the internet onto the home-network-only names);
  on Linux (sudo, once) each image's user gets its folders: TinyIce 1000, Prometheus's `data/` and password file
  nobody (not its folder: kit.sh writes `prometheus.yml` there as the user), Grafana 472, MySQL the stack's 1002:1003
  (Docker Desktop hides owners, so only Linux shows a miss: kit/test.sh there);
  `secrets/monitoring.env` (Grafana's admin and `grafana_ro` passwords, the alerts' ntfy topic = the bridge's) and
  Prometheus's `tinyice-password` file; on Docker Desktop (`docker info`) `DISK_MOUNT=/var/lib/docker`, as its
  machine's `/` is a kind node-exporter skips (Health's disk tile would be empty). Keeps files that are there. Prints what's left by hand, for the modules that are on (DNS names, Ghost owner and theme, Postiz account and keys,
  webhook, ntfy topic, streaming; with live off, how to add it later). Live off: no `LIVE_HOST` question (`live.<site>`
  kept), but TinyIce's passwords, config and Prometheus's password file are still made, so switching it on later is
  `MODULES` + `up -d`.
- `kit.sh <folder> <compose command…>`: runs `compose.yaml` as project `<ID_PREFIX>` with the profile, `SITE_DIR`,
  `DATA_DIR=<folder>/data` and `--profile` from `MODULES` (`down`: every profile, so a module switched off since goes
  too); exports site.env's `NTFY_URL` (the one place for it: the shell's value wins over `secrets/postiz.env`); on `up`,
  stops if a container with one of the stacks' fixed names (`traefik`, `tinyice`, `postiz*`) belongs to another
  project (one kit site per Docker host), and stops and removes (`rm -s -f -v`) the containers of a module switched
  off since (Compose's `up` leaves services outside the active profiles running); makes `proxy`/`monitoring` with the label `creatorkit.site` and notes one
  that was there already; on `up`, `lan_check` warns when the site's `lan-only.yml` lets in an IPv4 gateway of
  `proxy`/`monitoring` (Docker's relay hands connections over from there), or on Docker Desktop `192.168.65.1` (every
  connection's address there: the names can't be home-only, fine unless 80/443 are forwarded to it); copies the kit's Traefik files into `data/traefik/dynamic/`
  as `kit-*.yml` (`puppi3.yml` as `kit-site.yml`; never staging.yml, staging-bar.yml or the NAS's lan-only.yml);
  without `live` it exports `LIVE_STATS=false` (the bridge's live-show polling;
  the shell's value wins over site.env's), with it `LIVE_MOUNT` = the source mount from TinyIce's `config.json` (its mp3
  transcoder's input; on Linux the file is TinyIce's user's, 600, so an alpine container reads it when this user can't), so the mounts can be renamed in TinyIce. A first `up` with analytics starts tb-setup alone and waits for its tokens:
  recreating Ghost for them later could stop it mid-migration and leave Ghost's migration lock taken. With
  monitoring: writes `data/monitoring/prometheus/prometheus.yml` (jobs for the modules that are on; the bridge's job is
  `<ID_PREFIX>-pets`, as the dashboards expect) and runs `render.py --profile kit` into `data/monitoring/grafana/rendered/`
  (dashboards + alert rules); after the first `up` it asks Ghost for its `site_uuid` (the Tinybird queries pass it),
  keeps it in `data/monitoring/ghost.env`, renders again and restarts the site's own Grafana once (alert rules are read
  only at Grafana's start); after any other `up` whose render changed the alert rules (a module off, `NTFY_URL`), it
  restarts Grafana once too, and when Prometheus's jobs changed it sends Prometheus a HUP (it reloads its config).
- `monitoring/`: the monitoring module, kit-only (not in `stacks/`: a server may run its own Prometheus and Grafana already; profile
  `monitoring` set in the file itself). `compose.yaml`: Prometheus, Grafana 13.2.3 (Infinity plugin; the site's
  folder = `SITE_NAME`; routed at `GRAFANA_HOST`, Cloudflare-only then real-ip (its sign-in limits count by address), and
  `grafana.<LAN_DOMAIN>`, lan-only), cAdvisor,
  node-exporter (Health's disk: `/`, `DISK_MOUNT` for another), blackbox (the public checks), and two one-shot jobs
  (`grants.sh`) that make `grafana_ro` at every start: Ghost's MySQL with `stacks/ghost/grafana-ro.sh --sql`'s grants,
  Postiz's Postgres with SELECT on `Post`, `Integration`, `Tags`, `TagsPosts` (each waits for all its tables: Postiz
  makes them one by one). cAdvisor mounts Docker's socket itself (Docker Desktop has none in its `/var/run`) and
  `/run/containerd` and `/run/docker/containerd` (folders, not sockets: a missing one is made empty): from 0.54 it
  reads containers in Docker's containerd image store (Docker 29's and Docker Desktop's default) through containerd,
  and with 0.60 its Docker factory doesn't register at all without that socket, so no container has a name. The
  socket is the system's at `/run/containerd/` (Docker Desktop, Docker's packages) or dockerd's own at
  `/run/docker/containerd/` (an engine that runs its own, like `docker:dind`): a `sh -c` entrypoint passes the one
  that's there as `--containerd`, then runs the image's `entrypoint.sh`; `--disable_metrics` leaves only CPU and
  memory (all the dashboards and alerts read: `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`),
  since its disk metrics alone held ~0.7 GB (measured: 690 MB -> 20 MB; a panel needing another metric must take it
  out of that list); node-exporter's `/` mount
  has no `rslave` (Docker Desktop refuses it). Kubernetes' monitoring module uses `grants.sh`,
  `grafana/datasources.yml` and `grafana/dashboards.yml` as they are (`k8s/components/monitoring/`): keep its hosts
  (`mysql` there via `GHOST_DB_HOST`) and env names working for both.
  `grafana/datasources.yml`: the dashboards' datasource uids (`prometheus`, `ghost-mysql`, `ghost-analytics`,
  `bridge-instagram`, `postiz-pg`), logins as `${VAR}` from Grafana's environment (Tinybird's admin token from
  tokens.env), so no secret is in a file; the panels' hosts (`tinybird-local`, `postiz-ghost-bridge`) are the kit's
  service names too, so they aren't swapped. `grafana/dashboards.yml`: the provider.
- `compose.yaml`: `include:`s `stacks/{traefik,ghost,postiz,icecast}/compose.yaml`, each with its
  `secrets/<stack>.env` (include `env_file`; Ghost's is `GHOST_ENV_FILE`, which kit.sh sets) and merged with `profiles/<stack>.yaml`. Profiles never go into the stack
  files (each also runs on its own, without `--profile`, and would skip the services). The profile files also hold the
  kit's differences from a stack run on its own, with relative paths resolving in the stack's folder: Ghost as `<ID_PREFIX>-ghost`
  (`GHOST_UPSTREAM`, `GHOST_API_URL` follow) with the image's own user (`user: !reset null`), tokens.env from
  `GHOST_DATA_DIR` and the optional `secrets/ghost-mail.env` (`env_file: !override`; tb-setup gives it to the folder's owner, `TOKENS_OWNER_FROM_FOLDER`, since compose
  reads it as the user who runs kit.sh); the bridge reads the same file (`env_file`, so
  `tinybird__adminToken` gives the Platforms dashboard Ghost's numbers with no copying into `TINYBIRD_TOKEN`), the bridge's code and Traefik's plugins from the repo, Temporal's config from
  `postiz/dynamicconfig/`, Postgres in a `pgdata` subfolder (on a Mac it refuses a bind-mounted folder's root, "wrong
  ownership"). A new service in a module stack needs its profile line here, with `logging: *logs` (each file's
  `x-logging` anchor: json-file, 5 x 10 MB as the kubelet keeps; Docker keeps every line otherwise, and
  traffic-analytics logs every page hit; `monitoring/compose.yaml` has its own; not in the stacks, where it would
  recreate the NAS's Ghost). Host ports: only Traefik's web ports
  (`HTTP_PORT`, `HTTPS_PORT`) and TinyIce's (`LIVE_PORT`, on `LIVE_BIND` when set: that port is all of TinyIce,
  admin sign-in too, over plain http; the Setup guide's Live says to firewall it), each `!override`; Ghost's 8900, traffic-analytics' 8901 and
  Traefik's dashboard port are `!reset` (on a rented server they'd skip Traefik, Cloudflare-only and its firewall: the
  dashboard is at `traefik.<LAN_DOMAIN>`). The bridge is the published image with its code inside
  (`BRIDGE_IMAGE`, which kit.sh sets to `ghcr.io/puppi3-music/puppi3-creator-kit/ghost-bridge:<kit/VERSION>`,
  `KIT_BRIDGE_IMAGE` for another; `build: !reset null`, `pull_policy: missing`, `volumes: !override` with only its
  `data/`, `user: root` as the stack's base runs it, since its data folder is whoever made the site's). tb-setup the
  same (`TB_SETUP_IMAGE`, `KIT_TB_SETUP_IMAGE`; kit 1.2.1: a site's own build kept its old version over an update).
  `KIT_BUILD=1` adds `profiles/build.yaml` (a second `-f`, after the includes): both built from this repo, the bridge
  from `stacks/postiz/ghost-bridge/`'s Dockerfile (its `.dockerignore` keeps the build to the `.mjs` files, never
  `data/`), tb-setup from `stacks/ghost/tinybird/`, as `<ID_PREFIX>-ghost-bridge:local` and `<ID_PREFIX>-tb-setup:local`
  (named per site: a fixed name would replace another site's or the NAS stack's image), `pull_policy: build`;
  `local-site.sh` sets it for the test and the demo, k8s's test for its fake NAS. Traefik's `HTTPS_REDIRECT` (default true) turns on `kit-site.yml`'s
  http->https and www->site routers.
- `local-site.sh`: sourced by `test.sh` and `demo/demo.sh`, so both run the same on Linux, a Mac, or Windows inside
  WSL2 (bash there; stops on Git Bash, or on a repo under `/mnt/`, a Windows drive, where folders can't keep their
  owners). Checks the tools (`need`: brew or apt hint; Node.js 20+, Playwright's own minimum, which Ubuntu 24.04's
  package isn't; Playwright's Chromium itself, not only the npm package), the ports (bash's `/dev/tcp`, no lsof), and
  that no earlier site's folder is there; `sedi` is a sed -i for GNU and BSD both; `hostcat` reads a file a container
  wrote (on Linux Tinybird's `tokens.env` is root's, 600) through an alpine container; `LOCAL_RANGES` is where this
  computer's requests reach Traefik from (Docker Desktop's 192.168.65.x, a Linux Docker network's gateway, loopback),
  for `TRUSTED_EXTRA`. Its EXIT trap stops the stream (`FF`, ffmpeg's pid), takes
  the site down and removes its folder (through an alpine container for the parts the containers' users own on
  Linux), and the `proxy`/`monitoring` networks it made.
  Both tried on the Mac (Docker Desktop, arm64) and on Linux arm64 (Ubuntu 24.04 as a sudo user with uid 1001, so no
  image's fixed uid 1000 matches by chance; Docker 29's own engine, in a `docker:dind` beside the Mac's: its `/` is
  overlay, so Health's disk tile is empty there, unlike a real host's); not yet on Windows/WSL2 or Linux amd64.
- `test.sh [--keep]`: the Compose kit's test (`local-site.sh`): `kit/sites/kit-test` (kit.test, `ID_PREFIX=kittest`,
  `TLS_RESOLVER=self`: https on Traefik's own certificate), started, checked, removed. Cloudflare-only (403, then
  `LOCAL_RANGES` in `TRUSTED_EXTRA`), the kit's theme uploaded through the Admin API, ffmpeg streaming
  Ogg to TinyIce, a muted browser (`theme-test/kit-site.mjs`: looks like a visitor's Chrome, or Ghost's tracker skips
  it) for the LIVE NOW bar, plays, beacons and a page hit (country from page-hit-country: the browser says UTC), the
  bridge's health, performance and a signed webhook's DRY_RUN preview, Postiz's search fields in Temporal's Postgres (no
  Elasticsearch) and its running-job search, and no puppi3 in routers, containers,
  metrics or the rendered config; an old-layout copy of the site (`secrets/puppi3.env`, `data/puppi3/`) rendering with
  its own paths and password. Made as a
  try-out (`TRYOUT=yes`, all eight networks); checks only 80, 443 and the stream's port are on the host, http:// and
  www. redirect, no ntfy contact point, the switched-off render's `deleteRules`, and at the end `live` switched off on
  the running site (TinyIce's container, Prometheus's job and Grafana's rule all go). Needs ports 80, 443 and 8222 free
  (`LIVE_PORT=8223 kit/test.sh` beside the k3d cluster, which holds 8222), ffmpeg, and theme-test's `npm install` and
  `npx playwright install --with-deps chromium`. The site lives
  under `kit/sites/`, not a temp folder: Docker Desktop's share of `/private/tmp` breaks Postgres's ownership.
  Monitoring: every rendered dashboard in Grafana's site folder, no panel naming a datasource Grafana lacks, a real
  query through each datasource (`/api/ds/query`: grafana_ro on MySQL and Postgres, Tinybird with this Ghost's
  site_uuid, the bridge, Prometheus with every job up, cAdvisor's containers, a blackbox probe), the alert rules
  loaded, and a render with live, pets and five networks off leaving their panels, rows and rules out.
- `demo/demo.sh [--keep]`: the README's screenshots (`docs/images/*.webp`), from a throwaway demo site
  (`local-site.sh`, like test.sh; `kit/sites/demo`: demo.test, "Night Owl Radio", `ID_PREFIX=demo`, `NETWORKS=ghost`), removed after. Everything in
  it is made up: posts with pictures drawn by ffmpeg's `gradients` and a cover (`content.py`; Ghost's own sample post
  deleted, its picture is on Ghost's servers), 64 members (CSV import with `created_at`), music links, a live stream
  (ffmpeg), and a month of visits (`visits.py`: one real page hit's shape copied into ~6,000 rows over 30 days, sent to
  Tinybird's events API with `payload` as an object, `parsedReferrer` for the source; the answer counts only its first
  chunk, so it counts the table). Stand-ins, demo only: Traefik joins blackbox's network as demo.test and
  live.demo.test, and blackbox skips certificate checks (Traefik's own), so the uptime tiles read UP;
  The README only says the shots are from a made-up site: the scripts are for contributors (`CONTRIBUTING.md`). `shots.mjs` (muted Chromium): the home page with the LIVE
  NOW bar on a laptop and a phone, Grafana's Traffic and Overview (30 days) and Health's tiles (kiosk mode). No
  social preview shot: it needs Postiz with real networks connected. Needs the same ports as test.sh (`LIVE_PORT`
  too), ffmpeg with `gradients` (4.4+), cwebp.
- `VERSION` and `CHANGELOG.md`: the kit's version and what each one changes for a running site (the Operations
  guide's update section, and ZIP users, read them). A release bumps both, and is the tag `v<VERSION>` on the kit's
  repo (`CONTRIBUTING.md`, Releases): `.github/workflows/release.yml` builds the three images for amd64 and arm64 onto
  GHCR (`k8s/build-images.sh --platform ... --tag <VERSION>`) and a GitHub Release with the theme's zip and the
  changelog section as its notes (Actions pinned by commit), its wrapped lines joined (GitHub's notes break where the
  text does). From 1.2.2 each change is a `###` heading, prose, then `**Your site:**` and `**Restarts:**` paragraphs (not list items)
  (CONTRIBUTING.md, Releases). Only the maintainer tags.

## The kit's theme (`theme/`)

Ghost's Source (MIT) with the kit's hooks, so a kit site looks like its own. A site may use its own theme instead
(the Theme guide; `theme/KIT.md` lists the kit's parts to add to it).

- `theme/`: Source as released (the files `theme/KIT.md` lists left out; its README is `SOURCE-README.md`), plus
  `assets/kit/` (`kit.js`: `window.site`, `/.site/click` beacons for links out, the Social preview button on
  `/p/<uuid>/`, icons on links to other platforms (Patreon, Substack, Vimeo, SoundCloud...: `.kit-platform-link`) in the footer's secondary navigation; `live-bar.js`: the LIVE NOW player
  (no mascot); live = any source but the mp3 it plays and TinyIce's own `/_…`, so the source mount can be
  renamed (a `data-mount` attribute would name it) (a theme may add `window.site.livePup`); `kit.css`), `partials/kit/` (the bar, the icon
  sprite), and the edits to `default.hbs`, `partials/components/footer.hbs` (the credit line "Theme: Puppi3's Creator
  Kit by DJ Puppi3", `.kit-credit`, which the licence's 7(b) term asks copies to keep) and `package.json` (the
  `live_stream_url` setting) that `KIT.md` lists.
  Upgrading Source: copy the new tag over and re-apply those edits (`KIT.md`). Use Source's classes (`gh-outer`,
  `gh-inner`, `--ghost-accent-color`) so the kit's parts follow its layout and the site's accent colour.
- `theme-zip.sh`: builds `dist/puppi3-creator-kit-theme.zip` (git-ignored; needs zip and unzip, which a minimal
  Linux lacks), fails if another site's names are in it
  (the list is in the script: keep comments generic too), then runs gscan.
- `theme-test/`: `docker compose -f kit/theme-test/compose.yaml up -d`, then `npm install` (once) and
  `node test.mjs` there; `down -v` after. A throwaway Ghost on `localhost:2398` with `theme/` mounted live; the test
  sets the site up (it deletes all posts, so it refuses anything but localhost) and checks the hooks in a muted
  Chromium with the live status and stream faked.
- `redirects.yaml`: the kit's short links (`/b/ /t/ /i/ /k/ /d/ /y/`, matching the bridge's `SHORT_LINK_PREFIX`)
  and bio links (`/bsky /ig /th /tk /dis /yt`), 302s with utm tags.
