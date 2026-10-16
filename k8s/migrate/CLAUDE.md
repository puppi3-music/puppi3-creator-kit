# k8s/migrate/

Moving a site's data between a Docker host (the NAS, a Compose kit site) and a cluster. How someone uses it: the
Operations guide's moving section (`kit/docs/operations-guide.html`); its test: `k8s/test/test.sh --migrate`
(`k8s/test/CLAUDE.md`). The rest: `k8s/CLAUDE.md`.

Phase D part 4. `to-cloud.sh <site> <overlay> --from [<user>@<host>:]<data folder>` and
`to-nas.sh <site> <overlay> --to ...` (both `migrate.sh`; `-n` checks and prints the steps, `-y` doesn't ask,
`--no-start` leaves the NAS's apps stopped). The user runs them: Claude never points them at the real NAS or a real
cluster. The Docker host side is the stacks' containers (found by Compose service in the projects `<ID_PREFIX>`,
`ghost` or `puppi3` (its name before kit 1.2.0), `postiz`, `icecast`, `monitoring`: the kit's Compose and stacks
run one project each alike; a `puppi3-staging` project never) and the data folder (`DATA_DIR`; Ghost's folder in it,
`ghost/` or `puppi3/`, is read from where Ghost's container mounts `/var/lib/ghost/content`): over ssh with `sudo -k -S` (the password line first, the
stream after it: sudo reads it a byte at a time; never sent when sudo needs none), the password from Keychain item
`<ID_PREFIX>-nas` or asked; or this machine's Docker (the test). Every file
operation there runs in a throwaway `busybox:1.37.0` with the data folder at `/d` (the same tar, find, stat on a Mac).
The cluster side: pod `migrate` (MySQL's, Postgres's and rclone's clients) built from Ghost's Deployment: its
service account (IRSA), hosts file and sidecars (the Cloud SQL proxy), its `database__*` env, Secret `postiz`,
ConfigMap/Secret `s3`; and a busybox pod per volume (`migrate-<claim>`) with the volume's workload scaled to 0
(a volume is one node's at a time). What moves: Ghost's MySQL (mysqldump; the target's tables dropped first, not the
database: the cloud's login may not make one), images/media/files (the bucket, by rclone, or Ghost's volume
without one), themes/settings/data; Postiz's and Temporal's Postgres (`DROP SCHEMA public CASCADE` then a plain
dump without owners; `SET transaction_timeout` cut: pg_dump 17 into Temporal's 16), the bridge's `data/` and
Postiz's config/uploads (their apps stopped on the source: Postiz and the bridge move, two would post twice),
TinyIce's config and history, Tinybird's ClickHouse and Redis volumes (Tinybird stopped meanwhile on both sides,
then started), Prometheus's samples of `<ID_PREFIX>-pets|traefik|tinyice` (promtool `dump-openmetrics` ->
`create-blocks-from openmetrics` straight into the data folder, blocks of up to 31 days; to-nas only since the
cluster's Prometheus volume was made). Copied files take the owner the target's contents had. Every database and
folder is counted on both sides (exit 3 if any differ). Ghost's database goes only to the same or a newer Ghost.
to-cloud ends by deleting Secret `tinybird-tokens` and `data/k8s/ghost.env` and running `up.sh` (tb-setup reads the
copied workspace's tokens; up.sh asks Ghost for its site_uuid again; TinyIce is started first so up.sh reads its
copied mounts). to-nas keeps what the NAS had in `<data folder>/.migrate-backups/<stamp>/` (databases as `.sql.gz`,
folders moved, volumes as `.tar`), stops and starts the NAS's Ghost (it's the move home), writes `tokens.env` if the
cluster's differ (then Ghost etc. need recreating: the user's). Never Cloudflare.
