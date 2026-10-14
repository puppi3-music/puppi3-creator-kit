#!/usr/bin/env bash
# Moves a kit site's data between its Docker host (the NAS: the stacks' containers and data folder) and Kubernetes,
# for a cloud burst and back. You run it (Claude never runs it against the real NAS or a real cluster):
#   k8s/migrate/to-cloud.sh <site folder> <overlay> --from [<user>@<host>:]<data folder> [-n] [-y]
#   k8s/migrate/to-nas.sh   <site folder> <overlay> --to   [<user>@<host>:]<data folder> [-n] [-y]
# <site folder>/<overlay>: the cluster side, as k8s/up.sh runs it (up.sh must have run: the site's up, empty, there).
# The Docker host: its DATA_DIR (e.g. nas:/srv/stacks), over ssh with sudo (the password from the
# Keychain item <ID_PREFIX>-nas, as deploy.sh keeps it, or asked), or a folder on this machine (the test's).
# -n: only check and print the steps. -y: don't ask. --no-start (to-nas): leave the NAS's apps stopped afterwards.
# Copies, for the modules in the site's MODULES: Ghost's MySQL database, its images, media and files (the bucket,
# or Ghost's volume without one), themes, settings and redirects; Postiz's and Temporal's Postgres databases,
# Postiz's uploads and the bridge's data/ (social); TinyIce's config and history (live); Tinybird's data (analytics);
# Prometheus's samples for the site's jobs (monitoring). Never Cloudflare: the DNS flip stays yours.
set -euo pipefail

K8S="$(cd "$(dirname "$0")/.." && pwd)"
WAY="${1:?}"; shift
case "$WAY" in to-cloud) WHERE=--from ;; to-nas) WHERE=--to ;; *) exit 2 ;; esac
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 2 ] || usage
SITE_DIR="$(cd "$1" && pwd)"; OVERLAY="$2"; shift 2
PLACE=; DRY=0; YES=0; NO_START=0
while [ $# -gt 0 ]; do
    case "$1" in "$WHERE") PLACE="${2:?$WHERE <data folder>}"; shift ;; -n) DRY=1 ;; -y|--yes) YES=1 ;; --no-start) NO_START=1 ;; *) usage ;; esac
    shift
done
[ -n "$PLACE" ] || usage
die() { echo "$WAY: $*" >&2; exit 1; }
[ -f "$SITE_DIR/site.env" ] || die "no site.env in $SITE_DIR"
[ -d "$K8S/overlays/$OVERLAY" ] || die "no overlay $OVERLAY in k8s/overlays/"
val() { sed -n "s/^$1=//p" "$SITE_DIR/site.env" | tail -1; }
NS="$(val ID_PREFIX)"; MODULES="$(val MODULES)"
[ -n "$NS" ] || die "site.env has no ID_PREFIX"
has() { case ",$MODULES," in *",$1,"*) true ;; *) false ;; esac; }
STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/kit-migrate.XXXXXX")"
step() { echo; echo "== $*"; }
note() { echo "   $*"; }
# Containers' and pods' helpers (busybox everywhere: the same tar, find and stat on both sides)
BOX=busybox:1.37.0
RCLONE=rclone/rclone:1.75.2
# the owner a folder's contents have (its first entry's, else its own): what copied files get
OWNER_SH='owner() { f=$(find "$1" -mindepth 1 -maxdepth 1 ! -name lost+found 2>/dev/null | head -n 1); stat -c %u:%g "${f:-$1}"; }'
COUNT_SH='count() { find "$1" -type f ! -path "*/lost+found/*" 2>/dev/null | wc -l | tr -d " "; }'
mismatch=0
same() { # <what> <here> <there>
    if [ "$2" = "$3" ]; then note "$1: $2 = $3"; else note "$1: $2 -> $3  DIFFERENT"; mismatch=$((mismatch + 1)); fi
}

