#!/usr/bin/env bash
# The Kubernetes kit's test, on this Mac's k3d cluster (k8s/test/k3d.sh), never a real one: makes a throwaway site
# (kit/sites/k8s-test, kit.test, ID_PREFIX kittest, the modules that are on Kubernetes so far) with kit/setup.sh, builds the kit's images into k3d's registry,
# runs it with k8s/up.sh local, checks it end to end, and removes it (and the cluster, if the test made it).
#   k8s/test/test.sh [--keep] [--overlay local|k3d-eks|k3d-gke] [--migrate]
#   k8s/test/test.sh --render-only   only the first checks below (every overlay renders and validates, the twins'
#     diff), with no cluster and the images k8s/images/built.env names already: about a minute
#     --keep: leave the site and cluster up (k8s/up.sh kit/sites/k8s-test --down removes it)
#     --overlay: which setup runs (default local); every overlay is rendered and validated either way, and each k3d
#     twin's render compared with its cloud's (test/twin-diff.py: only the stand-ins may differ)
#     --migrate: then the migration round trip (k8s/migrate/): the site moved to a NAS (the same site on Compose on
#     Docker Desktop, kit/sites/k8s-test-nas, reached through a fake ssh and sudo) and from there into the other
#     twin (k3d-gke after k3d-eks, else k3d-eks), about 8 minutes more
# Needs Docker Desktop with 12 GB of memory or more, ports 9080, 9443, 8222 and 5111 free (if the cluster isn't up yet), k3d, kubeconform and ffmpeg (brew install k3d
# kubeconform ffmpeg).
# Checks:
#   - every overlay renders and kubeconform validates it (the clouds' with their example cloud.env); a k3d twin
#     differs from its cloud's overlay only by the stand-ins
#   - k3d-eks: MySQL and Postgres through the eks overlay's aliases of the database stand-ins, Postiz's and Temporal's
#     logins made by its Job, every volume on gp3
#   - k3d-gke: MySQL and Postgres through each pod's Cloud SQL proxy (the forwarder standing in), no Services for them,
#     the Jobs with a proxy finishing, Postiz's and Temporal's logins made, every volume on standard-rwo
#   - Cloudflare-only: a visitor from outside Cloudflare's ranges gets 403; from a trusted address the site loads
#     through Traefik (https on its own certificate: TLS_RESOLVER=self); with BEHIND_CLOUDFLARE=false, from anywhere
#   - Traefik runs its own image, the kit's plugins (a ConfigMap) load, no router or middleware in error, the dashboard on
#     traefik.<LAN_DOMAIN>
#   - Ghost's mail settings from the site's secrets/ghost-mail.env
#   - Ghost with the kit's theme (uploaded through the Admin API) and a post; killing the Ghost and MySQL pods brings
#     them back with the theme, its settings and the post
#   - a change to the profile that isn't Ghost's (BEHIND_CLOUDFLARE) leaves the Ghost pod running
#   - Ghost's files in a bucket (the local overlay's in-cluster S3 gateway): an uploaded image, sound and file land in
#     it under content/images|media|files/ (the NAS's layout), none on Ghost's volume; Ghost serves them at the
#     site's own /content/... addresses (same bytes, a resized image made and kept in the bucket, byte ranges for
#     players); a post stores the image as __GHOST_URL__/content/..., as on the NAS; served still after a new Ghost pod
#   - analytics: tb-setup's tokens in a Secret, Ghost started with them; Tinybird trimmed (no MCP or Kafka server,
#     no CSV worker); a page hit through Traefik reaches Tinybird
#     with page-hit-country's country; Ghost Admin's GET-only stats route answers, Tinybird's other API doesn't
#   - live: ffmpeg streams Ogg to TinyIce's port like the streaming software; /live-status.json shows it; a listener through
#     Traefik gets the 320 kbps mp3 from a relay, and it's the tone; the source drops out and reconnects with another tone,
#     which the relays carry; a relay pod killed doesn't stop listening; TinyIce's admin 403 on the public name, open on
#     tinyice.<LAN_DOMAIN>
#   - both mounts renamed in the running TinyIce's config (as its admin would): k8s/up.sh takes the new names, a stream
#     to the new source mount reaches listeners of the new mp3 mount, from a relay
#   - social: Postiz through Traefik on postiz.<SITE_HOST>; the webhook, the theme's clicks and the social preview
#     reach the bridge; the bridge has Tinybird's tokens; with listeners on the relays, its live shows count the
#     listeners, not the relays; a new bridge pod keeps its data
#   - monitoring: Grafana on grafana.<SITE_HOST> (Cloudflare-only) and grafana.<LAN_DOMAIN>, every dashboard
#     rendered with render.py --profile cloud in the site's folder, no panel naming a datasource Grafana lacks, a real
#     query through each datasource (grafana_ro on MySQL and Postgres, Tinybird with this Ghost's site_uuid, which
#     up.sh asked Ghost for, the bridge, Prometheus with every job up), Health's pod memory by workload and its disk
#     tile from the volumes, a blackbox probe, the alert rules; with one listener on a relay, Health's listeners say 1;
#     a render with live off leaves its panels out
#   - no puppi3 in the cluster's names
#   - --migrate: to-nas.sh, with the NAS's password through sudo, brings Ghost's database (the posts), the bucket's
#     files (the same bytes), the theme, the bridge's data, TinyIce's renamed mounts, Tinybird's data and
#     Prometheus's samples onto the NAS, every count the same; after up.sh --down and a fresh up.sh of the other
#     twin, to-cloud.sh brings them all back: the same posts, site_uuid and theme, the picture served from the new
#     bucket, every page hit in Tinybird, the renamed mounts in up.sh's ConfigMap, the bridge's data, samples older
#     than the new Prometheus, Postiz answering and grafana_ro reading Ghost's database again
set -uo pipefail

K8S="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$K8S")"
KIT="$REPO/kit"
# the fake NAS (Compose, --migrate) builds the bridge from this repo's code, as the cluster's images are built here
export KIT_BUILD=1
S="$KIT/sites/k8s-test"
N="$KIT/sites/k8s-test-nas"
KEEP=0; OVERLAY=local; MIGRATE=0; RENDER_ONLY=0
while [ $# -gt 0 ]; do
    case "$1" in --keep) KEEP=1 ;; --overlay) OVERLAY="${2:?--overlay local|k3d-eks|k3d-gke}"; shift ;; --migrate) MIGRATE=1 ;; --render-only) RENDER_ONLY=1 ;;
        *) echo "unknown $1" >&2; exit 2 ;; esac
    shift
done
[ -f "$K8S/overlays/$OVERLAY/kustomization.yaml" ] && case "$OVERLAY" in local|k3d-*) true ;; *) false ;; esac \
    || { echo "--overlay: local or a k3d twin (k3d-eks, k3d-gke)" >&2; exit 2; }
SP="${TMPDIR:-/tmp}/k8s-test.$$"; mkdir -p "$SP"

fails=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
die()  { echo "k8s/test/test.sh: $*" >&2; exit 1; }
wait_for() { local what=$1 n=$2; shift 2; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 2; done; fail "$what (gave up waiting)"; return 1; }

