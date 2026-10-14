# Changelog

What each version of Puppi3's Creator Kit changes for a site already running. Your version is in `kit/VERSION`.
How to update: the Operations guide (`kit/docs/operations-guide.html#upgrade`).

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
