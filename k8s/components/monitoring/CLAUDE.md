# k8s/components/monitoring/

The site's own Grafana and Prometheus on Kubernetes (the dashboards and alert rules themselves: `stacks/monitoring/grafana/CLAUDE.md`). The other components: `k8s/components/CLAUDE.md`; `up.sh` and the rest: `k8s/CLAUDE.md`.

Module `monitoring`: Grafana 13.2.3 (Deployment, Recreate, PVC; the Infinity plugin;
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
