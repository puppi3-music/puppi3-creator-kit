# k8s/

The Creator Kit on Kubernetes: Kustomize only (base, components, overlays), no Helm, no CRDs. Traefik + Ghost + MySQL
and the analytics, live, social and monitoring modules. Tests run only on a local k3d cluster (`test/`), never a real
one.

A site is the same folder as on Compose (`kit/setup.sh` makes it: `site.env`, `secrets/`, `data/`).

These folders have a CLAUDE.md of their own: open it before working there. This file has `up.sh`,
`build-images.sh`, the small folders and what the whole of `k8s/` shares.

| Folder | What it is |
|---|---|
| `k8s/base/` | Traefik and Ghost, what every site runs |
| `k8s/components/` | One Component per module (analytics, live, social, monitoring: each with its own CLAUDE.md), MySQL, Ghost's files in a bucket (s3-storage, own CLAUDE.md), the in-cluster S3, the clouds' Postgres, the k3d stand-ins |
| `k8s/overlays/` | Where a site runs: selfhosted, local, eks, gke and their k3d twins; how a cloud overlay's `finish/` and values work |
| `k8s/migrate/` | `to-cloud.sh`/`to-nas.sh`: a site's data between a Docker host and a cluster |
| `k8s/test/` | The k3d cluster, the end-to-end test, the twins' diff, the image pins; run with the `test-k8s` skill |

- `up.sh <site> <overlay> [--render] | <site> [<overlay>] --down` (no overlay: `local`, so a real cluster's needs it
  named; the guides say so): writes the site's kustomization to `<site>/data/k8s/` on every
  run (the overlay; a component per module in `MODULES` that has one, others noted and left out; ConfigMap `site` from
  `site.env`; ConfigMap `ghost` with only `SITE_HOST` and `STAFF_DEVICE_VERIFICATION`, so other profile changes don't
  restart Ghost; a Secret per `secrets/<stack>.env`, named after the stack (`secrets/puppi3.env`, a site's from before
  kit 1.2.0, is Secret `ghost` all the same); the kit's images: `images/built.env`'s when there is one, else this
  version's published ones, `ghcr.io/puppi3-music/puppi3-creator-kit/<name>:<kit/VERSION>`),
  renders it to `rendered.yaml` (`--load-restrictor LoadRestrictionsNone`: the base reads `stacks/traefik/dynamic/`),
  applies it to namespace `<ID_PREFIX>`, deletes the generated ConfigMaps/Secrets the apply no longer named (their
  names carry a hash), and waits (5 min; `UP_TIMEOUT=<s>` for a first slow image pull) until every Job has finished and every Deployment and StatefulSet is ready (Jobs are
  deleted before each apply, so tb-setup runs on every up, as on Compose), printing what it waits for every 30 s and
  stopping at once on a stuck pod (`pod-state.py`: crash loop, with its last log lines; image pull; config error other
  than waiting for `tinybird-tokens`). Ghost's `progressDeadlineSeconds` is 1800 (tokens, then migrations).
  With live on it also makes Secrets `tinyice-config` and `icecast-relay-config` (`components/live/`); with social on,
  Secrets `postiz-env` and `postiz-ghost-bridge-env` and ConfigMap `social` (`components/social/`), and with analytics
  too, a patch giving the bridge `tinybird-tokens`; with monitoring, the rendered dashboards (a ConfigMap each),
  alert rules and Prometheus's config (`components/monitoring/CLAUDE.md`). `rendered.yaml` and those env files hold secrets: mode 600.
  Applies server-side (`--server-side --force-conflicts`, field manager `creator-kit-up`): Platforms' ConfigMap
  (~280 KB) is over the 256 KiB a client-side apply's last-applied annotation holds. `--down` also deletes the
  site's ClusterRole and binding (`<ID_PREFIX>-prometheus-kubelet`), `data/k8s/ghost.env` and `data/k8s/s3.env`.
  With an overlay that has `components/s3-gateway` (and no `secrets/s3.env`), it makes the gateway's one account
  once per site (`data/k8s/s3.env`, mode 600, random keys) and adds it as Secret `s3`.
  Cloud overlays (`finish/`, their values, `replacements.yaml`, the stand-ins' master login): `overlays/CLAUDE.md`.
  `local`/`k3d-*` use k3d's own kubeconfig and refuse any other context; other overlays ask before using kubectl's
  current context.
- `build-images.sh --registry k3d|<registry> [--platform a,b] [--tag <t>]`: builds and pushes the kit's three images (the Icecast relay, the bridge from a folder of just its `.mjs` files (never `data/`) with `stacks/postiz/ghost-bridge/Dockerfile`, tb-setup from a
  folder of just its two files: the stack's folder here may hold a real `tokens.env`; tag = upstream version + a hash of
  the inputs, plus `--tag`'s; `--platform` with a comma = one `docker buildx build --push` for all of them; each with
  `org.opencontainers.image.source`, GHCR's link to the kit's repo), writes `images/built.env` (git-ignored), which
  `up.sh` turns into Kustomize `images:`. The release runs it for GHCR (both architectures, `--tag <VERSION>`; tried
  into k3d's registry: one index per image with amd64 and arm64, 71 s). `k3d` pushes to
  `localhost:5111` and the cluster pulls `k3d-creator-kit-registry:5111`.
- `clusters/eks.yaml` (eksctl: OIDC for IRSA, the load balancer controller's ServiceAccount, the EBS CSI add-on, a
  managed node group of two m7i.xlarge, not Fargate) and `clusters/eks-gp3.yaml` (the default StorageClass): the user
  runs them; untested without an AWS account. `clusters/gke.sh up|down` (gcloud, `PROJECT=`): one zone, two
  e2-standard-4, Workload Identity on; prints the binding for `cloud-sql`. The user runs it; untested.
- `examples/`: what a site's Kubernetes-only secrets files hold (`cloud.env`, `s3.env`; copy to
  `<site>/secrets/`), with the overlays' `cloud.env.example`s the source of the kit's Settings reference
  (`kit/docs/settings_reference.py`): its comments are the reference's text, and a key nothing reads stops the build.
- The Setup guide's Kubernetes and EKS/GKE sections, the Operations guide's moving section and the Cloud guide (each
  cloud set up step by step with its commands, a busy stretch there and back: `kit/docs/`) are how someone runs a
  site on a cluster or moves it: change them with the overlays, recipes or migration scripts.
- A StatefulSet doesn't replace a crash-looping pod after its spec changes (it waits for that pod to get ready):
  delete the pod by hand.
