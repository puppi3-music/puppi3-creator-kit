# k8s/overlays/

Where a site runs: one overlay per place, `up.sh <site> <overlay>` (`k8s/CLAUDE.md`). The clouds' recipes are
`k8s/clusters/`, their stand-ins `k8s/components/k3d-standins/` (`k8s/components/CLAUDE.md`), and how someone runs
one the Setup guide's EKS/GKE section (`kit/docs/setup-guide.html`).

- `selfhosted/` (base + mysql), `local/` (selfhosted on k3d, images from its registry, plus s3-storage and s3-gateway: Ghost's files in
  a bucket, as in a cloud).
- **Cloud overlays:** an overlay's `finish/` (a Component) goes in after the modules' components, so its patches
  reach every module's resources (an overlay's own patches see only its own). Its values: `k8s/overlays/<o>/cloud.k3d`
  (a k3d twin's, committed, not a `.env` since .gitignore keeps those out: the stand-ins', `{namespace}` filled in) or else `<site>/cloud-<o>.env` (from the
  overlay's `cloud.env.example`; up.sh stops without it) -> ConfigMap `cloud` (all of it) and `s3` (its `S3_*`), and
  `k8s/overlays/<CLOUD>/replacements.yaml` in the site's `replacements:` (CLOUD= in the values, else the overlay's name).
  Replacements and finish/ can't live in the overlay itself: a component's transformers run before the site's
  generators, so ConfigMap `cloud` isn't there yet. With the k3d stand-ins it makes the Postgres stand-in's master
  login once per site (`data/k8s/standins.env` -> Secret `cloud`: `POSTGRES_MASTER_USER`, `POSTGRES_MASTER_PASSWORD`)
  unless `secrets/cloud.env` gives the real one.
- `eks/` (Phase D part 2): base + s3-storage, `databases.yaml` (Service `mysql` = ExternalName of RDS for
  MySQL, ServiceAccount `ghost` with the IRSA role annotation), Ghost on ServiceAccount `ghost`.
  `finish/`: cloud-postgres, gp3 on every PVC and claim template (tinybird-local's second too), NLB annotations on
  `traefik` and `tinyice-source` (instance targets + `externalTrafficPolicy: Local` keep the visitor's address),
  Postiz's two Postgres Services replaced by ExternalNames. `replacements.yaml`:
  `MYSQL_HOST`, `POSTGRES_HOST`, `GHOST_ROLE_ARN`. `cloud.env.example`: what a site fills in (RDS Postgres needs
  `rds.force_ssl=0`: Postiz and Temporal connect without TLS). Not tried on AWS yet.
- `k3d-eks/`: `resources: ../eks` and nothing else; `finish/` = `k8s/components/k3d-standins` then eks's finish
  (so the stand-ins' volumes get gp3 too), plus s3-storage's `endpoint.yaml` for Ghost; `cloud.k3d` = the
  stand-ins' hosts, the gateway's bucket and endpoint.
- `gke/` (Phase D part 3): GKE Standard. base + s3-storage with `endpoint.yaml` (Cloud Storage's S3 API,
  `https://storage.googleapis.com`, an HMAC key as `secrets/s3.env`) and the AWS SDK's checksums only when required
  (`AWS_REQUEST_CHECKSUM_CALCULATION`/`AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED`: Ghost's SDK, 3.1079, sends
  them by default and Cloud Storage refuses some; versitygw doesn't, so k3d can't check it), `cloud-sql.yaml`
  (ServiceAccount `cloud-sql`, Workload Identity annotation `CLOUD_SQL_SA` via `replacements.yaml`).
  `finish/`: cloud-postgres; **`cloud-sql-proxy.yaml`**, a strategic merge on Ghost, Grafana, Postiz, Temporal, the
  bridge (it reads Postiz's database) and the Jobs grafana-ro-ghost, grafana-ro-postiz, postgres-logins: the Cloud
  SQL Auth Proxy (2.26.0, its `-alpine` image for the shell) as a native sidecar (an init container with
  `restartPolicy: Always`; a strategic merge puts it first, before Ghost's wait-for-db and the login waits; a Job
  still finishes), on 127.0.0.1:3306 and, when `POSTGRES_INSTANCE` is set (social), :5432 (`MYSQL_INSTANCE`,
  `POSTGRES_INSTANCE`, `CLOUD_SQL_PROXY_FLAGS` from ConfigMap `cloud`; never ConfigMap `site`, whose new name with
  any profile change would restart Ghost: the test caught that), started = `nc -z` on its ports; `hostAliases` send `mysql`,
  `postiz-postgres`, `postiz-temporal-postgres` to 127.0.0.1, so no module's setting changes; serviceAccountName
  `cloud-sql`; annotation `creator-kit/sidecar: cloud-sql-proxy` (the twin finds the pods by it). Postiz's Postgres
  Services deleted; standard-rwo everywhere; `cloud.google.com/l4-rbs: enabled` + `externalTrafficPolicy: Local` on
  `traefik` and `tinyice-source`. `cloud.env.example`. Not tried on Google Cloud yet.
- `k3d-gke/`: `resources: ../gke`; `finish/` = k3d-standins, gke's finish, then `forwarder.yaml` on the
  annotated pods: the sidecar's image (`alpine/socat`) and script only, socat from 127.0.0.1's ports to the
  stand-ins `cloud.k3d` names as the instances; env, probe, user and hosts stay gke's.