# ---- The Docker host: here, or over ssh with sudo --------------------------------------------------------------
HOST=; DATA="$PLACE"
case "$PLACE" in /*|.*) ;; *:*) HOST="${PLACE%%:*}"; DATA="${PLACE#*:}" ;; esac
if [ -z "$HOST" ]; then DATA="$(cd "$DATA" && pwd)" || die "no folder $PLACE"; fi
case "$DATA" in /*) ;; *) die "the data folder must be an absolute path on $HOST" ;; esac
SOCK="$TMP/ssh.sock"; PW=; SUDO_PW=0
cleanup() {
    [ ! -S "$SOCK" ] || ssh -o ControlPath="$SOCK" -O exit "$HOST" 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT
if [ -n "$HOST" ]; then
    user="${HOST%@*}"; [ "$user" != "$HOST" ] || user="$(id -un)"
    PW="$(security find-generic-password -s "$NS-nas" -a "$user" -w 2>/dev/null || true)"
    [ -n "$PW" ] || { read -rsp "Password for $HOST (ssh and sudo): " PW; echo; }
    printf '#!/bin/sh\nprintf "%%s\\n" "$KIT_NAS_PASS"\n' >"$TMP/askpass"; chmod 700 "$TMP/askpass"
    KIT_NAS_PASS="$PW" SSH_ASKPASS="$TMP/askpass" SSH_ASKPASS_REQUIRE=force \
        ssh -fN -o ControlMaster=yes -o ControlPath="$SOCK" -o ControlPersist=4h \
            -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 -o ConnectTimeout=15 "$HOST" \
        || die "couldn't log in to $HOST"
    # sudo without a password (NOPASSWD) would pass the password line on to the command, into a stream: only send
    # it when sudo asks
    if ssh -o ControlPath="$SOCK" "$HOST" 'sudo -k -n true' </dev/null 2>/dev/null; then SUDO_PW=0; else SUDO_PW=1; fi
fi
# on_nas <script>: runs a bash script as root on the Docker host; stdin goes through (on_nas0: none)
on_nas() {
    if [ -z "$HOST" ]; then bash -c "$1"; return; fi
    local b64; b64="$(printf '%s' "$1" | base64 | tr -d '\n')"
    if [ "$SUDO_PW" = 1 ]; then
        # sudo -k -S reads the password line (a byte at a time) and leaves the rest of stdin to the command
        { printf '%s\n' "$PW"; cat; } | ssh -o ControlPath="$SOCK" "$HOST" "sudo -k -S -p '' bash -c \"\$(echo $b64 | base64 -d)\""
    else
        ssh -o ControlPath="$SOCK" "$HOST" "sudo -n bash -c \"\$(echo $b64 | base64 -d)\""
    fi
}
on_nas0() { on_nas "$1" </dev/null; }
q() { printf '%q' "$1"; }
# nas_box <docker run options> <busybox script> [args]: a throwaway busybox there, the data folder at /d
nas_box() {
    local opts=$1 script=$2; shift 2
    local a=""; for x in "$@"; do a="$a $(q "$x")"; done
    on_nas "docker run --rm -i -v $(q "$DATA"):/d $opts $BOX sh -c $(q "$OWNER_SH; $COUNT_SH; $script") sh$a"
}

# The site's containers there: by Compose service, in the site's project (the kit's Compose) or the stacks' own
# (a host that runs each stack on its own: one project per stack); staging's and other sites' are other projects
on_nas0 "docker ps -a --format '{{.Names}}|{{.Label \"com.docker.compose.service\"}}|{{.Label \"com.docker.compose.project\"}}|{{.State}}'" \
    >"$TMP/containers" || die "couldn't list the containers on ${HOST:-this machine} (docker there?)"
ctr() { awk -F'|' -v s="$1" -v p=" $NS ghost puppi3 postiz icecast monitoring " '$2 == s && index(p, " " $3 " ") { print $1 }' "$TMP/containers" | head -n 1; }
running() { awk -F'|' -v c="$1" '$1 == c { print $4 }' "$TMP/containers" | grep -qx running; }
GHOST_C="$(ctr ghost)"; [ -n "$GHOST_C" ] || die "no Ghost container of $NS's on ${HOST:-this machine}"
on_nas0 "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(q "$GHOST_C")" >"$TMP/ghost.env"
genv() { sed -n "s/^$1=//p" "$TMP/ghost.env" | head -n 1; }
DB_C="$(genv database__connection__host)"; DB_NAME="$(genv database__connection__database)"
[ -n "$DB_C" ] && [ -n "$DB_NAME" ] || die "can't tell Ghost's database from $GHOST_C's environment"
grep -q "^$DB_C|" "$TMP/containers" || die "Ghost's MySQL, $DB_C, isn't a container there"
# The Ghost stack's folder in the data folder, where Ghost's content is mounted from: ghost/ (puppi3/, its old name,
# on a host that ran the stacks before kit 1.2.0, and in a kit site made before it)
GSRC="$(on_nas0 "docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/var/lib/ghost/content\"}}{{.Source}}{{end}}{{end}}' $(q "$GHOST_C")")"
case "$GSRC" in "$DATA"/*/ghost/content) G="${GSRC#"$DATA"/}"; G="${G%/ghost/content}" ;;
    *) die "Ghost's content (${GSRC:-not mounted}) isn't in $DATA's Ghost folder" ;; esac

# ---- The cluster --------------------------------------------------------------------------------------------
case "$OVERLAY" in
    local|k3d-*)
        export KUBECONFIG; KUBECONFIG="$(k3d kubeconfig write creator-kit 2>/dev/null)" || die "no k3d cluster"
        [ "$(kubectl config current-context)" = k3d-creator-kit ] || die "not k3d-creator-kit" ;;
esac
CTX="$(kubectl config current-context)"
k() { kubectl -n "$NS" "$@"; }
k get deploy/ghost >/dev/null 2>&1 || die "no Ghost in namespace $NS on $CTX: k8s/up.sh $SITE_DIR $OVERLAY first"
k get deploy/ghost -o json >"$TMP/ghost-deploy.json"
BUCKET=0; grep -q '"storage__active"' "$TMP/ghost-deploy.json" && BUCKET=1

# ---- Ghost's version: a database goes only to the same Ghost or a newer one (Ghost migrates it up, never down)
v_nas="$(genv GHOST_VERSION)"; v_k8s="$(k exec deploy/ghost -c ghost -- printenv GHOST_VERSION 2>/dev/null || true)"
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }
if [ "$WAY" = to-cloud ]; then
    [ -z "$v_k8s" ] || ! older "$v_k8s" "$v_nas" || die "the cluster's Ghost ($v_k8s) is older than the NAS's ($v_nas): pull the newer image first"
