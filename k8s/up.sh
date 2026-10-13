#!/usr/bin/env bash
# Runs a kit site (a folder kit/setup.sh made) on Kubernetes:
#   k8s/up.sh <site folder> <overlay>            render, apply, wait until everything's ready
#   k8s/up.sh <site folder> <overlay> --render   only render (data/k8s/rendered.yaml); no cluster needed
#   k8s/up.sh <site folder> --down               delete the site's namespace, its volumes with it
# Overlays: local (this Mac's k3d cluster: k8s/test/k3d.sh), selfhosted (any cluster), eks and gke (Amazon EKS, Google
# GKE: the site's values in <site>/cloud-<overlay>.env), k3d-eks and k3d-gke (those on k3d, with stand-ins for the
# cloud's databases and bucket). Moving a site's data between the NAS and a cluster: k8s/migrate/. local uses k3d's own kubeconfig
# and refuses any other cluster; the rest use kubectl's current context, after asking (--yes: don't ask).
# Each run writes the site's kustomization to <site>/data/k8s/: the overlay, a component per module in MODULES,
# ConfigMap "site" from site.env (and "ghost", Ghost's few values), a Secret per secrets/<stack>.env, the images from k8s/images/built.env
# (k8s/build-images.sh). The namespace is the site's ID_PREFIX. With monitoring, the first up asks Ghost for its
# site_uuid afterwards and runs once more (the dashboards' Tinybird queries pass it).
set -euo pipefail

K8S="$(cd "$(dirname "$0")" && pwd)"
[ $# -ge 2 ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
SITE_DIR="$(cd "$1" && pwd)"; shift
[ -f "$SITE_DIR/site.env" ] || { echo "no site.env in $SITE_DIR (kit/setup.sh makes it)" >&2; exit 1; }
val() { sed -n "s/^$1=//p" "$SITE_DIR/site.env" | tail -1; }
NS="$(val ID_PREFIX)"; [ -n "$NS" ] || { echo "site.env has no ID_PREFIX" >&2; exit 1; }
OVERLAY=; RENDER=0; DOWN=0; YES=0
for a in "$@"; do
    case "$a" in --render) RENDER=1 ;; --down) DOWN=1 ;; --yes) YES=1 ;; -*) echo "unknown $a" >&2; exit 2 ;; *) OVERLAY=$a ;; esac
done

# Which cluster: k3d's for the local overlays, else the current context after asking
cluster() {
    case "$OVERLAY" in
        local|k3d-*)
            export KUBECONFIG; KUBECONFIG="$(k3d kubeconfig write creator-kit 2>/dev/null)" \
                || { echo "no k3d cluster: k8s/test/k3d.sh up" >&2; exit 1; }
            [ "$(kubectl config current-context)" = k3d-creator-kit ] || { echo "not k3d-creator-kit" >&2; exit 1; } ;;
        *)
            local ctx; ctx="$(kubectl config current-context)"
            if [ "$YES" != 1 ]; then
                read -r -p "Apply $NS ($OVERLAY) to cluster $ctx? [y/N] " a; [ "$a" = y ] || exit 1
            fi ;;
    esac
}

if [ "$DOWN" = 1 ]; then
    [ -n "$OVERLAY" ] || OVERLAY=local
    cluster
    kubectl delete namespace "$NS" --ignore-not-found --wait=true
    # monitoring's cluster-wide part (components/monitoring/prometheus.yaml)
    kubectl delete clusterrolebinding,clusterrole "$NS-prometheus-kubelet" --ignore-not-found >/dev/null
    # the next Ghost is a new one, with its own site_uuid; the next gateway gets new keys
    rm -f "$SITE_DIR/data/k8s/ghost.env" "$SITE_DIR/data/k8s/s3.env" "$SITE_DIR/data/k8s/standins.env"
    exit 0
fi
[ -d "$K8S/overlays/$OVERLAY" ] || { echo "no overlay $OVERLAY in k8s/overlays/" >&2; exit 1; }

OUT="$SITE_DIR/data/k8s"; mkdir -p "$OUT"
[ "$RENDER" = 1 ] || cluster

