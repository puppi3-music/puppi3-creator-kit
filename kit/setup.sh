#!/usr/bin/env bash
# Makes a kit site's folder (kit.sh runs it), asking for the few values it needs:
#   kit/setup.sh <site folder>                 e.g. kit/setup.sh kit/sites/mysite (kit/sites/ is git-ignored)
#   SITE_HOST=example.org ACME_EMAIL=me@example.org kit/setup.sh <folder> --yes   (no questions: given or default)
# It writes site.env (instances/example.env with the answers), secrets/<stack>.env (each stack's examples, with
# random passwords and secrets) and data/ (Ghost's config, Traefik's lan-only.yml). Files already there are kept, so
# running it again only adds what's missing. Then: kit/kit.sh <folder> up -d, and the steps it prints at the end.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$KIT")"
case "${1:-}" in ""|-*) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
mkdir -p "$1"; SITE_DIR="$(cd "$1" && pwd)"; shift
YES=0; [ "${1:-}" = --yes ] && YES=1

rand() { python3 -c 'import secrets,string,sys; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(int(sys.argv[1]))), end="")' "${1:-32}"; }
# ask VAR "question" default: the environment's value, else the answer (or the default with --yes)
ask() {
    local var=$1 q=$2 def=$3 v
    v="${!var:-}"
    if [ -z "$v" ]; then
        if [ "$YES" = 1 ]; then v=$def; else read -r -p "$q [$def]: " v; v=${v:-$def}; fi
    fi
    printf -v "$var" '%s' "$v"
}
# set KEY value in a file: replace the KEY= line (or a commented-out #KEY= default), or add one
setkey() {
    local f=$1 k=$2 v=$3
    if grep -q "^#\{0,1\}$k=" "$f"; then
        python3 - "$f" "$k" "$v" <<'PY'
import sys
f, k, v = sys.argv[1:]
lines = open(f).read().split('\n')
open(f, 'w').write('\n'.join(f'{k}={v}' if l.startswith(k + '=') or l.startswith('#' + k + '=') else l for l in lines))
PY
    else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}

umask 077
mkdir -p "$SITE_DIR/secrets" "$SITE_DIR/data"