[ "$(uname)" = Darwin ] || die "this test is for the Mac's Docker Desktop"
[ -e "$S" ] && die "$S is already there (a kept test site?): k8s/up.sh $S --down && rm -rf $S"
[ "$MIGRATE" = 0 ] || [ ! -e "$N" ] || die "$N is already there (a kept test NAS?): kit/kit.sh $N down -v && rm -rf $N"
command -v k3d >/dev/null && command -v kubeconform >/dev/null || die "needs k3d and kubeconform (brew install k3d kubeconform)"
command -v ffmpeg >/dev/null || die "needs ffmpeg (brew install ffmpeg)"
# analytics, live and social together use ~8 GiB plus k3s's own: in Docker Desktop's default 8 GB the VM runs out
# (processes killed under their own limits, the API server stalling)
mem=$(( $(docker info --format '{{.MemTotal}}') / 1073741824 ))
[ "$RENDER_ONLY" = 1 ] || [ "$mem" -ge 11 ] || die "Docker Desktop has ${mem} GiB; give it 12 GB or more (Settings > Resources > Memory)"
made_cluster=0
cleanup() { rm -rf "$S" "$SP"; }
if [ "$RENDER_ONLY" = 1 ]; then
    :   # renders with the images built last (k8s/images/built.env), or without one this version's published ones
else
    if ! k3d cluster list -o json | grep -q '"name": *"creator-kit"'; then
        for port in 9080 9443 5111; do lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && die "port $port is in use"; done
        made_cluster=1
    fi
    "$K8S/test/k3d.sh" up >/dev/null || die "k3d.sh up failed"   # makes it, or makes its StorageClasses again
    export KUBECONFIG; KUBECONFIG="$(k3d kubeconfig write creator-kit)"
    [ "$(kubectl config current-context)" = k3d-creator-kit ] || die "not the k3d cluster"

    cleanup() {
        pkill -f "icecast://source:.*@127.0.0.1:8222/" 2>/dev/null
        if [ "$KEEP" = 1 ]; then echo "kept: $S (k8s/up.sh $S --down && rm -rf $S; k8s/test/k3d.sh down)"
            [ ! -d "$N" ] || [ "$MIGRATE" = 0 ] || echo "kept: $N (kit/kit.sh $N down -v && rm -rf $N)"
        else
            "$K8S/up.sh" "$S" --down >/dev/null 2>&1
            rm -rf "$S"
            if [ "$MIGRATE" = 1 ] && [ -d "$N" ]; then "$KIT/kit.sh" "$N" down -v >/dev/null 2>&1; rm -rf "$N"; fi
            [ "$made_cluster" = 1 ] && "$K8S/test/k3d.sh" down >/dev/null
        fi
        rm -rf "$SP"
    }
fi
trap cleanup EXIT

R=(--connect-to kit.test:443:127.0.0.1:9443 --connect-to live.kit.test:443:127.0.0.1:9443
   --connect-to postiz.kit.test:443:127.0.0.1:9443 --connect-to grafana.kit.test:443:127.0.0.1:9443
   --connect-to grafana.localhost:80:127.0.0.1:9080
   --connect-to traefik.localhost:80:127.0.0.1:9080 -k -s)
CF=(-H 'CF-Connecting-IP: 203.0.113.7' -H 'CF-IPCountry: CA')
code() { curl "${R[@]}" -o /dev/null -w '%{http_code}' "$@"; }
profile() { sed -i '' "s|^$1=.*|$1=$2|" "$S/site.env"; }
up() { "$K8S/up.sh" "$S" "$OVERLAY" >"$SP/up.log" 2>&1 || { tail -20 "$SP/up.log"; fail "k8s/up.sh"; return 1; }; }
k() { kubectl -n kittest "$@"; }

# ---- The site
echo "== setup, images, render"
SITE_HOST=kit.test SITE_NAME="Kit Test" ID_PREFIX=kittest TLS_RESOLVER=self BEHIND_CLOUDFLARE=true MODULES=analytics,live,social,monitoring \
    ACME_EMAIL=kit@example.com NTFY_URL= "$KIT/setup.sh" "$S" --yes >/dev/null || die "setup.sh failed"
echo "STAFF_DEVICE_VERIFICATION=false" >> "$S/site.env"
# Ghost's mail settings (k8s/base/ghost.yaml: Secret ghost-mail, optional)
printf 'mail__from=kit@example.com\n' > "$S/secrets/ghost-mail.env"
[ "$RENDER_ONLY" = 1 ] || "$K8S/build-images.sh" --registry k3d >"$SP/build.log" 2>&1 || { cat "$SP/build.log"; die "build-images.sh failed"; }
for o in "$K8S"/overlays/*/; do
    o="$(basename "$o")"
    # a cloud's overlay renders with its example values
    [ -f "$K8S/overlays/$o/cloud.env.example" ] && cp "$K8S/overlays/$o/cloud.env.example" "$S/cloud-$o.env"
    "$K8S/up.sh" "$S" "$o" --render >/dev/null 2>"$SP/render.err" \
        && kubeconform -strict -kubernetes-version 1.35.0 "$S/data/k8s/rendered.yaml" >"$SP/kc.log" 2>&1 \
        && ok "overlay $o renders and validates" || { cat "$SP/render.err" "$SP/kc.log"; fail "overlay $o renders and validates"; }
    cp "$S/data/k8s/rendered.yaml" "$SP/render-$o.yaml" 2>/dev/null
done
for t in "$K8S"/overlays/k3d-*/; do
    t="$(basename "$t")"; c="$(sed -n 's/^CLOUD=//p' "$K8S/overlays/$t/cloud.k3d")"
    python3 "$K8S/test/twin-diff.py" "$SP/render-$c.yaml" "$SP/render-$t.yaml" >"$SP/twin.txt" 2>&1 \
        && ok "$t differs from $c only by the stand-ins" || { cat "$SP/twin.txt"; fail "$t differs from $c only by the stand-ins"; }
done
check "Ghost takes its mail settings from secrets/ghost-mail.env" grep -q 'name: ghost-mail-' "$SP/render-local.yaml"
if [ "$RENDER_ONLY" = 1 ]; then
    if [ "$fails" = 0 ]; then echo "all passed (render only)"; else echo "$fails failed"; fi
    exit $(( fails > 0 ? 2 : 0 ))
fi

echo "== start"
up || die "k8s/up.sh $OVERLAY failed"
echo "(overlay $OVERLAY)"
# Ghost's MySQL: the in-cluster one, or (a cloud's twin) the stand-in the overlay reaches
MYSQL=mysql; [ "$OVERLAY" = local ] || MYSQL=standin-mysql
sc_bound() { [ -z "$(k get pvc -o jsonpath='{range .items[*]}{.spec.storageClassName} {.status.phase}{"\n"}{end}' | grep -v "^$1 Bound$")" ]; }
if [ "$OVERLAY" != local ]; then
    check "the in-cluster Postgres StatefulSets aren't there" eval '! k get statefulset postiz-postgres postiz-temporal-postgres >/dev/null 2>&1'
    check "the postgres-logins Job made Postiz's and Temporal's logins on the stand-in" eval '[ "$(k get job postgres-logins -o jsonpath="{.status.succeeded}")" = 1 ] && k logs job/postgres-logins -c logins | grep -q "logins are ready"'
