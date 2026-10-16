# k8s/components/live/

The live stream on Kubernetes: TinyIce and the Icecast 2 relays its listeners use. The other components: `k8s/components/CLAUDE.md`; `up.sh` and the rest: `k8s/CLAUDE.md`.

Module `live`: the main `tinyice` Deployment (the stack's digest, 1 replica, Recreate; its
config from Secret `tinyice-config` = `data/icecast/tinyice-data/config.json`, copied onto its PVC only when the
volume has none, so admin edits stay; history on the same PVC), Service `tinyice` (Traefik, the relays, the bridge's
`LIVE_STATUS_URL` default, Prometheus) and LoadBalancer `tinyice-source` on 8222 for the streaming software (straight to
TinyIce: Traefik drops a SOURCE body; all of TinyIce answers there, admin sign-in too, so the site's
`LIVE_SOURCE_RANGES` becomes its `loadBalancerSourceRanges`, an up.sh patch). Listeners' `/stream-mp3` goes to `tinyice-relay`: **Icecast 2** relays
(`k8s/images/icecast-relay/`, Alpine's package, uid 100), 2 replicas, stateless, pulling `/stream-mp3` from `tinyice`;
their `icecast.xml` is Secret `icecast-relay-config` from `up.sh` (TinyIce's admin password and mp3 burst size,
500 listeners each, logs to /dev/stdout and /dev/stderr: Icecast puts `<logdir>` in front of the names;
`master-update-interval` 5, how often a failed relay is retried: the default 120 s missed a new site's first
stream). Readiness: ready when the relay has `/stream-mp3` or no source is on the main TinyIce's `/stream-ogg`
(TinyIce lists `/stream-mp3` even with no source, sending nothing, so relays reconnect every 10 s then), so listeners
don't land on a relay catching up and `up.sh` doesn't wait for a source; it asks `127.0.0.1` (busybox wget tries
`::1` for localhost; Icecast is IPv4 only). **TinyIce's
own edge relays can't do it**: they refuse private addresses ("outbound request to a non-routable target
refused") and have no switch. TinyIce keeps `/stream-mp3` up with no source, so the relays stay connected, and a source
reconnecting comes through them (checked). Icecast handles the mp3 with its generic passthrough (a warning in its
log). `live.yml`: the icecast stack's labels as a Traefik file, the same router names (`tinyice`, `tinyice-admin`,
`tinyice-lan`, `live-status`) plus `tinyice-mp3` (priority 90, to the relays).
**The mounts' names are TinyIce's own:** `up.sh` reads the source's and the mp3 mount (the mp3 transcoder's input and
output) from the running TinyIce's config (`kubectl exec … cat /data/config.json`; a rename in its admin is saved on
its volume), else the site's, into ConfigMap `live` (`LIVE_SOURCE_MOUNT`, `LIVE_MP3_MOUNT`) and the relays' config;
Traefik gets it through a patch appending to its `envFrom` (`traefik.yaml`), the relays' readiness through theirs.
Renamed in TinyIce, run `up.sh` again. `up.sh` connects to the cluster before rendering now (except `--render`).
