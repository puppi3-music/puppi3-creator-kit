# The Ghost -> social bridge (stacks/postiz/ghost-bridge/) with its code inside: on Compose it's a read-only folder
# mount, but its modules sit in subfolders, which a ConfigMap can't hold. The postiz stack's own base (node + ffmpeg
# for the audiograms). k8s/build-images.sh builds it from a folder of just the code (the stack's folder here may
# hold the bridge's real data/).
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine
RUN apk add --no-cache ffmpeg
COPY --chown=root:root . /app
USER node
CMD ["node", "/app/ghost-bridge.mjs"]