else
    [ -z "$v_k8s" ] || ! older "$v_nas" "$v_k8s" || die "the NAS's Ghost ($v_nas) is older than the cluster's ($v_k8s): update it first (docker compose pull)"
fi

# ---- What moves --------------------------------------------------------------------------------------------
# folder | NAS place (data folder path, or vol:<service>:<mount>) | claim | path in it | the workload using it
{
    for d in themes settings data; do echo "Ghost's $d|$G/ghost/content/$d|ghost-content|$d|deploy/ghost"; done
    [ "$BUCKET" = 1 ] || for d in images media files; do echo "Ghost's $d|$G/ghost/content/$d|ghost-content|$d|deploy/ghost"; done
    if has social; then
        echo "the bridge's data|postiz/ghost-bridge/data|postiz-ghost-bridge|.|deploy/postiz-ghost-bridge"
        echo "Postiz's config|postiz/config|postiz|config|deploy/postiz"
        echo "Postiz's uploads|postiz/uploads|postiz|uploads|deploy/postiz"
    fi
    if has live; then
        echo "TinyIce's config|icecast/tinyice-data|tinyice|data|deploy/tinyice"
        echo "TinyIce's history|icecast/tinyice|tinyice|lib|deploy/tinyice"
    fi
    if has analytics; then
        echo "Tinybird's ClickHouse|vol:tinybird-local:/var/lib/clickhouse|clickhouse-tinybird-local-0|.|statefulset/tinybird-local"
        echo "Tinybird's Redis|vol:tinybird-local:/redis-data|redis-tinybird-local-0|.|statefulset/tinybird-local"
    fi
} >"$TMP/folders"
# a volume's name there (vol:<service>:<mount>), from the container that mounts it
vol() {
    local s="${1#vol:}"; local c; c="$(ctr "${s%%:*}")"; [ -n "$c" ] || return 1
    on_nas0 "docker inspect -f '{{range .Mounts}}{{if eq .Destination \"${s#*:}\"}}{{.Name}}{{end}}{{end}}' $(q "$c")"
}
PG=; TP=; has social && { PG="$(ctr postiz-postgres)"; TP="$(ctr postiz-temporal-postgres)"; }
PROM=; has monitoring && { PROM="$(ctr prometheus)"; }
JOBS="$NS-pets|traefik|tinyice"

# ---- The plan ----------------------------------------------------------------------------------------------
if [ "$WAY" = to-cloud ]; then FROM="${HOST:-this machine}:$DATA"; TO="$CTX, namespace $NS ($OVERLAY)"
else FROM="$CTX, namespace $NS ($OVERLAY)"; TO="${HOST:-this machine}:$DATA"; fi
echo "$WAY: $NS from $FROM"
echo "        to $TO"
echo "Ghost ${v_nas:-?} on the NAS, ${v_k8s:-?} in the cluster; its database $DB_NAME in $DB_C"
echo "Moves: Ghost's database$( [ "$BUCKET" = 1 ] && echo ", its images, media and files (the bucket)")"
while IFS='|' read -r what _; do echo "       $what"; done <"$TMP/folders"
has social && echo "       Postiz's database ($PG) and Temporal's ($TP)"
[ -z "$PROM" ] || echo "       Prometheus's samples of jobs $JOBS ($PROM)"
echo
if [ "$WAY" = to-cloud ]; then
    echo "On the NAS: Postiz, Temporal and the bridge stop (they move; two would post twice) and stay stopped;"
    echo "Tinybird stops while its data is copied, then starts again. Ghost keeps serving visitors: from now"
    echo "until the DNS flip, no edits in Ghost Admin (they'd stay behind)."
    echo "In the cluster: the site's apps stop while their data is replaced, then k8s/up.sh starts them again."
else
    echo "In the cluster: Postiz, Temporal and the bridge stop (they move) and stay stopped; Tinybird and TinyIce stop"
    echo "while their data is copied, then start again. Ghost keeps serving; no edits in Ghost Admin from now on."
    echo "On the NAS: Ghost ($GHOST_C), Tinybird, TinyIce, Postiz, Temporal and the bridge stop while their data is"
    echo "replaced, then start again. What they had goes to $DATA/.migrate-backups/$STAMP/ first."
fi
if [ "$DRY" = 1 ]; then echo; echo "(-n: nothing done)"; exit 0; fi
if [ "$YES" != 1 ]; then
    echo; read -r -p "Go ahead? [y/N] " a; [ "$a" = y ] || exit 1
fi

