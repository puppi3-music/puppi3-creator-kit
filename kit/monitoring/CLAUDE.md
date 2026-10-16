# kit/monitoring/

The monitoring module, kit-only (not in `stacks/`: a server may run its own Prometheus and Grafana already; profile
`monitoring` set in the file itself). What it shows: the dashboards and alert rules, `stacks/monitoring/grafana/CLAUDE.md`.
`kit.sh` writes Prometheus's config and renders those for the site (`kit/CLAUDE.md`, kit.sh). The rest of the kit:
`kit/CLAUDE.md`.

- `compose.yaml`: Prometheus, Grafana 13.2.3 (Infinity plugin; the site's folder = `SITE_NAME`; routed at
  `GRAFANA_HOST`, Cloudflare-only then real-ip (its sign-in limits count by address), and `grafana.<LAN_DOMAIN>`,
  lan-only), cAdvisor, node-exporter (Health's disk: `/`, `DISK_MOUNT` for another), blackbox (the public checks), and
  two one-shot jobs (`grants.sh`) that make `grafana_ro` at every start: Ghost's MySQL with
  `stacks/ghost/grafana-ro.sh --sql`'s grants, Postiz's Postgres with SELECT on `Post`, `Integration`, `Tags`,
  `TagsPosts` (each waits for all its tables: Postiz makes them one by one).
- cAdvisor mounts Docker's socket itself (Docker Desktop has none in its `/var/run`) and `/run/containerd` and
  `/run/docker/containerd` (folders, not sockets: a missing one is made empty): from 0.54 it reads containers in
  Docker's containerd image store (Docker 29's and Docker Desktop's default) through containerd, and with 0.60 its
  Docker factory doesn't register at all without that socket, so no container has a name. The socket is the system's
  at `/run/containerd/` (Docker Desktop, Docker's packages) or dockerd's own at `/run/docker/containerd/` (an engine
  that runs its own, like `docker:dind`): a `sh -c` entrypoint passes the one that's there as `--containerd`, then
  runs the image's `entrypoint.sh`; `--disable_metrics` leaves only CPU and memory (all the dashboards and alerts
  read: `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`), since its disk metrics alone held
  ~0.7 GB (measured: 690 MB -> 20 MB; a panel needing another metric must take it out of that list); node-exporter's
  `/` mount has no `rslave` (Docker Desktop refuses it).
- Kubernetes' monitoring module uses `grants.sh`, `grafana/datasources.yml` and `grafana/dashboards.yml` as they are
  (`k8s/components/monitoring/`): keep its hosts (`mysql` there via `GHOST_DB_HOST`) and env names working for both.
- `grafana/datasources.yml`: the dashboards' datasource uids (`prometheus`, `ghost-mysql`, `ghost-analytics`,
  `bridge-instagram`, `postiz-pg`), logins as `${VAR}` from Grafana's environment (Tinybird's admin token from
  tokens.env), so no secret is in a file; the panels' hosts (`tinybird-local`, `postiz-ghost-bridge`) are the kit's
  service names too, so they aren't swapped. `grafana/dashboards.yml`: the provider.
