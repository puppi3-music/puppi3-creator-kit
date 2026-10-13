#!/usr/bin/env bash
# The kit's demo site, for the README's screenshots: a throwaway site on this Mac (Docker Desktop), never anywhere
# else. It makes kit/sites/demo (demo.test, "Night Owl Radio", ID_PREFIX demo) with kit/setup.sh, fills it with made-up
# posts (pictures drawn by ffmpeg), members, music links, a month of visits in Ghost's analytics and a live stream, then
# takes the screenshots in a muted browser (shots.mjs) into kit/docs/images/, and removes the site.
#   kit/demo/demo.sh            (--keep: leave the site running: kit/kit.sh kit/sites/demo down -v removes it)
# Needs ports 80, 443 and 8222 free (LIVE_PORT=<another> for the stream's, e.g. beside the k3d test cluster), ffmpeg, cwebp and kit/theme-test's npm install (Playwright).
# Nothing in it is real: every name, address and number is made up here.
set -uo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
S="$KIT/sites/demo"
OUT="$KIT/docs/images"
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
SP="${TMPDIR:-/tmp}/kit-demo.$$"; mkdir -p "$SP"
die() { echo "kit/demo: $*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "this is for the Mac's Docker Desktop"
[ -e "$S" ] && die "$S is already there: kit/kit.sh $S down -v && rm -rf $S"
for t in ffmpeg cwebp; do command -v $t >/dev/null || die "needs $t (brew install ffmpeg webp)"; done
[ -d "$KIT/theme-test/node_modules/playwright" ] || die "needs Playwright: (cd kit/theme-test && npm install)"
LP="${LIVE_PORT:-8222}"
for port in 80 443 "$LP"; do
    lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && die "port $port is in use"
done
nets_before="$(docker network ls --format '{{.Name}}' | grep -xE 'proxy|monitoring' || true)"

cleanup() {
    pkill -f "icecast://source:.*@127.0.0.1:$LP/stream-ogg" 2>/dev/null
    if [ "$KEEP" = 1 ]; then echo "kept: $S (kit/kit.sh $S down -v && rm -rf $S)"; else
        "$KIT/kit.sh" "$S" down -v --remove-orphans >/dev/null 2>&1
        rm -rf "$S"
        for n in proxy monitoring; do
            grep -qx "$n" <<<"$nets_before" || docker network rm "$n" >/dev/null 2>&1
        done
    fi
    rm -rf "$SP"
}
trap cleanup EXIT

R=(--resolve demo.test:443:127.0.0.1 -k -s)
kit() { "$KIT/kit.sh" "$S" "$@"; }
wait_for() { local what=$1 n=$2; shift 2; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 2; done; die "$what (gave up waiting)"; }

echo "== the site"
SITE_HOST=demo.test SITE_NAME="Night Owl Radio" ID_PREFIX=demo TLS_RESOLVER=self BEHIND_CLOUDFLARE=true \
    MODULES=analytics,social,live,monitoring SITE_TIMEZONE=Europe/Berlin ACME_EMAIL=demo@example.com NTFY_URL= \
    STAFF_DEVICE_VERIFICATION=false "$KIT/setup.sh" "$S" --yes >/dev/null || die "setup.sh failed"
sed -i '' 's/^GHOST_BRIDGE_DRY_RUN=.*/GHOST_BRIDGE_DRY_RUN=true/' "$S/secrets/postiz.env"
# Docker Desktop's own addresses (where this Mac's requests come from) trusted like Cloudflare's; only the site's own
# numbers (no network accounts here, which would show as alert errors); the disk Docker Desktop keeps its data on
sed -i '' -e 's|^TRUSTED_EXTRA=.*|TRUSTED_EXTRA=192.168.65.0/24,172.16.0.0/12|' -e 's|^NETWORKS=.*|NETWORKS=ghost|' "$S/site.env"
echo "DISK_MOUNT=/var/lib/docker" >>"$S/site.env"
kit up -d >"$SP/up.log" 2>&1 || { tail -20 "$SP/up.log"; die "kit.sh up failed"; }
# Stand-ins for the uptime checks (Health, Overview), which can't reach demo.test from inside Docker: Traefik joins
# blackbox's network under the demo's names, and blackbox doesn't check certificates (Traefik's own here)
docker network connect --alias demo.test --alias live.demo.test demo_default traefik
docker exec demo-blackbox-1 cat /etc/blackbox_exporter/config.yml | python3 -c "
import sys; s=sys.stdin.read(); a='  http_2xx:\n    prober: http\n    http:\n'
assert a in s; print(s.replace(a, a + '      tls_config: { insecure_skip_verify: true }\n', 1), end='')" >"$SP/blackbox.yml"
docker cp "$SP/blackbox.yml" demo-blackbox-1:/etc/blackbox_exporter/config.yml && docker restart demo-blackbox-1 >/dev/null
ghost_up() { [ "$(curl "${R[@]}" -o /dev/null -w '%{http_code}' https://demo.test/ghost/api/admin/site/)" = 200 ]; }
wait_for "Ghost answers through Traefik" 120 ghost_up

echo "== Ghost: owner, theme, posts, members"
JAR="$SP/cookies"; API=https://demo.test/ghost/api/admin
admin() { local m=$1 p=$2; shift 2; curl "${R[@]}" -b "$JAR" -c "$JAR" -H 'Origin: https://demo.test' \
    -H 'Accept-Version: v6.0' -X "$m" "$API$p" "$@"; }
admin POST /authentication/setup/ -H 'Content-Type: application/json' \
    -d '{"setup":[{"name":"Night Owl","email":"demo@example.com","password":"night-owl-demo-1!","blogTitle":"Night Owl Radio"}]}' >/dev/null
admin POST /session/ -H 'Content-Type: application/json' -d '{"username":"demo@example.com","password":"night-owl-demo-1!"}' >/dev/null
"$KIT/theme-zip.sh" >"$SP/zip.log" 2>&1 || { tail -5 "$SP/zip.log"; die "theme-zip.sh failed"; }
admin POST /themes/upload/ -F "file=@$KIT/dist/puppi3-creator-kit-theme.zip" >/dev/null
admin PUT /themes/puppi3-creator-kit-theme/activate/ >/dev/null
admin GET /custom_theme_settings/ | python3 -c "
import json,sys; d=json.load(sys.stdin)['custom_theme_settings']
print(json.dumps({'custom_theme_settings':[{'key':s['key'],'value':'https://live.demo.test/stream-mp3' if s['key']=='live_stream_url' else s['value']} for s in d]}))" >"$SP/ts.json"
admin PUT /custom_theme_settings/ -H 'Content-Type: application/json' -d @"$SP/ts.json" >/dev/null
# pictures: ffmpeg's gradients, one per post
colours=("0x1b1464:0xff6f61" "0x0f2027:0x2c9ca6" "0x42275a:0xf7b267" "0x141e30:0x7f53ac" "0x0b3d2e:0xc6e377" "0x2b1055:0xd53369")
for i in "${!colours[@]}"; do
    c0=${colours[$i]%%:*}; c1=${colours[$i]##*:}
    ffmpeg -nostdin -loglevel error -f lavfi -i "gradients=s=1600x900:c0=$c0:c1=$c1:x0=0:y0=0:x1=1600:y1=900:n=2:seed=$i" \
        -frames:v 1 -q:v 3 "$SP/pic$i.jpg"
    admin POST /images/upload/ -F "file=@$SP/pic$i.jpg" -F purpose=image >"$SP/pic$i.json"
done
python3 "$KIT/demo/content.py" "$SP" >"$SP/requests.txt" || die "content.py failed"
while IFS=$'\t' read -r method path file; do
    admin "$method" "$path" -H 'Content-Type: application/json' -d @"$file" >"$file.out" || die "$method $path failed"
done <"$SP/requests.txt"
admin POST /members/upload/ -F "membersfile=@$SP/members.csv" >/dev/null
# Ghost's own sample post (its picture is on Ghost's servers)
for id in $(admin GET "/posts/?filter=slug:coming-soon" | python3 -c "import json,sys; print(' '.join(p['id'] for p in json.load(sys.stdin)['posts']))"); do
    admin DELETE "/posts/$id/" >/dev/null
done
slug="$(python3 -c "import json; print(json.load(open('$SP/post0.json.out'))['posts'][0]['slug'])")"

echo "== live stream"
pw="$(sed -n 's/^TINYICE_SOURCE_PASSWORD=//p' "$S/secrets/icecast.env")"
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=220:sample_rate=44100" -t 1800 -ac 2 -c:a vorbis \
    -strict -2 -content_type audio/ogg -metadata artist="Night Owl" -metadata title="Night Owl Session 42" -f ogg \
    "icecast://source:$pw@127.0.0.1:$LP/stream-ogg" >"$SP/ffmpeg.log" 2>&1 &
live_up() { curl "${R[@]}" -H 'CF-Connecting-IP: 203.0.113.7' https://demo.test/live-status.json | grep -q '/stream-ogg"'; }
wait_for "TinyIce shows the stream" 15 live_up

echo "== a month of visits"
GP="$(sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' "$S/secrets/monitoring.env")"
# one real visit first (the browser), so the made-up ones copy a real event's shape
node "$KIT/demo/shots.mjs" visit "$slug" >/dev/null || die "the first visit failed"
tb_token="$(sed -n 's/^tinybird__adminToken=//p' "$S/data/puppi3/tinybird/tokens.env")"
tb() { docker exec -i demo-tinybird-local-1 curl -s -H "Authorization: Bearer $tb_token" "$@"; }
one() { tb --data-urlencode "q=SELECT * FROM analytics_events LIMIT 1 FORMAT JSON" http://localhost:7181/v0/sql >"$SP/event.json"; \
    python3 -c "import json,sys; sys.exit(0 if json.load(open('$SP/event.json'))['data'] else 1)" 2>/dev/null; }
wait_for "the first visit in Tinybird" 30 one
python3 "$KIT/demo/visits.py" "$SP/event.json" "$SP"/post*.json.out >"$SP/visits.ndjson" || die "visits.py failed"
tb -X POST --data-binary @- "http://localhost:7181/v0/events?name=analytics_events" <"$SP/visits.ndjson" >/dev/null
# (its answer counts only the first chunk, and the rest land in the background: wait for the table's count)
all_in() { [ "$(tb --data-urlencode "q=SELECT count() FROM analytics_events FORMAT TSV" http://localhost:7181/v0/sql)" -gt \
    "$(wc -l <"$SP/visits.ndjson")" ]; }
wait_for "every visit in Tinybird" 30 all_in

echo "== screenshots"
sleep 60   # Prometheus's first samples, Grafana's first scrape of the bridge
mkdir -p "$OUT"
GRAFANA_PASSWORD="$GP" node "$KIT/demo/shots.mjs" shots "$SP" || die "shots.mjs failed"
for f in "$SP"/*.png; do
    cwebp -quiet -q 82 "$f" -o "$OUT/$(basename "${f%.png}").webp"
done
ls -l "$OUT"