# ---- site.env: the instance profile
if [ ! -f "$SITE_DIR/site.env" ]; then
    # A try-out (on this machine, before the site's address points here): Traefik's own certificate, open to all,
    # and no phone alerts (the public checks would fail and say so). Switch each later in site.env.
    ask TRYOUT "Trying it on this machine before the site is public? (yes/no)" no
    case "$TRYOUT" in y|yes|Yes|YES) TRYOUT=yes ;; *) TRYOUT=no ;; esac
    ask SITE_HOST "The site's address (no https://)" example.com
    ask SITE_NAME "Its name as people see it" "$SITE_HOST"
    ask ID_PREFIX "A short lowercase name used inside (Grafana, metrics, container names; pick it once)" \
        "$(printf '%s' "${SITE_HOST%%.*}" | tr -cd 'a-z0-9' | head -c 16)"
    ask SITE_TIMEZONE "Time zone" Etc/UTC
    ask MODULES "Modules (analytics, social, live, monitoring)" analytics,social,live,monitoring
    # live off: no question, the usual name kept for the day it's switched on
    case ",$MODULES," in *,live,*) ask LIVE_HOST "The live stream's address" "live.$SITE_HOST" ;; *) LIVE_HOST="live.$SITE_HOST" ;; esac
    ask BEHIND_CLOUDFLARE "Only Cloudflare reaches the site (true/false)" "$([ $TRYOUT = yes ] && echo false || echo true)"
    # Behind Cloudflare's proxy Let's Encrypt's TLS challenge reaches Cloudflare, not this host: cf there
    case "$BEHIND_CLOUDFLARE" in true) tls=cf ;; *) tls=le ;; esac
    [ "$TRYOUT" = yes ] && tls=self
    ask TLS_RESOLVER "Certificates: cf (Let's Encrypt through Cloudflare's DNS, with an API token), le (Let's Encrypt on port 443, not behind Cloudflare's proxy), self, none" $tls
    ask LAN_DOMAIN "Home-network-only names end in (Traefik's dashboard, Grafana, TinyIce's admin)" localhost
    if [ "$TRYOUT" = yes ]; then NTFY_URL=""; echo "Phone notifications: off for a try-out (NTFY_URL in site.env turns them on)"
    else ask NTFY_URL "ntfy server for phone notifications (empty = none)" https://ntfy.sh; fi
    # the networks you post to: each gets its dashboard section and its numbers' collector; one not set up yet
    # would show as an alert error
    if case ",$MODULES," in *,social,*) true ;; *) false ;; esac; then
        ask NETWORKS "Networks you use (ghost, instagram, youtube, soundcloud, bluesky, threads, tiktok, mixcloud)" ghost
    else NETWORKS=ghost; fi
    # instances/example.env, with a header for a site folder (the example's own is about the repo's instances/)
    { echo "# This site's settings (Puppi3's Creator Kit). kit/setup.sh wrote it; edit it, then: kit/kit.sh <this folder> up -d"
      echo "# Every setting: kit/docs/settings-reference.html. No secrets here: they're in secrets/."
      sed '1,/^$/d' "$REPO/instances/example.env"; } > "$SITE_DIR/site.env"
    for k in SITE_HOST SITE_NAME ID_PREFIX SITE_TIMEZONE MODULES LIVE_HOST BEHIND_CLOUDFLARE TLS_RESOLVER LAN_DOMAIN NTFY_URL NETWORKS; do
        setkey "$SITE_DIR/site.env" "$k" "${!k}"
    done
    # where posts go: the networks named that Postiz posts to (the rest only have numbers); none = the default list
    chans=""
    for n in ${NETWORKS//,/ }; do
        case "$n" in bluesky|threads) chans="$chans,$n" ;; instagram) chans="$chans,instagram-standalone" ;;
                     tiktok) chans="$chans,tiktok,tiktok-business" ;; esac
    done
    [ -n "$chans" ] && setkey "$SITE_DIR/site.env" CHANNELS "${chans#,}"
    setkey "$SITE_DIR/site.env" GRAFANA_HOST "grafana.$SITE_HOST"
    setkey "$SITE_DIR/site.env" GRAFANA_URL "https://grafana.$SITE_HOST"
    # Docker Desktop (a Mac, Windows): its machine's / is a kind node-exporter skips, so Health's disk tile reads the
    # disk Docker keeps its data on
    docker info -f '{{.OperatingSystem}}' 2>/dev/null | grep -q 'Docker Desktop' && setkey "$SITE_DIR/site.env" DISK_MOUNT /var/lib/docker
    echo "wrote site.env"
fi
val() { sed -n "s/^$1=//p" "$SITE_DIR/site.env" | tail -1; }
SITE_HOST="$(val SITE_HOST)"; ID_PREFIX="$(val ID_PREFIX)"; LAN_DOMAIN="$(val LAN_DOMAIN)"
on() { case ",$(val MODULES)," in *,"$1",*) true ;; *) false ;; esac; }

# ---- secrets/<stack>.env: each stack's examples, filled in
# secret <stack>[:<file>] KEY=value ...: write the stack's file (secrets/<file>.env, <stack> by default) once, from its
# examples (the stack's own, without its NAS notes; the kit's, kit/examples/<stack>.env.example, as it is), then fill in
# the values
secret() {
    local stack=${1%%:*} name=${1#*:} f; shift; f="$SITE_DIR/secrets/$name.env"
    [ -f "$f" ] && return 0
    # the stack's example with its comments, less its first line and its "Site values" part (site.env has those) and
    # NTFY_URL (site.env's, which kit.sh passes)
    { echo "# $stack's secrets for this kit site (kit/setup.sh; every setting: kit/docs/settings-reference.html)"
      if [ -f "$REPO/stacks/$stack/.env.example" ]; then
          sed -e '1d' -e '/^# Site values/,/^$/d' -e '/^NTFY_URL=/d' "$REPO/stacks/$stack/.env.example"; echo
      fi
      if [ -f "$KIT/examples/$stack.env.example" ]; then cat "$KIT/examples/$stack.env.example"; fi; } > "$f"
    local kv; for kv in "$@"; do setkey "$f" "${kv%%=*}" "${kv#*=}"; done
    echo "wrote secrets/$name.env"
}
# Let's Encrypt's account email: only for its certificates (cf, le)
if [ ! -f "$SITE_DIR/secrets/traefik.env" ]; then
    case "$(val TLS_RESOLVER)" in cf|le) ask ACME_EMAIL "Email for Let's Encrypt" "admin@$SITE_HOST" ;; *) ACME_EMAIL="admin@$SITE_HOST" ;; esac
