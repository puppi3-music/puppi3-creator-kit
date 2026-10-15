# The Ghost -> social bridge with its code inside: what a kit site runs (the published image), what Kubernetes runs
# (its modules sit in subfolders, which a ConfigMap can't hold) and what KIT_BUILD=1 builds from this folder. The
# NAS's own stack builds just the base (compose.yaml's dockerfile_inline, the same Node) and mounts the code instead.
# Node (its own SQLite for data/stats.db) and ffmpeg for the audiograms; .dockerignore keeps the build to the .mjs
# files, never data/.
ARG NODE_VERSION=24.22.0
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache ffmpeg
COPY --chown=root:root . /app
USER node
CMD ["node", "/app/ghost-bridge.mjs"]
