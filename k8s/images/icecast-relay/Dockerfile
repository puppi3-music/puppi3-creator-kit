# The live module's relays on Kubernetes (k8s/components/live/relay.yaml): stock Icecast 2 from Alpine, pulling
# /stream-mp3 from the main TinyIce. Not TinyIce's own edge relays: they refuse private addresses ("outbound request
# to a non-routable target refused"), which every in-cluster address is, and have no switch for it.
# Built by k8s/build-images.sh; its config is a Secret k8s/up.sh makes (icecast.xml).
ARG ALPINE_VERSION
FROM alpine:${ALPINE_VERSION}
# mailcap: /etc/mime.types, which Icecast reads for the files it serves
RUN apk add --no-cache icecast mailcap
# uid 100, gid 101 (relay.yaml's runAsUser: Kubernetes checks a numeric user for runAsNonRoot)
USER icecast
ENTRYPOINT ["icecast", "-c", "/config/icecast.xml"]