# ---- live: TinyIce's mounts (the DJ's and the mp3 listeners play: its transcoder's input and output), from the
# running TinyIce's config when there is one (a rename in its admin is saved on its volume), else the site's
# (kit/setup.sh's). They name the relays' mount, their readiness check and Traefik's route; the relays' config also
# takes TinyIce's admin password and the mp3's burst size.
LIVE_SOURCE=; LIVE_MP3=
if case ",$(val MODULES)," in *,live,*) true ;; *) false ;; esac; then
    ice="$SITE_DIR/data/icecast/tinyice-data/config.json"
    [ -s "$ice" ] || { echo "no $ice (kit/setup.sh writes it)" >&2; exit 1; }
    cur="$ice"
    if [ "$RENDER" != 1 ] && (umask 077; kubectl -n "$NS" exec deploy/tinyice -c tinyice -- cat /data/config.json \
            >"$OUT/tinyice-running.json" 2>/dev/null) && [ -s "$OUT/tinyice-running.json" ]; then
        cur="$OUT/tinyice-running.json"
    fi
    mounts="$(umask 077; python3 - "$cur" "$SITE_DIR/secrets/icecast.env" "$OUT/icecast-relay.xml" <<'PY'
import json, sys
from xml.sax.saxutils import escape as x
c = json.load(open(sys.argv[1]))
env = dict(l.split("=", 1) for l in open(sys.argv[2]).read().splitlines() if "=" in l and not l.startswith("#"))
pw = x(env["TINYICE_ADMIN_PASSWORD"])
t = [t for t in c.get("transcoders") or [] if t.get("enabled", True) and t.get("format") == "mp3"]
src, mp3 = (t[0]["input_mount"], t[0]["output_mount"]) if t else ("/stream-ogg", "/stream-mp3")
burst = c.get("advanced_mounts", {}).get(mp3, {}).get("burst_size", 131072)
open(sys.argv[3], "w").write(f"""<icecast>
  <hostname>{x(c.get("hostname", "localhost"))}</hostname>
  <admin>{x(c.get("admin_email", ""))}</admin>
  <limits>
    <clients>500</clients>
    <sources>2</sources>
    <queue-size>1048576</queue-size>
    <burst-size>{burst}</burst-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
  </limits>
  <authentication>
    <source-password>{pw}</source-password>
    <relay-password>{pw}</relay-password>
    <admin-user>{x(c.get("admin_user", "admin"))}</admin-user>
    <admin-password>{pw}</admin-password>
  </authentication>
  <listen-socket><port>8080</port></listen-socket>
  <relay>
    <server>tinyice</server>
    <port>8080</port>
    <mount>{x(mp3)}</mount>
    <local-mount>{x(mp3)}</local-mount>
    <on-demand>0</on-demand>
    <relay-shoutcast-metadata>1</relay-shoutcast-metadata>
  </relay>
  <!-- How often a relay that failed is tried again (default 120 s: on a new site the relays would miss the first
       stream for two minutes; TinyIce has no mp3 mount until a DJ first connects). No master server here. -->
  <master-update-interval>5</master-update-interval>
  <fileserve>1</fileserve>
  <paths>
    <basedir>/usr/share/icecast</basedir>
    <logdir>/dev</logdir>
    <webroot>/usr/share/icecast/web</webroot>
    <adminroot>/usr/share/icecast/admin</adminroot>
    <pidfile>/tmp/icecast.pid</pidfile>
  </paths>
  <logging>
    <!-- Icecast puts logdir in front of these: /dev/stdout and /dev/stderr, so kubectl logs shows them -->
    <accesslog>stdout</accesslog>
    <errorlog>stderr</errorlog>
    <loglevel>3</loglevel>
  </logging>
  <security><chroot>0</chroot></security>
</icecast>
""")
print(src, mp3)
PY
)" || exit 1
    read -r LIVE_SOURCE LIVE_MP3 <<<"$mounts"
fi