# ---- Cluster helpers ------------------------------------------------------------------------------------------
LABEL=app.kubernetes.io/name=creator-kit-migrate
pod_ready() { k wait --for=condition=Ready "pod/$1" --timeout=300s >/dev/null || { k describe pod "$1" | tail -20; die "pod $1 didn't start"; }; }
# claim_pod <claim>: a busybox pod with the claim at /v (its workload stopped: a volume is one node's at a time)
claim_pod() {
    local n="migrate-$1"
    k get pod "$n" >/dev/null 2>&1 || cat <<EOF | k apply -f - >/dev/null
{"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "$n", "labels": {"app.kubernetes.io/name": "creator-kit-migrate"}},
 "spec": {"restartPolicy": "Never", "terminationGracePeriodSeconds": 0,
  "containers": [{"name": "box", "image": "$BOX", "command": ["sleep", "86400"], "volumeMounts": [{"name": "v", "mountPath": "/v"}]}],
  "volumes": [{"name": "v", "persistentVolumeClaim": {"claimName": "$1"}}]}}
EOF
    pod_ready "$n"
}
in_claim() { local c=$1 s=$2; shift 2; k exec -i "migrate-$c" -c box -- sh -c "$OWNER_SH; $COUNT_SH; $s" sh "$@"; }
# The toolbox: MySQL's, Postgres's and rclone's clients, reaching the databases and the bucket the way Ghost's pod does
# (its service account, hosts file and sidecars: the Cloud SQL proxy on GKE), with Ghost's database login
toolbox() {
    k get pod migrate >/dev/null 2>&1 && return 0
    k get deploy,statefulset,job -o json >"$TMP/workloads.json"
    python3 - "$TMP/ghost-deploy.json" "$TMP/workloads.json" "$RCLONE" "$(has social && echo 1)" <<'PY' | k apply -f - >/dev/null
import json, re, sys
d, wl, rclone, social = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3], sys.argv[4]
spec = d["spec"]["template"]["spec"]
ghost = next(c for c in spec["containers"] if c["name"] == "ghost")
# up.sh's ConfigMaps and Secrets carry a hash in their names: take the names from what uses them
def ref(obj, kind, key):
    if isinstance(obj, dict):
        r = obj.get(kind)
        if isinstance(r, dict) and r.get("key") == key: return r["name"]
        for v in obj.values():
            n = ref(v, kind, key)
            if n: return n
    elif isinstance(obj, list):
        for v in obj:
            n = ref(v, kind, key)
            if n: return n
sleep = ["sleep", "86400"]
s3 = [{"configMapRef": {"name": ref(ghost, "configMapKeyRef", "S3_BUCKET")}}] if ref(ghost, "configMapKeyRef", "S3_BUCKET") else []
s3 += [e for e in ghost.get("envFrom", []) if re.match(r"^s3(-|$)", e.get("secretRef", {}).get("name", ""))]
cs = [{"name": "mysql", "image": "mysql:8.0.46", "command": sleep,
       "env": [e for e in ghost.get("env", []) if e["name"].startswith("database__")]},
      {"name": "rclone", "image": rclone, "command": sleep, "volumeMounts": [{"name": "stage", "mountPath": "/stage"}],
       "envFrom": s3}]
if social:
    pz = ref(wl, "secretKeyRef", "POSTIZ_DB_PASSWORD")
    if not pz: sys.exit("no workload names Postiz's database password (social module up?)")
    cs.append({"name": "postgres", "image": "postgres:17.11-alpine", "command": sleep,
               "envFrom": [{"secretRef": {"name": pz}}]})
pod = {"apiVersion": "v1", "kind": "Pod",
       "metadata": {"name": "migrate", "labels": {"app.kubernetes.io/name": "creator-kit-migrate"}},
       "spec": {"restartPolicy": "Never", "terminationGracePeriodSeconds": 0, "containers": cs,
                "volumes": [{"name": "stage", "emptyDir": {}}]}}
for k in ("serviceAccountName", "hostAliases"):
    if k in spec: pod["spec"][k] = spec[k]
# sidecars only (an init container that keeps running); not Ghost's waits
side = [c for c in spec.get("initContainers", []) if c.get("restartPolicy") == "Always"]
if side: pod["spec"]["initContainers"] = side
if "annotations" in d["spec"]["template"]["metadata"]:
    pod["metadata"]["annotations"] = d["spec"]["template"]["metadata"]["annotations"]
print(json.dumps(pod))
PY
    pod_ready migrate
}
tb() { local c=$1; shift; k exec -i migrate -c "$c" -- "$@"; }
# Workloads stopped (scaled to 0), with the number they had ($TMP/replicas), to start them again
: >"$TMP/replicas"
had() { awk -v w="$1" '$1 == w { print $2 }' "$TMP/replicas"; }
stop_k() {
    local w n
    for w in "$@"; do
        n="$(k get "$w" -o jsonpath='{.spec.replicas}' 2>/dev/null)" || continue
        [ -n "$(had "$w")" ] || echo "$w $n" >>"$TMP/replicas"
        k scale "$w" --replicas=0 >/dev/null
    done
    for w in "$@"; do
        [ -n "$(had "$w")" ] || continue
        k wait --for=delete pod -l "app=${w#*/}" --timeout=300s >/dev/null 2>&1 || true
    done
}
start_k() { local w; for w in "$@"; do [ -z "$(had "$w")" ] || k scale "$w" --replicas="$(had "$w")" >/dev/null; done; }
done_pods() { k delete pod -l "$LABEL" --wait=false >/dev/null 2>&1 || true; }

# NAS containers stopped ($STOPPED, in that order), to start again
STOPPED=
stop_nas() {
    local s c
    for s in "$@"; do
        c="$(ctr "$s")"; [ -n "$c" ] && running "$c" || continue
        on_nas0 "docker stop $(q "$c")" >/dev/null && STOPPED="$STOPPED $c"
    done
}
start_nas() {
    local c
    for c in "$@"; do on_nas0 "docker start $(q "$c")" >/dev/null && note "started $c"; done
}