fi
secret traefik "ACME_EMAIL=${ACME_EMAIL:-}"
# The Ghost stack's folder and secrets file: ghost, or puppi3 in a site made before kit 1.2.0 (kit.sh decides the same)
g=ghost; [ -d "$SITE_DIR/data/puppi3" ] || [ -f "$SITE_DIR/secrets/puppi3.env" ] && g=puppi3
secret "ghost:$g" "database__connection__password=$(rand)" "database__connection__database=ghost"
secret postiz "POSTIZ_DOMAIN=postiz.$SITE_HOST" "POSTIZ_JWT_SECRET=$(rand 48)" "POSTIZ_DB_PASSWORD=$(rand)" \
    "TEMPORAL_DB_PASSWORD=$(rand)" "POSTIZ_DISABLE_REGISTRATION=false" "GHOST_WEBHOOK_SECRET=$(rand 40)" \
    "NTFY_TOPIC=$ID_PREFIX-$(rand 12 | tr 'A-Z' 'a-z')" "SEARCH_CONSOLE_SITE=sc-domain:$SITE_HOST"
secret icecast "TINYICE_SOURCE_PASSWORD=$(rand 20)" "TINYICE_ADMIN_PASSWORD=$(rand 20)"
# the alerts go to the bridge's topic
secret monitoring "GRAFANA_ADMIN_PASSWORD=$(rand 24)" "GRAFANA_RO_PASSWORD=$(rand)" \
    "NTFY_TOPIC=$(sed -n 's/^NTFY_TOPIC=//p' "$SITE_DIR/secrets/postiz.env")"

# ---- data/: what has to exist before the first start
umask 022
d="$SITE_DIR/data"
# Every data folder made here, not by Docker (which makes them root's)
mkdir -p "$d/$g/ghost/content" "$d/$g/db" "$d/$g/tinybird" "$d/icecast/tinyice-data" "$d/icecast/tinyice" \
    "$d/postiz/ghost-bridge/data" "$d/postiz/config" "$d/postiz/uploads" "$d/postiz/postgres" "$d/postiz/redis" \
    "$d/postiz/temporal-postgres" "$d/traefik/dynamic" "$d/traefik/letsencrypt" \
    "$d/monitoring/prometheus/data" "$d/monitoring/grafana/data" "$d/monitoring/grafana/rendered"
# Ghost's config file, replacing the image's own, so it says what that does: listen on all addresses, content in
# /var/lib/ghost/content. Direct mail until the site has secrets/ghost-mail.env (its mail__* settings win over this
# file's; not here, as this file is readable by everyone on the machine): Ghost emails staff a code at each new
# sign-in (staffDeviceVerification; STAFF_DEVICE_VERIFICATION=false turns it off, as a try-out does: no mail service
# yet, and Direct mail rarely arrives).
[ -f "$d/$g/ghost/config.production.json" ] || cat > "$d/$g/ghost/config.production.json" <<JSON
{
  "server": { "port": 2368, "host": "::" },
  "mail": { "transport": "Direct" },
  "logging": { "transports": ["file", "stdout"] },
  "process": "systemd",
  "security": { "staffDeviceVerification": ${STAFF_DEVICE_VERIFICATION:-$([ "${TRYOUT:-}" = yes ] && echo false || echo true)} },
  "paths": { "contentPath": "/var/lib/ghost/content" }
}
JSON
# TinyIce's config, set up (else it waits for its web setup page): /stream-ogg for the streaming software, transcoded to
# /stream-mp3 for listeners, with the burst sizes a live site runs with (a smaller mp3 burst leaves a slow
# listener room before TinyIce's 512 KB ring jumps them). Passwords bcrypt-hashed, as TinyIce keeps them.
bcrypt() {
    if python3 -c 'import bcrypt' 2>/dev/null; then
        python3 -c 'import bcrypt,sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(12)).decode())' "$1"
    elif command -v htpasswd >/dev/null; then htpasswd -bnBC 12 "" "$1" | tr -d ':\n'; echo
    else docker run --rm httpd:2-alpine htpasswd -bnBC 12 "" "$1" | tr -d ':\n'; echo
    fi | sed 's/^\$2y\$/$2a$/'
}
if [ ! -f "$d/icecast/tinyice-data/config.json" ]; then
    ice() { sed -n "s/^$1=//p" "$SITE_DIR/secrets/icecast.env"; }
    SOURCE_HASH="$(bcrypt "$(ice TINYICE_SOURCE_PASSWORD)")" ADMIN_HASH="$(bcrypt "$(ice TINYICE_ADMIN_PASSWORD)")" \
    ADMIN_USER="$(ice TINYICE_ADMIN_USER)" LIVE="$(val LIVE_HOST)" NAME="$(val SITE_NAME)" EMAIL="${ACME_EMAIL:-admin@$SITE_HOST}" \
    python3 - "$d/icecast/tinyice-data/config.json" <<'PY'