fi
if [ "$OVERLAY" = k3d-eks ]; then
    check "MySQL and Postgres are aliases of the stand-ins" eval '[ "$(k get svc mysql postiz-postgres postiz-temporal-postgres -o jsonpath="{.items[*].spec.externalName}")" = "standin-mysql.kittest.svc.cluster.local standin-postgres.kittest.svc.cluster.local standin-postgres.kittest.svc.cluster.local" ]'
    check "every volume is on gp3, and bound" sc_bound gp3
fi
if [ "$OVERLAY" = k3d-gke ]; then
    # every pod with a database has the proxy (here the forwarder) as a native sidecar, its first init container
    proxied() { [ "$(k get deploy,job -o jsonpath='{range .items[*]}{.metadata.name} {.spec.template.spec.initContainers[0].name}/{.spec.template.spec.initContainers[0].restartPolicy}{"\n"}{end}' \
        | awk '$2 == "cloud-sql-proxy/Always" {print $1}' | sort | tr '\n' ' ')" \
        = "ghost grafana grafana-ro-ghost grafana-ro-postiz postgres-logins postiz postiz-ghost-bridge postiz-temporal " ]; }
    check "Ghost, Grafana, Postiz, Temporal, the bridge and the database Jobs each have a Cloud SQL proxy, started first" proxied
    check "...no Services for MySQL or Postgres: the pods reach them on 127.0.0.1" eval '! k get svc mysql postiz-postgres postiz-temporal-postgres >/dev/null 2>&1 && [ "$(k exec deploy/ghost -c ghost -- node -e "require(\"dns\").lookup(\"mysql\",(e,a)=>console.log(a))")" = 127.0.0.1 ]'
    check "...the Jobs with a proxy finish (the sidecar stops with them)" eval '[ "$(k get job grafana-ro-ghost grafana-ro-postiz postgres-logins -o jsonpath="{.items[*].status.succeeded}")" = "1 1 1" ]'
    check "...the bridge reads Postiz's database through its proxy" eval 'k exec deploy/postiz-ghost-bridge -c bridge -- node -e "require(\"net\").connect(5432,\"postiz-postgres\").on(\"connect\",()=>process.exit(0)).on(\"error\",()=>process.exit(1))"'
    check "every volume is on standard-rwo, and bound" sc_bound standard-rwo
fi
check "Traefik runs its own image (the kit's plugins from a ConfigMap)" grep -q "image: traefik:v" "$S/data/k8s/rendered.yaml"

echo "== Cloudflare-only"
check "a visitor from outside Cloudflare gets 403" [ "$(code "${CF[@]}" https://kit.test/)" = 403 ]
# Where this Mac's requests come from inside the cluster (the load balancer's and pods' private addresses), trusted
profile TRUSTED_EXTRA "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
up
site_cf() { [ "$(code "${CF[@]}" https://kit.test/)" = 200 ]; }
wait_for "the site loads through Traefik from a trusted address" 30 site_cf && ok "the site loads through Traefik from a trusted address"

echo "== Traefik"
api() { curl "${R[@]}" "http://traefik.localhost/api/http/$1"; }
check "the dashboard answers on traefik.<LAN_DOMAIN>" [ "$(code http://traefik.localhost/dashboard/)" = 200 ]
errs="$(for t in routers middlewares services; do api $t | python3 -c "import json,sys; [print(r['name']) for r in json.load(sys.stdin) if r['status'] != 'enabled']"; done)"
check "no router, middleware or service in error${errs:+ ($errs)}" [ -z "$errs" ]
check "the plugins load (real-ip, page-hit-country)" [ "$(api middlewares | grep -o '"\(real-ip\|page-hit-country\)@file"' | sort -u | wc -l | tr -d ' ')" = 2 ]

# ---- Ghost: owner, the kit's theme, a post (Admin API with a session, as Ghost Admin does)
echo "== Ghost and the kit's theme"
JAR="$SP/cookies"; API=https://kit.test/ghost/api/admin
admin() { local m=$1 p=$2; shift 2; curl "${R[@]}" "${CF[@]}" -b "$JAR" -c "$JAR" -H 'Origin: https://kit.test' \
    -H 'Accept-Version: v6.0' -X "$m" "$API$p" "$@"; }
admin POST /authentication/setup/ -H 'Content-Type: application/json' \
    -d '{"setup":[{"name":"Kit Test","email":"kit@example.com","password":"kit-test-site-1!","blogTitle":"Kit Test"}]}' >/dev/null
admin POST /session/ -H 'Content-Type: application/json' -d '{"username":"kit@example.com","password":"kit-test-site-1!"}' >/dev/null
"$KIT/theme-zip.sh" >"$SP/zip.log" 2>&1 || { tail -5 "$SP/zip.log"; die "theme-zip.sh failed"; }
admin POST /themes/upload/ -F "file=@$KIT/dist/puppi3-creator-kit-theme.zip" >/dev/null
admin PUT /themes/puppi3-creator-kit-theme/activate/ >/dev/null
active() { admin GET /themes/ | python3 -c "import json,sys; print([t['name'] for t in json.load(sys.stdin)['themes'] if t['active']][0])" 2>/dev/null; }
check "the kit's theme is active (uploaded zip)" [ "$(active)" = puppi3-creator-kit-theme ]
check "...and Ghost has its mail settings" [ "$(k exec deploy/ghost -c ghost -- printenv mail__from)" = kit@example.com ]
admin POST /posts/ -H 'Content-Type: application/json' \
    -d '{"posts":[{"title":"A cluster post","status":"published"}]}' >/dev/null
