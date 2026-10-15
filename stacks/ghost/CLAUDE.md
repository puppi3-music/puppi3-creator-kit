# stacks/ghost/

The site itself: Ghost and its database, and Ghost's own web analytics (the `analytics` module). The folder's name
is `ghost` (kit 1.2.0; `puppi3` before). In a kit site, Ghost's container is `<ID_PREFIX>-ghost` (`kit/profiles/ghost.yaml`),
and its data is in `GHOST_DATA_DIR`, which `kit/kit.sh` sets: the site folder's `data/ghost/`, or `data/puppi3/` (with
`secrets/puppi3.env`) in a site made before 1.2.0, used as it is so nobody has to move anything.

- Ghost 6 (`config.production.json` mounted as a single file: `kit/setup.sh` writes it in the site's folder, with the
  mail settings; it applies only when Ghost restarts), MySQL 8, and with `analytics`: traffic-analytics, tinybird-local
  (pinned by digest, no host port), tinybird-sync and tb-setup (writes `tinybird/tokens.env`, then idles;
  `TB_SETUP_EXIT=1` makes it exit instead, for Kubernetes' Job in `k8s/components/analytics/`).
- Ghost and traffic-analytics are on the `proxy` network: Traefik (`dynamic/puppi3.yml`) and the bridge reach them by
  name (`GHOST_UPSTREAM`, `traffic-analytics:3000`), the same on Compose and Kubernetes. Ghost reaches MySQL by its
  container name (`GHOST_DB_HOST`), never a generic one like `db`, which another stack on `proxy` might answer to.
- Restarting Ghost takes the site down for a moment: the theme, routes, redirects, code injection and theme settings
  go through its Admin API instead (`scripts/ghost-admin.sh`).
- Site values come from the instance profile (`instances/CLAUDE.md`): `SITE_HOST` (url, tracker endpoints) and
  `GHOST_DATA_DIR` (this stack's bind mounts: the folder holding `ghost/`, `db/` and `tinybird/`), required, so a
  profile without them can't start Ghost and MySQL on an empty folder.
- tinybird-local starts trimmed (its `command:`): a copy of the image's supervisord files in `/tmp/kit` without its
  MCP and Kafka servers, and `tinybird_server --config` with `csv_workers: 0` (Ghost only sends events, never CSV).
  ~1.8 GB instead of ~2.4. The same script is in staging's compose file and `k8s/components/analytics/tinybird.yaml`;
  `k8s/test/image-pins.py` keeps the copies equal and fails on a new Tinybird digest until `kit/test.sh`'s "Tinybird
  trimmed" passed on it (then `TINYBIRD_TRIED`). If a new image's files don't match, the script logs it and starts
  the image unchanged; `PYTHON_CPU_COUNT=2` then keeps it at one CSV worker.
- `grafana-ro.sh`: Grafana's read-only MySQL login. `grafana_ro` has SELECT on only the tables in its `TABLES`, never
  users, sessions, api_keys or settings (the monitoring module's `grants.sh` uses its `--sql`).
  `stacks/monitoring/grafana/ro-tables.py --check` keeps the dashboards to that list. Restart Grafana after a grant
  change: pooled connections keep their old rights until they reconnect.
