#!/usr/bin/env bash
# Builds the kit's own images and pushes them. A kit site doesn't need to: each release publishes them
# (ghcr.io/puppi3-music/puppi3-creator-kit/<name>:<version>, .github/workflows/release.yml), and k8s/up.sh uses those.
# This is for a changed kit, or a registry of your own:
#   k8s/build-images.sh --registry k3d           this Mac's k3d cluster's registry (k8s/test/k3d.sh up)
#   k8s/build-images.sh --registry <host/path>   any registry you're logged in to (ECR, Artifact Registry, ghcr.io/you)
#     --platform linux/amd64,linux/arm64         for nodes of other architectures (default: this machine's; several:
#                                                built and pushed together by buildx, one image for all of them)
#     --tag <tag>                                also tag each one so (the release: the kit's version)
# Each tag is the upstream version plus a hash of what went in, so a changed plugin is a new tag (no stale pulls).
# Writes k8s/images/built.env (git-ignored): each image as the cluster pulls it, which k8s/up.sh hands to Kustomize.
set -euo pipefail

K8S="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$K8S")"
usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
REGISTRY=; PLATFORM="${PLATFORM:-}"; EXTRA_TAG=
while [ $# -gt 0 ]; do
    case "$1" in
        --registry) REGISTRY="${2:-}"; shift 2 ;;
        --platform) PLATFORM="${2:-}"; shift 2 ;;
        --tag) EXTRA_TAG="${2:-}"; shift 2 ;;
        *) usage ;;
    esac
done
[ -n "$REGISTRY" ] || usage
if [ "$REGISTRY" = k3d ]; then
    push=localhost:5111/creator-kit; pull=k3d-creator-kit-registry:5111/creator-kit   # k8s/test/k3d.sh's registry
else
    push=$REGISTRY; pull=$REGISTRY
fi

hash() { (cd "$REPO" && find "$@" -type f ! -name .DS_Store -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-10); }
out="$K8S/images/built.env.tmp"
echo "# k8s/build-images.sh --registry $REGISTRY${PLATFORM:+ --platform $PLATFORM}, $(date '+%Y-%m-%d %H:%M')" > "$out"

# build <image> <context> <dockerfile> <tag> [build args...]
build() {
    local name=$1 ctx=$2 file=$3 tag=$4; shift 4
    local args=(); for a in "$@"; do args+=(--build-arg "$a"); done
    local tags=(-t "$push/$name:$tag"); [ -z "$EXTRA_TAG" ] || tags+=(-t "$push/$name:$EXTRA_TAG")
    # (GHCR links an image to its source repository by this label)
    local label=(--label "org.opencontainers.image.source=https://github.com/puppi3-music/puppi3-creator-kit")
    echo "== $name:$tag${EXTRA_TAG:+ and :$EXTRA_TAG}${PLATFORM:+ ($PLATFORM)}"
    case "$PLATFORM" in
        *,*)   # several architectures: one image index, built and pushed together
            docker buildx build --platform "$PLATFORM" --push -q "${tags[@]}" "${label[@]}" -f "$file" \
                ${args[@]+"${args[@]}"} "$ctx" >/dev/null ;;
        *)
            docker build ${PLATFORM:+--platform "$PLATFORM"} -q "${tags[@]}" "${label[@]}" -f "$file" ${args[@]+"${args[@]}"} \
                "$ctx" >/dev/null
            docker push -q "$push/$name:$tag" >/dev/null
            [ -z "$EXTRA_TAG" ] || docker push -q "$push/$name:$EXTRA_TAG" >/dev/null ;;
    esac
    printf '%s=%s\n' "$name" "$pull/$name:$tag" >> "$out"
}

# Traefik: the Compose stack's version, with the local plugins
tv="$(sed -n 's/^ *image: traefik:\([^ ]*\).*/\1/p' "$REPO/stacks/traefik/compose.yaml")"
build traefik "$REPO/stacks/traefik" "$K8S/images/traefik/Dockerfile" \
    "$tv-$(hash k8s/images/traefik stacks/traefik/plugins-local/src/creatorkit/realip stacks/traefik/plugins-local/src/creatorkit/pagehitcountry)" \
    "TRAEFIK_VERSION=$tv"

# tb-setup: the ghost stack's own (Tinybird's CLI and setup.sh), as Compose builds it. From a folder of just those
# two: the stack's folder on this machine may hold a tokens.env, which mustn't go to the build.
tbv="$(sed -n 's/.*tinybird==\([0-9.]*\).*/\1/p' "$REPO/stacks/ghost/tinybird/dockerfile")"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
cp "$REPO/stacks/ghost/tinybird/dockerfile" "$REPO/stacks/ghost/tinybird/setup.sh" "$ctx/"
build tb-setup "$ctx" "$ctx/dockerfile" \
    "$tbv-$(hash stacks/ghost/tinybird/dockerfile stacks/ghost/tinybird/setup.sh)"

# The live module's relays: Icecast 2 from Alpine (k8s/images/icecast-relay/)
av=3.22.6
build icecast-relay "$K8S/images/icecast-relay" "$K8S/images/icecast-relay/Dockerfile" \
    "2.4.4-alpine$av-$(hash k8s/images/icecast-relay)" "ALPINE_VERSION=$av"

# The social module's bridge: its code inside (stacks/postiz/ghost-bridge/Dockerfile), from a folder of just the code:
# the stack's folder here may hold the bridge's real data/
bdf="$REPO/stacks/postiz/ghost-bridge/Dockerfile"
nv="$(sed -n 's/^ARG NODE_VERSION=\([0-9.]*\)$/\1/p' "$bdf")"
bctx="$ctx/ghost-bridge"; mkdir -p "$bctx"
(cd "$REPO/stacks/postiz/ghost-bridge" && find . -name '*.mjs' ! -path './data/*' ! -path './node_modules/*' -print0 |
    xargs -0 -I{} rsync -R {} "$bctx/")
build ghost-bridge "$bctx" "$bdf" \
    "node$nv-$(cd "$bctx" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | cat - "$bdf" | shasum -a 256 | cut -c1-10)"

mv "$out" "$K8S/images/built.env"
echo "wrote k8s/images/built.env"