# ---- social: Postiz's and the bridge's environment, the postiz stack's own lists rendered for the site (docker compose
# config with the profile and secrets/postiz.env, nothing from this shell), so its defaults and notes stay in one place.
# Only what differs on Kubernetes is changed: Ghost's address, and the live module's settings (as kit/kit.sh does).
SOCIAL=0
if case ",$(val MODULES)," in *,social,*) true ;; *) false ;; esac; then
    SOCIAL=1
    [ -s "$SITE_DIR/secrets/postiz.env" ] || { echo "no secrets/postiz.env (kit/setup.sh writes it)" >&2; exit 1; }
    if [ -n "$LIVE_MP3" ]; then live_env=(LIVE_MOUNT="$LIVE_SOURCE"); else live_env=(LIVE_STATS=false); fi
    # (DATA_DIR only fills in the stack's bind mounts, which Kubernetes doesn't use; the compose file requires it)
    (umask 077; env -i PATH="$PATH" HOME="$HOME" DATA_DIR="$SITE_DIR/data" "${live_env[@]}" docker compose -p "$NS" \
        -f "$K8S/../stacks/postiz/compose.yaml" --env-file "$SITE_DIR/site.env" --env-file "$SITE_DIR/secrets/postiz.env" \
        config --format json >"$OUT/postiz-compose.json") || { echo "docker compose couldn't render the postiz stack" >&2; exit 1; }
    (umask 077; python3 - "$OUT" "${LIVE_MP3:+tinyice-relay-pods}" <<'PY'
import json, sys
out, relays = sys.argv[1], sys.argv[2]
svc = json.load(open(f"{out}/postiz-compose.json"))["services"]
over = {
    "postiz": {},
    # Ghost's Service; the relays' pod addresses (a headless Service), so live shows count their listeners
    "postiz-ghost-bridge": {"GHOST_API_URL": "http://ghost:2368", "LIVE_RELAYS": relays},
}
for name, extra in over.items():
    env = {k: "" if v is None else str(v) for k, v in (svc[name].get("environment") or {}).items()}
    env.update(extra)
    bad = [k for k, v in env.items() if "\n" in v]
    if bad: sys.exit(f"{name}: a value on more than one line ({', '.join(bad)}); a Secret's env file can't hold it")
    with open(f"{out}/{name}-env.env", "w") as f:
        f.write("".join(f"{k}={v}\n" for k, v in sorted(env.items())))
PY
    ) || exit 1
    rm -f "$OUT/postiz-compose.json"
fi

