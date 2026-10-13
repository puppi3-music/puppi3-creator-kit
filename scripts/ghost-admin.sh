#!/usr/bin/env bash
# ghost-admin.sh: one Ghost site's theme, routes, redirects, code injection and theme settings, through Ghost's Admin
# API (Puppi3's Creator Kit). Needs only the site's address and a Staff access token
# (Ghost Admin -> Settings -> Staff -> your profile -> Staff access token; an integration's key can't do these).
#
#   GHOST_URL=https://example.com GHOST_ADMIN_TOKEN=<24 hex>:<64 hex> scripts/ghost-admin.sh <command> [file]
#
#   theme <zip>              upload and replace the theme (THEME_NAME= picks which installed one, if several)
#   routes <routes.yaml>     replace routes.yaml
#   redirects <file>         replace the redirects (.yaml, or Ghost's older .json)
#   injection <folder>       Code injection: the folder's site-header.html / site-footer.html (only boxes with a file)
#   theme-settings <file>    a JSON object {"<setting>": <value>} (settings it doesn't name stay as they are)
#   site                     check the address and the token: the site's title, address and Ghost version
#
# Every change backs up what it replaces first, in GA_BACKUPS (default ./ghost-backups)/<time>/. GA_KEEP_SETTINGS
# (space-separated) are theme settings it never touches. Stops at the first refusal; Ghost keeps what it had.
# deploy.sh sources this file for the same functions (api, ghost_theme, ghost_routes...), with its own backups
# folder, temp folder, default files (source_of) and extra advice (ghost_api_hint).
# Keep it bash 3.2 compatible (macOS /bin/bash), as deploy.sh.

# What the caller may have defined already (deploy.sh does): stop with a message, a path to show, the backups folder
declare -F die >/dev/null || die() { echo "ghost-admin: $*" >&2; exit 1; }
declare -F rel >/dev/null || rel() { echo "$1"; }
declare -F ghost_backup_dir >/dev/null || ghost_backup_dir() {
  local d="${GA_BACKUPS:-./ghost-backups}/${GA_STAMP:=$(date +%Y%m%d-%H%M%S)}"; mkdir -p "$d"; echo "$d"
}
# ga_file <topic> [<file>]: the file given, else the caller's default for the topic (deploy.sh's source_of)
ga_file() {
  if [ -n "${2:-}" ]; then echo "$2"
  elif declare -F source_of >/dev/null; then source_of "$1"
  else echo "ghost-admin: $1: which file?" >&2; return 1; fi
}

GHOST_FAIL=""   # set by api when Ghost can't be reached or refuses the token

# === Ghost: Admin API ========================================================
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# A fresh 5-minute token per request, signed with the staff token's secret.
ghost_token() {
  local id=${ADMIN_KEY%%:*} secret=${ADMIN_KEY#*:} now head body sig
  now=$(date +%s)
  head=$(printf '{"alg":"HS256","typ":"JWT","kid":"%s"}' "$id" | b64url)
  body=$(printf '{"iat":%d,"exp":%d,"aud":"/admin/"}' "$now" $((now + 300)) | b64url)
  sig=$(printf '%s.%s' "$head" "$body" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$secret" -binary | b64url)
  echo "$head.$body.$sig"
}

# Ghost's error response, readable: message, context, and theme check failures.
api_error() {
  python3 - "$1" <<'PY'
import json, re, sys
raw = open(sys.argv[1], errors="replace").read()
try:
    errors = json.loads(raw).get("errors", [])
except Exception:
    print(raw[:300]); sys.exit()
clean = lambda s: re.sub(r"<[^>]+>", "", str(s or "")).strip()
for e in errors:
    print(clean(e.get("message")) + (" - " + clean(e.get("context")) if e.get("context") else ""))
    details = e.get("details")
    for rule in (details.get("errors") or []) if isinstance(details, dict) else []:
        print("    * " + clean(rule.get("rule")))
        for f in rule.get("failures") or []:
            print("        " + clean(f.get("ref")))
PY
}

# api <output file> <METHOD> <path> [curl args...]
api() {
  local out=$1 method=$2 path=$3 code; shift 3
  code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H "Authorization: Ghost $(ghost_token)" \
           -H 'Accept-Version: v5.0' "$@" "$GHOST_API$path") \
    || { echo "  couldn't reach $GHOST_API" >&2; GHOST_FAIL="couldn't reach Ghost"; return 1; }
  case $code in 2??) return 0 ;; esac
  local err; err=$(api_error "$out")
  echo "  Ghost answered $code: $err" >&2
  case $code in 404) case $err in "404 page not found")
    # Traefik's own 404: nothing is routed to Ghost at that address
    GHOST_FAIL="no Ghost at $SITE_URL"
    echo "  That's Traefik's 404, not Ghost's: Traefik has no route to Ghost there, usually because the Ghost" \
         "container isn't running." >&2 ;;
  esac ;; esac
  case $code in 401|403)
    GHOST_FAIL="Ghost refused the Staff access token"
    case $err in *"API tokens do not have permission"*)
      echo "  That's a custom integration's key, which Ghost doesn't allow here. Use your Staff access token" \
           "(Ghost Admin -> Settings -> Staff -> your profile -> Staff access token)." >&2 ;;
    *) echo "  The token was refused." >&2 ;; esac ;;
  esac
  # the caller's own advice (deploy.sh: staging, the Keychain), if it has any
  ! declare -F ghost_api_hint >/dev/null || ghost_api_hint "$code" "$err" >&2
  return 1
}


