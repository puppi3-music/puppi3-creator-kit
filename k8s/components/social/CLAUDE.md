# k8s/components/social/

Postiz and the bridge on Kubernetes. The other components: `k8s/components/CLAUDE.md`; `up.sh` and the rest: `k8s/CLAUDE.md`.

Module `social`: Postiz (Deployment, Recreate, uploads and config on PVC `postiz`; an init
container waits for Postgres, Redis and Temporal, Compose's depends_on; probes are Compose's node check, any answer
under 500), its Postgres and Redis (`databases.yaml`), Temporal (`temporal.yaml`: auto-setup and its Postgres, which also holds its searchable records
(`ENABLE_ES=false`, as the postiz stack), the dynamic config from `kit/postiz/dynamicconfig/`; no Temporal UI; its health check asks the pod's
address, it doesn't listen on localhost), and the bridge (`bridge.yaml`: the kit's image, `stacks/postiz/ghost-bridge/Dockerfile`, with
the code inside, node user, 1 replica, Recreate, 300 s to stop, `data/` on PVC `postiz-ghost-bridge`, readiness
`/health`). Every Service keeps the stack's name, so the addresses in the stack's environment work unchanged.
**Postiz's and the bridge's settings come from the stack itself:** `up.sh` runs `docker compose config` on
`stacks/postiz/compose.yaml` with `site.env` and `secrets/postiz.env` (in an empty environment: nothing from your
shell) and writes each service's environment as a Secret's env file, changing only the bridge's `GHOST_API_URL`
(`http://ghost:2368`), `LIVE_STATS=false` without live or `LIVE_MOUNT` = the source mount with it, and `LIVE_RELAYS`
(below). So a new setting or default in the stack reaches Kubernetes with no change here. Values on more than one
line are refused (an env file can't hold them). Kustomize keeps values like `#campaign-` and `Post in app` (checked).
With analytics on, the bridge also gets `tinybird-tokens` (its `tinybird__adminToken`, as staging's bridge) and
waits for it like Ghost. `social.yml`: the stack's labels as a Traefik file (routers `postiz`,
`postiz-ghost-bridge`, `<ID_PREFIX>-social-preview`), Postiz's name from ConfigMap `social` (`POSTIZ_DOMAIN` from
`secrets/postiz.env`) through a patch appending to Traefik's `envFrom`; the theme's click and pet routes to the
bridge are already in `site.yml`.
**Live listeners with relays:** every relay is one listener on the main TinyIce, so with live on the bridge gets
`LIVE_RELAYS=tinyice-relay-pods`, a headless Service (`k8s/components/live/relay.yaml`) whose addresses are the ready
relays; `stats/live.mjs` asks each relay's status and counts main listeners - relays + the relays' listeners.
Unset (Compose, the NAS) it counts as before.
