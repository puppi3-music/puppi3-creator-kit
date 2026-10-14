#!/usr/bin/env bash
# The Compose kit's test, on this computer (Linux, a Mac, or Windows inside WSL2), never on a real site's machine: makes
# a throwaway site (kit/sites/kit-test,
# kit.test, ID_PREFIX kittest) with kit/setup.sh, starts it with kit/kit.sh, checks it end to end, and removes it.
#   kit/test.sh           (--keep: leave the site running afterwards; kit/kit.sh kit/sites/kit-test down -v removes it)
# Needs ports 80, 443 and 8222 free (LIVE_PORT=<another> for the stream's, e.g. beside the k3d test cluster), ffmpeg,
# python3, and kit/theme-test's npm install and Playwright's Chromium (kit/local-site.sh checks them all).
# Checks:
#   - Cloudflare-only: a visitor from outside Cloudflare's ranges gets 403; from a trusted address the site loads
#     through Traefik (https on Traefik's own certificate: TLS_RESOLVER=self); with BEHIND_CLOUDFLARE=false, from anywhere
#   - Ghost with the kit's theme (uploaded through the Admin API): a page hit reaches Tinybird, with its country
#     filled in by page-hit-country (the browser says UTC, Cloudflare's header says CA)
#   - Live: ffmpeg streams Ogg to TinyIce like the streaming software; /live-status.json shows it, the LIVE NOW bar appears
#     with the track and plays /stream-mp3; the play and a link out reach the bridge as click beacons
#   - The bridge: /health, /performance.json, a signed Ghost webhook through Traefik makes a DRY_RUN preview
#   - The draft preview has the Social preview button; no pets route; no puppi3 in container names, routers, metrics
#   - A site folder from before kit 1.2.0 (secrets/puppi3.env, data/puppi3/) renders with its own paths and password
#   - Monitoring: Grafana has every rendered dashboard in the site's folder, no panel names a datasource it lacks, each
#     datasource answers a real query (grafana_ro on Ghost's MySQL and Postiz's Postgres, Tinybird with this Ghost's
#     site_uuid, the bridge, Prometheus with every job up), the alert rules are loaded; a render with modules and
#     networks switched off leaves their panels and rules out; live switched off on the running site: TinyIce's
#     container gone, Prometheus's job and Grafana's rule with it
set -uo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$KIT")"
S="$KIT/sites/kit-test"
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
SP="${TMPDIR:-/tmp}/kit-test.$$"

fails=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }
die()  { echo "kit/test.sh: $*" >&2; exit 1; }

. "$KIT/local-site.sh"
need ffmpeg ffmpeg ffmpeg
mkdir -p "$SP"

R=(--resolve kit.test:443:127.0.0.1 --resolve kit.test:80:127.0.0.1 --resolve www.kit.test:443:127.0.0.1 --resolve live.kit.test:443:127.0.0.1
   --resolve postiz.kit.test:443:127.0.0.1 -k -s)
CF=(-H 'CF-Connecting-IP: 203.0.113.7' -H 'CF-IPCountry: CA')
code() { curl "${R[@]}" -o /dev/null -w '%{http_code}' "$@"; }
kit() { "$KIT/kit.sh" "$S" "$@"; }
profile() { sedi "s|^$1=.*|$1=$2|" "$S/site.env"; }
bridge() { docker exec postiz-ghost-bridge wget -qO- "http://localhost:8080$1"; }
wait_for() { local what=$1 n=$2; shift 2; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 2; done; fail "$what (gave up waiting)"; return 1; }

# ---- The site
echo "== setup and start (the first start pulls images)"
TRYOUT=yes SITE_HOST=kit.test SITE_NAME="Kit Test" ID_PREFIX=kittest BEHIND_CLOUDFLARE=true \
    MODULES=analytics,social,live,monitoring NETWORKS=ghost,instagram,youtube,soundcloud,bluesky,threads,tiktok,mixcloud \
    STAFF_DEVICE_VERIFICATION=false "$KIT/setup.sh" "$S" --yes >/dev/null || die "setup.sh failed"
