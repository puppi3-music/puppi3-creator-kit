# k8s/

The Creator Kit on Kubernetes: Kustomize only (base, components, overlays), no Helm, no CRDs. Traefik + Ghost + MySQL
and the analytics, live, social and monitoring modules. Tests run only on a local k3d cluster (`test/`), never a real
one.

A site is the same folder as on Compose (`kit/setup.sh` makes it: `site.env`, `secrets/`, `data/`).

- `up.sh <site> <overlay> [--render] | <site> --down`: writes the site's kustomization to `<site>/data/k8s/` on every
  run (the overlay; a component per module in `MODULES` that has one, others noted and left out; ConfigMap `site` from
  `site.env`; ConfigMap `ghost` with only `SITE_HOST` and `STAFF_DEVICE_VERIFICATION`, so other profile changes don't
  restart Ghost; a Secret per `secrets/<stack>.env`, named after the stack (`secrets/puppi3.env`, a site's from before
  kit 1.2.0, is Secret `ghost` all the same); the kit's images: `images/built.env`'s when there is one, else this
  version's published ones, `ghcr.io/puppi3-music/puppi3-creator-kit/<name>:<kit/VERSION>`),
  renders it to `rendered.yaml` (`--load-restrictor LoadRestrictionsNone`: the base reads `stacks/traefik/dynamic/`),
  applies it to namespace `<ID_PREFIX>`, deletes the generated ConfigMaps/Secrets the apply no longer named (their
  names carry a hash), and waits (5 min; `UP_TIMEOUT=<s>` for a first slow image pull) until every Job has finished and every Deployment and StatefulSet is ready (Jobs are
  deleted before each apply, so tb-setup runs on every up, as on Compose), printing what it waits for every 30 s and
  stopping at once on a stuck pod (`pod-state.py`: crash loop, with its last log lines; image pull; config error other
  than waiting for `tinybird-tokens`). Ghost's `progressDeadlineSeconds` is 1800 (tokens, then migrations).
  With live on it also makes Secrets `tinyice-config` and `icecast-relay-config` (`components/live/`); with social on,
  Secrets `postiz-env` and `postiz-ghost-bridge-env` and ConfigMap `social` (`components/social/`), and with analytics
  too, a patch giving the bridge `tinybird-tokens`; with monitoring, the rendered dashboards (a ConfigMap each),
  alert rules and Prometheus's config (below). `rendered.yaml` and those env files hold secrets: mode 600.
  Applies server-side (`--server-side --force-conflicts`, field manager `creator-kit-up`): Platforms' ConfigMap
  (~280 KB) is over the 256 KiB a client-side apply's last-applied annotation holds. `--down` also deletes the
  site's ClusterRole and binding (`<ID_PREFIX>-prometheus-kubelet`), `data/k8s/ghost.env` and `data/k8s/s3.env`.
  With an overlay that has `components/s3-gateway` (and no `secrets/s3.env`), it makes the gateway's one account
  once per site (`data/k8s/s3.env`, mode 600, random keys) and adds it as Secret `s3`.
  **Cloud overlays:** an overlay's `finish/` (a Component) goes in after the modules' components, so its patches
  reach every module's resources (an overlay's own patches see only its own). Its values: `overlays/<o>/cloud.k3d`
  (a k3d twin's, committed, not a `.env` since .gitignore keeps those out: the stand-ins', `{namespace}` filled in) or else `<site>/cloud-<o>.env` (from the
  overlay's `cloud.env.example`; up.sh stops without it) -> ConfigMap `cloud` (all of it) and `s3` (its `S3_*`), and
  `overlays/<CLOUD>/replacements.yaml` in the site's `replacements:` (CLOUD= in the values, else the overlay's name).
  Replacements and finish/ can't live in the overlay itself: a component's transformers run before the site's
  generators, so ConfigMap `cloud` isn't there yet. With the k3d stand-ins it makes the Postgres stand-in's master
  login once per site (`data/k8s/standins.env` -> Secret `cloud`: `POSTGRES_MASTER_USER`, `POSTGRES_MASTER_PASSWORD`)
  unless `secrets/cloud.env` gives the real one.
  `local`/`k3d-*` use k3d's own kubeconfig and refuse any other context; other overlays ask before using kubectl's
  current context.