import json, os, sys
e = os.environ
cfg = {
    "bind_host": "0.0.0.0", "port": "8000",
    "default_source_password": e["SOURCE_HASH"],
    "mounts": {"/stream-ogg": e["SOURCE_HASH"]},
    "advanced_mounts": {"/stream-ogg": {"password": "", "burst_size": 65536},
                        "/stream-mp3": {"password": "", "burst_size": 131072}},
    "transcoders": [{"name": "MP3 320kbps", "input_mount": "/stream-ogg", "output_mount": "/stream-mp3",
                     "format": "mp3", "bitrate": 320, "enabled": True, "sample_rate": 44100}],
    "admin_user": e["ADMIN_USER"], "admin_password": e["ADMIN_HASH"], "admin_email": e["EMAIL"],
    "hostname": e["LIVE"], "page_title": e["NAME"], "page_subtitle": "Live",
    "visible_mounts": {}, "fallback_mounts": {}, "setup_complete": True,
}
open(sys.argv[1], 'w').write(json.dumps(cfg, indent=2) + '\n')
PY
    chmod 600 "$d/icecast/tinyice-data/config.json"
fi
# Prometheus's TinyIce login (the admin's: TinyIce's /metrics wants it), a file it reads
if [ ! -f "$d/monitoring/prometheus/tinyice-password" ]; then
    (umask 077; sed -n 's/^TINYICE_ADMIN_PASSWORD=//p' "$SITE_DIR/secrets/icecast.env" | tr -d '\n' \
        > "$d/monitoring/prometheus/tinyice-password")
fi
# lan-only: the home-network-only names (*.<LAN_DOMAIN>) answer private addresses only. The site's own file: edit the
# ranges to your network's. Not 172.16.0.0/12: Docker's own networks are there, and a connection Docker relays itself
# (over IPv6, on a server with an IPv6 address) arrives from its network's gateway, so that range would let the
# internet in. kit.sh warns at every up when the file lets in an address every connection may come from.
[ -f "$d/traefik/dynamic/lan-only.yml" ] || cat > "$d/traefik/dynamic/lan-only.yml" <<'EOF'
# Home network only, for the *.<LAN_DOMAIN> names (Traefik's dashboard, TinyIce's admin, Grafana): private addresses
# only. Edit the ranges to your home network's. Leave out Docker's own networks (172.16.0.0/12 by default): connections
# Docker relays itself arrive from their gateway, which would let anyone in. kit/kit.sh warns if this lets one in.
http:
  middlewares:
    lan-only:
      ipAllowList:
        sourceRange: ["10.0.0.0/8", "192.168.0.0/16", "127.0.0.1/32", "fc00::/7", "fe80::/10"]
EOF
# On Linux each image's user must own its folders (Ghost's image sees to its own)
if [ "$(uname)" = Linux ]; then
    sudo chown -R 1000:1000 "$d/icecast"        # TinyIce as 1000:1000
    # Prometheus as nobody: its data, and the password file it reads (600); the folder stays this user's, as kit.sh
    # writes prometheus.yml there at every run
    sudo chown -R 65534:65534 "$d/monitoring/prometheus/data" "$d/monitoring/prometheus/tinyice-password"
    sudo chown -R 472:0 "$d/monitoring/grafana/data"        # Grafana as 472
    sudo chown -R 1002:1003 "$d/$g/db"                       # MySQL as the stack's user: 1002:1003
fi

# What's left by hand, for the modules that are on
names="$SITE_HOST, www.$SITE_HOST"
on live && names="$names, $(val LIVE_HOST)"
on social && names="$names, postiz.$SITE_HOST"
on monitoring && names="$names, $(val GRAFANA_HOST)"
streamurl=""; on live && streamurl=" and set its Live stream URL to https://$(val LIVE_HOST)/stream-mp3"
cat <<EOF

