# k8s/test/

The Kubernetes kit's tests, on this computer's k3d cluster only, never a real one. What they test: `k8s/CLAUDE.md`
and its folders' CLAUDE.md files.

- `k3d.sh up|down|env`: cluster `creator-kit` (k3s pinned, 1 server + 2 agents, k3s's Traefik disabled, registry
  on :5111, the site's ports on 9080/9443, the stream source on 8222, StorageClasses `gp3` and `standard-rwo` on local-path, made again by
  `up` when the cluster's already there), its kubeconfig in its own file (`~/.kube/config` untouched).
- `test.sh [--keep] [--overlay local|k3d-eks|k3d-gke] [--migrate]` (the overlay that runs; every overlay is rendered either way, the
  clouds' with their example cloud.env, and each twin diffed against its cloud's) (Docker Desktop needs 12 GB or more: analytics + live + social on k3d ran its default 8 GB out of memory, killing processes under their own limits and stalling the API server; it checks first): site `kit/sites/k8s-test` (kit.test, `kittest`, `MODULES` = the modules on Kubernetes so far,
  `TLS_RESOLVER=self`), images, every overlay rendered and checked with kubeconform, `up.sh local`, then:
  cloudflare-only (403, then the cluster's private ranges in `TRUSTED_EXTRA`), Traefik's dashboard, no router or
  middleware in error, the plugins loaded, the kit's theme uploaded and a post, Ghost's files in the bucket (an image, a sound and a file land under content/images|media|files/ and none on Ghost's volume, served at the site's addresses byte for byte, a w600 resize made and kept, byte ranges, a post storing `__GHOST_URL__/content/...`, served again by a new Ghost pod), analytics (the Secret, Ghost never
  restarted, a page hit as Ghost's tracker sends it reaching Tinybird with page-hit-country's CA, the GET-only stats
  route answering and Tinybird's other API not), monitoring (Grafana on both names, the 10 dashboards in the site's folder, a real query through each datasource, every Prometheus job up, Health's pod memory by workload and disk from the volumes, the alert rules; with one listener on a relay, Health's listeners say 1), social (Postiz on `postiz.<SITE_HOST>`, Cloudflare-only; Postiz's search fields in Temporal's Postgres and its running-job search, no Elasticsearch; the webhook (401 unsigned), the theme's clicks (204) and the social preview reaching the bridge; the bridge's Tinybird tokens; with one listener on a relay its live shows say 1, not the relays; a new bridge pod keeping `data/`), live (ffmpeg to 8222, `/live-status.json`, a 320 kbps mp3 from a relay through Traefik
  that's really the tone (pitch from zero crossings), the source reconnecting with another tone heard through the relays, a
  relay pod killed, TinyIce's admin 403 public and open on `tinyice.<LAN_DOMAIN>`), the Ghost and MySQL pods killed and back with their data, no puppi3 in names, `BEHIND_CLOUDFLARE=false` open,
  and Ghost's pod untouched by that change. `--migrate` then: a fake NAS (`kit/sites/k8s-test-nas`: this site's profile, secrets and setup files on Compose, the base's Ghost image pulled to match the cluster's; databases and Prometheus running, the rest made but stopped; a fake ssh, a sudo that wants a password, a fake Keychain), to-nas.sh, checks there, `up.sh --down`, a fresh up of the other twin, to-cloud.sh, checks in the cluster (posts, site_uuid, theme, the picture's bytes, page hits, TinyIce's renamed mounts, the bridge's data, older Prometheus samples, Postiz, grafana_ro). Requests go through `curl --connect-to kit.test:443:127.0.0.1:9443`, so the
  Host stays `kit.test`. Deletes the cluster only if it made it; when it made it, up.sh gets `UP_TIMEOUT=900` (unless set): a new cluster pulls every image inside up.sh's wait, and Postiz's alone took 3 of its 5 min.
- `test.sh --render-only`: only the first checks (setup.sh's site, every overlay rendered and kubeconform'd, the
  twins' diff), no cluster, no image build (it renders with `k8s/images/built.env` as it is, or without one the published images); ~40 s, cleans up.
- `image-pins.py`: every image the kit names (compose files, the kit's profiles, k8s's YAML, the Dockerfiles'
  `FROM` with their `ARG` defaults, `migrate.sh`'s images, `build-images.sh`'s Alpine, `theme-zip.sh`'s gscan) is at an
  exact version (three numbers, two for PostgreSQL, or a digest), and one image's major version and variant is at one
  version everywhere (postgres 16 and 17-alpine are two). Not the kit's own builds (`creator-kit/...`, `:local`) or
  names from a variable. A site's repo may list folders in `.image-pins` at its top (`skip`, or `own`: exact but its
  own versions, like a staging copy). The commit hook runs it. A version bump is one edit in every file at once, with
  its `kit/CHANGELOG.md` line.
- `twin-diff.py <cloud render> <twin render>`: a twin may differ from its cloud's render only by the stand-ins'
  resources, ConfigMaps `cloud`/`s3`, Secrets' contents, ExternalNames and ServiceAccounts' annotations (values),
  Ghost's gateway endpoint, and the `cloud-sql-proxy` sidecar's image and args; generated names' hashes ignored. test.sh runs it for every `k8s/overlays/k3d-*`.
- The `test-k8s` skill (`.claude/skills/test-k8s/`) is how Claude runs these: which run fits which change (render
  check first, then the overlay(s) the change reaches; `--migrate` for `k8s/migrate/`), watching the log and the pods
  while it runs, and `kc.sh`, a kubectl that only ever talks to `k3d-creator-kit` (never plain `kubectl`).
