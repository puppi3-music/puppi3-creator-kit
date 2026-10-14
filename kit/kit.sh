#!/usr/bin/env bash
# Runs one kit site: docker compose on kit/compose.yaml with the site folder's profile, secrets and data.
#   kit/kit.sh <site folder> up -d        (any docker compose command: ps, logs -f ghost, down, config ...)
# The site folder (kit/setup.sh makes it):
#   site.env          the instance profile (instances/example.env filled in)
#   secrets/*.env     each stack's secrets (traefik, puppi3, postiz, icecast, monitoring)
#   data/             everything the site keeps (DATA_DIR), Traefik's dynamic/ files among it
# Profiles come from the profile's MODULES. Every run copies the kit's Traefik files into data/traefik/dynamic/ as
# kit-*.yml (a site's own routes go beside them, under other names) and, with monitoring, writes Prometheus's config and
# renders the dashboards and alert rules for the site (data/monitoring/). A first `up` starts tb-setup alone first: compose
# reads Tinybird's tokens (tb-setup writes them) only when it creates a container, so Ghost waits for them.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$KIT")"
[ $# -ge 2 ] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
SITE_DIR="$(cd "$1" && pwd)"; shift
[ -f "$SITE_DIR/site.env" ] || { echo "kit.sh: no site.env in $SITE_DIR (make the site with kit/setup.sh)" >&2; exit 1; }

# The profile's values this script needs (compose reads the whole file itself)
val() { sed -n "s/^$1=//p" "$SITE_DIR/site.env" | tail -1; }
ID_PREFIX="$(val ID_PREFIX)"; MODULES="$(val MODULES)"
[ -n "$ID_PREFIX" ] || { echo "kit.sh: set ID_PREFIX in site.env" >&2; exit 1; }

export SITE_DIR DATA_DIR="$SITE_DIR/data"
args=(-p "$ID_PREFIX" -f "$KIT/compose.yaml" --env-file "$SITE_DIR/site.env")
# down: every module's containers, also those of a module switched off since they were made
for m in analytics social live monitoring; do
    case ",$MODULES,:$1" in *",$m,"*|*:down) args+=(--profile "$m") ;; esac
done
# Phone notifications: site.env's NTFY_URL for the bridge too (the shell's value wins over secrets/postiz.env's)
export NTFY_URL="$(val NTFY_URL)"

# Live off: the bridge stops asking TinyIce for shows (stacks/postiz/compose.yaml's LIVE_STATS; the shell's value wins
# over site.env's).
# Live on: the bridge's LIVE_MOUNT is the source mount in TinyIce's config (its transcoder's input), so a rename there
# (config.json or TinyIce's admin, which writes the same file) carries over at the next run
case ",$MODULES," in
    *,live,*)
        ice="$DATA_DIR/icecast/tinyice-data/config.json"
        if [ -f "$ice" ]; then
            # (on Linux it's TinyIce's user's, 600: a container reads it when this user can't)
            LIVE_MOUNT="$({ cat "$ice" 2>/dev/null || docker run --rm -v "$(dirname "$ice"):/d:ro" alpine cat /d/config.json 2>/dev/null; } |
                python3 -c 'import json,sys; t=[t for t in json.load(sys.stdin).get("transcoders") or []
if t.get("enabled", True) and t.get("format") == "mp3"]; print(t[0]["input_mount"] if t else "")' 2>/dev/null)"
            [ -n "$LIVE_MOUNT" ] && export LIVE_MOUNT
        fi ;;
    *) export LIVE_STATS=false ;;
esac

# Traefik's dynamic files: the kit's, refreshed every run (staging's and the NAS's own stay out)
dyn="$DATA_DIR/traefik/dynamic"
mkdir -p "$dyn"
cp "$REPO/stacks/traefik/dynamic/puppi3.yml" "$dyn/kit-site.yml"
for f in cloudflare-only real-ip page-hit-country; do cp "$REPO/stacks/traefik/dynamic/$f.yml" "$dyn/kit-$f.yml"; done

