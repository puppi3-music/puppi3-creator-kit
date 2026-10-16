# kit/profiles/

What `kit/compose.yaml` changes in each stack it puts together. The rest of the kit (setup.sh, kit.sh, the tests):
`kit/CLAUDE.md`.

`kit/compose.yaml` `include:`s `stacks/{traefik,ghost,postiz,icecast}/compose.yaml`, each with its
`secrets/<stack>.env` (include `env_file`; Ghost's is `GHOST_ENV_FILE`, which kit.sh sets) and merged with
`profiles/<stack>.yaml`. Profiles never go into the stack files (each also runs on its own, without `--profile`, and
would skip the services).

- The profile files also hold the kit's differences from a stack run on its own, with relative paths resolving in the
  stack's folder: Ghost as `<ID_PREFIX>-ghost` (`GHOST_UPSTREAM`, `GHOST_API_URL` follow) with the image's own user
  (`user: !reset null`), tokens.env from `GHOST_DATA_DIR` and the optional `secrets/ghost-mail.env`
  (`env_file: !override`; tb-setup gives it to the folder's owner, `TOKENS_OWNER_FROM_FOLDER`, since compose reads it
  as the user who runs kit.sh); the bridge reads the same file (`env_file`, so `tinybird__adminToken` gives the
  Platforms dashboard Ghost's numbers with no copying into `TINYBIRD_TOKEN`), the bridge's code and Traefik's plugins
  from the repo, Temporal's config from `kit/postiz/dynamicconfig/`, Postgres in a `pgdata` subfolder (on a Mac it
  refuses a bind-mounted folder's root, "wrong ownership").
- A new service in a module stack needs its profile line here, with `logging: *logs` (each file's `x-logging` anchor:
  json-file, 5 x 10 MB as the kubelet keeps; Docker keeps every line otherwise, and traffic-analytics logs every page
  hit; `kit/monitoring/compose.yaml` has its own; not in the stacks, where it would recreate the NAS's Ghost).
- Host ports: only Traefik's web ports (`HTTP_PORT`, `HTTPS_PORT`) and TinyIce's (`LIVE_PORT`, on `LIVE_BIND` when
  set: that port is all of TinyIce, admin sign-in too, over plain http; the Setup guide's Live says to firewall it),
  each `!override`; Ghost's 8900, traffic-analytics' 8901 and Traefik's dashboard port are `!reset` (on a rented
  server they'd skip Traefik, Cloudflare-only and its firewall: the dashboard is at `traefik.<LAN_DOMAIN>`).
- The bridge is the published image with its code inside (`BRIDGE_IMAGE`, which kit.sh sets to
  `ghcr.io/puppi3-music/puppi3-creator-kit/ghost-bridge:<kit/VERSION>`, `KIT_BRIDGE_IMAGE` for another;
  `build: !reset null`, `pull_policy: missing`, `volumes: !override` with only its `data/`, `user: root` as the
  stack's base runs it, since its data folder is whoever made the site's). tb-setup the same (`TB_SETUP_IMAGE`,
  `KIT_TB_SETUP_IMAGE`; kit 1.2.1: a site's own build kept its old version over an update).
- `KIT_BUILD=1` adds `build.yaml` (a second `-f`, after the includes): both built from this repo, the bridge from
  `stacks/postiz/ghost-bridge/`'s Dockerfile (its `.dockerignore` keeps the build to the `.mjs` files, never `data/`),
  tb-setup from `stacks/ghost/tinybird/`, as `<ID_PREFIX>-ghost-bridge:local` and `<ID_PREFIX>-tb-setup:local` (named
  per site: a fixed name would replace another site's or the NAS stack's image), `pull_policy: build`;
  `kit/local-site.sh` sets it for the test and the demo, k8s's test for its fake NAS.
- Traefik's `HTTPS_REDIRECT` (default true) turns on `kit-site.yml`'s http->https and www->site routers.
