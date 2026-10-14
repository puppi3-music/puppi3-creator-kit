![The Creator Kit's puppy](kit/docs/images/kit-puppy.svg)

# Puppi3's Creator Kit 🐾

[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)

A self-hosted home for your work as a creator: a Ghost website and newsletter, web analytics with no third party, a
live stream with a LIVE NOW bar, each post shared to your social networks, every network's numbers in one set of
Grafana dashboards, and alerts on your phone. It all runs on one machine with Docker Compose, or on Kubernetes (your
own cluster, Amazon EKS or Google GKE).

**Guides:** [Setup](kit/docs/setup-guide.html) · [Operations](kit/docs/operations-guide.html) ·
[Theme](kit/docs/theme-guide.html) · [Posting](kit/docs/posting-guide.html) · [Analytics](kit/docs/analytics-guide.html) ·
[Settings reference](kit/docs/settings-reference.html)

The guides are web pages in `kit/docs/`: read them online at https://puppi3-music.github.io/puppi3-creator-kit/kit/docs/,
or open `kit/docs/index.html` from your copy. (On GitHub's file view a guide shows as its source.) The `CLAUDE.md`
files and `docs/bridge-map.md` are notes for whoever works on the kit itself ([CONTRIBUTING](CONTRIBUTING.md)).

## What it looks like

![A kit site's home page with the LIVE NOW bar playing the stream](kit/docs/images/site.webp)

| On a phone | The Traffic dashboard |
|---|---|
| ![The same page on a phone](kit/docs/images/phone.webp) | ![Grafana's Traffic dashboard: a month of visitors and page views, with each post marked](kit/docs/images/traffic.webp) |

![Grafana's Overview: site status, visitors, members and newsletters in one place](kit/docs/images/overview.webp)

![Grafana's Health: the site, Ghost, the stream server, the bridge, errors and disk at a glance](kit/docs/images/health.webp)

*Screenshots from a made-up demo site.* Not pictured: when you publish a post, the bridge shares it to your networks,
and Ghost's Preview of a draft gets a Social preview button that shows what each network would get.

## What you get

The site is always there. Each other part is a module you switch on in your site's `MODULES`.

| Module | What it does | What it needs from you |
|---|---|---|
| (always on) | Ghost 6 with MySQL, behind Traefik (https, and optionally only reachable through Cloudflare); the kit's theme (Ghost's Source with the kit's extras) | A domain and its DNS; an email address for Let's Encrypt |
| `analytics` | Ghost's own web analytics (Tinybird, run locally), with each visitor's country | Nothing |
| `live` | A live audio stream (TinyIce) for a radio show, a live podcast or a DJ set: your streaming software sends to it, and the site shows a LIVE NOW bar that plays it | Software that streams Ogg to Icecast (butt, Mixxx, Traktor, ffmpeg...) |
| `social` | Postiz, plus a bridge that shares each Ghost post to your networks, draws social previews of drafts, counts clicks and collects every network's numbers | A developer app for each network you post to (their keys go in `secrets/postiz.env`); optional keys for SoundCloud, Cloudflare and Search Console numbers |
| `monitoring` | Grafana with the dashboards (traffic, growth, members, content, social, each platform, each post) and alerts to your phone; Prometheus, which collects the numbers they show | Nothing (a DNS name for Grafana if you want it outside home) |

Phone notifications go through ntfy: [ntfy.sh](https://ntfy.sh) on a private topic that setup makes up, or your own
ntfy server. Install the ntfy app and subscribe to that topic.

## What you need

- **A machine** running Linux, macOS or Windows (inside WSL2), on Intel/AMD or ARM. A home server, a NAS or a rented
  server all work. Only one site per machine is allowed: its Traefik takes the web ports, and some of its
  containers have fixed names like `traefik` and `postiz`.
- **Docker** with Compose 2.24 or newer, and **Python 3**.
- **Ports 80 and 443** that the internet reaches, and 8222 for streaming. Each can be another: see `HTTP_PORT` and
  `LIVE_PORT` in the [Settings reference](kit/docs/settings-reference.html).
- **Nothing to build:** the kit's own images and its theme come ready-made with each release.
- **A domain** whose DNS you can change.

On Linux, setup asks for `sudo` once, to give each service's folders to the user it runs as.

### How big a machine

Measured on the kit's own test site, with every module on, at rest and while it streams, takes page hits and makes
social previews:

| Part | Memory | Disk for its images |
|---|---|---|
| The site (Ghost, MySQL, Traefik) | 0.7 GB | 2.5 GB |
| `analytics` (Tinybird holds about 2.2 GB all the time) | 2.5 GB, 3 GB when busy | 10 GB |
| `social` (Postiz and its Temporal) | 2.5 GB, 3 GB when busy | 11 GB |
| `live` | under 0.1 GB | 0.1 GB |
| `monitoring` | 1.9 GB | 2.5 GB |
| **Everything** | **7.5 GB, 8 GB when busy** | **about 26 GB** |

So the site alone runs on a 2 GB machine, and everything wants 10 GB of memory or more (12 to 16 GB is comfortable)
and 50 GB of free disk. On a Mac or Windows, Docker Desktop's own settings must give it that much memory (Settings,
Resources). Disk grows with what you upload, Prometheus's history (up to 10 GB, then it drops the oldest) and your
visitors' page hits (small). The [Setup guide](kit/docs/setup-guide.html#before-how-big) has the detail.

## Getting the kit

```sh
git clone https://github.com/puppi3-music/puppi3-creator-kit.git
cd puppi3-creator-kit
```

Or **Code → Download ZIP** on GitHub, and unzip it. With git, an update is one `git pull`; with a ZIP, you download
the new one and move your site's folder across (the [Operations guide](kit/docs/operations-guide.html#upgrade) says how).
Your version is in `kit/VERSION`, and what each one changes in `kit/CHANGELOG.md`.

## Setting up a site

The [Setup guide](kit/docs/setup-guide.html) has it all: Compose and Kubernetes, Cloudflare or not, the clouds, and every
step to finish by hand. In short, on one machine:

**Trying it before your domain points here?** Answer *yes* to setup's first question. The site uses Traefik's own
certificate and sends no phone alerts (its public checks would fail until the DNS is there), and setup says how to
reach it from your browser. The Setup guide's [Trying it at home first](kit/docs/setup-guide.html#tryout) has the rest.

1. **Make the site's folder:** `kit/setup.sh kit/sites/mysite`. It asks for the address, the name, the modules and a
   few more things. Then it writes the folder:
   - `site.env`: your answers, with every other setting explained in it.
   - `secrets/`: random passwords, and the place for your API keys.
   - `data/`: everything the site keeps.

   `kit/sites/` stays out of git. Keep a backup of the folder: it's the whole site, but for the analytics' Docker
   volumes (the [Operations guide](kit/docs/operations-guide.html#backup) says how to back up both).
2. **Start it:** `kit/kit.sh kit/sites/mysite up -d`. The first start downloads the images and takes a few minutes.
   `kit.sh` takes any `docker compose` command: `ps`, `logs -f`, `down`.
3. **Finish by hand:** setup prints the steps for your modules. In short:
   - DNS for the site, `live.`, `postiz.` and `grafana.`.
   - Ghost's owner account.
   - The theme: `puppi3-creator-kit-theme.zip` from [the kit's release](https://github.com/puppi3-music/puppi3-creator-kit/releases) for your version
     (`kit/VERSION`), which you upload in Ghost Admin.
   - The redirects file.
   - Your Postiz account and networks.
   - The Ghost webhook to the bridge.
   - The ntfy topic.
   - Your streaming software's stream settings.

   That's it: your site's up! 🐶

To change a setting, edit `site.env` or a file in `secrets/` and run `kit/kit.sh <folder> up -d` again. How posts are
shared (which networks, what posts by itself, the tags you use in Ghost) is in `site.env` too.
Every setting, what it does and its default: [the Settings reference](kit/docs/settings-reference.html).

| Guide | For |
|---|---|
| [Setup](kit/docs/setup-guide.html) | Setting up a site: Compose or Kubernetes, Cloudflare or not, every step to finish by hand |
| [Operations](kit/docs/operations-guide.html) | Updating the kit, backups, moving the site between machines or to a cloud, troubleshooting |
| [Theme](kit/docs/theme-guide.html) | The theme's settings, the LIVE NOW bar, links to your other platforms, short links, another theme |
| [Posting](kit/docs/posting-guide.html) | Whoever posts: tags, what each network gets, finishing Instagram and TikTok posts |
| [Analytics](kit/docs/analytics-guide.html) | Reading the dashboards: which one answers what |
| [Settings reference](kit/docs/settings-reference.html) | Every setting, what it does and its default |

To switch a module on or off later, change `MODULES` in `site.env` and run `up -d` again. With `live` off there's no
stream server and no LIVE NOW bar (the theme shows it only once its Live stream URL is set). Its passwords are made
anyway, so switching it on later needs only the DNS name for the stream and the theme's Live stream URL.

## On Kubernetes

The same folder runs on a cluster: your own (`selfhosted`), Amazon EKS (`eks`) or Google GKE (`gke`). You need
`kubectl` pointed at the cluster; the kit's own images come from GitHub's registry, for Intel/AMD and ARM nodes alike:

```sh
kit/setup.sh kit/sites/mysite                                    # the same folder as for Compose
k8s/up.sh kit/sites/mysite selfhosted                            # asks before using the cluster kubectl points at
```

Then point the site's DNS at Traefik's address and finish by hand as above. The [Setup guide](kit/docs/setup-guide.html#k8s)
has the overlays, the clouds' databases and buckets, and testing before the DNS; the [Operations
guide](kit/docs/operations-guide.html#move) moves a running site between Compose and a cluster.

## Grafana

With `monitoring` on, Grafana is at `https://grafana.<your site>` (behind Cloudflare, if the site is) and at
`http://grafana.<LAN_DOMAIN>` at home. Sign in as `admin` with `GRAFANA_ADMIN_PASSWORD` from
`secrets/monitoring.env`.

The dashboards and alert rules come with the kit, made for your site each time `kit.sh` runs. Your names, your
addresses and your time zone go in, and anything for a module or network you switched off is left out. So don't
edit them in Grafana: changes there don't stay.

The alerts cover:
- the site or the live stream going down
- errors
- a nearly full disk
- visitors no longer being counted
- spam complaints
- failed newsletters
- stuck social posts
- a network's numbers going stale

They go to your ntfy topic. A network you list in `NETWORKS` but haven't set up yet shows as an alert error until
you do: set it up, or take it out of `NETWORKS`.

## Changing the kit

Fixes, new networks and reports from your own site are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says where things
are and which check fits a change. The checks build throwaway sites on your own computer (Linux, a Mac, or Windows
with WSL2), never on your real one. To try the kit for your own site, use setup's try-out ([Setting up a site](#setting-up-a-site)).

## Licence and credit

Copyright (c) 2026 puppi3-music (DJ Puppi3). The kit is free software under the GNU Affero General Public License,
version 3 ([LICENSE](LICENSE)): use it, change it and share it. If you run a changed copy as a website, offer its
visitors your changed source code. One added term (section 7(b)): copies and changed versions keep the author credit,
the theme footer's line "Theme: Puppi3's Creator Kit by DJ Puppi3" and the copyright line here and in LICENSE.

The theme is Ghost's [Source](https://github.com/TryGhost/Source) (MIT, Copyright (c) Ghost Foundation:
[its licence](kit/theme/LICENSE)) with the kit's additions, which are AGPL like the rest.

Contributions are welcome, under the same licence: [CONTRIBUTING.md](CONTRIBUTING.md).
