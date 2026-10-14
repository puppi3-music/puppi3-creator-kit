# instances/

`example.env` is the instance profile: one file of site-level settings (no secrets: those are each stack's, in a
site's `secrets/<stack>.env`), every one documented in it. `kit/setup.sh` writes a site's own copy as `site.env` in
its folder, with the answers it asked for; its comments are the Settings reference's text (`docs/build-docs.py`).

- Who reads what: the compose files read `SITE_HOST`, `DATA_DIR` and the Ghost stack's `GHOST_DATA_DIR` (required:
  `${VAR:?…}`, so a stack with no profile stops instead of starting as another site on empty folders), `LIVE_HOST` (default `live.<SITE_HOST>`),
  `TLS_RESOLVER`, `LAN_DOMAIN` (`traefik.<it>`, `tinyice.<it>`, `grafana.<it>`: the home-network-only names; default
  `localhost`) and `ID_PREFIX` (router, container and project names). Traefik's dynamic files (Go templates) read
  `SITE_HOST`, `ID_PREFIX`, `MODULES`, `BEHIND_CLOUDFLARE`, `TRUSTED_EXTRA`, `TLS_RESOLVER` from Traefik's environment
  (`stacks/traefik/CLAUDE.md`). The bridge reads `SITE_HOST`, `SITE_NAME`, `SITE_TIMEZONE`, `ID_PREFIX`, `SITE_HOSTS`,
  `LIVE_HOSTS`, `PETS`, `NETWORKS`, `GRAFANA_URL`, and the optional posting settings (`CHANNELS` … `TIKTOK_PRIVACY`,
  commented out in `example.env` with their defaults; `stacks/postiz/CLAUDE.md`; the `FEATURED_*` ones are the featured link's wording, neutral by default). `render.py` reads the profile for
  the dashboards' placeholders and which modules and networks to leave out (`stacks/monitoring/grafana/CLAUDE.md`).
- `kit/kit.sh` passes the profile to Compose with `--env-file`; `k8s/up.sh` turns it into the cluster's settings.
- A profile variable with the same name as a stack secret wins over it when both are passed, so a name lives in one
  place only.
- `DATA_DIR` = the folder holding the stacks' data folders; the compose files append `<stack>/...`. Required, never a
  relative default (a stack manager running compose in its own container would resolve it there, and MySQL would
  start on an empty folder). A kit site leaves it unset: `kit/kit.sh` sets it to the site folder's `data/`, and
  `GHOST_DATA_DIR` to its `data/ghost/` (`data/puppi3/` in a site made before kit 1.2.0).
- `*.local.env` beside a profile is for values you don't commit.