echo "LIVE_PORT=$LP" >> "$S/site.env"
sedi 's/^GHOST_BRIDGE_DRY_RUN=.*/GHOST_BRIDGE_DRY_RUN=true/' "$S/secrets/postiz.env"
kit up -d >"$SP/up.log" 2>&1 || { tail -20 "$SP/up.log"; die "kit.sh up failed"; }
ghost_up() { docker exec traefik wget -qO /dev/null --header 'X-Forwarded-Proto: https' http://kittest-ghost:2368/ghost/api/admin/site/ 2>/dev/null; }
wait_for "Ghost answers Traefik" 90 ghost_up

echo "== Ports and redirects"
host_ports() { docker ps --filter label=com.docker.compose.project=kittest --format '{{.Ports}}' |
    grep -oE '0\.0\.0\.0:[0-9]+' | sed 's/.*://' | sort -un | tr '\n' ' '; }
check "only Traefik's and TinyIce's ports are on the host (no Ghost, analytics or dashboard port)" \
    [ "$(host_ports)" = "$(printf '%s\n' 80 443 "$LP" | sort -un | tr '\n' ' ')" ]
loc() { curl "${R[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$@" | sed 's/^30[18] /moved /'; }
check "http:// goes to https://" [ "$(loc http://kit.test/about/)" = "moved https://kit.test/about/" ]
check "www. goes to the site" [ "$(loc 'https://www.kit.test/x?y=1')" = "moved https://kit.test/x?y=1" ]
no_ntfy() { [ -s "$1" ] && ! grep -q '^contactPoints:' "$1"; }
check "the alert rules have no ntfy contact point (NTFY_URL empty)" \
    no_ntfy "$S/data/monitoring/grafana/rendered/alerting/kittest.yml"

echo "== Cloudflare-only"
check "a visitor from outside Cloudflare gets 403" [ "$(code "${CF[@]}" https://kit.test/)" = 403 ]
# where this computer's requests come from (Docker Desktop's machine, or a Docker network's gateway) trusted like Cloudflare's
profile TRUSTED_EXTRA "$LOCAL_RANGES"
kit up -d traefik >/dev/null 2>&1
site_cf() { [ "$(code "${CF[@]}" https://kit.test/)" = 200 ]; }
wait_for "the site loads through Traefik from a trusted address" 30 site_cf && ok "the site loads through Traefik from a trusted address"

# ---- Ghost: owner, the kit's theme, posts (Admin API with a session, as Ghost Admin does)
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
active="$(admin GET /themes/ | python3 -c "import json,sys; print([t['name'] for t in json.load(sys.stdin)['themes'] if t['active']][0])")"
check "the kit's theme is active (uploaded zip)" [ "$active" = puppi3-creator-kit-theme ]
admin GET /custom_theme_settings/ | python3 -c "
import json,sys; d=json.load(sys.stdin)['custom_theme_settings']
print(json.dumps({'custom_theme_settings':[{'key':s['key'],'value':'https://live.kit.test/stream-mp3' if s['key']=='live_stream_url' else s['value']} for s in d]}))" >"$SP/ts.json"
admin PUT /custom_theme_settings/ -H 'Content-Type: application/json' -d @"$SP/ts.json" >/dev/null
lexical='{\"root\":{\"type\":\"root\",\"version\":1,\"direction\":null,\"format\":\"\",\"indent\":0,\"children\":[{\"type\":\"paragraph\",\"version\":1,\"direction\":null,\"format\":\"\",\"indent\":0,\"children\":[{\"type\":\"link\",\"version\":1,\"url\":\"https://example.org/elsewhere\",\"rel\":null,\"target\":null,\"title\":null,\"direction\":null,\"format\":\"\",\"indent\":0,\"children\":[{\"type\":\"text\",\"version\":1,\"text\":\"a link elsewhere\",\"detail\":0,\"format\":0,\"mode\":\"normal\",\"style\":\"\"}]}]}]}}'
admin POST /posts/ -H 'Content-Type: application/json' \
    -d "{\"posts\":[{\"title\":\"A kit post\",\"status\":\"published\",\"lexical\":\"$lexical\"}]}" >"$SP/post.json"
admin POST /posts/ -H 'Content-Type: application/json' -d '{"posts":[{"title":"A kit draft","status":"draft"}]}' >"$SP/draft.json"
slug="$(python3 -c "import json; print(json.load(open('$SP/post.json'))['posts'][0]['slug'])")"
uuid="$(python3 -c "import json; print(json.load(open('$SP/draft.json'))['posts'][0]['uuid'])")"

# ---- Live: a source like the streaming software's
echo "== live stream and the browser"
pw="$(sed -n 's/^TINYICE_SOURCE_PASSWORD=//p' "$S/secrets/icecast.env")"
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 120 -ac 2 -c:a vorbis \
    -strict -2 -content_type audio/ogg -metadata artist=Kit -metadata title="Test Tone" -f ogg \
    "icecast://source:$pw@127.0.0.1:$LP/stream-ogg" >"$SP/ffmpeg.log" 2>&1 &
FF=$!
live_up() { curl "${R[@]}" "${CF[@]}" https://kit.test/live-status.json | grep -q '/stream-ogg"'; }
wait_for "TinyIce shows /stream-ogg" 15 live_up && ok "/live-status.json shows the stream"
node "$KIT/theme-test/kit-site.mjs" "$slug" "$uuid" >"$SP/browser.json" 2>"$SP/browser.err" || cat "$SP/browser.err"
b() { python3 -c "import json,sys; d=json.load(open('$SP/browser.json')); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
check "the LIVE NOW bar shows while streaming" [ "$(b "d['barVisible']")" = True ]
check "the bar shows the track" [ "$(b "d['track']")" = "Kit - Test Tone" ]
check "the bar plays /stream-mp3" [ "$(b "d['played']")" = True ]
check "the page hits were accepted" [ "$(b "bool(d['pageHits']) and all(s < 300 for s in d['pageHits'])")" = True ]
check "the draft preview has the Social preview button" [ "$(b "d['previewButton']")" = True ]
check "no script errors" [ "$(b "d['errors']")" = "[]" ]

# ---- What reached the bridge and Tinybird
echo "== bridge and analytics"
clicks() { bridge /clicks.json | python3 -c "import json,sys; t=json.load(sys.stdin)['totals']; print(eval(sys.argv[1]))" "$1"; }
played() { [ "$(clicks "t['play']")" -gt 0 ]; }
wait_for "the play beacon reached the bridge" 10 played && ok "the play beacon reached the bridge"
went_out() { [ "$(clicks "sum(t['out'].values())")" -gt 0 ]; }
wait_for "the link out reached the bridge" 10 went_out && ok "the link out reached the bridge"
tb_token="$(hostcat "$S/data/ghost/tinybird/tokens.env" | sed -n 's/^tinybird__adminToken=//p')"
tb() { docker exec kittest-tinybird-local-1 curl -s -H "Authorization: Bearer $tb_token" --data-urlencode "q=$1" http://localhost:7181/v0/sql; }
hit_ok() { tb "SELECT count() c FROM analytics_events WHERE JSONExtractString(payload, 'location') = 'CA' FORMAT TSV" | grep -qv '^0$'; }
wait_for "a page hit with country CA in Tinybird" 15 hit_ok && ok "a page hit reached Tinybird, country CA from page-hit-country"
check "bridge /health" [ "$(bridge /health)" = ok ]
check "the bridge has Tinybird's token (Ghost's numbers on Platforms, no copying by hand)" \
    [ -n "$(docker exec postiz-ghost-bridge printenv tinybird__adminToken 2>/dev/null)" ]
bridge /performance.json | grep -q '"summary"' && ok "bridge /performance.json" || fail "bridge /performance.json"
secret="$(sed -n 's/^GHOST_WEBHOOK_SECRET=//p' "$S/secrets/postiz.env")"
python3 -c "import json; p=json.load(open('$SP/post.json'))['posts'][0]; open('$SP/hook.json','w').write(json.dumps({'post':{'current':p}}))"
ts="$(($(date +%s) * 1000))"
sig="$(printf '%s%s' "$(cat "$SP/hook.json")" "$ts" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')"
hook="$(code "${CF[@]}" -X POST -H 'Content-Type: application/json' -H "X-Ghost-Signature: sha256=$sig, t=$ts" \
    --data-binary @"$SP/hook.json" https://postiz.kit.test/ghost-webhook)"
check "a signed Ghost webhook through Traefik is accepted (202)" [ "$hook" = 202 ]
preview() { ls "$S/data/postiz/ghost-bridge/data/previews/" 2>/dev/null | grep -q . ||
    docker run --rm -v "$S/data/postiz/ghost-bridge/data:/d:ro" alpine ls /d/previews 2>/dev/null | grep -q .; }
wait_for "the DRY_RUN share wrote a preview" 30 preview && ok "the DRY_RUN share wrote a preview"

# ---- Monitoring
echo "== Grafana and Prometheus"
GP="$(sed -n 's/^GRAFANA_ADMIN_PASSWORD=//p' "$S/secrets/monitoring.env")"
g() { local p=$1; shift; curl -s --resolve grafana.localhost:80:127.0.0.1 -u "admin:$GP" "http://grafana.localhost$p" "$@"; }
R_DIR="$S/data/monitoring/grafana/rendered"
graf_up() { g /api/health | grep -q '"database": *"ok"'; }
wait_for "Grafana answers on grafana.<LAN_DOMAIN>" 90 graf_up
dash_ok() { g '/api/search?type=dash-db' | python3 -c "
import json,sys,glob
got={d['uid']: d.get('folderTitle') for d in json.load(sys.stdin)}
want={json.load(open(f)).get('uid') or json.load(open(f))['metadata']['name'] for f in glob.glob('$R_DIR/dashboards/*.json')}
sys.exit(0 if want and set(got) == want and set(got.values()) == {'Kit Test'} else 1)"; }
wait_for "every rendered dashboard is in Grafana's Kit Test folder" 30 dash_ok && ok "every rendered dashboard is in Grafana, folder Kit Test"
g /api/datasources >"$SP/ds.json"
python3 - "$R_DIR/dashboards" "$SP/ds.json" >"$SP/ds-missing.txt" <<'PY2'
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
# a real query through each datasource (as a panel would ask)
q() { g /api/ds/query -H 'Content-Type: application/json' -d "{\"from\":\"now-1h\",\"to\":\"now\",\"queries\":[$1]}"; }
# the first value of the answer (the frames' first field's first value), or ERROR
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
uuid="$(sed -n 's/^GHOST_SITE_UUID=//p' "$S/data/monitoring/ghost.env" 2>/dev/null)"
check "kit.sh gave the dashboards this Ghost's site_uuid" bash -c "[ -n '$uuid' ] && grep -q '$uuid' '$R_DIR/dashboards/3-traffic.json'"
today="$(date -u +%Y-%m-%d)"
visits() { v="$(inf ghost-analytics "http://tinybird-local:7181/v0/pipes/api_kpis.json?site_uuid=$uuid&timezone=Etc/UTC&date_from=$today&date_to=$today" '$sum(data.pageviews)')"; [ "${v%%.*}" -ge 1 ] 2>/dev/null; }
wait_for "Ghost Analytics (Tinybird) counts today's page views for this site" 30 visits && ok "Ghost Analytics counts today's page views for this site"
plays() { v="$(inf bridge-instagram http://postiz-ghost-bridge:8080/clicks.json 'totals.play')"; [ "${v%%.*}" -ge 1 ] 2>/dev/null; }
wait_for "the bridge datasource reads clicks.json" 10 plays && ok "the bridge datasource reads clicks.json"
prom() { q "{\"refId\":\"A\",\"datasource\":{\"uid\":\"prometheus\"},\"expr\":\"$1\",\"instant\":true,\"range\":false}" | first; }
jobs_up() { v="$(prom 'count(up{job=~\"kittest-pets|traefik|tinyice|cadvisor|node\"} == 1)')"; [ "${v%%.*}" = 5 ]; }
wait_for "Prometheus: the bridge, Traefik, TinyIce, cAdvisor and node-exporter up" 60 jobs_up && ok "Prometheus scrapes the bridge, Traefik, TinyIce, cAdvisor and node-exporter"
cpu() { has_val "$(prom 'count(container_memory_working_set_bytes{name=\"kittest-ghost\"})')"; }
# (with Docker's own overlay2 store and with containerd's, Docker 29's and Docker Desktop's default: cAdvisor 0.54+)
wait_for "cAdvisor sees the site's containers (Health's container panels)" 30 cpu && ok "cAdvisor sees the site's containers"
probe() { has_val "$(prom 'probe_success{instance=\"https://kit.test\"}')"; }
wait_for "blackbox checks the site" 45 probe && ok "blackbox checks the site (it can't reach kit.test from inside: no DNS)"
want_rules="$(sed -n "/^groups:/,\$p" "$R_DIR/alerting/kittest.yml" | grep -c "^      - uid:")"
rules_ok() { g /api/v1/provisioning/alert-rules | python3 -c "
import json,sys; r=json.load(sys.stdin)
sys.exit(0 if len(r) == $want_rules and all(x['labels'].get('project') == 'kittest' for x in r) else 1)"; }
wait_for "Grafana has the site's $want_rules alert rules" 15 rules_ok && ok "Grafana has the site's $want_rules alert rules (project=kittest)"
# switched off: live, pets, and every network but the site and Instagram
sed -e 's/^MODULES=.*/MODULES=analytics,social,monitoring/' -e 's/^PETS=.*/PETS=false/' -e 's/^NETWORKS=.*/NETWORKS=ghost,instagram/' \
    "$S/site.env" >"$SP/off.env"
python3 "$REPO/stacks/monitoring/grafana/render.py" --profile kit --site "$SP/off.env" --site "$S/secrets/monitoring.env" \
    "$REPO/stacks/monitoring/grafana/provisioning/dashboards/json" "$SP/off" >/dev/null 2>&1
off_ok() { python3 - "$SP/off" <<'PY2'
import json, pathlib, re, sys
o = pathlib.Path(sys.argv[1]); bad = []
for f in (o / "dashboards").glob("*.json"):
    t = f.read_text()
    bad += [f"{f.name}: {w}" for w in ("tinyice_", "/live.json", "_live_stalls", "puppy_pets", "/pets.json") if w in t]
    if f.name == "8-platforms.json":
        rows = [r["spec"]["title"] for r in json.loads(t)["spec"]["layout"]["spec"]["rows"]]
        bad += [f"Platforms row {r}" for r in ("Bluesky", "Mixcloud", "SoundCloud", "Threads", "TikTok", "YouTube") if r in rows]
a, _, gone = next((o / "alerting").glob("*.yml")).read_text().partition("\ndeleteRules:")
bad += [f"rule {u}" for u in re.findall(r"uid: (kittest-(?:live-down|stats-(?:youtube|soundcloud|bluesky|threads|tiktok|mixcloud)))", a)]
# and Grafana is told to delete those it has from before (it keeps a provisioned rule whose entry is gone)
bad += [f"no deleteRules for {u}" for u in ("kittest-live-down", "kittest-stats-tiktok") if f"uid: {u}\n" not in gone]
print("\n".join(bad)); sys.exit(1 if bad or not list((o / "dashboards").glob("*.json")) else 0)
PY2
}
check "a render with live, pets and five networks off leaves out their panels, rows and rules" off_ok

# ---- Names
echo "== names"
curl -s --resolve traefik.localhost:80:127.0.0.1 http://traefik.localhost/api/http/routers >"$SP/routers.json"
check "Traefik's dashboard answers on traefik.<LAN_DOMAIN>" grep -q kittest-ghost "$SP/routers.json"
check "no pets route (PETS module off)" bash -c "! grep -q '/.puppy/pets' '$SP/routers.json'"
check "no puppi3 in router names" bash -c "! python3 -c \"import json; print([r['name'] for r in json.load(open('$SP/routers.json'))])\" | grep -q puppi3"
kit ps -a --format '{{.Name}}' >"$SP/names.txt" 2>/dev/null
check "no puppi3 in container names" bash -c "[ -s '$SP/names.txt' ] && ! grep -q puppi3 '$SP/names.txt'"
check "no puppi3 in the bridge's metrics" bash -c "! docker exec postiz-ghost-bridge wget -qO- http://localhost:8080/metrics | grep -q puppi3"
kit config 2>/dev/null | sed "s|$REPO|<repo>|g" | grep -n puppi3 >"$SP/left.txt"
check "no puppi3 in the rendered config" [ ! -s "$SP/left.txt" ] || cat "$SP/left.txt"
# A site made before kit 1.2.0 (the Ghost stack was puppi3 then): its secrets/puppi3.env and data/puppi3/ are used as
# they are (a copy of this site's files, only rendered)
O="$SP/old-site"; mkdir -p "$O/data/puppi3"; O="$(cd "$O" && pwd)"   # as kit.sh spells it (TMPDIR may end in /)
cp "$S/site.env" "$O/"; cp -R "$S/secrets" "$O/"
mv "$O/secrets/ghost.env" "$O/secrets/puppi3.env"
"$KIT/kit.sh" "$O" config >"$SP/old-config.txt" 2>&1 || true
pw="$(sed -n 's/^database__connection__password=//p' "$O/secrets/puppi3.env")"
check "a site from before 1.2.0: Ghost's data stays in data/puppi3/, its secrets in secrets/puppi3.env" \
    bash -c "grep -q '$O/data/puppi3/ghost/content' '$SP/old-config.txt' && ! grep -q '$O/data/ghost/' '$SP/old-config.txt' &&
        grep -q 'database__connection__password: $pw' '$SP/old-config.txt'"

# ---- Open to all
echo "== BEHIND_CLOUDFLARE=false"
profile BEHIND_CLOUDFLARE false; profile TRUSTED_EXTRA none
kit up -d traefik >/dev/null 2>&1
site_any() { [ "$(code https://kit.test/)" = 200 ]; }
wait_for "the site loads with no Cloudflare headers" 30 site_any && ok "the site loads with no Cloudflare headers"

echo "== a module switched off"
profile MODULES analytics,social,monitoring
kit up -d >"$SP/off-up.log" 2>&1 || { tail -20 "$SP/off-up.log"; fail "kit.sh up with live off"; }
check "live off: TinyIce's container is gone" [ -z "$(docker ps -aq --filter name='^tinyice$')" ]
prom_jobs() { docker exec kittest-prometheus wget -qO- 'http://localhost:9090/api/v1/targets' 2>/dev/null; }
no_tinyice_job() { prom_jobs | grep -q '"job":"prometheus"' && ! prom_jobs | grep -q '"job":"tinyice"'; }
wait_for "live off: Prometheus drops TinyIce's job" 15 no_tinyice_job && ok "live off: Prometheus drops TinyIce's job"
no_live_rule() { g /api/v1/provisioning/alert-rules | python3 -c "
import json,sys; sys.exit(0 if not any(x['uid'] == 'kittest-live-down' for x in json.load(sys.stdin)) else 1)" 2>/dev/null; }
wait_for "live off: Grafana drops its alert rule" 30 no_live_rule && ok "live off: Grafana drops its alert rule"

echo
[ "$fails" = 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
