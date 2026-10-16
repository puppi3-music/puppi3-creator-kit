# k8s/components/

Kustomize Components: one per module, which `up.sh` adds for the site's `MODULES` (`k8s/CLAUDE.md`), and the parts
the overlays share. The big ones have a CLAUDE.md of their own, in their folders: open it before working on one.
This file has the small ones.

| Folder | What it is |
|---|---|
| `analytics/` | Module `analytics`: Tinybird, traffic-analytics, tb-setup as a Job that keeps the tokens in a Secret (own CLAUDE.md) |
| `live/` | Module `live`: TinyIce, the Icecast 2 relays listeners use, the stream source's LoadBalancer (own CLAUDE.md) |
| `social/` | Module `social`: Postiz, its databases, Temporal and the bridge, their settings rendered from the postiz stack (own CLAUDE.md) |
| `monitoring/` | Module `monitoring`: Grafana, Prometheus, blackbox, json-exporter, the grafana_ro Jobs (own CLAUDE.md) |
| `s3-storage/` | Ghost's images, media and files in a bucket, `KitS3Storage.js` (own CLAUDE.md) |
| `mysql/`, `s3-gateway/`, `cloud-postgres/`, `k3d-standins/` | Below |

- `mysql/`: MySQL 8 StatefulSet (the Compose stack's exact version) + Service `mysql`, root's password from Secret `ghost`.
- `s3-gateway/`: an in-cluster S3, **versitygw** v1.8.0 (Versity's gateway, Apache 2.0; MinIO, the plan's
  choice, no longer publishes images), a StatefulSet `s3` keeping each object as a file (`/data/<bucket>/<key>`;
  the bucket is a folder its init container makes), Service `s3:7070`, ConfigMap `s3` (bucket `ghost-content`,
  path-style). It needs a filesystem with extended attributes (it keeps content types there): fine on k3s volumes,
  not on a macOS bind mount.
- `cloud-postgres/` (both clouds' `finish/`): Postiz's and Temporal's Postgres as one managed Postgres.
  Job `postgres-logins` (with social: Postiz's and Temporal's logins and the databases `postiz`, `temporal`,
  `temporal_visibility` from the master login, Secret `cloud`; `GRANT <role> TO CURRENT_USER` since RDS's and Cloud
  SQL's master isn't a superuser; Temporal's setup needs its first database there already: the postgres image made
  it in the cluster), the two Postgres StatefulSets deleted (`$patch: delete` by target: nothing when social is off),
  Postiz and Temporal wait (init containers) until their login works, and monitoring's `grafana-ro-postiz` signs in
  as the master (postiz isn't a superuser there and may not make roles; the master is in role postiz, the tables'
  owner). How pods reach it is each overlay's.
- `k3d-standins/`: `standin-mysql` (MySQL 8, master = Ghost's login) and `standin-postgres` (Postgres 17,
  only the master login, Secret `cloud`), and the S3 gateway (`../s3-gateway/gateway.yaml`, not its ConfigMap:
  ConfigMap `s3` comes from cloud.k3d). k3d.sh makes the StorageClasses `gp3` and `standard-rwo` (local-path).
