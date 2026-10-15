#!/usr/bin/env bash
# The kit's checks that need no Docker, in one go (a few seconds): every path the files name is in the repo, every
# Traefik plugin they load is there (kit/check_refs.py), the guides' build, the dashboards' checks and a render for
# the example profile and the dashboard scripts' tests, the bridge's modules and its tests (with Node.js), the Traefik
# plugins' tests (with Go), and every shell script's syntax. GitHub runs it too, on every push and pull request (.github/workflows/check.yml).
#   kit/check.sh [--here <another repo>]   (--here: also the paths only that repo has: kit/check_refs.py's header)
set -uo pipefail
cd "$(dirname "$0")/.."
G=stacks/monitoring/grafana
here=()
[ "${1:-}" = --here ] && here=(--here "$2")

runs=(
  "python3 kit/check_refs.py ${here[*]:-}"
  "python3 docs/build-docs.py --check"
  "python3 $G/style.py --check"
  "python3 $G/ro-tables.py --check"
  "o=\$(mktemp -d) && python3 $G/render.py --profile kit --site instances/example.env $G/provisioning/dashboards/json \"\$o\" >/dev/null; r=\$?; rm -rf \"\$o\"; exit \$r"
  "python3 -m unittest discover -q -s $G/tests"
)
if command -v node >/dev/null 2>&1; then
  runs+=("cd stacks/postiz/ghost-bridge && env -i PATH=\"\$PATH\" PORT=0 DRY_RUN=true STATE_FILE=/nonexistent/posted.json MAP=\"\$OLDPWD/docs/bridge-map.md\" node \"\$OLDPWD/.githooks/bridge-check.mjs\"")
  runs+=("cd stacks/postiz/ghost-bridge-test && node --test --test-reporter=dot")
fi
if command -v go >/dev/null 2>&1; then
  for m in stacks/traefik/plugins-local/src/*/*/go.mod; do
    runs+=("cd '$(dirname "$m")' && f=\$(gofmt -l .) && { [ -z \"\$f\" ] || { echo \"not gofmt'd: \$f\"; false; }; } && go vet ./... && go test -count=1 ./...")
  done
fi
while IFS= read -r f; do runs+=("bash -n '$f'"); done < <(git ls-files -co --exclude-standard '*.sh')

bad=0
for cmd in "${runs[@]}"; do
  if ! res=$(bash -c "$cmd" 2>&1); then
    bad=$((bad + 1))
    echo "check: failed: ${cmd:0:90}"
    echo "$res" | tail -20 | sed 's/^/    /'
  fi
done
echo "check: ${#runs[@]} checks: $([ $bad = 0 ] && echo "all passed" || echo "$bad failed")"
[ $bad = 0 ]