at() { [ "$1" = . ] || echo "/$1"; }   # a path in a volume, for the steps
# ---- Copying ------------------------------------------------------------------------------------------------
# NAS -> cluster: the folder (or volume) as a tar stream, into the claim's path, which it replaces
nas_read() { # <place>
    case "$1" in
        vol:*) local v; v="$(vol "$1")" || return 1; nas_box "-v $(q "$v"):/v:ro" 'tar -c -C /v --exclude ./lost+found .' </dev/null ;;
        *) nas_box "" 'tar -c -C "/d/$1" .' "$1" </dev/null ;;
    esac
}
nas_count() {
    case "$1" in
        vol:*) local v; v="$(vol "$1")" || return 1; nas_box "-v $(q "$v"):/v:ro" 'count /v' </dev/null ;;
        *) nas_box "" '[ -d "/d/$1" ] && count "/d/$1" || echo 0' "$1" </dev/null ;;
    esac
}
# cluster -> NAS: replaces the folder (or volume), keeping what it had in .migrate-backups/<stamp>/
nas_write() { # <place> (tar on stdin)
    case "$1" in
        vol:*)
            local v; v="$(vol "$1")" || return 1
            nas_box "-v $(q "$v"):/v" 'set -e; o=$(owner /v); mkdir -p "/d/.migrate-backups/$1"
                tar -c -C /v --exclude ./lost+found -f "/d/.migrate-backups/$1/$2.tar" .
                find /v -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +
                tar -x -C /v; chown -R "$o" /v; count /v' "$STAMP" "$v" ;;
        *)
            nas_box "" 'set -e; t="/d/$1"; b="/d/.migrate-backups/$2/$1"
                if [ -d "$t" ]; then o=$(owner "$t"); mkdir -p "${b%/*}"; mv "$t" "$b"; else o=$(owner "${t%/*}"); fi
                mkdir -p "$t"; tar -x -C "$t"; chown -R "$o" "$t"; count "$t"' "$1" "$STAMP" ;;
    esac
}
k_write() { # <claim> <path> (tar on stdin): replaces the path's contents
    in_claim "$1" 'set -e; t="/v/$1"
        if [ -d "$t" ]; then o=$(owner "$t"); find "$t" -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +
        else o=$(owner /v); mkdir -p "$t"; fi
        tar -x -C "$t"; chown -R "$o" "$t"; count "$t"' "$2"
}
k_read() { in_claim "$1" 'tar -c -C "/v/$1" --exclude ./lost+found .' "$2" </dev/null; }
k_count() { in_claim "$1" '[ -d "/v/$1" ] && count "/v/$1" || echo 0' "$2" </dev/null; }
# Ghost's own folders, read from the running Ghost (to-nas: the cloud's site keeps serving)
ghost_read() { k exec deploy/ghost -c ghost -- sh -c 'tar -c -C "/var/lib/ghost/content/$1" .' sh "$1" </dev/null; }
ghost_count() { k exec deploy/ghost -c ghost -- sh -c '[ -d "/var/lib/ghost/content/$1" ] && find "/var/lib/ghost/content/$1" -type f | wc -l | tr -d " " || echo 0' sh "$1" </dev/null; }

# ---- Databases ----------------------------------------------------------------------------------------------
NAS_MYSQL='MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD'
K_MYSQL='MYSQL_PWD="$database__connection__password"; export MYSQL_PWD; set -- -h "$database__connection__host" -u "$database__connection__user" "$database__connection__database"'
DUMP_OPTS='--single-transaction --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4'
# empties a database (its tables, not the database: the cloud's login may not make databases) before a restore
DROP_ALL="SET SESSION group_concat_max_len = 1000000; SELECT CONCAT('SET FOREIGN_KEY_CHECKS=0;', IFNULL(GROUP_CONCAT(CONCAT('DROP TABLE IF EXISTS ', CHAR(96), table_name, CHAR(96)) SEPARATOR ';'), 'DO 0'), ';') FROM information_schema.tables WHERE table_schema = DATABASE()"
nas_mysql() { on_nas "docker exec -i $(q "$DB_C") sh -c $(q "$NAS_MYSQL; $1") sh $(q "$DB_NAME")"; }
k_mysql() { tb mysql sh -c "$K_MYSQL; $1"; }
GHOST_COUNTS="SELECT CONCAT((SELECT COUNT(*) FROM posts), ' posts, ', (SELECT COUNT(*) FROM members), ' members, ', (SELECT COUNT(*) FROM users), ' staff')"
# Postgres: Postiz's (postiz) and Temporal's (temporal), each with its own login
nas_pg() { on_nas "docker exec -i -e PGUSER=$(q "$2") -e PGDATABASE=$(q "$2") $(q "$1") sh -c $(q "$3")"; }
k_pg() { # <host> <db> <script>: login <db> with its password from Secret postiz
    local pw=POSTIZ_DB_PASSWORD; [ "$2" = postiz ] || pw=TEMPORAL_DB_PASSWORD
    tb postgres sh -c "PGPASSWORD=\"\$$pw\" PGHOST=$1 PGUSER=$2 PGDATABASE=$2; export PGPASSWORD PGHOST PGUSER PGDATABASE; $3"
}
PG_DUMP='pg_dump --no-owner --no-privileges'
# pg_dump 17 sets transaction_timeout, which Postgres 16 (Temporal's on the NAS) doesn't know
PG_RESTORE="sed '/^SET transaction_timeout = /d' | psql -q -v ON_ERROR_STOP=1 >/dev/null"
PG_EMPTY="PGOPTIONS='-c client_min_messages=warning' psql -q -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public' >/dev/null"
pg_count() { # <script runner...>: the tables' exact row counts, summed
    "$@" "psql -tAc \"SELECT string_agg(format('SELECT COUNT(*) FROM %I.%I', schemaname, tablename), ' UNION ALL ') FROM pg_tables WHERE schemaname = 'public'\" | { read -r s; [ -n \"\$s\" ] && psql -tAc \"SELECT SUM(count) FROM (\$s) t\" || echo 0; }"
}