- `base/`: Traefik and Ghost.
  - Traefik: Traefik's own image at the Compose version; the local plugins `realip` and `pagehitcountry` are ConfigMap
    `traefik-plugins` (the stack's files; `items` put each back under `/plugins-local/src/creatorkit/<name>/`, a
    changed plugin = a new ConfigMap name = a restart, which plugins need). Not root, so entrypoints
    `web` :8000 and `https` :8443 behind a LoadBalancer Service on 80/443 (`externalTrafficPolicy: Local`, for the
    visitor's address); the Compose stack's flags otherwise (timeouts, Cloudflare's trusted ranges, the `cf`/`le`
    resolvers on a small PVC, metrics on :8082 with Service `traefik-metrics`). Routes come only from the file
    provider: ConfigMap `traefik-dynamic` = the stacks' own templates (`puppi3.yml` as `site.yml`, `cloudflare-only`,
    `real-ip`, `page-hit-country`) plus `base/traefik/{lan-only,dashboard}.yml`; a module's component adds its route
    files to it (`behavior: merge`). Traefik reads the mounted ConfigMap folder without doubling (checked). Its
    environment is the `site` ConfigMap plus `GHOST_UPSTREAM=http://ghost:2368`; the other upstreams' defaults are
    already the Services' names (`traffic-analytics`, `tinybird-local`, `postiz-ghost-bridge`), so keep those names.
  - Ghost: `ghost:<version>-alpine` (the Compose stack's exact version), 1 replica, `Recreate`, settings as environment (no `config.production.json`), MySQL at
    Service `mysql` (an init container waits for it), content on PVC `ghost-content`; mail (`mail__*`, as the NAS's
    config file's `mail`) from the site's optional `secrets/ghost-mail.env` (Secret `ghost-mail`, envFrom, optional:
    without it Ghost's Direct mail; `kit/examples/ghost-mail.env.example`, which Compose reads too); probes ask
    `/ghost/api/admin/site/` with `X-Forwarded-Proto: https`.
- `components/mysql/`: MySQL 8 StatefulSet (the Compose stack's exact version) + Service `mysql`, root's password from Secret `ghost`.
- `components/analytics/` (module `analytics`): `tinybird-local` StatefulSet (the stack's digest; ClickHouse and Redis
  volumes; started trimmed by the Ghost stack's script (no MCP or Kafka server, no CSV worker; `image-pins.py` keeps
  the copies equal): ~1.8 GB idle, so request 2Gi; limit 4Gi, room for an unchanged start (~2.4 GB with one CSV worker
  at `PYTHON_CPU_COUNT=2`; with five workers 3Gi was OOM-killed in a loop); startup
  probe with a 5 s timeout, as Compose's), `traffic-analytics` Deployment (salts on a small PVC), and `tb-setup` as a
  Job: init containers copy Ghost's schema files out of Ghost's image and run the stack's `setup.sh` with
  `TB_SETUP_EXIT=1`, then `save-tokens` puts the tokens into Secret `tinybird-tokens` with a server-side apply through
  the API (ServiceAccount + Role: create secrets, get/patch only that one). Ghost and traffic-analytics take it as
  `envFrom`, not optional, so their pods wait (CreateContainerConfigError until it exists) and Ghost starts with the
  tokens. The Ghost patch is a JSON patch that appends: a strategic merge puts new env first, before `SITE_HOST`,
  and `$(SITE_HOST)` wouldn't expand. Traefik's routes are already in the site's template.
- `components/live/` (module `live`): the main `tinyice` Deployment (the stack's digest, 1 replica, Recreate; its
  config from Secret `tinyice-config` = `data/icecast/tinyice-data/config.json`, copied onto its PVC only when the
  volume has none, so admin edits stay; history on the same PVC), Service `tinyice` (Traefik, the relays, the bridge's
  `LIVE_STATUS_URL` default, Prometheus) and LoadBalancer `tinyice-source` on 8222 for the streaming software (straight to
  TinyIce: Traefik drops a SOURCE body; all of TinyIce answers there, admin sign-in too, so the site's
  `LIVE_SOURCE_RANGES` becomes its `loadBalancerSourceRanges`, an up.sh patch). Listeners' `/stream-mp3` goes to `tinyice-relay`: **Icecast 2** relays
  (`images/icecast-relay/`, Alpine's package, uid 100), 2 replicas, stateless, pulling `/stream-mp3` from `tinyice`;
  their `icecast.xml` is Secret `icecast-relay-config` from `up.sh` (TinyIce's admin password and mp3 burst size,
  500 listeners each, logs to /dev/stdout and /dev/stderr: Icecast puts `<logdir>` in front of the names;
  `master-update-interval` 5, how often a failed relay is retried: the default 120 s missed a new site's first
  stream). Readiness: ready when the relay has `/stream-mp3` or no source is on the main TinyIce's `/stream-ogg`
  (TinyIce lists `/stream-mp3` even with no source, sending nothing, so relays reconnect every 10 s then), so listeners
  don't land on a relay catching up and `up.sh` doesn't wait for a source; it asks `127.0.0.1` (busybox wget tries
  `::1` for localhost; Icecast is IPv4 only). **TinyIce's
  own edge relays can't do it**: they refuse private addresses ("outbound request to a non-routable target
  refused") and have no switch. TinyIce keeps `/stream-mp3` up with no source, so the relays stay connected, and a source
  reconnecting comes through them (checked). Icecast handles the mp3 with its generic passthrough (a warning in its
  log). `live.yml`: the icecast stack's labels as a Traefik file, the same router names (`tinyice`, `tinyice-admin`,
  `tinyice-lan`, `live-status`) plus `tinyice-mp3` (priority 90, to the relays).
  **The mounts' names are TinyIce's own:** `up.sh` reads the source's and the mp3 mount (the mp3 transcoder's input and
  output) from the running TinyIce's config (`kubectl exec … cat /data/config.json`; a rename in its admin is saved on
  its volume), else the site's, into ConfigMap `live` (`LIVE_SOURCE_MOUNT`, `LIVE_MP3_MOUNT`) and the relays' config;
  Traefik gets it through a patch appending to its `envFrom` (`traefik.yaml`), the relays' readiness through theirs.
  Renamed in TinyIce, run `up.sh` again. `up.sh` connects to the cluster before rendering now (except `--render`).
- `components/social/` (module `social`): Postiz (Deployment, Recreate, uploads and config on PVC `postiz`; an init
  container waits for Postgres, Redis and Temporal, Compose's depends_on; probes are Compose's node check, any answer
  under 500), its Postgres and Redis (`databases.yaml`), Temporal (`temporal.yaml`: auto-setup, its Postgres and
  Elasticsearch, the dynamic config from `kit/postiz/dynamicconfig/`; no Temporal UI; its health check asks the pod's
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
  `LIVE_RELAYS=tinyice-relay-pods`, a headless Service (`components/live/relay.yaml`) whose addresses are the ready
  relays; `stats/live.mjs` asks each relay's status and counts main listeners - relays + the relays' listeners.
  Unset (Compose, the NAS) it counts as before.
- `components/monitoring/` (module `monitoring`): Grafana 13.2.3 (Deployment, Recreate, PVC; the Infinity plugin;
  the Compose kit's own `kit/monitoring/grafana/{datasources,dashboards}.yml`, their `${VAR}` logins from its
  environment: Secrets `monitoring`, `ghost`, ConfigMap `site`; `tinybird-tokens` with analytics, as the bridge),
  Prometheus v3.5.0 (StatefulSet, 10 Gi, a year or 8 GB), blackbox (the public checks), json-exporter (the relays'
  `/status-json.xsl` as `icecast_relay_listeners{mount}`) and the Compose kit's `grants.sh` as Jobs `grafana-ro-ghost`
  and `grafana-ro-postiz` (grafana_ro, on every up). `up.sh` renders the dashboards with
  `render.py --profile cloud` into `data/k8s/monitoring/` (`stacks/monitoring/grafana/CLAUDE.md`): one ConfigMap
  `grafana-dashboard-<name>` each, listed in Grafana's projected `dashboards` volume by a patch, `grafana-alerting`
  (a changed rule = a new name = Grafana restarts, which is when it reads them), and writes Prometheus's jobs
  (`prometheus-config`): Traefik, the bridge (`<ID_PREFIX>-pets`), TinyIce, `tinyice-relays` (each ready relay of
  `tinyice-relay-pods` through json-exporter, the mount label cut to its path), blackbox, and the kubelets straight
  at each node's :10250 (`cadvisor`: pod CPU/memory; `kubelet`: volume stats; only those metrics and the site's
  namespace kept; `insecure_skip_verify`, as a kubelet's serving certificate is usually its own; ClusterRole renamed
  per site by up.sh: `nodes` list/watch and `nodes/metrics` get only, never `nodes/proxy`, which lets a token run
  commands in any pod through the kubelet; pods must reach the nodes' :10250, as k3d, eksctl's and GKE Standard's
  defaults allow). No node-exporter or cAdvisor of its own. After the first up it asks
  Ghost for its `site_uuid` (`kubectl exec deploy/traefik -- wget`), keeps it in `data/k8s/ghost.env` and runs
  itself once more (only Grafana's ConfigMaps change). Grafana's routers are `grafana`/`grafana-lan`, not
  `<ID_PREFIX>-grafana` as on Compose: every router here is `@file`, and Health counts `<ID_PREFIX>-*@file` as the
  site's. kubelet volume stats work on k3s's local-path volumes (they're `local` PVs).
- `components/s3-storage/` (Phase D part 1; the `local` overlay now, the clouds later): Ghost's images, media and
  files in a bucket, keys `content/images|media|files/...` (the NAS's own layout, so they copy across as they are);
  themes and settings stay on `ghost-content`. The adapter is **`KitS3Storage.js`**: Ghost 6's own built-in
  `S3Storage` (it has one: saving, resized images through `saveRaw`, multipart uploads) with `serve()` streaming from
  the bucket (content type, a year's cache, byte ranges, 304, 404) instead of Ghost's 301 to a separate CDN address,
  so files stay at `https://<site>/content/...` (Cloudflare caches them) and the bucket stays private. Mounted from
  ConfigMap `ghost-s3-adapter` beside Ghost's own adapters (`/var/lib/ghost/current/core/server/adapters/storage/`),
  no image of its own; configured by `storage__...` environment (media and files as feature settings over the
  images' ones; Ghost parses numbers and booleans in env). `cdnUrl` = the site, so Ghost stores new files as
  `__GHOST_URL__/content/...` (checked), the same as with local storage: no link changes either way. Bucket and
  region from ConfigMap `s3`; keys, when there are any, envFrom Secret `s3` (optional; with none the AWS SDK's chain,
  IRSA on EKS). Ghost's `envFrom` is `[]` in the base and every component appends (`/envFrom/-`): an `add` of the
  whole list would drop the other's.
  `endpoint.yaml`: Ghost's patch for a bucket somewhere other than AWS (S3_ENDPOINT, path-style): s3-gateway, gke and
  k3d-eks add it.
- `components/s3-gateway/`: an in-cluster S3, **versitygw** v1.8.0 (Versity's gateway, Apache 2.0; MinIO, the plan's
  choice, no longer publishes images), a StatefulSet `s3` keeping each object as a file (`/data/<bucket>/<key>`;
  the bucket is a folder its init container makes), Service `s3:7070`, ConfigMap `s3` (bucket `ghost-content`,
  path-style). It needs a filesystem with extended attributes (it keeps content types there): fine on k3s volumes,
  not on a macOS bind mount.
- `components/cloud-postgres/` (both clouds' `finish/`): Postiz's and Temporal's Postgres as one managed Postgres.
  Job `postgres-logins` (with social: Postiz's and Temporal's logins and the databases `postiz`, `temporal`,
  `temporal_visibility` from the master login, Secret `cloud`; `GRANT <role> TO CURRENT_USER` since RDS's and Cloud
  SQL's master isn't a superuser; Temporal's setup needs its first database there already: the postgres image made
  it in the cluster), the two Postgres StatefulSets deleted (`$patch: delete` by target: nothing when social is off),
  Postiz and Temporal wait (init containers) until their login works, and monitoring's `grafana-ro-postiz` signs in
  as the master (postiz isn't a superuser there and may not make roles; the master is in role postiz, the tables'
  owner). How pods reach it is each overlay's.
- `overlays/eks/` (Phase D part 2): base + s3-storage, `databases.yaml` (Service `mysql` = ExternalName of RDS for
  MySQL, ServiceAccount `ghost` with the IRSA role annotation), Ghost on ServiceAccount `ghost`.
  `finish/`: cloud-postgres, gp3 on every PVC and claim template (tinybird-local's second too), NLB annotations on
  `traefik` and `tinyice-source` (instance targets + `externalTrafficPolicy: Local` keep the visitor's address),
  Postiz's two Postgres Services replaced by ExternalNames. `replacements.yaml`:
  `MYSQL_HOST`, `POSTGRES_HOST`, `GHOST_ROLE_ARN`. `cloud.env.example`: what a site fills in (RDS Postgres needs
  `rds.force_ssl=0`: Postiz and Temporal connect without TLS). Not tried on AWS yet.
- `overlays/k3d-eks/`: `resources: ../eks` and nothing else; `finish/` = `components/k3d-standins` then eks's finish
  (so the stand-ins' volumes get gp3 too), plus s3-storage's `endpoint.yaml` for Ghost; `cloud.k3d` = the
  stand-ins' hosts, the gateway's bucket and endpoint.
- `overlays/gke/` (Phase D part 3): GKE Standard. base + s3-storage with `endpoint.yaml` (Cloud Storage's S3 API,
  `https://storage.googleapis.com`, an HMAC key as `secrets/s3.env`) and the AWS SDK's checksums only when required
  (`AWS_REQUEST_CHECKSUM_CALCULATION`/`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`: Ghost's SDK, 3.1079, sends
  them by default and Cloud Storage refuses some; versitygw doesn't, so k3d can't check it), `cloud-sql.yaml`
  (ServiceAccount `cloud-sql`, Workload Identity annotation `CLOUD_SQL_SA` via `replacements.yaml`).
  `finish/`: cloud-postgres; **`cloud-sql-proxy.yaml`**, a strategic merge on Ghost, Grafana, Postiz, Temporal, the
  bridge (it reads Postiz's database) and the Jobs grafana-ro-ghost, grafana-ro-postiz, postgres-logins: the Cloud
  SQL Auth Proxy (2.26.0, its `-alpine` image for the shell) as a native sidecar (an init container with
  `restartPolicy: Always`; a strategic merge puts it first, before Ghost's wait-for-db and the login waits; a Job
  still finishes), on 127.0.0.1:3306 and, when `POSTGRES_INSTANCE` is set (social), :5432 (`MYSQL_INSTANCE`,
  `POSTGRES_INSTANCE`, `CLOUD_SQL_PROXY_FLAGS` from ConfigMap `cloud`; never ConfigMap `site`, whose new name with
  any profile change would restart Ghost: the test caught that), started = `nc -z` on its ports; `hostAliases` send `mysql`,
  `postiz-postgres`, `postiz-temporal-postgres` to 127.0.0.1, so no module's setting changes; serviceAccountName
  `cloud-sql`; annotation `creator-kit/sidecar: cloud-sql-proxy` (the twin finds the pods by it). Postiz's Postgres
  Services deleted; standard-rwo everywhere; `cloud.google.com/l4-rbs: enabled` + `externalTrafficPolicy: Local` on
  `traefik` and `tinyice-source`. `cloud.env.example`. Not tried on Google Cloud yet.
- `overlays/k3d-gke/`: `resources: ../gke`; `finish/` = k3d-standins, gke's finish, then `forwarder.yaml` on the
  annotated pods: the sidecar's image (`alpine/socat`) and script only, socat from 127.0.0.1's ports to the
  stand-ins `cloud.k3d` names as the instances; env, probe, user and hosts stay gke's.
- `components/k3d-standins/`: `standin-mysql` (MySQL 8, master = Ghost's login) and `standin-postgres` (Postgres 17,
  only the master login, Secret `cloud`), and the S3 gateway (`../s3-gateway/gateway.yaml`, not its ConfigMap:
  ConfigMap `s3` comes from cloud.k3d). k3d.sh makes the StorageClasses `gp3` and `standard-rwo` (local-path).
- The Setup guide's Kubernetes and EKS/GKE sections and the Operations guide's moving section (`kit/docs/`) are how
  someone runs a site on a cluster or moves it: change them with the overlays, recipes or migration scripts.
- `clusters/eks.yaml` (eksctl: OIDC for IRSA, the load balancer controller's ServiceAccount, the EBS CSI add-on, a
  managed node group of two m7i.xlarge, not Fargate) and `clusters/eks-gp3.yaml` (the default StorageClass): the user
  runs them; untested without an AWS account. `clusters/gke.sh up|down` (gcloud, `PROJECT=`): one zone, two
  e2-standard-4, Workload Identity on; prints the binding for `cloud-sql`. The user runs it; untested.
- `examples/`: what a site's Kubernetes-only secrets files hold (`cloud.env`, `s3.env`; copy to
  `<site>/secrets/`), with the overlays' `cloud.env.example`s the source of the kit's Settings reference
  (`kit/docs/settings_reference.py`): its comments are the reference's text, and a key nothing reads stops the build.
- `migrate/` (Phase D part 4): `to-cloud.sh <site> <overlay> --from [<user>@<host>:]<data folder>` and
  `to-nas.sh <site> <overlay> --to ...` (both `migrate.sh`; `-n` checks and prints the steps, `-y` doesn't ask,
  `--no-start` leaves the NAS's apps stopped). The user runs them: Claude never points them at the real NAS or a real
  cluster. The Docker host side is the stacks' containers (found by Compose service in the projects `<ID_PREFIX>`,
  `ghost` or `puppi3` (its name before kit 1.2.0), `postiz`, `icecast`, `monitoring`: the kit's Compose and stacks
  run one project each alike; a `puppi3-staging` project never) and the data folder (`DATA_DIR`; Ghost's folder in it,
  `ghost/` or `puppi3/`, is read from where Ghost's container mounts `/var/lib/ghost/content`): over ssh with `sudo -k -S` (the password line first, the
  stream after it: sudo reads it a byte at a time; never sent when sudo needs none), the password from Keychain item
  `<ID_PREFIX>-nas` or asked; or this machine's Docker (the test). Every file
  operation there runs in a throwaway `busybox:1.37.0` with the data folder at `/d` (the same tar, find, stat on a Mac).
  The cluster side: pod `migrate` (MySQL's, Postgres's and rclone's clients) built from Ghost's Deployment: its
  service account (IRSA), hosts file and sidecars (the Cloud SQL proxy), its `database__*` env, Secret `postiz`,
  ConfigMap/Secret `s3`; and a busybox pod per volume (`migrate-<claim>`) with the volume's workload scaled to 0
  (a volume is one node's at a time). What moves: Ghost's MySQL (mysqldump; the target's tables dropped first, not the
  database: the cloud's login may not make one), images/media/files (the bucket, by rclone, or Ghost's volume
  without one), themes/settings/data; Postiz's and Temporal's Postgres (`DROP SCHEMA public CASCADE` then a plain
  dump without owners; `SET transaction_timeout` cut: pg_dump 17 into Temporal's 16), the bridge's `data/` and
  Postiz's config/uploads (their apps stopped on the source: Postiz and the bridge move, two would post twice),
  TinyIce's config and history, Tinybird's ClickHouse and Redis volumes (Tinybird stopped meanwhile on both sides,
  then started), Prometheus's samples of `<ID_PREFIX>-pets|traefik|tinyice` (promtool `dump-openmetrics` ->
  `create-blocks-from openmetrics` straight into the data folder, blocks of up to 31 days; to-nas only since the
  cluster's Prometheus volume was made). Copied files take the owner the target's contents had. Every database and
  folder is counted on both sides (exit 3 if any differ). Ghost's database goes only to the same or a newer Ghost.
  to-cloud ends by deleting Secret `tinybird-tokens` and `data/k8s/ghost.env` and running `up.sh` (tb-setup reads the
  copied workspace's tokens; up.sh asks Ghost for its site_uuid again; TinyIce is started first so up.sh reads its
  copied mounts). to-nas keeps what the NAS had in `<data folder>/.migrate-backups/<stamp>/` (databases as `.sql.gz`,
  folders moved, volumes as `.tar`), stops and starts the NAS's Ghost (it's the move home), writes `tokens.env` if the
  cluster's differ (then Ghost etc. need recreating: the user's). Never Cloudflare.
- `test/image-pins.py`: every image the kit names (compose files, the kit's profiles, k8s's YAML, the Dockerfiles'
  `FROM` with their `ARG` defaults, `migrate.sh`'s images, `build-images.sh`'s Alpine, `theme-zip.sh`'s gscan) is at an
  exact version (three numbers, two for PostgreSQL, or a digest), and one image's major version and variant is at one
  version everywhere (postgres 16 and 17-alpine are two). Not the kit's own builds (`creator-kit/...`, `:local`) or
  names from a variable. A site's repo may list folders in `.image-pins` at its top (`skip`, or `own`: exact but its
  own versions, like a staging copy). The commit hook runs it. A version bump is one edit in every file at once, with
  its `kit/CHANGELOG.md` line.
- `test/twin-diff.py <cloud render> <twin render>`: a twin may differ from its cloud's render only by the stand-ins'
  resources, ConfigMaps `cloud`/`s3`, Secrets' contents, ExternalNames and ServiceAccounts' annotations (values),
  Ghost's gateway endpoint, and the `cloud-sql-proxy` sidecar's image and args; generated names' hashes ignored. test.sh runs it for every `overlays/k3d-*`.
- `overlays/selfhosted/` (base + mysql), `overlays/local/` (selfhosted on k3d, images from its registry, plus s3-storage and s3-gateway: Ghost's files in
  a bucket, as in a cloud).
- `build-images.sh --registry k3d|<registry> [--platform a,b] [--tag <t>]`: builds and pushes the kit's three images (the Icecast relay, the bridge from a folder of just its `.mjs` files (never `data/`) with `stacks/postiz/ghost-bridge/Dockerfile`, tb-setup from a
  folder of just its two files: the stack's folder here may hold a real `tokens.env`; tag = upstream version + a hash of
  the inputs, plus `--tag`'s; `--platform` with a comma = one `docker buildx build --push` for all of them; each with
  `org.opencontainers.image.source`, GHCR's link to the kit's repo), writes `images/built.env` (git-ignored), which
  `up.sh` turns into Kustomize `images:`. The release runs it for GHCR (both architectures, `--tag <VERSION>`; tried
  into k3d's registry: one index per image with amd64 and arm64, 71 s). `k3d` pushes to
  `localhost:5111` and the cluster pulls `k3d-creator-kit-registry:5111`.
- `test/k3d.sh up|down|env`: cluster `creator-kit` (k3s pinned, 1 server + 2 agents, k3s's Traefik disabled, registry
  on :5111, the site's ports on 9080/9443, the stream source on 8222, StorageClasses `gp3` and `standard-rwo` on local-path, made again by
  `up` when the cluster's already there), its kubeconfig in its own file (`~/.kube/config` untouched).
- `test/test.sh [--keep] [--overlay local|k3d-eks|k3d-gke] [--migrate]` (the overlay that runs; every overlay is rendered either way, the
  clouds' with their example cloud.env, and each twin diffed against its cloud's) (Docker Desktop needs 12 GB or more: analytics + live + social on k3d ran its default 8 GB out of memory, killing processes under their own limits and stalling the API server; it checks first): site `kit/sites/k8s-test` (kit.test, `kittest`, `MODULES` = the modules on Kubernetes so far,
  `TLS_RESOLVER=self`), images, every overlay rendered and checked with kubeconform, `up.sh local`, then:
  cloudflare-only (403, then the cluster's private ranges in `TRUSTED_EXTRA`), Traefik's dashboard, no router or
  middleware in error, the plugins loaded, the kit's theme uploaded and a post, Ghost's files in the bucket (an image, a sound and a file land under content/images|media|files/ and none on Ghost's volume, served at the site's addresses byte for byte, a w600 resize made and kept, byte ranges, a post storing `__GHOST_URL__/content/...`, served again by a new Ghost pod), analytics (the Secret, Ghost never
  restarted, a page hit as Ghost's tracker sends it reaching Tinybird with page-hit-country's CA, the GET-only stats
  route answering and Tinybird's other API not), monitoring (Grafana on both names, the 10 dashboards in the site's folder, a real query through each datasource, every Prometheus job up, Health's pod memory by workload and disk from the volumes, the alert rules; with one listener on a relay, Health's listeners say 1), social (Postiz on `postiz.<SITE_HOST>`, Cloudflare-only; the webhook (401 unsigned), the theme's clicks (204) and the social preview reaching the bridge; the bridge's Tinybird tokens; with one listener on a relay its live shows say 1, not the relays; a new bridge pod keeping `data/`), live (ffmpeg to 8222, `/live-status.json`, a 320 kbps mp3 from a relay through Traefik
  that's really the tone (pitch from zero crossings), the source reconnecting with another tone heard through the relays, a
  relay pod killed, TinyIce's admin 403 public and open on `tinyice.<LAN_DOMAIN>`), the Ghost and MySQL pods killed and back with their data, no puppi3 in names, `BEHIND_CLOUDFLARE=false` open,
  and Ghost's pod untouched by that change. `--migrate` then: a fake NAS (`kit/sites/k8s-test-nas`: this site's profile, secrets and setup files on Compose, the base's Ghost image pulled to match the cluster's; databases and Prometheus running, the rest made but stopped; a fake ssh, a sudo that wants a password, a fake Keychain), to-nas.sh, checks there, `up.sh --down`, a fresh up of the other twin, to-cloud.sh, checks in the cluster (posts, site_uuid, theme, the picture's bytes, page hits, TinyIce's renamed mounts, the bridge's data, older Prometheus samples, Postiz, grafana_ro). Requests go through `curl --connect-to kit.test:443:127.0.0.1:9443`, so the
  Host stays `kit.test`. Deletes the cluster only if it made it.
- `test/test.sh --render-only`: only the first checks (setup.sh's site, every overlay rendered and kubeconform'd, the
  twins' diff), no cluster, no image build (it renders with `images/built.env` as it is, or without one the published images); ~40 s, cleans up.
- The `test-k8s` skill (`.claude/skills/test-k8s/`) is how Claude runs these: which run fits which change (render
  check first, then the overlay(s) the change reaches; `--migrate` for `migrate/`), watching the log and the pods
  while it runs, and `kc.sh`, a kubectl that only ever talks to `k3d-creator-kit` (never plain `kubectl`).
- A StatefulSet doesn't replace a crash-looping pod after its spec changes (it waits for that pod to get ready):
  delete the pod by hand.
