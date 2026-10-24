# kit/

Puppi3's Creator Kit: the Compose kit, its theme, its guides and its checks. `CLAUDE.md` at the top maps the rest
(`k8s/`, `stacks/`, `instances/`).

`README.md` (at the top) is the kit's front page (for someone setting up a site, no repo knowledge): what it does,
Compose and Kubernetes in short, the licence notice and credit. `LICENSE`: AGPL-3.0 (gnu.org's text, unchanged) under a
header with the copyright, what it covers, and the section 7(b) term (keep the theme footer's credit line and the
copyright line). `CONTRIBUTING.md`: where things are, what goes with a change, which test fits.

`scrub.py`: no secrets and no private names in the kit. It runs gitleaks (Docker, pinned) over the repo's whole history
and every file, then looks in every file for `PRIVATE_WORDS` (settings_reference's), apart from what `ALLOW` keeps on
purpose (the copyright and author credit, the word lists the kit once carried, the guides' swaps); then the repo's
whole history the same way (every version of every file, the messages, author and committer both the theme's author).
`--names` skips Docker, `-v` prints each line. It only reports; a mention meant to stay goes in `ALLOW` with its
reason.

The private words (a site's names, NAS, home network, owner) are in `private-words.txt` at the top of the site repo
that sends the kit, never in the kit: one ERE pattern per line, `#` comments, matched ignoring case. Its readers:
`settings_reference.PRIVATE_WORDS` (and through it scrub.py and the guides' build), `theme-zip.sh` (`grep -f`, beside
its own `window.puppi3` and `/.puppy/`) and the Grafana `render.py`'s `SOURCE_PRIVATE`. Without the file (the kit's
own repo) there are no words, and those checks find nothing: a word list in the kit would itself name what it hides.

`check.sh [--here <repo>]`: the checks that need no Docker, in seconds: `check_refs.py` (every repo path a file names
is in the repo, every Traefik plugin a file loads is there: one missing turns them all off; `ALLOW` for a mention
that's fine), the guides' build, the dashboards' checks and a render for the example profile, the dashboard scripts'
tests (`stacks/monitoring/grafana/tests/`), the bridge's modules and its tests (`stacks/postiz/ghost-bridge-test/`),
the Traefik plugins' tests with gofmt and go vet (when Go is there), every shell script's syntax.
`.github/workflows/check.yml` runs it in the kit's repo on every push and pull request (the Node of the bridge's
Dockerfile, the Go of the plugins' go.mod, the runner's Python 3; only there, like release.yml). A site repo that sends the kit runs it on the kit's copy with `--here` itself, so a path
only that site has counts as missing. A site's own notes for a folder may be in a `CLAUDE.site.md` beside its
CLAUDE.md (never in the kit's repo).

**For any creator.** The kit is for artists, podcasters, writers, makers and musicians alike: keep its words neutral
("streaming software", "the featured link", "your other platforms", made-up creators in examples). A site's own
wording goes in its `site.env` (the bridge's `FEATURED_*` lines).

These folders have a CLAUDE.md of their own: open it before working there. This file has the files at `kit/`'s top,
`examples/`, and what the whole kit shares.

| Folder | What it is |
|---|---|
| `kit/docs/` | The kit's guides (Setup, Operations, Theme, Posting, Analytics, the Settings reference): what each covers and what it keeps current with |
| `kit/profiles/` | What `compose.yaml` changes in each stack: names, users, host ports, the published images, `KIT_BUILD` |
| `kit/monitoring/` | The monitoring module: Prometheus, Grafana, cAdvisor, node-exporter, blackbox, `grants.sh` |
| `kit/theme/` | The kit's theme (Ghost's Source + the kit's hooks), and `theme-zip.sh`, which builds its zip |
| `kit/theme-test/` | The theme's test on a throwaway Ghost; `kit-site.mjs`, test.sh's browser; the Playwright they share |
| `kit/demo/` | The README's screenshots, from a made-up site |

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
  connection's address there: the names can't be home-only, fine unless 80/443 are forwarded to it); then, after an `up` on Docker Desktop with that address let in, `lan_probe` asks for `traefik.<LAN_DOMAIN>` on `HTTP_PORT` from this computer and on a 403 says how to make `proxy`/`monitoring` again (`down`, `docker network rm`, `up`): seen 2026-10-17, two-day-old networks handed connections over from their gateway (a Docker Desktop restart alone doesn't do it; cause unknown), so every home-network-only page answered 403 (kit/test.sh's Grafana checks with them); copies the kit's Traefik files into `data/traefik/dynamic/`
  as `kit-*.yml` (`puppi3.yml` as `kit-site.yml`; never staging.yml, staging-bar.yml or the NAS's lan-only.yml);
  without `live` it exports `LIVE_STATS=false` (the bridge's live-show polling;
  the shell's value wins over site.env's), with it `LIVE_MOUNT` = the source mount from TinyIce's `config.json` (its mp3
  transcoder's input; on Linux the file is TinyIce's user's, 600, so an alpine container reads it when this user can't), so the mounts can be renamed in TinyIce. A first `up` with analytics starts tb-setup alone and waits for its tokens:
  recreating Ghost for them later could stop it mid-migration and leave Ghost's migration lock taken. With
  monitoring: writes `data/monitoring/prometheus/prometheus.yml` (jobs for the modules that are on; the bridge's job is
  `<ID_PREFIX>-pets`, as the dashboards expect) and runs `render.py --profile kit` into `data/monitoring/grafana/rendered/`
  (dashboards + alert rules; the module itself: `kit/monitoring/CLAUDE.md`); after the first `up` it asks Ghost for its `site_uuid` (the Tinybird queries pass it),
  keeps it in `data/monitoring/ghost.env`, renders again and restarts the site's own Grafana once (alert rules are read
  only at Grafana's start); after any other `up` whose render changed the alert rules (a module off, `NTFY_URL`), it
  restarts Grafana once too, and when Prometheus's jobs changed it sends Prometheus a HUP (it reloads its config).
- `compose.yaml`: `include:`s `stacks/{traefik,ghost,postiz,icecast}/compose.yaml`, each with its
  `secrets/<stack>.env` and merged with `profiles/<stack>.yaml`, the kit's differences from a stack run on its own
  (`kit/profiles/CLAUDE.md`). `monitoring/compose.yaml` is the kit's own module (`kit/monitoring/CLAUDE.md`).
- `local-site.sh`: sourced by `test.sh` and `demo/demo.sh`, so both run the same on Linux, a Mac, or Windows inside
  WSL2 (bash there; stops on Git Bash, or on a repo under `/mnt/`, a Windows drive, where folders can't keep their
  owners). Checks the tools (`need`: brew or apt hint; Node.js 20+, Playwright's own minimum, which Ubuntu 24.04's
  package isn't; Playwright's Chromium itself, not only the npm package), the ports (bash's `/dev/tcp`, no lsof), and
  that no earlier site's folder is there; `sedi` is a sed -i for GNU and BSD both; `hostcat` reads a file a container
  wrote (on Linux Tinybird's `tokens.env` is root's, 600) through an alpine container; `LOCAL_RANGES` is where this
  computer's requests reach Traefik from (Docker Desktop's 192.168.65.x, a Linux Docker network's gateway, loopback),
  for `TRUSTED_EXTRA`. `demo/demo.sh` is the README's screenshots (`kit/demo/CLAUDE.md`). Its EXIT trap stops the stream (`FF`, ffmpeg's pid), takes
  the site down and removes its folder (through an alpine container for the parts the containers' users own on
  Linux), and the `proxy`/`monitoring` networks it made.
  Both tried on the Mac (Docker Desktop, arm64) and on Linux arm64 (Ubuntu 24.04 as a sudo user with uid 1001, so no
  image's fixed uid 1000 matches by chance; Docker 29's own engine, in a `docker:dind` beside the Mac's: its `/` is
  overlay, so Health's disk tile is empty there, unlike a real host's); not yet on Windows/WSL2 or Linux amd64.
- `test.sh [--keep]`: the Compose kit's test (`local-site.sh`): `kit/sites/kit-test` (kit.test, `ID_PREFIX=kittest`,
  `TLS_RESOLVER=self`: https on Traefik's own certificate), started, checked, removed. Cloudflare-only (403, then
  `LOCAL_RANGES` in `TRUSTED_EXTRA`), the kit's theme uploaded through the Admin API, ffmpeg streaming
  Ogg to TinyIce, a muted browser (`theme-test/kit-site.mjs`, `kit/theme-test/CLAUDE.md`: looks like a visitor's Chrome, or Ghost's tracker skips
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
- `VERSION` and `CHANGELOG.md`: the kit's version and what each one changes for a running site (the Operations
  guide's update section, and ZIP users, read them). A release bumps both, and is the tag `v<VERSION>` on the kit's
  repo (`CONTRIBUTING.md`, Releases): `.github/workflows/release.yml` builds the three images for amd64 and arm64 onto
  GHCR (`k8s/build-images.sh --platform ... --tag <VERSION>`) and a GitHub Release with the theme's zip and the
  changelog section as its notes (Actions pinned by commit), its wrapped lines joined (GitHub's notes break where the
  text does). From 1.2.2 each change is a `###` heading, prose, then `**Your site:**` and `**Restarts:**` paragraphs (not list items)
  (CONTRIBUTING.md, Releases). Only the maintainer tags.
- `redirects.yaml`: the kit's short links (`/b/ /t/ /i/ /k/ /d/ /y/`, matching the bridge's `SHORT_LINK_PREFIX`)
  and bio links (`/bsky /ig /th /tk /dis /yt`), 302s with utm tags.
- `theme-zip.sh`: builds the kit's theme's zip (`kit/theme/CLAUDE.md`).