# Monitoring: Prometheus's jobs for the site's modules, and the dashboards and alert rules rendered for the site
if case ",$MODULES," in *,monitoring,*) true ;; *) false ;; esac; then
    has() { case ",$MODULES," in *",$1,"*) true ;; *) false ;; esac; }
    host="$(val SITE_HOST)"; live="$(val LIVE_HOST)"; live="${live:-live.$host}"
    mon="$DATA_DIR/monitoring"
    mkdir -p "$mon/prometheus/data" "$mon/grafana/data" "$mon/grafana/rendered"
    prom_before="$(cksum < "$mon/prometheus/prometheus.yml" 2>/dev/null || true)"
    {
        echo "# Written by kit/kit.sh at every run (edit kit.sh, not this): what Prometheus reads for this site"
        echo "global: { scrape_interval: 15s, evaluation_interval: 15s }"
        echo "scrape_configs:"
        echo "  - { job_name: prometheus, static_configs: [{ targets: [localhost:9090] }] }"
        echo "  - { job_name: node, static_configs: [{ targets: ['node-exporter:9100'], labels: { instance: $ID_PREFIX } }] }"
        echo "  - { job_name: cadvisor, static_configs: [{ targets: ['cadvisor:8080'] }] }"
        echo "  - { job_name: traefik, static_configs: [{ targets: ['traefik:8082'] }] }"
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
            echo "  - { job_name: $ID_PREFIX-pets, scrape_interval: 1m, static_configs: [{ targets: ['postiz-ghost-bridge:8080'] }] }"
        fi
        if has live; then
            echo "  - job_name: tinyice"
            echo "    scrape_interval: 5s"
            echo "    static_configs: [{ targets: ['tinyice:8080'] }]"
            echo "    basic_auth: { username: '$(sed -n 's/^TINYICE_ADMIN_USER=//p' "$SITE_DIR/secrets/icecast.env")', password_file: /etc/prometheus/tinyice-password }"
        fi
    } > "$mon/prometheus/prometheus.yml"
    # Grafana reads its alert rules only when it starts: a change (a module switched off, NTFY_URL) restarts it below
    alerts_sum() { { cat "$mon/grafana/rendered/alerting/"*.yml 2>/dev/null || true; } | cksum; }
    alerts_before="$(alerts_sum)"
    render() {
        local sites=(--site "$SITE_DIR/site.env" --site "$SITE_DIR/secrets/monitoring.env")
        [ -s "$mon/ghost.env" ] && sites+=(--site "$mon/ghost.env")   # GHOST_SITE_UUID, below
        python3 "$REPO/stacks/monitoring/grafana/render.py" --profile kit "${sites[@]}" \
            "$REPO/stacks/monitoring/grafana/provisioning/dashboards/json" "$mon/grafana/rendered"
    }
    render
fi

# One kit site per Docker host: these containers have fixed names (the stacks reach each other by them), and Traefik
# and TinyIce take the host's ports. Another site's or another program's container by one of these names stops here.
if [ "${1:-}" = up ]; then
    for name in traefik tinyice postiz postiz-ghost-bridge postiz-postgres postiz-redis; do
        owner="$(docker container inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$name" 2>/dev/null)" || continue
        [ "$owner" = "$ID_PREFIX" ] && continue
        echo "kit.sh: a container named $name is already on this machine (${owner:+Compose project $owner}${owner:-not from Compose})." >&2
        echo "  A kit site needs it for its own: one kit site per Docker host. Stop or rename that one first" >&2
        echo "  (docker ps -a --filter name=$name), then run this again." >&2
        exit 1
    done
fi
# The shared networks the stacks expect (on the NAS, made once by hand). Made here with a label; one that was there
# already belongs to something else, whose containers can then reach this site's services: said once, at each up.
for n in proxy monitoring; do
    if ! docker network inspect "$n" >/dev/null 2>&1; then
        docker network create --label "creatorkit.site=$ID_PREFIX" "$n" >/dev/null
    elif [ "${1:-}" = up ] && [ -z "$(docker network inspect -f '{{ index .Labels "creatorkit.site" }}' "$n")" ]; then
        echo "kit.sh: note: the Docker network $n was already here (not made by the kit); this site joins it." >&2
    fi
done