# ---- to-cloud ---------------------------------------------------------------------------------------------------
to_cloud() {
    local db host c what place claim path work n d stopped=
    if has social; then
        step "Stopping the NAS's social side (it moves)"
        stop_nas postiz-ghost-bridge postiz postiz-temporal; stopped="$STOPPED"; STOPPED=
        [ -z "$stopped" ] && note "nothing running" || note "stopped$stopped (to undo: docker start$stopped)"
    fi

    step "Stopping the site's apps in the cluster"
    stop_k deploy/ghost deploy/postiz deploy/postiz-temporal deploy/postiz-ghost-bridge deploy/tinyice \
        statefulset/tinybird-local deploy/traffic-analytics
    toolbox

    step "Ghost's database: $DB_NAME ($DB_C) -> the cluster's"
    k_mysql "mysql -N -e \"$DROP_ALL\" \"\$@\" | mysql \"\$@\"" </dev/null
    nas_mysql "mysqldump -uroot $DUMP_OPTS \"\$1\"" </dev/null | k_mysql 'mysql "$@"'
    same "rows" "$(nas_mysql "mysql -uroot -N -e \"$GHOST_COUNTS\" \"\$1\"" </dev/null)" \
        "$(k_mysql "mysql -N -e \"$GHOST_COUNTS\" \"\$@\"" </dev/null)"

    if has social; then
        for db in postiz temporal; do
            if [ "$db" = postiz ]; then c="$PG"; host=postiz-postgres; else c="$TP"; host=postiz-temporal-postgres; fi
            step "$db's database ($c) -> the cluster's"
            [ -n "$c" ] || { note "no such Postgres on the NAS: skipped"; continue; }
            k_pg "$host" "$db" "$PG_EMPTY" </dev/null
            nas_pg "$c" "$db" "$PG_DUMP" </dev/null | k_pg "$host" "$db" "$PG_RESTORE"
            same "rows" "$(pg_count nas_pg "$c" "$db" </dev/null)" "$(pg_count k_pg "$host" "$db" </dev/null)"
        done
    fi

    if [ "$BUCKET" = 1 ]; then
        step "Ghost's images, media and files -> the bucket"
        n=0; for d in images media files; do n=$((n + $(nas_count "$G/ghost/content/$d"))); done
        nas_box "" 'cd "/d/$1/ghost/content"; set --; for d in images media files; do [ -d "$d" ] && set -- "$@" "$d"; done
            [ $# = 0 ] && exec tar -c -T /dev/null; exec tar -c "$@"' "$G" </dev/null |
            tb rclone sh -c 'set -e; rm -rf /stage/content; mkdir -p /stage/content; tar -x -C /stage/content
                '"$RCLONE_ENV"'
                rclone sync /stage/content "b:$S3_BUCKET/content" --checksum
                rclone lsf -R --files-only "b:$S3_BUCKET/content" | wc -l | tr -d " "; rm -rf /stage/content' >"$TMP/n"
        same "files" "$n" "$(tail -n 1 "$TMP/n")"
    fi

    while IFS='|' read -r what place claim path work <&3; do
        step "$what -> volume $claim$(at "$path")"
        if [ "${place#vol:}" != "$place" ]; then
            vol "$place" >/dev/null || { note "no such volume on the NAS: skipped"; continue; }
            # Tinybird's files only while it's stopped there (it starts again after)
            c="$(ctr tinybird-local)"
            if running "$c" && [ -z "$STOPPED" ]; then stop_nas tinybird-local; note "stopped$STOPPED on the NAS meanwhile"; fi
        fi
        claim_pod "$claim"
        n="$(nas_count "$place")"
        same "files" "$n" "$(nas_read "$place" | k_write "$claim" "$path")"
    done 3<"$TMP/folders"
    [ -z "$STOPPED" ] || start_nas $STOPPED

    if [ -n "$PROM" ]; then
        step "Prometheus's samples ($JOBS) -> the cluster's"
        on_nas0 "docker exec $(q "$PROM") promtool tsdb dump-openmetrics --match='{job=~\"$JOBS\"}' /prometheus" >"$TMP/prom.om" \
            || die "couldn't dump Prometheus's samples on the NAS"
        prom_in "$TMP/prom.om"
    fi

    step "Done copying: the site starts again (k8s/up.sh)"
    done_pods
    # Ghost and the bridge start with Tinybird's tokens as Tinybird has them now: tb-setup makes the Secret again
    k delete secret tinybird-tokens --ignore-not-found >/dev/null
    # this Ghost's site_uuid is the NAS's now: up.sh asks it again for the dashboards
    rm -f "$SITE_DIR/data/k8s/ghost.env"
    # TinyIce first, so up.sh reads its mounts from the config that came across
    if has live; then start_k deploy/tinyice; k rollout status deploy/tinyice --timeout=300s >/dev/null 2>&1 || true; fi
    "$K8S/up.sh" "$SITE_DIR" "$OVERLAY" --yes
    echo
    echo "Moved. Check the site in the cluster before the DNS flip (curl --connect-to $(val SITE_HOST):443:<load balancer>:443 ...),"
    echo "then point Cloudflare at the cluster's load balancer. The NAS keeps its copy; its social side stays stopped."
}