# ---- monitoring: the dashboards and alert rules rendered for the site (render.py --profile cloud: the kubelet's
# numbers instead of Docker's, the relays' listeners), and Prometheus's jobs for its modules, as kit/kit.sh writes
# them for Compose. Both go into ConfigMaps (components/monitoring/).
MON=0
has() { case ",$(val MODULES)," in *",$1,"*) true ;; *) false ;; esac; }
if has monitoring; then
    MON=1
    mon="$OUT/monitoring"; mkdir -p "$mon"
    sites=(--site "$SITE_DIR/site.env" --site "$SITE_DIR/secrets/monitoring.env")
    [ -s "$OUT/ghost.env" ] && sites+=(--site "$OUT/ghost.env")   # GHOST_SITE_UUID, after the first up (below)
    python3 "$K8S/../stacks/monitoring/grafana/render.py" --profile cloud "${sites[@]}" \
        "$K8S/../stacks/monitoring/grafana/provisioning/dashboards/json" "$mon" || exit 1
    host="$(val SITE_HOST)"; live="$(val LIVE_HOST)"; live="${live:-live.$host}"
    {
        echo "# Written by k8s/up.sh at every run (edit up.sh, not this): what Prometheus reads for this site"
        echo "global: { scrape_interval: 15s, evaluation_interval: 15s }"
        echo "scrape_configs:"
        echo "  - { job_name: prometheus, static_configs: [{ targets: [localhost:9090] }] }"
        echo "  - { job_name: traefik, static_configs: [{ targets: ['traefik-metrics:8082'] }] }"
        echo "  # the kubelets, through the API server: cAdvisor's pod CPU and memory, the volumes' free space; the site's only"
        for job in cadvisor kubelet; do
            if [ $job = cadvisor ]; then path=/metrics/cadvisor; keep='container_cpu_usage_seconds_total|container_memory_working_set_bytes'
            else path=/metrics; keep='kubelet_volume_stats_(available|capacity)_bytes'; fi
            echo "  - job_name: $job"
            echo "    scheme: https"
            echo "    tls_config: { ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt }"
            echo "    authorization: { credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token }"
            echo "    kubernetes_sd_configs: [{ role: node }]"
            echo "    relabel_configs:"
            echo "      - { target_label: __address__, replacement: 'kubernetes.default.svc:443' }"
            echo "      - { source_labels: [__meta_kubernetes_node_name], target_label: __metrics_path__, replacement: '/api/v1/nodes/\${1}/proxy$path' }"
            echo "    metric_relabel_configs:"
            echo "      - { source_labels: [__name__], regex: '$keep', action: keep }"
            echo "      - { source_labels: [namespace], regex: '$NS', action: keep }"
        done
        echo "  # the public checks, once a minute (through Cloudflare when the site is behind it)"
        echo "  - job_name: blackbox-http"
        echo "    scrape_interval: 1m"
        echo "    metrics_path: /probe"
        echo "    params: { module: [http_2xx] }"
        echo "    static_configs:"
        echo "      - targets:"
        echo "          - https://$host"
        echo "          - https://$host/ghost/api/admin/site/"
        has live && echo "          - https://$live"
        echo "    relabel_configs:"
        echo "      - { source_labels: [__address__], target_label: __param_target }"
        echo "      - { source_labels: [__param_target], target_label: instance }"
        echo "      - { target_label: __address__, replacement: 'blackbox:9115' }"
        if has social; then
            echo "  # the bridge's counters (pets, link clicks, live plays, stalls, reconnects)"
            echo "  - { job_name: $NS-pets, scrape_interval: 1m, static_configs: [{ targets: ['postiz-ghost-bridge:8080'] }] }"
        fi
        if has live; then
            echo "  - job_name: tinyice"
            echo "    scrape_interval: 5s"
            echo "    static_configs: [{ targets: ['tinyice:8080'] }]"
            echo "    basic_auth: { username: '$(sed -n 's/^TINYICE_ADMIN_USER=//p' "$SITE_DIR/secrets/icecast.env")', password_file: /etc/prometheus-secrets/tinyice-password }"
            echo "  # each ready relay's own listeners (json-exporter reads its status): TinyIce counts a relay as one listener"
            echo "  - job_name: tinyice-relays"
            echo "    scrape_interval: 5s"
            echo "    metrics_path: /probe"
            echo "    params: { module: [icecast] }"
            echo "    kubernetes_sd_configs: [{ role: endpointslice, namespaces: { own_namespace: true } }]"
            echo "    relabel_configs:"
            echo "      - { source_labels: [__meta_kubernetes_service_name], regex: tinyice-relay-pods, action: keep }"
            echo "      - { source_labels: [__meta_kubernetes_endpointslice_endpoint_conditions_ready], regex: 'true', action: keep }"
            echo "      - { source_labels: [__address__], target_label: __param_target, replacement: 'http://\${1}/status-json.xsl' }"
            echo "      - { source_labels: [__meta_kubernetes_pod_name], target_label: instance }"
            echo "      - { target_label: __address__, replacement: 'json-exporter:7979' }"
            echo "    metric_relabel_configs:"
            echo "      - { source_labels: [mount], regex: 'https?://[^/]+(/.*)', target_label: mount }"
        fi
    } > "$mon/prometheus.yml"
fi

# ---- A cloud overlay's values (eks: <site>/cloud-eks.env, from its cloud.env.example; a k3d twin: the overlay's own
# cloud.k3d, the stand-ins': not a .env, which .gitignore keeps out), as ConfigMap "cloud" for its replacements.yaml and "s3" for Ghost's bucket
CLOUD=; CLOUDENV=
if [ -f "$K8S/overlays/$OVERLAY/cloud.k3d" ]; then
    CLOUDENV="$K8S/overlays/$OVERLAY/cloud.k3d"
elif [ -f "$K8S/overlays/$OVERLAY/cloud.env.example" ]; then
    CLOUDENV="$SITE_DIR/cloud-$OVERLAY.env"
    [ -s "$CLOUDENV" ] || { echo "no $CLOUDENV: copy k8s/overlays/$OVERLAY/cloud.env.example there and fill it in" >&2; exit 1; }
fi
if [ -n "$CLOUDENV" ]; then
    sed -e '/^ *#/d' -e '/^ *$/d' -e "s/{namespace}/$NS/g" "$CLOUDENV" > "$OUT/cloud.env"
    CLOUD="$(sed -n 's/^CLOUD=//p' "$OUT/cloud.env")"; CLOUD="${CLOUD:-$OVERLAY}"
    grep '^S3_' "$OUT/cloud.env" > "$OUT/s3-bucket.env" || true
