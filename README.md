![The Creator Kit's puppy](kit/docs/images/kit-puppy.svg)

# Puppi3's Creator Kit 🐾

By puppi3-music (DJ Puppi3). Free software under the [GNU AGPL-3.0](LICENSE): use it, change it and share it; if you
run a changed copy as a website, offer its visitors your changed source code. Keep the credit line in the theme's
footer ([LICENSE](LICENSE) says exactly what's asked).

Everything for a Ghost site of your own: web analytics with no third party, a live stream with a LIVE NOW bar,
each post shared to the social networks, every network's numbers in one set of Grafana dashboards, and phone
notifications. All of it runs on one machine with Docker Compose, behind Traefik, or on Kubernetes (your own cluster,
Amazon EKS or Google GKE).

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

A made-up demo site (`kit/demo/demo.sh` makes it and takes these). When you publish a post, the bridge also shares it
to your networks, and Ghost's Preview of a draft gets a Social preview button that shows what each network would get.

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

You need:
- Docker with Compose 2.24 or newer, and Python 3
- ports 80 and 443 that the internet reaches (and 8222 for streaming; each can be another, see `HTTP_PORT` and
  `LIVE_PORT` in the [Settings reference](kit/docs/settings-reference.html))
- Node.js, only for the theme's check before you upload it
- the machine to itself: one kit site per Docker host (its Traefik takes the web ports, and some of its containers
  have fixed names like `traefik` and `postiz`)

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
   - The theme: `kit/theme-zip.sh` builds it, and you upload it in Ghost Admin.
   - The redirects file.
   - Your Postiz account and networks.
   - The Ghost webhook to the bridge.
   - The ntfy topic.
   - Your streaming software's stream settings.

   For the Ghost numbers on the Platforms dashboard, copy `tinybird__adminToken` from
   `data/puppi3/tinybird/tokens.env` to `TINYBIRD_TOKEN` in `secrets/postiz.env`. Then run `up -d` again.

   That's it: your site's up! 🐶

To change a setting, edit `site.env` or a file in `secrets/` and run `kit/kit.sh <folder> up -d` again. How posts are
shared (which networks, what posts by itself, the tags you use in Ghost) is in `site.env` too.
Every setting, what it does and its default: [the Settings reference](kit/docs/settings-reference.html).

Updating the kit, backups, moving the site between machines, Compose, Kubernetes and the clouds, and
troubleshooting: [the Operations guide](kit/docs/operations-guide.html). For whoever posts: [the Posting
guide](kit/docs/posting-guide.html); reading the dashboards: [the Analytics guide](kit/docs/analytics-guide.html); the theme's
settings, the LIVE NOW bar, links to your other platforms, short links and using another theme: [the Theme guide](kit/docs/theme-guide.html).

To switch a module on or off later, change `MODULES` in `site.env` and run `up -d` again. With `live` off there's no
stream server and no LIVE NOW bar (the theme shows it only once its Live stream URL is set). Its passwords are made
anyway, so switching it on later needs only the DNS name for the stream and the theme's Live stream URL.

## On Kubernetes

The same folder runs on a cluster: your own (`selfhosted`), Amazon EKS (`eks`) or Google GKE (`gke`). You need
`kubectl` pointed at the cluster and a registry for the kit's four own images:

```sh
kit/setup.sh kit/sites/mysite                                    # the same folder as for Compose
PLATFORM=linux/amd64 k8s/build-images.sh --registry <registry>/creator-kit
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

## Trying it

`kit/test.sh` (Mac with Docker Desktop; ports 80, 443 and 8222 free, ffmpeg, and `npm install` in
`kit/theme-test/`) builds a throwaway site, `kit.test`, and checks it end to end:
- the site, the theme, a stream on the LIVE NOW bar, a page hit with its country
- the bridge
- Grafana's dashboards and datasources, and Prometheus

Then it removes the site.

## Licence and credit

Copyright (c) 2026 puppi3-music (DJ Puppi3). The kit is under the GNU Affero General Public License, version 3
([LICENSE](LICENSE)), with one added term (section 7(b)): copies and changed versions keep the author credit, the
theme footer's line "Theme: Puppi3's Creator Kit by DJ Puppi3" and the copyright line here and in LICENSE.

The theme is Ghost's [Source](https://github.com/TryGhost/Source) (MIT, Copyright (c) Ghost Foundation:
[its licence](kit/theme/LICENSE)) with the kit's additions, which are AGPL like the rest.

Contributions are welcome, under the same licence: [CONTRIBUTING.md](CONTRIBUTING.md).