prom_in() { # <file>: blocks from the samples, into the cluster's Prometheus (it loads them within a minute or two)
    local lines; lines="$(grep -vc '^#' "$1" || true)"
    [ "$lines" -gt 0 ] || { note "no samples"; return 0; }
    k exec -i statefulset/prometheus -c prometheus -- sh -c 'cat >/tmp/migrate.om
        promtool tsdb create-blocks-from openmetrics --max-block-duration=744h /tmp/migrate.om /prometheus >/dev/null; s=$?
        rm -f /tmp/migrate.om; exit $s' <"$1"
    note "$lines samples"
}

# ---- to-nas -------------------------------------------------------------------------------------------------------
to_nas() {
    local db host c what place claim path work n d last_claim= last_work= since lines
    local backup="$DATA/.migrate-backups/$STAMP"
    if has social; then
        step "Stopping the cluster's social side (it moves)"
        stop_k deploy/postiz-ghost-bridge deploy/postiz deploy/postiz-temporal
        note "to undo: k8s/up.sh $SITE_DIR $OVERLAY"
    fi

    step "Stopping the NAS's apps (their data is replaced)"
    stop_nas postiz-ghost-bridge postiz postiz-temporal ghost tinyice traffic-analytics tinybird-local
    [ -z "$STOPPED" ] && note "nothing running" || note "stopped$STOPPED"
    on_nas0 "mkdir -p $(q "$backup")"
    toolbox

    step "Ghost's database: the cluster's -> $DB_NAME ($DB_C)"
    on_nas0 "docker exec $(q "$DB_C") sh -c $(q "$NAS_MYSQL; mysqldump -uroot $DUMP_OPTS \"\$1\"") sh $(q "$DB_NAME") | gzip >$(q "$backup/$DB_NAME.sql.gz")"
    note "the NAS's was kept: $backup/$DB_NAME.sql.gz"
    nas_mysql 'mysql -uroot -e "CREATE DATABASE IF NOT EXISTS \`$1\` CHARACTER SET utf8mb4"
        mysql -uroot -N -e "'"$DROP_ALL"'" "$1" | mysql -uroot "$1"' </dev/null
    k_mysql "mysqldump $DUMP_OPTS \"\$@\"" </dev/null | nas_mysql 'mysql -uroot "$1"'
    same "rows" "$(k_mysql "mysql -N -e \"$GHOST_COUNTS\" \"\$@\"" </dev/null)" \
        "$(nas_mysql "mysql -uroot -N -e \"$GHOST_COUNTS\" \"\$1\"" </dev/null)"

    if has social; then
        for db in postiz temporal; do
            if [ "$db" = postiz ]; then c="$PG"; host=postiz-postgres; else c="$TP"; host=postiz-temporal-postgres; fi
            step "$db's database: the cluster's -> $c"
            [ -n "$c" ] || { note "no such Postgres on the NAS: skipped"; continue; }
            on_nas0 "docker exec -e PGUSER=$db -e PGDATABASE=$db $(q "$c") $PG_DUMP | gzip >$(q "$backup/$db.sql.gz")"
            nas_pg "$c" "$db" "$PG_EMPTY" </dev/null
            k_pg "$host" "$db" "$PG_DUMP" </dev/null | nas_pg "$c" "$db" "$PG_RESTORE"
            same "rows" "$(pg_count k_pg "$host" "$db" </dev/null)" "$(pg_count nas_pg "$c" "$db" </dev/null)"
        done
    fi

    if [ "$BUCKET" = 1 ]; then
        step "The bucket -> Ghost's images, media and files"
        tb rclone sh -c 'set -e; rm -rf /stage/content; mkdir -p /stage/content
            '"$RCLONE_ENV"'
            rclone copy "b:$S3_BUCKET/content" /stage/content --checksum' </dev/null
        for d in images media files; do
            n="$(tb rclone sh -c 'mkdir -p "/stage/content/$1"; find "/stage/content/$1" -type f | wc -l | tr -d " "' sh "$d" </dev/null)"
            same "$d" "$n" "$(tb rclone tar -c -C "/stage/content/$d" . </dev/null | nas_write "$G/ghost/content/$d")"
        done
        tb rclone rm -rf /stage/content </dev/null
    fi

    # (a volume's pod and workload stay as they are until the next folder needs another)
    next_claim() {
        [ -z "$last_claim" ] || [ "$last_claim" = "$1" ] || k delete pod "migrate-$last_claim" --wait=true >/dev/null
        if [ -n "$last_work" ] && [ "$last_work" != "$2" ]; then
            case "$last_work" in deploy/postiz*) ;; *) start_k "$last_work" ;; esac   # the social side stays stopped
        fi
        last_claim="$1"; last_work="$2"
    }
    while IFS='|' read -r what place claim path work <&3; do
        step "volume $claim$(at "$path") -> $what"
        if [ "${place#vol:}" != "$place" ]; then vol "$place" >/dev/null || { note "no such volume on the NAS: skipped"; continue; }; fi
        if [ "$work" = deploy/ghost ]; then
            # from the running Ghost: the cloud's site keeps serving
            same "files" "$(ghost_count "$path")" "$(ghost_read "$path" | nas_write "$place")"
            continue
        fi
        next_claim "$claim" "$work"
        stop_k "$work"
        claim_pod "$claim"
        same "files" "$(k_count "$claim" "$path")" "$(k_read "$claim" "$path" | nas_write "$place")"
    done 3<"$TMP/folders"
    next_claim "" ""

    if has analytics; then
        step "Tinybird's tokens"
        local tokens="$DATA/$G/tinybird/tokens.env"
        k get secret tinybird-tokens -o json | python3 -c 'import base64, json, sys