# Which installed theme the zip replaces -> TH_NAME TH_ACTIVE (0/1) TH_INSTALLED (0/1) TH_CURRENT (active theme).
# Several installed copies of the theme: TH_NAME=MANY and TH_CURRENT lists them.
theme_in_ghost() { # [zip]
  local zip=$(ga_file theme "${1:-}") pkg
  # package.json at the top, or in the one folder Ghost's own downloads may wrap the theme in
  pkg=$(unzip -p "$zip" "$(unzip -Z1 "$zip" | grep -m1 -E '^([^/]+/)?package\.json$')" \
          | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
  api "$TMP/themes.json" GET /themes/ || return 1
  read -r TH_NAME TH_ACTIVE TH_INSTALLED TH_CURRENT < <(python3 - "$TMP/themes.json" "$pkg" "$THEME_NAME" <<'PY'
import json, sys
themes = json.load(open(sys.argv[1])).get("themes", [])
pkg, want = sys.argv[2], sys.argv[3]
active = next((t for t in themes if t.get("active")), {})
pkgname = lambda t: (t.get("package") or {}).get("name")
if want:
    match = [t for t in themes if t["name"] == want]
elif pkgname(active) == pkg:
    match = [active]
else:
    match = [t for t in themes if pkgname(t) == pkg]
    if len(match) > 1:
        print("MANY 0 1", ",".join(t["name"] for t in match)); sys.exit()
t = match[0] if match else {"name": want or pkg}
print(t["name"], int(bool(t.get("active"))), int(bool(match)), active.get("name", "?"))
PY
)
}

ghost_theme() { # [zip]
  echo "theme:"
  local zip=$(ga_file theme "${1:-}") name active installed current backup
  theme_in_ghost "$zip" || die "theme: couldn't list Ghost's themes"
  [ "$TH_NAME" != MANY ] || die "theme: several installed themes are this one ($TH_CURRENT). Run again with THEME_NAME=<the one to replace>."
  name=$TH_NAME active=$TH_ACTIVE installed=$TH_INSTALLED current=$TH_CURRENT
  if [ "$installed" = 1 ]; then
    backup="$(ghost_backup_dir)/theme-$name.zip"
    api "$backup" GET "/themes/$name/download/" \
      || { rm -f "$backup"; die "theme: couldn't back up the current theme, so it wasn't replaced"; }
    echo "  backed up the current \"$name\" to $(rel "$backup")"
  fi
  api "$TMP/upload.json" POST /themes/upload/ -F "file=@$zip;filename=$name.zip;type=application/zip" \
    || die "theme: Ghost didn't take the upload (see above); the live theme is unchanged and nothing after this was deployed"
  python3 - "$TMP/upload.json" <<'PY'
import json, re, sys
t = (json.load(open(sys.argv[1])).get("themes") or [{}])[0]
for w in t.get("warnings") or []:
    print("  warning: " + re.sub(r"<[^>]+>", "", str(w.get("rule", ""))).strip())
PY
  if [ "$active" = 1 ]; then
    echo "  uploaded \"$name\"; it's the active theme, so it's live now"
  else
    echo "  uploaded \"$name\", but the site is using \"$current\"."
    echo "  To switch, activate \"$name\" in Ghost Admin -> Settings -> Design -> Change theme."
  fi
}

ghost_routes() { # [file]
  echo "routes:"
  local backup; backup="$(ghost_backup_dir)/routes.yaml"
  api "$backup" GET /settings/routes/yaml/ \
    || { rm -f "$backup"; die "routes: couldn't back up the current routes, so they weren't replaced"; }
  echo "  backed up the current routes to $(rel "$backup")"
  api "$TMP/routes.json" POST /settings/routes/yaml/ -F "routes=@$(ga_file routes "${1:-}");type=application/yaml" \
    || die "routes: Ghost didn't take the upload (see above); live routes are unchanged and nothing after this was deployed"
  echo "  uploaded; live now"
}

ghost_redirects() { # [file]
  echo "redirects:"
  local file=$(ga_file redirects "${1:-}") type=application/yaml backup
  case $file in *.json) type=application/json ;; esac
  backup="$(ghost_backup_dir)/redirects-current"
  api "$backup" GET /redirects/download/ \
    || { rm -f "$backup"; die "redirects: couldn't back up the current redirects, so they weren't replaced"; }
  case $(head -c1 "$backup") in '{'|'[') mv "$backup" "$backup.json"; backup="$backup.json" ;;
                                *)       mv "$backup" "$backup.yaml"; backup="$backup.yaml" ;; esac
  echo "  backed up the current redirects to $(rel "$backup")"
  api "$TMP/redirects.json" POST /redirects/upload/ -F "redirects=@$file;type=$type" \
    || die "redirects: Ghost didn't take the upload (see above); live redirects are unchanged and nothing after this was deployed"
  echo "  uploaded; live now"
}

