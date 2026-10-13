# stacks/icecast/

The `live` module's stream server: TinyIce (one container: stream input, mounts, the mp3 transcode, the player page,
admin). What visitors see of it, the LIVE NOW bar, is in the theme (`kit/theme/`, `kit/CLAUDE.md`).

- The DJ software sends Ogg to `/stream-ogg` on host port 8222, always straight to TinyIce's port, never through
  Traefik: Traefik drops a SOURCE request's body, so TinyIce logs "has sent no audio", the mp3 transcoder can't start
  and `/stream-mp3` 404s. TinyIce transcodes it to `/stream-mp3`, which listeners get.
- Routes (labels in `compose.yaml`): `LIVE_HOST` (default `live.<SITE_HOST>`, Cloudflare-only) for listening and the
  player pages; its admin paths (`/admin`, `/login`, `/logout`, `/api`, `/metrics`) are 403 there (everyone arrives
  through Cloudflare, so "home only" can't be told apart) and served at `http://tinyice.<LAN_DOMAIN>` (lan-only);
  `/live-status.json` on the site's own address (priority 100) is TinyIce's `/status-json.xsl`, for the LIVE NOW bar
  (same origin, and it doesn't open the stream, so checks don't count as listeners).
- Its config, `data/icecast/tinyice-data/config.json` in a site's folder, is written by `kit/setup.sh` (the
  `/stream-ogg` -> `/stream-mp3` transcoder, bcrypt passwords; the plain ones in `secrets/icecast.env`). Keep
  `advanced_mounts./stream-mp3.burst_size` at 131072: TinyIce's ring is a fixed 512 KB and its default burst is all of
  it, which leaves a listener no slack, so a slow one gets jumped mid-frame (a "record scratch"). TinyIce reads it at
  start: restart it after a change.
- The image is pinned by digest (TinyIce 2.12.3). Hosts and paths come from the instance profile: `SITE_HOST` and
  `DATA_DIR` (required), `LIVE_HOST`, `LAN_DOMAIN` (`instances/CLAUDE.md`).
- On Kubernetes (`k8s/components/live/`) the same TinyIce takes the stream, and Icecast 2 relays serve listeners'
  `/stream-mp3`: TinyIce's own edge relays refuse private (in-cluster) addresses (`k8s/CLAUDE.md`).
