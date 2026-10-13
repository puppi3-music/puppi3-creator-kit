#!/usr/bin/env bash
# Builds the kit's own images for Kubernetes and pushes them:
#   k8s/build-images.sh --registry k3d           this Mac's k3d cluster's registry (k8s/test/k3d.sh up)
#   k8s/build-images.sh --registry <host/path>   any registry you're logged in to (ECR, Artifact Registry, ghcr.io/you)
#   PLATFORM=linux/amd64 k8s/build-images.sh ...  for nodes of another architecture (default: this machine's)
# Each tag is the upstream version plus a hash of what went in, so a changed plugin is a new tag (no stale pulls).
# Writes k8s/images/built.env (git-ignored): each image as the cluster pulls it, which k8s/up.sh hands to Kustomize.
set -euo pipefail

K8S="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$K8S")"
[ "${1:-}" = --registry ] && [ -n "${2:-}" ] || { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
if [ "$2" = k3d ]; then
    push=localhost:5111/creator-kit; pull=k3d-creator-kit-registry:5111/creator-kit   # k8s/test/k3d.sh's registry
else
    push=$2; pull=$2
fi

hash() { (cd "$REPO" && find "$@" -type f ! -name .DS_Store -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-10); }
out="$K8S/images/built.env.tmp"
echo "# k8s/build-images.sh --registry $2, $(date '+%Y-%m-%d %H:%M')" > "$out"

# build <image> <context> <dockerfile> <tag> [build args...]
build() {
    local name=$1 ctx=$2 file=$3 tag=$4; shift 4
    local args=(); for a in "$@"; do args+=(--build-arg "$a"); done
    echo "== $name:$tag"
    docker build ${PLATFORM:+--platform "$PLATFORM"} -q -t "$push/$name:$tag" -f "$file" ${args[@]+"${args[@]}"} "$ctx" >/dev/null
    docker push -q "$push/$name:$tag" >/dev/null
    printf '%s=%s\n' "$name" "$pull/$name:$tag" >> "$out"
}

# Traefik: the Compose stack's version, with the local plugins
tv="$(sed -n 's/^ *image: traefik:\([^ ]*\).*/\1/p' "$REPO/stacks/traefik/compose.yaml")"
build traefik "$REPO/stacks/traefik" "$K8S/images/traefik/Dockerfile" \
    "$tv-$(hash k8s/images/traefik stacks/traefik/plugins-local/src/creatorkit/realip stacks/traefik/plugins-local/src/creatorkit/pagehitcountry)" \
    "TRAEFIK_VERSION=$tv"

# tb-setup: the puppi3 stack's own (Tinybird's CLI and setup.sh), as Compose builds it. From a folder of just those
# two: the stack's folder on this machine may hold a tokens.env, which mustn't go to the build.
tbv="$(sed -n 's/.*tinybird==\([0-9.]*\).*/\1/p' "$REPO/stacks/puppi3/tinybird/dockerfile")"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
cp "$REPO/stacks/puppi3/tinybird/dockerfile" "$REPO/stacks/puppi3/tinybird/setup.sh" "$ctx/"
build tb-setup "$ctx" "$ctx/dockerfile" \
    "$tbv-$(hash stacks/puppi3/tinybird/dockerfile stacks/puppi3/tinybird/setup.sh)"

# The live module's relays: Icecast 2 from Alpine (k8s/images/icecast-relay/)
av=3.22
build icecast-relay "$K8S/images/icecast-relay" "$K8S/images/icecast-relay/Dockerfile" \
    "2.4.4-alpine$av-$(hash k8s/images/icecast-relay)" "ALPINE_VERSION=$av"

# The social module's bridge: its code inside (k8s/images/ghost-bridge/), from a folder of just the code: the stack's
# folder here may hold the bridge's real data/
nv="$(sed -n 's/^ *FROM node:\([0-9]*\)-alpine.*/\1/p' "$REPO/stacks/postiz/compose.yaml")"
bctx="$ctx/ghost-bridge"; mkdir -p "$bctx"
(cd "$REPO/stacks/postiz/ghost-bridge" && find . -name '*.mjs' ! -path './data/*' ! -path './node_modules/*' -print0 |
    xargs -0 -I{} rsync -R {} "$bctx/")
build ghost-bridge "$bctx" "$K8S/images/ghost-bridge/Dockerfile" \
    "node$nv-$(cd "$bctx" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | cat - "$K8S/images/ghost-bridge/Dockerfile" | shasum -a 256 | cut -c1-10)" \
    "NODE_VERSION=$nv"

mv "$out" "$K8S/images/built.env"
echo "wrote k8s/images/built.env"