front() { curl "${R[@]}" "${CF[@]}" https://kit.test/; }
has_post() { front | grep -q 'A cluster post'; }
in_theme() { has_post && front | grep -q 'assets/kit/'; }
wait_for "the front page shows the post, in the kit's theme" 15 in_theme && ok "the front page shows the post, in the kit's theme"

echo "== Ghost's files in the bucket"
# a busy picture (resizing it makes it smaller), a sound, a file
ffmpeg -nostdin -loglevel error -y -f lavfi -i mandelbrot=size=1600x900 -frames:v 1 "$SP/pic.jpg"
ffmpeg -nostdin -loglevel error -y -f lavfi -i "sine=frequency=440" -t 3 -c:a libmp3lame "$SP/tone.mp3"
echo "a file for the bucket" >"$SP/note.txt"
url() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'][0]['url'])" 2>/dev/null; }
img="$(admin POST /images/upload/ -F "file=@$SP/pic.jpg;type=image/jpeg" -F purpose=image | url images)"
snd="$(admin POST /media/upload/ -F "file=@$SP/tone.mp3;type=audio/mpeg" | url media)"
doc="$(admin POST /files/upload/ -F "file=@$SP/note.txt;type=text/plain" | url files)"
check "uploads get the site's own addresses ($img)" eval '[[ "$img $snd $doc" =~ ^https://kit.test/content/images/.+\ https://kit.test/content/media/.+\ https://kit.test/content/files/.+$ ]]'
in_bucket() { k exec s3-0 -c versitygw -- test -s "/data/ghost-content/${1#https://kit.test/}"; }
check "...and land in the bucket under content/images, media and files" eval 'in_bucket "$img" && in_bucket "$snd" && in_bucket "$doc"'
check "...not on Ghost's volume" eval '[ -z "$(k exec deploy/ghost -c ghost -- find /var/lib/ghost/content/images /var/lib/ghost/content/media /var/lib/ghost/content/files -type f 2>/dev/null)" ]'
get() { curl "${R[@]}" "${CF[@]}" -o "$2" -w '%{http_code}' "${@:3}" "$1"; }
# what the bucket holds (Ghost re-encodes an uploaded picture, so that's the one to compare with)
from_bucket() { k exec s3-0 -c versitygw -- cat "/data/ghost-content/${1#https://kit.test/}" >"$2"; }
served() { from_bucket "$1" "$SP/bucket.bin" && [ "$(get "$1" "$SP/served.bin")" = 200 ] && cmp -s "$SP/bucket.bin" "$SP/served.bin"; }
check "Ghost serves them through Traefik, the bucket's bytes" eval 'served "$img" && served "$snd" && served "$doc" && cmp -s "$SP/served.bin" "$SP/note.txt"'
w600="$(sed 's|/content/images/|/content/images/size/w600/|' <<<"$img")"
width() { ffprobe -v error -show_entries stream=width -of csv=p=0 "$1" 2>/dev/null; }
check "a resized image (size/w600) is made, $(get "$w600" "$SP/w600.jpg") $(width "$SP/w600.jpg") px wide" eval '[ "$(width "$SP/w600.jpg")" = 600 ] && in_bucket "$w600"'
check "players get byte ranges of a sound (206)" eval '[ "$(get "$snd" "$SP/part.bin" -H "Range: bytes=0-99")" = 206 ] && [ "$(wc -c <"$SP/part.bin" | tr -d " ")" = 100 ]'
admin POST /posts/ -H 'Content-Type: application/json' \
    -d "{\"posts\":[{\"title\":\"A post with a picture\",\"status\":\"published\",\"feature_image\":\"$img\"}]}" >/dev/null
DBN="$(sed -n 's/^database__connection__database=//p' "$S/secrets/ghost.env")"
stored="$(k exec "$MYSQL-0" -- sh -c "mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -N -e \"SELECT feature_image FROM \\\`$DBN\\\`.posts WHERE title = 'A post with a picture'\"" 2>/dev/null)"
check "a post keeps it as ${stored:-nothing} (as on the NAS: the files can move either way)" eval '[ "$stored" = "__GHOST_URL__${img#https://kit.test}" ]'

echo "== analytics"
check "tb-setup saved Tinybird's tokens as a Secret" [ "$(k get secret tinybird-tokens -o jsonpath='{.data}' | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")" = 3 ]
check "Ghost started with them, never restarted" [ "$(k get pod -l app=ghost -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}')" = 0 ]
tb_trimmed() { local p; p="$(k exec tinybird-local-0 -- ps -eo args)" || return 1
  grep -q 'tinybird_server --port 8001 --config /tmp/kit/settings.py' <<<"$p" && ! grep -q 'tinybird.mcp\|tbakafka\|csv_worker' <<<"$p"; }
check "Tinybird trimmed: no MCP or Kafka server, no CSV worker" tb_trimmed
tok() { k get secret tinybird-tokens -o jsonpath="{.data.$1}" | base64 -d; }
site_uuid="$(admin GET /site/ | python3 -c "import json,sys; print(json.load(sys.stdin)['site']['site_uuid'])")"
# A page hit as Ghost's tracker sends it (JavaScript's toISOString: traffic-analytics refuses microseconds), from a browser that says UTC (no country): page-hit-country adds CA
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
hit="$(python3 -c "
import json, sys, uuid, datetime
u, s = sys.argv[1:]
print(json.dumps({'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
  'action': 'page_hit', 'version': '1', 'session_id': str(uuid.uuid4()),
  'payload': {'user-agent': u, 'locale': 'en-US', 'location': None, 'pathname': '/', 'href': 'https://kit.test/',
    'site_uuid': s, 'post_uuid': 'undefined', 'post_type': 'null', 'member_uuid': 'undefined', 'member_status': 'undefined'}}))" "$UA" "$site_uuid")"
hit_code="$(code "${CF[@]}" -X POST -A "$UA" -H 'Content-Type: application/json' -H "x-site-uuid: $site_uuid" \
    -H 'Referer: https://kit.test/' --data "$hit" \
    "https://kit.test/.ghost/analytics/api/v1/page_hit?name=analytics_events&token=$(tok TINYBIRD_TRACKER_TOKEN)")"
