# Sourced by kit/test.sh and kit/demo/demo.sh: what a throwaway kit site on this computer needs, the same on Linux, a
# Mac, or Windows inside WSL2 (with Docker Desktop, or Docker's own engine on Linux). Expects $KIT, $S, $SP and die().
# Gives: sedi, need, port_free, hostcat, LOCAL_RANGES, FF (the stream's ffmpeg), the EXIT trap, and KIT_BUILD=1.

# Windows: the kit's scripts are bash, run inside WSL2, with the repo in WSL's own filesystem: on a Windows drive
# (/mnt/c/...) the site's folders can't keep their owners, and Postgres and MySQL refuse them
case "$(uname -s)" in
    Linux | Darwin) ;;
    *) die "run this inside WSL2 (Ubuntu, with Docker Desktop's WSL integration on), not $(uname -s)" ;;
esac
if grep -qi microsoft /proc/version 2>/dev/null; then
    case "$KIT" in /mnt/*) die "the repo is on a Windows drive ($KIT): clone it into WSL's own filesystem (e.g. ~/)" ;; esac
fi
docker info >/dev/null 2>&1 || die "can't reach Docker (is it running, and may this user use it?)"
# The bridge built from this repo's code, not the published image: these try the code as it is here
export KIT_BUILD=1

# sed -i that works with both GNU sed (Linux) and BSD sed (a Mac); the file is the last argument
sedi() { local f="${*: -1}"; sed -i.bak "$@" && rm -f "$f.bak"; }
# need <command> <Homebrew package> <apt package>
need() {
    command -v "$1" >/dev/null && return
    if [ "$(uname -s)" = Darwin ]; then die "needs $1 (brew install $2)"; else die "needs $1 (sudo apt install $3, or your system's package)"; fi
}
need python3 python python3
need curl curl curl
need openssl openssl openssl
need node node nodejs
need zip zip zip       # theme-zip.sh, for the kit's theme
need unzip unzip unzip
# Playwright needs Node.js 20 or newer (Ubuntu 24.04's own package is 18: nodejs.org or NodeSource has newer)
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] 2>/dev/null || die "needs Node.js 20 or newer (this is $(node -v))"
[ -d "$KIT/theme-test/node_modules/playwright" ] && (cd "$KIT/theme-test" &&
    node -e "const fs=require('fs'); process.exit(fs.existsSync(require('playwright').chromium.executablePath()) ? 0 : 1)") 2>/dev/null ||
    die "needs Playwright and its Chromium: (cd kit/theme-test && npm install && npx playwright install --with-deps chromium)"
# A port is free when nothing answers on it
port_free() { ! (: </dev/tcp/127.0.0.1/"$1") 2>/dev/null; }
# A file in the site's folder that a container wrote (on Linux, some are its user's only: Tinybird's tokens are root's)
hostcat() { cat "$1" 2>/dev/null || docker run --rm -v "$(dirname "$1"):/d:ro" alpine cat "/d/$(basename "$1")"; }
# Where this computer's requests reach Traefik from: Docker Desktop's machine (192.168.65.0/24), or on Linux a Docker
# network's gateway (172.16.0.0/12, then 192.168.0.0/16 once those run out) or loopback
LOCAL_RANGES="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8"

[ -e "$S" ] && die "$S is already there (a kept site?): kit/kit.sh $S down -v, then remove the folder (on Linux: sudo rm -rf $S)"
LP="${LIVE_PORT:-8222}"
for port in 80 443 "$LP"; do port_free "$port" || die "port $port is in use"; done
nets_before="$(docker network ls --format '{{.Name}}' | grep -xE 'proxy|monitoring' || true)"
KEEP=${KEEP:-0}
FF=""
cleanup() {
    [ -n "$FF" ] && kill "$FF" 2>/dev/null
    if [ "$KEEP" = 1 ]; then echo "kept: $S (kit/kit.sh $S down -v, then remove the folder)"; else
        "$KIT/kit.sh" "$S" down -v --remove-orphans >/dev/null 2>&1
        # on Linux some of it is the containers' users': a container removes what this user can't
        rm -rf "$S" 2>/dev/null || docker run --rm -v "$(dirname "$S"):/sites" alpine rm -rf "/sites/$(basename "$S")"
        for n in proxy monitoring; do
            grep -qx "$n" <<<"$nets_before" || docker network rm "$n" >/dev/null 2>&1
        done
    fi
    rm -rf "$SP"
}
trap cleanup EXIT
