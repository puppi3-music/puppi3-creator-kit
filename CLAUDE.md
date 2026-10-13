# Puppi3's Creator Kit

A Ghost site with web analytics, a live stream, social sharing and Grafana dashboards, run with Docker Compose on one
machine or on Kubernetes (your own cluster, EKS, GKE). `README.md` is the front page; the guides are in `kit/docs/`
(Setup, Operations, Theme, Posting, Analytics, and the Settings reference made from the example files).

This file is the index. The detail lives in a CLAUDE.md in each folder (table below), next to the code it describes.
Only this one loads by itself: open the folder's CLAUDE.md before working there. When you change something, update
the CLAUDE.md nearest to it in the same change, and the guide that describes it (`kit/docs/`, for someone running a
site, no code).

## Rules
- Tests run locally only (`CONTRIBUTING.md`, The checks): `kit/test.sh` on Docker Desktop, `k8s/test/test.sh` on a
  local k3d cluster. Never against a real site, cluster or cloud account; what only a real cloud can show is for
  whoever runs one.
- Nothing site-specific in the kit: no real addresses, accounts, home-network names or private paths, comments
  included (say `SITE_HOST`, `LAN_DOMAIN`, `example.com`, "the server"). `python3 kit/scrub.py` checks every file
  (and gitleaks the history for secrets); the guides' build and `kit/theme-zip.sh` check theirs.
- Never commit secrets: a site's folder (`kit/sites/`, or wherever it is: `site.env` is safe, `secrets/` isn't),
  any `.env` (only `.env.example`s), `k8s/secrets/`, `k8s/overlays/*/secrets/`, `k8s/images/built.env`.
- Every setting is documented where it's read from: a commented line in `instances/example.env`, a stack's
  `.env.example`, `kit/examples/` or `k8s/examples/`. Those comments are the Settings reference's text, and
  `docs/build-docs.py` fails on a setting read but not documented, or documented but not read.

## Layout
| Folder | What it is | Detail |
|---|---|---|
| `kit/` | The Compose kit: `setup.sh` makes a site's folder, `kit.sh` runs it, `compose.yaml` + `profiles/` put the stacks together, `monitoring/` (Grafana, Prometheus), `test.sh`, `scrub.py`; `theme/` the kit's theme (Ghost's Source + the kit's parts), `theme-test/`; `docs/` the guides | `kit/CLAUDE.md` |
| `k8s/` | The kit on Kubernetes: Kustomize `base/`, `components/` (one per module), `overlays/` (selfhosted, local, eks, gke and their k3d twins), `up.sh`, `build-images.sh`, `migrate/` (Compose <-> cluster), `clusters/` (cloud recipes), `test/` | `k8s/CLAUDE.md` |
| `instances/` | `example.env`: the instance profile, every site-level setting | `instances/CLAUDE.md` |
| `stacks/` | The services, one Compose file each, which `kit/compose.yaml` includes and `k8s/` builds from | `stacks/CLAUDE.md` |
| `stacks/traefik/` | Traefik: the site's routes (Go templates), middlewares, the local plugins | `stacks/traefik/CLAUDE.md` |
| `stacks/puppi3/` | Ghost, MySQL, Ghost's own analytics (Tinybird), `grafana-ro.sh` (the folder's name is the kit's, like `ID_PREFIX`'s default) | `stacks/puppi3/CLAUDE.md` |
| `stacks/postiz/` | Postiz and the bridge (`ghost-bridge/`): shares each post, social previews, clicks, every network's numbers | `stacks/postiz/CLAUDE.md`, `docs/bridge-map.md` |
| `stacks/icecast/` | TinyIce, the live stream server (compose and `.env.example` only) | `stacks/CLAUDE.md` |
| `stacks/monitoring/grafana/` | The dashboards (`provisioning/dashboards/json/site/`, the big ones as folders of parts) and the alert rules' source `alerts.yml`, with `@SITE_HOST@`-style placeholders; `render.py` makes them for a site, `parts.py`, `style.py`, `ro-tables.py` | `stacks/monitoring/grafana/CLAUDE.md` |
| `scripts/` | `ghost-admin.sh`: a Ghost site's theme, routes, redirects, code injection and theme settings through its Admin API | the script's header |
| `docs/` | `build-docs.py` (builds the guides in `kit/docs/` with the shared `assets/`), `bridge-map.md` | `docs/CLAUDE.md` |
| `.githooks/` | pre-commit: the guides' build and checks, the dashboards' checks, the bridge's modules (`git config core.hooksPath .githooks`) | the hook's comments |
