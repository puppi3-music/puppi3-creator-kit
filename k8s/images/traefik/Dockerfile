# Traefik with the kit's local plugins (realip, pagehitcountry), which Compose mounts from stacks/traefik/plugins-local/.
# Built by k8s/build-images.sh with stacks/traefik/ as the context. Traefik finds them at ./plugins-local from /.
ARG TRAEFIK_VERSION
FROM traefik:${TRAEFIK_VERSION}
COPY plugins-local/src/creatorkit/realip /plugins-local/src/creatorkit/realip
COPY plugins-local/src/creatorkit/pagehitcountry /plugins-local/src/creatorkit/pagehitcountry