Site folder ready: $SITE_DIR
Next:
EOF
[ "$(val TLS_RESOLVER)" = cf ] && ! grep -q '^CLOUDFLARE_DNS_API_TOKEN=.' "$SITE_DIR/secrets/traefik.env" && cat <<EOF
  0. Certificates: a Cloudflare API token that may edit the site's DNS (Zone, DNS, Edit) in CLOUDFLARE_DNS_API_TOKEN
     in secrets/traefik.env.
EOF
if [ "$(val TLS_RESOLVER)" = self ] && [ "$(val NTFY_URL)" = "" ]; then cat <<EOF
  1. A try-out: no DNS yet. Your browser reaches $SITE_HOST once your computer's hosts file points it (and the other
     names below) at this machine, e.g. "127.0.0.1 $(echo "$names" | tr -d ,)"; it warns about the certificate
     (Traefik's own) once. Later, for real: DNS, TLS_RESOLVER and NTFY_URL in site.env (the Setup guide, "Trying it
     at home first").
EOF
else cat <<EOF
  1. DNS: $names to this host (through Cloudflare if BEHIND_CLOUDFLARE=true). www. and http:// go to https://$SITE_HOST.
EOF
fi
cat <<EOF
  2. Start it: kit/kit.sh $SITE_DIR up -d
  3. Ghost: https://$SITE_HOST/ghost/ to make the owner account; upload the kit's theme (download it:
     https://github.com/puppi3-music/puppi3-creator-kit/releases/download/v$(cat "$KIT/VERSION")/puppi3-creator-kit-theme.zip)$streamurl;
     upload kit/redirects.yaml (Settings -> Labs -> Open -> Beta features -> Redirects).
EOF
if [ -n "$(val NTFY_URL)" ]; then cat <<EOF
  4. Phone notifications: subscribe to topic $(sed -n 's/^NTFY_TOPIC=//p' "$SITE_DIR/secrets/postiz.env") on $(val NTFY_URL).
EOF
fi
on social && cat <<EOF
  - Social: make your account at https://postiz.$SITE_HOST, then set POSTIZ_DISABLE_REGISTRATION=true in
    secrets/postiz.env; connect the networks (each one step by step: kit/docs/networks-guide.html); put Postiz's
    API key in POSTIZ_API_KEY; a Ghost custom integration's
    Admin API key in GHOST_ADMIN_API_KEY, and its webhook "Post published" to
    https://postiz.$SITE_HOST/ghost-webhook with secret GHOST_WEBHOOK_SECRET (in secrets/postiz.env). Ghost sends
    it only to a public address (postiz.$SITE_HOST must resolve to one from this machine). To try it first without
    posting anything: GHOST_BRIDGE_DRY_RUN=true in secrets/postiz.env.
    Then kit/kit.sh $SITE_DIR up -d again.
EOF
if on live; then cat <<EOF
  - Live: the streaming software sends Ogg to $(val LIVE_HOST) port $(val LIVE_PORT | grep . || echo 8222) (this host's own address if behind Cloudflare,
    which doesn't pass the port; straight to TinyIce: Traefik would drop the audio), mount /stream-ogg, user source, password TINYICE_SOURCE_PASSWORD from secrets/icecast.env.
    TinyIce's admin: http://tinyice.$(val LAN_DOMAIN) (home network), TINYICE_ADMIN_USER / TINYICE_ADMIN_PASSWORD.
    That port is all of TinyIce over plain http, its admin sign-in too: keep it to the addresses you stream from with a
    firewall rule, or LIVE_BIND in site.env (the Setup guide, Live).
EOF
else cat <<EOF
  - Live is off. To add it later: put live in MODULES in site.env, point $(val LIVE_HOST) at this host, run
    kit/kit.sh $SITE_DIR up -d, and set the theme's Live stream URL to https://$(val LIVE_HOST)/stream-mp3
    (TinyIce's passwords and config are made already).
EOF
fi
on monitoring && cat <<EOF
  - Monitoring: Grafana at https://$(val GRAFANA_HOST) or http://grafana.$(val LAN_DOMAIN) at home,
    user admin, password GRAFANA_ADMIN_PASSWORD in secrets/monitoring.env. Alerts go to the same ntfy topic.
EOF
true