fi
# ---- The k3d stand-ins (components/k3d-standins/, a k3d twin's): RDS Postgres's master login, made once per site
STANDINS=; grep -rq 'k3d-standins' "$K8S/overlays/$OVERLAY" && STANDINS=1
if [ -n "$STANDINS" ] && [ ! -s "$SITE_DIR/secrets/cloud.env" ]; then
    [ -s "$OUT/standins.env" ] || (umask 077; printf 'POSTGRES_MASTER_USER=postgres\nPOSTGRES_MASTER_PASSWORD=%s\n' \
        "$(openssl rand -hex 24)" > "$OUT/standins.env")
fi

# ---- The in-cluster S3 gateway (components/s3-gateway/: the local overlay's bucket, and the k3d stand-ins'): its one
# account, made once per site and kept with its data (a key the site's own secrets/s3.env gives wins: the clouds'
# HMAC keys, say)
S3_KEYS=
if { grep -q 'components/s3-gateway' "$K8S/overlays/$OVERLAY/kustomization.yaml" || [ -n "$STANDINS" ]; } \
        && [ ! -s "$SITE_DIR/secrets/s3.env" ]; then
    S3_KEYS="$OUT/s3.env"
    [ -s "$S3_KEYS" ] || (umask 077; printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' \
        "kit$(openssl rand -hex 8)" "$(openssl rand -hex 24)" > "$S3_KEYS")
fi

# ---- The site's kustomization
rel() { python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$1" "$OUT"; }
{
    echo "# Written by k8s/up.sh on every run (don't edit: it's replaced)."
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "namespace: $NS"
    echo "labels:"
    echo "  - pairs:"
    echo "      app.kubernetes.io/part-of: creator-kit"
    echo "resources:"
    echo "  - namespace.yaml"
    echo "  - $(rel "$K8S/overlays/$OVERLAY")"
    comps=()
    for m in $(val MODULES | tr ',' ' '); do
        [ "$m" = none ] && continue
        if [ -d "$K8S/components/$m" ]; then comps+=("$(rel "$K8S/components/$m")")
        else echo "module $m: not on Kubernetes yet, left out" >&2; fi
    done
    # the overlay's part that reaches the modules' resources too (eks: gp3, the NLB, Postgres on RDS), after them
    [ -d "$K8S/overlays/$OVERLAY/finish" ] && comps+=("$(rel "$K8S/overlays/$OVERLAY/finish")")
    if [ ${#comps[@]} -gt 0 ]; then echo "components:"; printf '  - %s\n' "${comps[@]}"; fi
    # a cloud overlay's values (ConfigMap "cloud", below), filled in after everything is in
    if [ -n "$CLOUD" ] && [ -f "$K8S/overlays/$CLOUD/replacements.yaml" ]; then
        echo "replacements:"
        echo "  - path: $(rel "$K8S/overlays/$CLOUD/replacements.yaml")"
    fi
    patches=()
    # with analytics, the bridge (its Ghost collector) and Grafana (Ghost Analytics' token) read Ghost's analytics with
    # tb-setup's tokens (tinybird__adminToken, as staging's bridge does), and wait for them like Ghost
    if has analytics; then
        tokens='[{"op": "add", "path": "/spec/template/spec/containers/0/envFrom/-", "value": {"secretRef": {"name": "tinybird-tokens"}}}]'
        [ "$SOCIAL" = 1 ] && patches+=("  - target: {kind: Deployment, name: postiz-ghost-bridge}" "    patch: '$tokens'")
        [ "$MON" = 1 ] && patches+=("  - target: {kind: Deployment, name: grafana}" "    patch: '$tokens'")
    fi
    if [ "$MON" = 1 ]; then
        # Grafana's dashboards volume: one ConfigMap per dashboard (below)
        patches+=("  - patch: |-" "      apiVersion: apps/v1" "      kind: Deployment" "      metadata: {name: grafana}"
            "      spec:" "        template:" "          spec:" "            volumes:" "              - name: dashboards"
            "                projected:" "                  sources:")
        for f in "$mon"/dashboards/*.json; do
            patches+=("                    - configMap: {name: grafana-dashboard-$(basename "$f" .json)}")
        done
        # the kubelets' ClusterRole, named after the site (one per site; --down deletes it)
        cr="$NS-prometheus-kubelet"
        patches+=("  - target: {kind: ClusterRole, name: prometheus-kubelet}"
            "    patch: '[{\"op\": \"replace\", \"path\": \"/metadata/name\", \"value\": \"$cr\"}]'"
            "  - target: {kind: ClusterRoleBinding, name: prometheus-kubelet}"
            "    patch: '[{\"op\": \"replace\", \"path\": \"/metadata/name\", \"value\": \"$cr\"}, {\"op\": \"replace\", \"path\": \"/roleRef/name\", \"value\": \"$cr\"}, {\"op\": \"replace\", \"path\": \"/subjects/0/namespace\", \"value\": \"$NS\"}]'")
    fi
    if [ ${#patches[@]} -gt 0 ]; then echo "patches:"; printf '%s\n' "${patches[@]}"; fi
    echo "configMapGenerator:"
    echo "  - name: site"
    echo "    envs: [$(rel "$SITE_DIR/site.env")]"
    # Ghost's own few values apart, so a change to the rest of site.env doesn't restart it
    echo "  - name: ghost"
    echo "    literals:"
    for key in SITE_HOST STAFF_DEVICE_VERIFICATION; do
        v="$(val $key)"; [ -n "$v" ] && echo "      - $key=$v"
    done
    # live: its mounts, for Traefik's route and the relays (components/live/)
    if [ -n "$LIVE_MP3" ]; then
        echo "  - name: live"
        echo "    literals: [LIVE_SOURCE_MOUNT=$LIVE_SOURCE, LIVE_MP3_MOUNT=$LIVE_MP3]"
    fi
    if [ -n "$CLOUD" ]; then
        echo "  - name: cloud"
        echo "    envs: [cloud.env]"
        if [ -s "$OUT/s3-bucket.env" ]; then
            echo "  - name: s3"
            echo "    envs: [s3-bucket.env]"
        fi
    fi
    # social: Postiz's name, for Traefik's routes (components/social/)
    if [ "$SOCIAL" = 1 ]; then
        echo "  - name: social"
        echo "    literals: [POSTIZ_DOMAIN=$(sed -n 's/^POSTIZ_DOMAIN=//p' "$SITE_DIR/secrets/postiz.env" | tail -1)]"
    fi
    # monitoring: the rendered dashboards (a ConfigMap each) and alert rules, Prometheus's jobs (components/monitoring/)
    if [ "$MON" = 1 ]; then
        for f in "$mon"/dashboards/*.json; do
            echo "  - name: grafana-dashboard-$(basename "$f" .json)"
            echo "    files: [monitoring/dashboards/$(basename "$f")]"
        done
        echo "  - name: grafana-alerting"
        echo "    files: [monitoring/alerting/$NS.yml]"
        echo "  - name: prometheus-config"
        echo "    files: [monitoring/prometheus.yml]"
    fi
    echo "secretGenerator:"
    for f in "$SITE_DIR"/secrets/*.env; do
        echo "  - name: $(basename "$f" .env)"
        echo "    envs: [$(rel "$f")]"
    done
    if [ -n "$S3_KEYS" ]; then
        echo "  - name: s3"
        echo "    envs: [s3.env]"
    fi
    if [ -n "$STANDINS" ] && [ -s "$OUT/standins.env" ] && [ ! -s "$SITE_DIR/secrets/cloud.env" ]; then
        echo "  - name: cloud"
        echo "    envs: [standins.env]"
    fi
    if [ -n "$LIVE_MP3" ]; then
        echo "  - name: tinyice-config"
        echo "    files: [config.json=$(rel "$ice")]"
        echo "  - name: icecast-relay-config"
        echo "    files: [icecast.xml=icecast-relay.xml]"
    fi
    if [ "$SOCIAL" = 1 ]; then
        for n in postiz-env postiz-ghost-bridge-env; do
            echo "  - name: $n"
            echo "    envs: [$n.env]"
        done
    fi
    if [ -f "$K8S/images/built.env" ]; then
        echo "images:"
        grep -v '^#' "$K8S/images/built.env" | while IFS='=' read -r name ref; do
            echo "  - name: creator-kit/$name"
            echo "    newName: ${ref%:*}"
            echo "    newTag: ${ref##*:}"
        done
    fi
} > "$OUT/kustomization.yaml"
printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n' "$NS" > "$OUT/namespace.yaml"
# it holds the Secrets: readable by you only
(umask 077; kubectl kustomize --load-restrictor LoadRestrictionsNone "$OUT" > "$OUT/rendered.yaml"); chmod 600 "$OUT/rendered.yaml"
if grep -q 'image: creator-kit/' "$OUT/rendered.yaml"; then
    echo "the kit's images aren't built: k8s/build-images.sh --registry <k3d or yours>" >&2; exit 1
fi
[ "$RENDER" = 1 ] && { echo "rendered: $OUT/rendered.yaml"; exit 0; }

# ---- Apply and wait (cluster() ran before the live mounts)
# Jobs (tb-setup) run on every up, as their Compose services do at every start: a finished Job can't be applied again
kubectl -n "$NS" delete job --all --ignore-not-found >/dev/null 2>&1 || true
# Server-side: a dashboard's ConfigMap is bigger than the 256 KiB a client-side apply's last-applied annotation holds
keep="$(kubectl apply --server-side --force-conflicts --field-manager=creator-kit-up -f "$OUT/rendered.yaml" -o name)"
# The generated ConfigMaps and Secrets get a new name when they change: remove the ones nothing uses any more
kubectl -n "$NS" get configmap,secret -l app.kubernetes.io/part-of=creator-kit -o name | while read -r r; do
    grep -qx "$r" <<<"$keep" || kubectl -n "$NS" delete "$r" >/dev/null
done
# Wait (up to 5 min) until every Job has finished and every Deployment and StatefulSet is ready, saying what it's
# waiting for every 30 s. Stops at once, with the reason, on a pod that won't get there by itself: a crash loop (with its last log lines),
# an image that can't be pulled, a config error (but not Ghost and traffic-analytics waiting for tb-setup's Secret).
state() { kubectl -n "$NS" get deployment,statefulset,job,pod -o json | python3 "$K8S/pod-state.py"; }
# 5 min: with the images pulled, a new site is ready in about 1.5 (UP_TIMEOUT=<seconds> for a first, slow pull)
LIMIT="${UP_TIMEOUT:-300}"
start=$SECONDS; said=0
while :; do
    s="$(state)"
    case "$s" in
        ready) break ;;
        stuck*)
            echo "$s" >&2
            while read -r _ pod container reason _; do
                case "$reason" in CrashLoopBackOff*)
                    echo "--- $pod/$container, its last run:" >&2
                    kubectl -n "$NS" logs "$pod" -c "$container" --previous --tail=20 >&2 2>&1 || true ;;
                esac
            done <<<"$s"
            exit 1 ;;
    esac
    if [ $((SECONDS - start)) -ge "$LIMIT" ]; then echo "gave up after $((LIMIT / 60)) min, $s" >&2; exit 1; fi
    if [ $((SECONDS - said)) -ge 30 ]; then echo "$s"; said=$SECONDS; fi
    sleep 5
done
echo "$NS is up ($OVERLAY)"

# monitoring: the dashboards' Tinybird queries and alert pass Ghost's site_uuid, which Ghost makes at its first start.
# Ask it once, and run again: the new render changes only Grafana's ConfigMaps, so only Grafana restarts.
if [ "$MON" = 1 ] && [ ! -s "$OUT/ghost.env" ]; then
    uuid="$(kubectl -n "$NS" exec deploy/traefik -- wget -qO- --header 'X-Forwarded-Proto: https' \
        http://ghost:2368/ghost/api/admin/site/ 2>/dev/null |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["site"].get("site_uuid") or "")' 2>/dev/null)" || true
    if [ -n "$uuid" ]; then
        echo "GHOST_SITE_UUID=$uuid" > "$OUT/ghost.env"
        echo "dashboards: this Ghost's site_uuid is $uuid; once more for Grafana"
        exec "$0" "$SITE_DIR" "$OVERLAY" --yes
    fi
    echo "Ghost didn't say its site_uuid; the Tinybird panels stay empty until the next up" >&2
fi