d = json.load(sys.stdin)["data"]
print("# Generated by tb-setup - do not edit, do not share")
for k in ("tinybird__workspaceId", "tinybird__adminToken", "TINYBIRD_TRACKER_TOKEN"): print(f"{k}={base64.b64decode(d[k]).decode()}")' >"$TMP/tokens.env"
        if on_nas0 "cat $(q "$tokens") 2>/dev/null || true" | grep -v '^#' | cmp -s - <(grep -v '^#' "$TMP/tokens.env"); then
            note "the same as the NAS's"
        else
            on_nas0 "cp -p $(q "$tokens") $(q "$backup/tokens.env") 2>/dev/null || true"
            on_nas "umask 077; mkdir -p $(q "${tokens%/*}"); cat >$(q "$tokens")" <"$TMP/tokens.env"
            note "the NAS's tokens.env now holds the cluster's: Ghost, traffic-analytics and the bridge read it only when"
            note "they're made, so recreate them (the Ghost and postiz stacks: docker compose up -d)"
        fi
    fi

    if [ -n "$PROM" ]; then
        step "Prometheus's samples ($JOBS) since the cluster's Prometheus began -> $PROM"
        since="$(k get pvc data-prometheus-0 -o jsonpath='{.metadata.creationTimestamp}')"
        since="$(python3 -c 'import datetime, sys; print(int(datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000))' "$since")"
        k exec statefulset/prometheus -c prometheus -- promtool tsdb dump-openmetrics --min-time="$since" \
            --match="{job=~\"$JOBS\"}" /prometheus >"$TMP/prom.om" </dev/null || die "couldn't dump the cluster's Prometheus"
        lines="$(grep -vc '^#' "$TMP/prom.om" || true)"
        if [ "$lines" -gt 0 ]; then
            on_nas "docker exec -i $(q "$PROM") sh -c 'cat >/tmp/migrate.om
                promtool tsdb create-blocks-from openmetrics --max-block-duration=744h /tmp/migrate.om /prometheus >/dev/null; s=\$?
                rm -f /tmp/migrate.om; exit \$s'" <"$TMP/prom.om"
        fi
        note "$lines samples"
    fi

    step "Done copying: the NAS's apps start again"
    done_pods
    # in the order they need each other (what was running, and the social side, which moves home)
    local order=" $STOPPED " s
    has social && for s in postiz-temporal postiz postiz-ghost-bridge; do
        c="$(ctr "$s")"; [ -z "$c" ] || case "$order" in *" $c "*) ;; *) order="$order$c " ;; esac
    done
    local start=
    for s in tinybird-local traffic-analytics ghost tinyice postiz-temporal postiz postiz-ghost-bridge; do
        c="$(ctr "$s")"; [ -n "$c" ] && case "$order" in *" $c "*) start="$start $c" ;; esac
    done
    if [ "$NO_START" = 1 ]; then note "left stopped (--no-start): docker start$start"; else start_nas $start; fi
    has monitoring && note "Grafana's grafana_ro lost its SELECT on Postiz's tables (they're new): the kit's Compose gives it again at its next up"
    echo
    echo "Moved home. Check the site on the NAS, then point Cloudflare back at it. The cluster keeps its copy (its social"
    echo "side stopped) until you remove it: k8s/up.sh $SITE_DIR --down. What the NAS had: $backup/"
}

# rclone's remote "b": the bucket as Ghost reaches it (ConfigMap s3, Secret s3's keys if any, else the pod's identity)
RCLONE_ENV=': >/tmp/rclone.conf; export RCLONE_CONFIG=/tmp/rclone.conf RCLONE_CONFIG_B_TYPE=s3 RCLONE_CONFIG_B_ENV_AUTH=true RCLONE_CONFIG_B_REGION="$S3_REGION" RCLONE_CONFIG_B_NO_CHECK_BUCKET=true
    case "${S3_ENDPOINT:-}" in "") export RCLONE_CONFIG_B_PROVIDER=AWS ;;
        *storage.googleapis.com*) export RCLONE_CONFIG_B_PROVIDER=GCS RCLONE_CONFIG_B_ENDPOINT="$S3_ENDPOINT" ;;
        *) export RCLONE_CONFIG_B_PROVIDER=Other RCLONE_CONFIG_B_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_B_FORCE_PATH_STYLE=true ;; esac'

case "$WAY" in to-cloud) to_cloud ;; to-nas) to_nas ;; esac
echo
if [ "$mismatch" = 0 ]; then echo "Everything counted the same on both sides."
else echo "$mismatch count(s) differ (DIFFERENT above): look before the DNS flip." >&2; exit 3; fi