compose() { docker compose "${args[@]}" "$@"; }
# A module switched off since its containers were made: up leaves them running (Compose skips services outside the
# active profiles), so they're stopped and removed here first, with their anonymous volumes (the data stays in data/)
if [ "${1:-}" = up ]; then
    every=(-p "$ID_PREFIX" -f "$KIT/compose.yaml" --env-file "$SITE_DIR/site.env"
           --profile analytics --profile social --profile live --profile monitoring)
    on_now="$(docker compose "${args[@]}" config --services 2>/dev/null)"
    off=()
    for svc in $(docker compose "${every[@]}" ps -a --services 2>/dev/null); do
        grep -qx "$svc" <<<"$on_now" || off+=("$svc")
    done
    if [ ${#off[@]} -gt 0 ]; then
        echo "kit.sh: removing what switched-off modules left running: ${off[*]}"
        docker compose "${every[@]}" rm -s -f -v "${off[@]}" >/dev/null 2>&1
    fi
fi
# The Tinybird panels and alert pass Ghost's site_uuid, which Ghost makes at its first start: after an `up`, ask it
# (once), render again, and restart the site's Grafana (the kit's own, never puppi3's) so it reads the alert rules again
site_uuid() {
    [ "${1:-}" = up ] && [ -n "${mon:-}" ] && [ ! -s "$mon/ghost.env" ] || return 0
    local uuid="" i
    for i in $(seq 1 60); do
        uuid="$(docker exec traefik wget -qO- --header 'X-Forwarded-Proto: https' \
            "http://$ID_PREFIX-ghost:2368/ghost/api/admin/site/" 2>/dev/null |
            python3 -c 'import json,sys; print(json.load(sys.stdin)["site"].get("site_uuid") or "")' 2>/dev/null)" || true
        [ -n "$uuid" ] && break
        sleep 5
    done
    [ -n "$uuid" ] || { echo "kit.sh: Ghost didn't say its site_uuid; the Tinybird panels stay empty until the next up" >&2; return 0; }
    echo "GHOST_SITE_UUID=$uuid" > "$mon/ghost.env"
    render
    docker restart "$ID_PREFIX-grafana" >/dev/null && restarted=1 && echo "kit.sh: dashboards now read this Ghost's analytics (site_uuid $uuid)"
}
if [ "${1:-}" = up ] && [ ! -s "$DATA_DIR/puppi3/tinybird/tokens.env" ] && case ",$MODULES," in *,analytics,*) true ;; *) false ;; esac; then
    # First start with analytics: Tinybird and tb-setup first, then the rest once its tokens are written, so Ghost is
    # created with them. (Recreating Ghost for them afterwards could stop it in its first migrations, leaving
    # Ghost's migration lock taken.)
    tokens="$DATA_DIR/puppi3/tinybird/tokens.env"
    compose up -d tb-setup
    echo "kit.sh: waiting for tb-setup to write Tinybird's tokens..."
    for _ in $(seq 1 90); do [ -s "$tokens" ] && break; sleep 2; done
    [ -s "$tokens" ] || { echo "kit.sh: no tokens after 3 minutes; see: kit/kit.sh $SITE_DIR logs tb-setup" >&2; exit 1; }
    compose "$@"
else
    compose "$@"
fi
site_uuid "$@"
# Prometheus's jobs changed (a module on or off): it reads its config again
if [ "${1:-}" = up ] && [ -n "${mon:-}" ] && [ "$(cksum < "$mon/prometheus/prometheus.yml")" != "${prom_before:-}" ] &&
    [ "$(docker inspect -f '{{.State.Running}}' "$ID_PREFIX-prometheus" 2>/dev/null)" = true ]; then
    docker kill -s HUP "$ID_PREFIX-prometheus" >/dev/null && echo "kit.sh: Prometheus reloaded its jobs"
fi
# The alert rules changed since the last run (and the site_uuid step didn't just restart Grafana): Grafana reads them again
if [ "${1:-}" = up ] && [ -n "${mon:-}" ] && [ -n "${alerts_before:-}" ] && [ "$(alerts_sum)" != "$alerts_before" ] && [ -z "${restarted:-}" ] &&
    [ "$(docker inspect -f '{{.State.Running}}' "$ID_PREFIX-grafana" 2>/dev/null)" = true ]; then
    docker restart "$ID_PREFIX-grafana" >/dev/null && echo "kit.sh: Grafana restarted to read the changed alert rules"
fi
