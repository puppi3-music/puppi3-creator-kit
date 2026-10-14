# Changelog

What each version of Puppi3's Creator Kit changes for a site already running. Your version is in `kit/VERSION`.
How to update: the Operations guide (`kit/docs/operations-guide.html#upgrade`).

## 1.2.1

- On Kubernetes, Traefik runs Traefik's own image (`traefik:v3.7.13`, as on Compose), with the kit's two plugins
  (real visitor addresses, the visitor's country) from a ConfigMap instead of an image of the kit's. The kit
  publishes three images now (tb-setup, the stream relay, the bridge), and a changed plugin needs only `k8s/up.sh`,
  no image build. Your site: `k8s/up.sh <folder> <overlay>` (Traefik restarts once; a few seconds without the
  site). On Compose: nothing.
- On Compose, the analytics' setup job (tb-setup) is the release's published image too, like the bridge, instead of
  one each site built: nothing at all is built on a site now, and an update brings its new version (a site's own build
  kept the old one). Your site: `kit/kit.sh <folder> up -d`. The image your site built before can go:
  `docker image rm <short name>-tb-setup`.
- The guides: tidied for this version (the Operations guide's Kubernetes troubleshooting, Ghost's versions when moving
  a site, where Ghost's theme upload is), and the README reordered, with an Updating section.

## 1.2.0

- Every image is at an exact version, the same on Compose and Kubernetes: Ghost 6.69.0, MySQL 8.0.46, PostgreSQL
  17.11 (Postiz) and 16.15 (Temporal), Redis 7.2.16, Node 22.23.3 (the bridge), busybox 1.37.0, and gscan 6.6.1 for
  the theme check. Before, `ghost:6-alpine` and the like took whatever was newest at your next pull, so a new Ghost
  could migrate your database without anyone having tried it. From now on a new version comes with a kit update and
  its line here. Your site: `kit/kit.sh <folder> up -d` (if your Ghost is already newer than 6.69.0, wait for the
  next kit version instead: Ghost can't move a database back to an older version).
- Tinybird (the `analytics` module) uses about 2 GB less memory: it ran a CSV import worker for every two CPUs
  (about 0.5 GB each, and Ghost never imports CSV); now it runs one. On Kubernetes its pod asks for 2.5 GiB instead
  of 4. The README and the Setup guide say how big a machine each module needs. Your site: `kit/kit.sh <folder> up
  -d` (Tinybird restarts; Ghost's numbers wait for it a minute).
- The Ghost stack is called `ghost` now (it was `puppi3`, the name of the site the kit came from): its files are in
  `stacks/ghost/`, and a new site keeps Ghost's data in `data/ghost/` and its database login in `secrets/ghost.env`.
  Your site: nothing. A site made before keeps its `data/puppi3/` and `secrets/puppi3.env`, and the kit goes on using
  them as they are. If you run the stacks on their own (without `kit.sh`), set `GHOST_DATA_DIR` to the Ghost stack's
  folder (the one holding `ghost/`, `db/` and `tinybird/`): its compose file stops without it, rather than starting
  Ghost and MySQL on an empty folder. On Kubernetes the database login is Secret `ghost` (it was `puppi3`):
  `k8s/up.sh` makes it from either file, and the old Secret can be deleted after the next `up.sh`.
- Nothing to build any more. The bridge, and on Kubernetes the kit's four images, come ready-made for this version
  from GitHub's registry (`ghcr.io/puppi3-music/puppi3-creator-kit/`), for Intel/AMD and ARM; the theme's zip is on
  the version's [release](https://github.com/puppi3-music/puppi3-creator-kit/releases), so Node.js isn't needed.
  Your site: `kit/kit.sh <folder> up -d` swaps the bridge you built for the published one (its data stays). On
  Kubernetes, delete `k8s/images/built.env` to use the published images, or keep building your own as before. A
  bridge you've changed yourself: `KIT_BUILD=1 kit/kit.sh <folder> up -d` builds it from your copy (CONTRIBUTING.md).
- For contributors: `k8s/test/image-pins.py` (and the commit hook) refuse a floating tag, and an image at two
  versions in different files.

## 1.1.1

Fixes for Linux, Docker 29 and Docker Desktop.

- On Linux, a site set up by a user other than root now starts. Setup gives the database (MySQL), Postiz's search
  engine and Prometheus's data the owners they run as, and leaves Prometheus's folder to you so `kit.sh` can write
  its settings there. Tinybird's tokens file is now yours too, so the analytics start. Your site, if it's on Linux
  and stopped on its first start: `sudo chown -R $(id -u):$(id -g) data/monitoring/prometheus`, then
  `kit/setup.sh <folder>` again (it keeps your files and settings), then `kit/kit.sh <folder> up -d --build`.
- Health's container panels (CPU and memory per container) work again with Docker 29 and Docker Desktop, whose
  newer image store the old cAdvisor couldn't read. Your site: `kit/kit.sh <folder> up -d`.
- Health's disk tile works on a Mac or Windows: setup now sets `DISK_MOUNT=/var/lib/docker` there. Your site, on
  Docker Desktop: add that line to `site.env`, then `kit/kit.sh <folder> up -d`.
- No more copying Tinybird's token: the bridge reads it itself, so Ghost's own numbers reach the Platforms dashboard.
  Your site: `kit/kit.sh <folder> up -d`. A `TINYBIRD_TOKEN` you copied into `secrets/postiz.env` can stay, or be
  emptied.
- On Linux, a renamed stream mount (in TinyIce's admin) now reaches the bridge when TinyIce's settings file isn't
  yours. Your site: nothing.
- `kit/theme-zip.sh` says when `zip` or `unzip` is missing.
- For contributors: `kit/test.sh` and `kit/demo/demo.sh` run on Linux, a Mac or Windows inside WSL2
  (CONTRIBUTING.md).

## 1.1.0

The kit speaks to any creator, not only DJs.

- The featured link (was the "Listen" line): a post's link to where the work is gets its own line in the social
  posts, now "🔗 YouTube: <link>" on Bluesky and Threads and "🔗 Also on YouTube + the full post: link in bio" on
  Instagram and TikTok, with Vimeo, Spotify, Apple Podcasts, Apple Music, Bandcamp and Twitch found too. New settings
  in `site.env`: `FEATURED_DOMAINS` (it replaces `LISTEN_DOMAINS`: if you set that, rename it), `FEATURED_LINE`,
  `FEATURED_BIO_LINE`, `FEATURED_LABEL` (the Settings reference has them). To keep the old wording, set
  `FEATURED_LINE=🎧 Listen: [url]`, `FEATURED_BIO_LINE=🎧 Full set on [name] + the full post: link in bio 🔗` and
  `FEATURED_LABEL=Listen link`. Your site: `kit/kit.sh <folder> up -d` for the bridge.
- The theme's footer icons cover more platforms: Vimeo, Apple Podcasts, Patreon, Ko-fi, Substack, Etsy, Behance and
  Discord, beside the music ones. Their class is now `kit-platform-link` (was `kit-music-link`: a theme of your own
  that copied the kit's parts needs the new `kit.js`, `kit.css` and `icons.hbs`). Clicks to them are counted by name
  instead of as "Other". Your site: build and upload the theme again (`kit/theme-zip.sh`).
- Grafana: Content's "Clicks to music" is "Clicks to watch or listen" (Vimeo, Twitch and Apple Podcasts counted
  too), and the live stream's input is "the streaming software". Your site: `kit/kit.sh <folder> up -d` renders them.
- YouTube's "vs industry" verdict compares with every kind of channel, not music channels: 2-6% likes and comments
  per view for videos, 2.5-4% for Shorts (CreatorDB and SociaVault, 2026). Your site: `kit/kit.sh <folder> up -d`.
- The guides: the Posting guide's samples are a potter, a podcaster, a writer and a painter; "streaming software"
  instead of "DJ software" everywhere.

## 1.0.1

- The theme's footer and the bridge's preview pages link the kit's source ("Source"), which the licence asks a site to
  offer its visitors. Your site: build and upload the theme again (`kit/theme-zip.sh`), then `kit/kit.sh <folder> up -d`
  for the bridge.

## 1.0.0

The first release: Ghost 6 behind Traefik, with the analytics, social, live and monitoring modules, on Docker
Compose or Kubernetes (your own cluster, Amazon EKS, Google GKE), and the kit's theme.