# Code injection (Settings -> Code injection): one file per box, site-header.html -> codeinjection_head and
# site-footer.html -> codeinjection_foot. Only the boxes that have a file are compared, deployed or pulled.
injection_file() { case $1 in head) echo site-header.html ;; foot) echo site-footer.html ;; esac; }
injection_keys() { # [folder]: the boxes with a file there
  local k d=$(ga_file injection "${1:-}")
  for k in head foot; do [ ! -f "$d/$(injection_file $k)" ] || printf '%s ' $k; done
}
# Ghost's current code injection -> <folder>/site-header.html and site-footer.html (empty when a box is empty)
injection_fetch() {
  mkdir -p "$1"
  api "$TMP/settings.json" GET /settings/ || return 1
  python3 - "$TMP/settings.json" "$1" <<'PY'
import json, os, sys
settings = {s["key"]: s.get("value") for s in json.load(open(sys.argv[1])).get("settings", [])}
for key, name in (("codeinjection_head", "site-header.html"), ("codeinjection_foot", "site-footer.html")):
    with open(os.path.join(sys.argv[2], name), "w", encoding="utf-8") as f:
        f.write(settings.get(key) or "")
PY
}
ghost_injection() { # [folder]: puts that folder's boxes live (the repo's by default; a backup's for --restore)
  echo "injection:"
  local d=$(ga_file injection "${1:-}") keys backup k
  keys=$(injection_keys "$d")
  backup="$(ghost_backup_dir)/code-injection"
  injection_fetch "$TMP/injection-now" \
    || die "injection: couldn't back up the current code injection, so it wasn't replaced"
  mkdir -p "$backup"
  for k in $keys; do cp "$TMP/injection-now/$(injection_file $k)" "$backup/"; done
  echo "  backed up the live $(for k in $keys; do injection_file $k; done | paste -sd ' ' - | sed 's/ / and /') to $(rel "$backup")/"
  python3 - "$d" $keys > "$TMP/injection.json" <<'PY'
import json, os, sys
names = {"head": "site-header.html", "foot": "site-footer.html"}
print(json.dumps({"settings": [{"key": "codeinjection_" + k,
                                "value": open(os.path.join(sys.argv[1], names[k]), encoding="utf-8").read()}
                               for k in sys.argv[2:]]}))
PY
  api "$TMP/injection-put.json" PUT /settings/ -H 'Content-Type: application/json' --data-binary "@$TMP/injection.json" \
    || die "injection: Ghost didn't take it (see above); the live code injection is unchanged and nothing after this was deployed"
  echo "  saved; live now"
}