check "traffic-analytics takes a page hit through Traefik ($hit_code)" [ "${hit_code:0:1}" = 2 ]
tb() { k exec tinybird-local-0 -- curl -s -H "Authorization: Bearer $(tok tinybird__adminToken)" --data-urlencode "q=$1" http://localhost:7181/v0/sql; }
hit_ok() { tb "SELECT count() FROM analytics_events WHERE JSONExtractString(payload, 'location') = 'CA' FORMAT TSV" | grep -qv '^0$'; }
wait_for "a page hit with country CA in Tinybird" 20 hit_ok && ok "the page hit reached Tinybird, country CA from page-hit-country"
stats="https://kit.test/.ghost/stats/v0/pipes/api_kpis.json?site_uuid=$site_uuid&date_from=2026-01-01&date_to=2030-01-01&token=$(tok tinybird__adminToken)"
check "Ghost Admin's charts reach Tinybird (GET /.ghost/stats/v0/pipes/)" [ "$(code "${CF[@]}" "$stats")" = 200 ]
check "Tinybird's other API isn't reachable from outside" [ "$(code "${CF[@]}" "https://kit.test/.ghost/stats/v0/tokens?token=$(tok tinybird__adminToken)")" != 200 ]

echo "== social"
bridge() { k exec deploy/postiz-ghost-bridge -c bridge -- "$@"; }
postiz_up() { c="$(code "${CF[@]}" https://postiz.kit.test/)"; [ "${c:0:1}" = 2 ] || [ "${c:0:1}" = 3 ]; }
check "Postiz answers through Traefik on postiz.<SITE_HOST> ($(code "${CF[@]}" https://postiz.kit.test/))" postiz_up
# (this Mac's addresses are trusted by now, so Cloudflare-only shows in the routers, not as a 403)
cf_routers() { api routers | python3 -c 'import json,sys; r={x["name"]: x for x in json.load(sys.stdin)}
sys.exit(not all("cloudflare-only@file" in r.get(n, {}).get("middlewares", []) for n in ("postiz@file", "postiz-ghost-bridge@file", "kittest-social-preview@file")))'; }
check "...and its routes, the webhook's and the social preview's are Cloudflare-only" cf_routers
check "Ghost's webhook reaches the bridge (unsigned: 401)" [ "$(code "${CF[@]}" -X POST -d '{}' https://postiz.kit.test/ghost-webhook)" = 401 ]
check "the theme's clicks reach the bridge" [ "$(code "${CF[@]}" -X POST "https://kit.test/.site/click?kind=out&to=https%3A%2F%2Fexample.com%2F&from=%2F")" = 204 ]
preview() { curl "${R[@]}" "${CF[@]}" https://kit.test/ghost/social-preview/00000000-0000-0000-0000-000000000000/; }
check "the social preview route reaches the bridge (off without an Admin API key)" eval 'preview | grep -q "Social previews are off"'
check "the bridge has Tinybird's tokens" eval '[ -n "$(bridge printenv tinybird__adminToken)" ]'

echo "== monitoring"
GP="$(sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' "$S/secrets/monitoring.env")"
g() { local p=$1; shift; curl "${R[@]}" -u "admin:$GP" "http://grafana.localhost$p" "$@"; }
M="$S/data/k8s/monitoring"
graf_up() { g /api/health | grep -q '"database": *"ok"'; }
wait_for "Grafana answers on grafana.<LAN_DOMAIN>" 60 graf_up && ok "Grafana answers on grafana.<LAN_DOMAIN>"
check "...and on grafana.<SITE_HOST> ($(code "${CF[@]}" https://grafana.kit.test/login))" [ "$(code "${CF[@]}" https://grafana.kit.test/login)" = 200 ]
cf_grafana() { api routers | python3 -c 'import json,sys; r={x["name"]: x for x in json.load(sys.stdin)}
sys.exit("cloudflare-only@file" not in r.get("grafana@file", {}).get("middlewares", []))'; }
check "...Cloudflare-only" cf_grafana
dash_ok() { g '/api/search?type=dash-db' | python3 -c "
import json,sys,glob
got={d['uid']: d.get('folderTitle') for d in json.load(sys.stdin)}
want={json.load(open(f)).get('uid') or json.load(open(f))['metadata']['name'] for f in glob.glob('$M/dashboards/*.json')}
sys.exit(0 if len(want) == 10 and set(got) == want and set(got.values()) == {'Kit Test'} else 1)"; }
wait_for "every rendered dashboard is in Grafana's Kit Test folder" 30 dash_ok && ok "all 10 rendered dashboards are in Grafana, folder Kit Test"
g /api/datasources >"$SP/ds.json"
python3 - "$M/dashboards" "$SP/ds.json" >"$SP/ds-missing.txt" <<'PY2'
import json, sys, pathlib
have = {d["uid"] for d in json.load(open(sys.argv[2]))} | {"-- Grafana --", "-- Mixed --", "-- Dashboard --", "__expr__"}
def walk(v, acc):
    if isinstance(v, dict):
        ds = v.get("datasource")
        if isinstance(ds, dict):
            u = ds.get("uid") or ds.get("name")
            if u and not str(u).startswith("$"):
                acc.add(u)
        for x in v.values():
            walk(x, acc)
    elif isinstance(v, list):
        for x in v:
            walk(x, acc)
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.json")):
    used = set()
    walk(json.load(open(f)), used)
    for u in sorted(used - have):
        print(f"{f.name}: {u}")
PY2
check "no panel names a datasource Grafana doesn't have" [ ! -s "$SP/ds-missing.txt" ] || cat "$SP/ds-missing.txt"
# a real query through each datasource, as a panel asks
q() { g /api/ds/query -H 'Content-Type: application/json' -d "{\"from\":\"now-1h\",\"to\":\"now\",\"queries\":[$1]}"; }
# the answer's first value (the first frame's last field's first value), or ERROR
first() { python3 -c "
import json,sys
r=json.load(sys.stdin)['results']['A']
if r.get('error'): print('ERROR', r['error']); sys.exit()
fr=r.get('frames') or [{}]; f=fr[0].get('data', {}).get('values') or []
print(f[-1][0] if f and f[-1] else '')" 2>/dev/null || echo ERROR; }
has_val() { [ -n "$1" ] && [ "${1#ERROR}" = "$1" ]; }
sql() { q "{\"refId\":\"A\",\"datasource\":{\"uid\":\"$1\"},\"format\":\"table\",\"rawQuery\":true,\"rawSql\":\"$2\"}" | first; }
posts_n() { v="$(sql ghost-mysql 'SELECT COUNT(*) AS n FROM posts')"; [ "${v%%.*}" -ge 2 ] 2>/dev/null; }
wait_for "Ghost's MySQL through grafana_ro (the posts)" 60 posts_n && ok "Ghost's MySQL answers through grafana_ro"
pz_ok() { has_val "$(sql postiz-pg 'SELECT COUNT(*) AS n FROM \"Integration\"')"; }
wait_for "Postiz's Postgres through grafana_ro" 60 pz_ok && ok "Postiz's Postgres answers through grafana_ro"
inf() { q "{\"refId\":\"A\",\"datasource\":{\"uid\":\"$1\"},\"type\":\"json\",\"source\":\"url\",\"format\":\"table\",\"parser\":\"backend\",\"url\":\"$2\",\"url_options\":{\"method\":\"GET\",\"data\":\"\"},\"root_selector\":\"$3\"}" | first; }
uuid="$(sed -n 's/^GHOST_SITE_UUID=//p' "$S/data/k8s/ghost.env" 2>/dev/null)"
check "up.sh gave the dashboards this Ghost's site_uuid" bash -c "[ '$uuid' = '$site_uuid' ] && grep -q '$uuid' '$M/dashboards/3-traffic.json'"
today="$(date -u +%Y-%m-%d)"
visits() { v="$(inf ghost-analytics "http://tinybird-local:7181/v0/pipes/api_kpis.json?site_uuid=$uuid&timezone=Etc/UTC&date_from=$today&date_to=$today" '$sum(data.pageviews)')"; [ "${v%%.*}" -ge 1 ] 2>/dev/null; }
wait_for "Ghost Analytics (Tinybird) counts today's page views for this site" 30 visits && ok "Ghost Analytics counts today's page views for this site"
outs() { v="$(inf bridge-instagram http://postiz-ghost-bridge:8080/clicks.json 'totals.out')"; [ "${v%%.*}" -ge 1 ] 2>/dev/null; }
wait_for "the bridge datasource reads clicks.json (the click above)" 10 outs && ok "the bridge datasource reads clicks.json"
prom() { q "{\"refId\":\"A\",\"datasource\":{\"uid\":\"prometheus\"},\"expr\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"),\"instant\":true,\"range\":false}"; }
jobs="kittest-pets|traefik|tinyice|tinyice-relays|cadvisor|kubelet|blackbox-http"
jobs_up() { [ "$(prom "count(count by (job) (up{job=~\"$jobs\"} == 1))" | first)" = 7 ]; }
wait_for "Prometheus: every job up ($jobs)" 45 jobs_up && ok "Prometheus scrapes every job: ${jobs//|/, }"
# a panel's own query, from the rendered dashboard (by title)
panel() { python3 - "$M/dashboards/$1" "$2" <<'PY2'
import json, sys
def walk(ps):
    for p in ps:
        yield p
        yield from walk(p.get("panels", []))
for p in walk(json.load(open(sys.argv[1]))["panels"]):
    if p.get("title") == sys.argv[2]:
        print(p["targets"][0]["expr"]); break
PY2
}
# the series' names (label "name") and values of an instant query
series() { prom "$1" | python3 -c "
import json,sys
for f in json.load(sys.stdin)['results']['A'].get('frames', []):
    v=f['data']['values']; n=(f['schema']['fields'][-1].get('labels') or {}).get('name', '')
    print(n, v[-1][0] if v and v[-1] else '')"; }
pods_ok() { series "$(panel 2-health.json 'Container memory')" >"$SP/pods.txt"
    for w in ghost "$MYSQL" tinyice tinyice-relay tinybird-local postiz-ghost-bridge grafana; do grep -q "^$w " "$SP/pods.txt" || return 1; done; }
wait_for "Health's pod memory, by workload" 30 pods_ok && ok "Health's pod memory names the workloads ($(cut -d' ' -f1 "$SP/pods.txt" | sort | tr '\n' ' '))"
disk_ok() { v="$(series "$(panel 2-health.json 'Disk free (the fullest volume)')" | awk '{print $NF}')"; python3 -c "import sys; sys.exit(not 0 < float('${v:-x}') < 1)" 2>/dev/null; }
wait_for "Health's disk tile reads the volumes" 30 disk_ok && ok "Health's disk tile reads the site's volumes"
probe() { has_val "$(prom 'probe_success{instance="https://kit.test"}' | first)"; }
wait_for "blackbox checks the site" 45 probe && ok "blackbox checks the site (it can't reach kit.test from inside: no DNS)"
want_rules="$(sed -n "/^groups:/,\$p" "$M/alerting/kittest.yml" | grep -c "^      - uid:")"
rules_ok() { g /api/v1/provisioning/alert-rules | python3 -c "
import json,sys; r=json.load(sys.stdin)
sys.exit(0 if len(r) == $want_rules and all(x['labels'].get('project') == 'kittest' for x in r) else 1)"; }
wait_for "Grafana has the site's $want_rules alert rules" 15 rules_ok && ok "Grafana has the site's $want_rules alert rules (project=kittest)"
sed -e 's/^MODULES=.*/MODULES=analytics,social,monitoring/' "$S/site.env" >"$SP/off.env"
python3 "$REPO/stacks/monitoring/grafana/render.py" --profile cloud --site "$SP/off.env" --site "$S/secrets/monitoring.env" \
    "$REPO/stacks/monitoring/grafana/provisioning/dashboards/json" "$SP/off" >/dev/null 2>&1
# (the rules only: deleteRules at the end names the dropped ones on purpose, so Grafana removes them)
check "a render with live off leaves out its panels and rules" eval '! grep -lE "tinyice_|icecast_relay" "$SP"/off/dashboards/*.json && ! sed "/^deleteRules:/,\$d" "$SP"/off/alerting/*.yml | grep -qE "tinyice_|icecast_relay|live-down"'

echo "== live stream"
# A source like the streaming software's: Ogg straight to TinyIce's own port (8222), never through Traefik
src() { pw="$(sed -n 's/^TINYICE_SOURCE_PASSWORD=//p' "$S/secrets/icecast.env")"
    ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=$1:sample_rate=44100" -t 300 -ac 2 -c:a vorbis \
        -strict -2 -content_type audio/ogg -metadata artist=Kit -metadata title="$2" -f ogg \
        "icecast://source:$pw@127.0.0.1:8222/stream-ogg" >>"$SP/ffmpeg.log" 2>&1 & }
stop_src() { pkill -f "icecast://source:.*@127.0.0.1:8222/" 2>/dev/null; }
status_has() { curl "${R[@]}" "${CF[@]}" https://kit.test/live-status.json | grep -q "$1"; }
listen() { curl "${R[@]}" "${CF[@]}" --max-time 6 -o "$SP/$1.mp3" https://live.kit.test/stream-mp3; }
# the tone's pitch from its zero crossings (two a cycle), and how loud it is
pitch() { ffmpeg -nostdin -ss 3 -t 2 -i "$SP/$1.mp3" -af astats=metadata=1 -f null - 2>&1 \
    | sed -n 's/.*Zero crossings rate: \([0-9.]*\).*/\1/p' | head -1 | awk '{printf "%d", $1 * 44100 / 2}'; }
loud() { ffmpeg -nostdin -i "$SP/$1.mp3" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \([-0-9.]*\) dB/\1/p'; }
near() { [ -n "$1" ] && [ "$1" -gt $(($2 - 20)) ] && [ "$1" -lt $(($2 + 20)) ]; }
relay_hits_at() { for p in $(k get pod -l app=tinyice-relay -o name); do k logs "$p"; done | grep -c "GET $1 "; }
relay_hits() { relay_hits_at /stream-mp3; }
src 440 "First Tone"
wait_for "/live-status.json shows the stream and its track" 15 status_has 'Kit - First Tone' && ok "/live-status.json shows the stream and its track"
# the relays pick the stream up within seconds (they retry every 5 s); a player would retry too
# (curl's 6 s cap always ends a stream with "timed out", so the file is what counts)
mp3() { listen "$1"; [ "$(ffprobe -v error -show_entries stream=bit_rate -of csv=p=0 "$SP/$1.mp3" 2>/dev/null)" = 320000 ]; }
before="$(relay_hits)"
wait_for "a listener through Traefik gets the mp3 (320 kbps)" 10 mp3 first && ok "a listener through Traefik gets the mp3 (320 kbps)"
check "...from a relay, not the main TinyIce" [ "$(relay_hits)" -gt "$before" ]
l="$(loud first)"
p1="$(pitch first)"
tone() { near "$p1" 440 && [ "${l%.*}" -gt -40 ]; }
check "...and it's the tone, not silence (${p1} Hz, ${l} dB)" tone
# the source drops out and comes back: the relays carry the new stream
stop_src; sleep 15; src 880 "Second Tone"
wait_for "the new track shows" 15 status_has 'Kit - Second Tone'
wait_for "the relays carry the reconnected stream" 10 mp3 second
p2="$(pitch second)"
check "after the source reconnects, listeners hear the new stream through the relays (${p2} Hz)" near "$p2" 880
# One listener on a relay, for a minute: the bridge's live shows (every 30 s) count 1, not the relays (each is a
# listener on the main TinyIce)
curl "${R[@]}" "${CF[@]}" --max-time 60 -o /dev/null https://live.kit.test/stream-mp3 & lpid=$!
now_listening() { bridge wget -qO- http://localhost:8080/live.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["listenersNow"])' 2>/dev/null; }
one() { [ "$(now_listening)" = "live 1" ]; }
wait_for "the bridge's live shows count the relays' listener" 25 one && ok "the bridge's live shows count the relays' listener, not the relays"
health_one() { [ "$(series "$(panel 2-health.json 'Listeners now')" | awk '{print $NF}')" = 1 ]; }
wait_for "Health's listeners say 1" 10 health_one && ok "Health's listeners say 1 (TinyIce sees $(prom 'sum(tinyice_listeners_total)' | first): the relays)"
kill "$lpid" 2>/dev/null; wait "$lpid" 2>/dev/null
# A relay gone: the other one serves, and it comes back
k delete pod "$(k get pod -l app=tinyice-relay -o jsonpath='{.items[0].metadata.name}')" --wait=false >/dev/null
# (for a moment the Service may still pick the pod going away; a player tries again, so this does too)
third() { mp3 third && near "$(pitch third)" 880; }
wait_for "with a relay pod killed, listening still works" 5 third && ok "with a relay pod killed, listening still works"
k rollout status deploy/tinyice-relay --timeout=120s >/dev/null && ok "the relay comes back" || fail "the relay comes back"
stop_src
check "TinyIce's admin is closed on the public name" [ "$(code "${CF[@]}" https://live.kit.test/admin)" = 403 ]
check "...and answers on tinyice.<LAN_DOMAIN>" [ "$(code --connect-to tinyice.localhost:80:127.0.0.1:9080 http://tinyice.localhost/)" = 200 ]

echo "== live mounts renamed (as in TinyIce's admin)"
# TinyIce's own config, on its volume, with both mounts renamed; then TinyIce restarted and k8s/up.sh run again,
# which reads the running config: the relays, their readiness and Traefik's route follow
k exec deploy/tinyice -c tinyice -- cat /data/config.json | python3 -c '
import json, sys
c = json.load(sys.stdin)
ren = {"/stream-ogg": "/dj-input.ogg", "/stream-mp3": "/live.mp3"}
for key in ("mounts", "advanced_mounts"):
    c[key] = {ren.get(m, m): v for m, v in (c.get(key) or {}).items()}
for t in c.get("transcoders") or []:
    t["input_mount"], t["output_mount"] = ren.get(t["input_mount"], t["input_mount"]), ren.get(t["output_mount"], t["output_mount"])
print(json.dumps(c, indent=2))' >"$SP/renamed.json"
k exec -i deploy/tinyice -c tinyice -- sh -c 'cat > /data/config.json' <"$SP/renamed.json"
k delete pod -l app=tinyice --wait=true >/dev/null
k rollout status deploy/tinyice --timeout=120s >/dev/null
up
check "k8s/up.sh took the names from the running TinyIce" [ "$(k get configmap -l app.kubernetes.io/part-of=creator-kit -o json | python3 -c "
import json, sys
for c in json.load(sys.stdin)['items']:
    if c['metadata']['name'].startswith('live-'): print(c['data']['LIVE_SOURCE_MOUNT'], c['data']['LIVE_MP3_MOUNT'])")" = "/dj-input.ogg /live.mp3" ]
src_at() { pw="$(sed -n 's/^TINYICE_SOURCE_PASSWORD=//p' "$S/secrets/icecast.env")"
    ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=660:sample_rate=44100" -t 300 -ac 2 -c:a vorbis \
        -strict -2 -content_type audio/ogg -metadata artist=Kit -metadata title="Renamed" -f ogg \
        "icecast://source:$pw@127.0.0.1:8222$1" >>"$SP/ffmpeg.log" 2>&1 & }
src_at /dj-input.ogg
wait_for "/live-status.json shows the renamed mount" 15 status_has 'dj-input.ogg'
renamed() { curl "${R[@]}" "${CF[@]}" --max-time 6 -o "$SP/renamed.mp3" https://live.kit.test/live.mp3
    [ "$(ffprobe -v error -show_entries stream=bit_rate -of csv=p=0 "$SP/renamed.mp3" 2>/dev/null)" = 320000 ]; }
before="$(relay_hits_at /live.mp3)"
wait_for "a listener gets the renamed mp3" 10 renamed && ok "a listener gets the renamed mp3, /live.mp3 (320 kbps)"
check "...from a relay" [ "$(relay_hits_at /live.mp3)" -gt "$before" ]
p3="$(pitch renamed)"
check "...and it's the new stream (${p3} Hz)" near "$p3" 660
stop_src

echo "== pods come back with their data"
survived() { [ "$(active)" = puppi3-creator-kit-theme ] && has_post; }
relogin() { admin POST /session/ -H 'Content-Type: application/json' -d '{"username":"kit@example.com","password":"kit-test-site-1!"}' >/dev/null; }
k delete pod -l app=ghost --wait=false >/dev/null
sleep 5; k rollout status deploy/ghost --timeout=300s >/dev/null
wait_for "Ghost answers again" 30 site_cf
relogin
check "a new Ghost pod keeps the theme and the post" survived
check "...and serves the image from the bucket" served "$img"
k delete pod "$MYSQL-0" >/dev/null
k rollout status "statefulset/$MYSQL" --timeout=300s >/dev/null
wait_for "Ghost reaches the new MySQL pod" 60 has_post
# Ghost's pool drops its connections to the old pod only as they fail: the first requests may error
back() { relogin; survived; }
wait_for "a new MySQL pod keeps the post and the settings" 15 back && ok "a new MySQL pod keeps the post and the settings"
# the bridge's history (live.json from the stream above, stats.db) on its volume
k delete pod -l app=postiz-ghost-bridge >/dev/null
k rollout status deploy/postiz-ghost-bridge --timeout=300s >/dev/null
check "a new bridge pod keeps its data" eval 'bridge test -s /data/live.json'

echo "== names"
check "no puppi3 in the cluster's names" [ -z "$(k get all,configmap,secret,pvc -o name | grep -i puppi3)" ]
check "no puppi3 in router names" [ -z "$(api routers | grep -io '"name":"[^"]*puppi3[^"]*"')" ]

echo "== BEHIND_CLOUDFLARE=false"
ghost_pod="$(k get pod -l app=ghost -o name)"
profile BEHIND_CLOUDFLARE false; profile TRUSTED_EXTRA none
up
site_open() { [ "$(code https://kit.test/)" = 200 ]; }
wait_for "the site loads with no Cloudflare headers" 30 site_open && ok "the site loads with no Cloudflare headers"
check "a change to Traefik's settings leaves Ghost running" [ "$(k get pod -l app=ghost -o name)" = "$ghost_pod" ]

if [ "$MIGRATE" = 1 ]; then
    case "$OVERLAY" in k3d-eks) OTHER=k3d-gke ;; *) OTHER=k3d-eks ;; esac
    echo "== migration: $OVERLAY -> a NAS (Compose on Docker Desktop) -> $OTHER"
    # The NAS: this site's profile, secrets and setup files as a Compose site; its databases and Prometheus running,
    # the rest made but stopped. Reached as fake-nas: through a fake ssh, and a sudo that wants the password (which
    # comes from a fake Keychain): the stream after it must reach the command untouched.
    mkdir -p "$N" "$SP/bin"
    # the NAS's Ghost the cluster's version (to-nas.sh refuses a database to an older Ghost: it can't migrate down)
    docker pull -q "$(sed -n 's/^ *image: \(ghost:[^ ]*\).*/\1/p' "$K8S/base/ghost.yaml")" >/dev/null
    cp -R "$S/site.env" "$S/secrets" "$N/"
    rsync -a --exclude /k8s "$S/data/" "$N/data/"
    # (kit.sh would otherwise start Tinybird for its tokens, and wait for Ghost's site_uuid)
    echo "tinybird__workspaceId=none" >"$N/data/ghost/tinybird/tokens.env"
    mkdir -p "$N/data/monitoring"; echo "GHOST_SITE_UUID=none" >"$N/data/monitoring/ghost.env"
    { "$KIT/kit.sh" "$N" up -d --no-deps db postiz-postgres postiz-temporal-postgres prometheus \
        && "$KIT/kit.sh" "$N" up --no-start --no-deps ghost tinybird-local traffic-analytics postiz postiz-temporal \
            postiz-ghost-bridge tinyice; } >"$SP/nas.log" 2>&1 || { tail -20 "$SP/nas.log"; die "the test NAS didn't start"; }
    cat >"$SP/bin/ssh" <<'EOF'
#!/bin/bash
# fake ssh: the command runs here
while [ $# -gt 0 ]; do case "$1" in -o|-p|-i|-l) shift 2 ;; -O) exit 0 ;; -f|-N|-fN) master=1; shift ;; -*) shift ;; *) break ;; esac; done
[ -z "${master:-}" ] || exit 0
shift; exec bash -c "$*"
EOF
    cat >"$SP/bin/sudo" <<'EOF'
#!/bin/bash
# fake sudo: always wants the password (-S: one line of stdin; the rest is the command's)
while :; do case "$1" in -k) shift ;; -S) S=1; shift ;; -n) exit 1 ;; -p) shift 2 ;; *) break ;; esac; done
[ -n "${S:-}" ] || exit 1
IFS= read -r pw; [ "$pw" = "$FAKE_NAS_PW" ] || { echo "sudo: wrong password" >&2; exit 1; }
echo "$1" >>"$FAKE_NAS_LOG"
exec "$@"
EOF
    printf '#!/bin/sh\necho "$FAKE_NAS_PW"\n' >"$SP/bin/security"
    chmod +x "$SP/bin/"*
    nas_env=(env PATH="$SP/bin:$PATH" FAKE_NAS_PW="a password; with 'quotes'" FAKE_NAS_LOG="$SP/sudo.log")
    nsql() { docker exec kittest-db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N "$1" -e "$2"' sh "$DBN" "$1"; }
    for _ in $(seq 1 60); do nsql 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done

    # What leaves: the posts, the picture's bytes, site_uuid, the page hits
    titles() { admin GET '/posts/?limit=all&fields=title' | python3 -c 'import json,sys; print("|".join(sorted(p["title"] for p in json.load(sys.stdin)["posts"])))'; }
    t0="$(titles)"; get "$img" "$SP/img-before.bin" >/dev/null
    hits() { tb "SELECT count() FROM analytics_events FORMAT TSV"; }
    h0="$(hits)"
    echo "(leaving: posts $t0; $h0 page hits; site_uuid $site_uuid)"

    "${nas_env[@]}" "$K8S/migrate/to-nas.sh" "$S" "$OVERLAY" --to "fake-nas:$N/data" -y --no-start >"$SP/to-nas.log" 2>&1
    rc=$?; [ "$rc" = 0 ] || tail -30 "$SP/to-nas.log"
    check "to-nas.sh: done, every count the same on both sides (exit $rc)" [ "$rc" = 0 ]
    check "...each NAS command through sudo, with the password ($(wc -l <"$SP/sudo.log" | tr -d ' ') calls)" [ -s "$SP/sudo.log" ]
    nas_titles="$(nsql "SELECT title FROM posts WHERE type = 'post'" | sort | paste -sd'|' -)"
    check "the NAS's MySQL has the posts ($nas_titles)" [ "$nas_titles" = "$t0" ]
    check "...the bucket's picture, the same bytes" cmp -s "$SP/img-before.bin" "$N/data/ghost/ghost/content/${img#https://kit.test/content/}"
    check "...the kit's theme" [ -s "$N/data/ghost/ghost/content/themes/puppi3-creator-kit-theme/package.json" ]
    check "...TinyIce's config with the renamed mounts" grep -q '/dj-input.ogg' "$N/data/icecast/tinyice-data/config.json"
    check "...the bridge's data" [ -s "$N/data/postiz/ghost-bridge/data/live.json" ]
    check "...what the NAS had, kept aside" eval 'ls "$N/data/.migrate-backups/"*/"$DBN.sql.gz" >/dev/null'
    nas_prom_ms="$(python3 -c 'import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1][:26].rstrip("Z")).replace(tzinfo=datetime.timezone.utc).timestamp()*1000))' \
        "$(docker inspect -f '{{.State.StartedAt}}' kittest-prometheus)")"
    older_samples() { "$@" promtool tsdb dump-openmetrics --max-time="$older_than" '--match={job="kittest-pets"}' /prometheus 2>/dev/null | grep -vc '^#'; }
    older_than="$nas_prom_ms"; n="$(older_samples docker exec kittest-prometheus)"
    check "...and Prometheus's pets samples from before it started ($n)" [ "${n:-0}" -gt 0 ]

    # A new cluster site, the other twin: everything comes back from the NAS
    [ "$rc" = 0 ] || { echo "(to-nas.sh failed: the way back isn't tried; see $SP/to-nas.log)"; KEEP=1; exit 2; }
    "$K8S/up.sh" "$S" --down >/dev/null 2>&1
    OVERLAY="$OTHER"; MYSQL=standin-mysql
    up || die "k8s/up.sh $OVERLAY failed"
    "${nas_env[@]}" "$K8S/migrate/to-cloud.sh" "$S" "$OVERLAY" --from "fake-nas:$N/data" -y >"$SP/to-cloud.log" 2>&1
    rc=$?; [ "$rc" = 0 ] || tail -30 "$SP/to-cloud.log"
    check "to-cloud.sh into $OVERLAY: done, every count the same (exit $rc)" [ "$rc" = 0 ]
    rm -f "$JAR"; relogin
    check "the same posts" [ "$(titles)" = "$t0" ]
    check "the same Ghost (site_uuid), which up.sh asked for again" eval '[ "$(admin GET /site/ | python3 -c "import json,sys; print(json.load(sys.stdin)[\"site\"][\"site_uuid\"])")" = "$site_uuid" ] && grep -q "$site_uuid" "$S/data/k8s/ghost.env"'
    check "the kit's theme active" [ "$(active)" = puppi3-creator-kit-theme ]
    check "the picture served from the new bucket, the same bytes" eval '[ "$(get "$img" "$SP/img-after.bin")" = 200 ] && cmp -s "$SP/img-before.bin" "$SP/img-after.bin"'
    h1="$(hits)"
    check "every page hit in Tinybird ($h0 -> $h1)" [ "$h1" = "$h0" ]
    check "up.sh took TinyIce's renamed mounts from the config that came across" [ "$(k get configmap -l app.kubernetes.io/part-of=creator-kit -o json | python3 -c "
import json, sys
for c in json.load(sys.stdin)['items']:
    if c['metadata']['name'].startswith('live-'): print(c['data']['LIVE_SOURCE_MOUNT'], c['data']['LIVE_MP3_MOUNT'])")" = "/dj-input.ogg /live.mp3" ]
    check "the bridge's data" bridge test -s /data/live.json
    older_than="$(python3 -c 'import datetime,sys; print(int(datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()*1000))' \
        "$(k get pvc data-prometheus-0 -o jsonpath='{.metadata.creationTimestamp}')")"
    n="$(older_samples k exec prometheus-0 -c prometheus --)"
    check "Prometheus's pets samples from before this cluster's ($n)" [ "${n:-0}" -gt 0 ]
    wait_for "Postiz answers" 30 postiz_up && ok "Postiz answers on its database that came across"
    check "grafana_ro reads Ghost's database again" posts_n
fi

echo
if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; KEEP=1; fi
exit $(( fails > 0 ? 2 : 0 ))