# Theme settings (Design -> Customize): the settings file holds them as {"<key>": <value>}
# (--pull theme-settings fills in every setting Ghost has); a setting not in the file stays as it is in Ghost.
# GA_KEEP_SETTINGS (space-separated keys) are left out of comparing, deploying and pulling: deploy.sh --staging sets
# live_stream_url, which staging keeps as its own (refresh.sh points it at staging's stream).
# tsettings_norm <file> <out>: the file in one layout (so diffs show only values), minus staging's own
# settings (GA_KEEP_SETTINGS); fails if the file isn't such an object
tsettings_norm() {
  python3 - "$1" "${GA_KEEP_SETTINGS:-}" > "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
if not isinstance(d, dict) or any(not isinstance(v, (str, bool, type(None))) for v in d.values()):
    sys.exit(1)
own = sys.argv[2].split()
print(json.dumps({k: v for k, v in d.items() if k not in own}, indent=2, ensure_ascii=False))
PY
}
# tsettings_fetch <out> <normalized file>: Ghost's values of the file's settings, same layout, in <out>;
# <out>.missing = the file's settings the live theme doesn't have, <out>.extra = Ghost's settings the file
# doesn't have yet, <out>.pulled = the file as --pull would leave it (all of Ghost's settings, in Ghost's
# order, then any the live theme lacks with your values)
tsettings_fetch() {
  api "$TMP/custom-theme-settings.json" GET /custom_theme_settings/ || return 1
  python3 - "$TMP/custom-theme-settings.json" "$2" "$1" "${GA_KEEP_SETTINGS:-}" \
    "$(ga_file theme-settings "" 2>/dev/null || true)" <<'PY'
import json, os, sys
own = sys.argv[4].split()
live = {s["key"]: s.get("value") for s in json.load(open(sys.argv[1])).get("custom_theme_settings", [])
        if s["key"] not in own}
mine = json.load(open(sys.argv[2], encoding="utf-8"))
out = sys.argv[3]
dump = lambda d: json.dumps(d, indent=2, ensure_ascii=False) + "\n"
open(out, "w", encoding="utf-8").write(dump({k: live[k] for k in mine if k in live}))
open(out + ".missing", "w").write("".join(k + "\n" for k in mine if k not in live))
open(out + ".extra", "w").write("".join(k + "\n" for k in live if k not in mine))
repo = json.load(open(sys.argv[5], encoding="utf-8")) if os.path.isfile(sys.argv[5]) else {}
pulled = dict(live)
pulled.update({k: v for k, v in repo.items() if k not in live})
open(out + ".pulled", "w", encoding="utf-8").write(dump(pulled))
PY
}
ghost_theme_settings() { # [file]: puts that file's settings live (the repo's by default; a backup's for --restore)
  echo "theme-settings:"
  local f=$(ga_file theme-settings "${1:-}") backup
  tsettings_norm "$f" "$TMP/theme-settings-deploy.json" || die "theme-settings: $(rel "$f") isn't a JSON object of settings"
  [ "$(cat "$TMP/theme-settings-deploy.json")" != "{}" ] || { echo "  no settings in $(rel "$f"), nothing to do"; return 0; }
  tsettings_fetch "$TMP/theme-settings-now.json" "$TMP/theme-settings-deploy.json" \
    || die "theme-settings: couldn't back up the current settings, so they weren't changed"
  [ ! -s "$TMP/theme-settings-now.json.missing" ] \
    || die "theme-settings: the live theme has no $(paste -sd ' ' - < "$TMP/theme-settings-now.json.missing" | sed 's/ /, /g') setting (deploy a theme that has it first); nothing changed"
  backup="$(ghost_backup_dir)/theme-settings.json"
  cp "$TMP/theme-settings-now.json" "$backup"
  echo "  backed up the live values to $(rel "$backup")"
  python3 - "$TMP/theme-settings-deploy.json" > "$TMP/theme-settings-put.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(json.dumps({"custom_theme_settings": [{"key": k, "value": v} for k, v in d.items()]}))
PY
  api "$TMP/theme-settings-res.json" PUT /custom_theme_settings/ -H 'Content-Type: application/json' \
      --data-binary "@$TMP/theme-settings-put.json" \
    || die "theme-settings: Ghost didn't take them (see above); the live settings are unchanged and nothing after this was deployed"
  echo "  saved; live now"
  [ -z "${GA_KEEP_SETTINGS:-}" ] || echo "  (left as they are there: $GA_KEEP_SETTINGS)"
}

# --- on its own: the command line ------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
  [ $# -ge 1 ] || usage
  cmd=$1 arg=${2:-}
  [ -n "${GHOST_URL:-}" ] || die "set GHOST_URL to the site's address (e.g. https://example.com)"
  SITE_URL=${GHOST_URL%/}/
  GHOST_API=${GHOST_API:-${SITE_URL%/}/ghost/api/admin}
  ADMIN_KEY=${GHOST_ADMIN_TOKEN:-}
  [[ $ADMIN_KEY =~ ^[0-9a-f]{24}:[0-9a-f]{64}$ ]] \
    || die "set GHOST_ADMIN_TOKEN to a Staff access token (<24 hex>:<64 hex>; Ghost Admin -> Settings -> Staff -> your profile)"
  THEME_NAME=${THEME_NAME:-}
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  need() { [ -n "$arg" ] && [ -e "$arg" ] || die "$cmd: name the ${1} (scripts/ghost-admin.sh $cmd <${1}>)"; }
  case $cmd in
    theme)          need zip;    ghost_theme "$arg" ;;
    routes)         need file;   ghost_routes "$arg" ;;
    redirects)      need file;   ghost_redirects "$arg" ;;
    injection)      need folder; [ -n "$(injection_keys "$arg/")" ] || die "injection: no site-header.html or site-footer.html in $arg"
                                 ghost_injection "$arg/" ;;
    theme-settings) need file;   ghost_theme_settings "$arg" ;;
    site)           api "$TMP/site.json" GET /site/ || die "site: $GHOST_FAIL"
                    python3 - "$TMP/site.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))["site"]
print("%s, %s, Ghost %s" % (s.get("title"), s.get("url"), s.get("version")))
PY
                    ;;
    *) usage ;;
  esac
fi
