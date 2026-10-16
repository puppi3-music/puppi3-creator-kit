#!/usr/bin/env bash
# A GKE Standard cluster for the kit's gke overlay, with gcloud (you run it; Claude never does):
#   PROJECT=<project> k8s/clusters/gke.sh up      (about 10 minutes; REGION, NAME, VERSION change the defaults)
#   PROJECT=<project> k8s/clusters/gke.sh down    when the burst is over (after k8s/migrate/to-nas.sh)
# Standard, not Autopilot: Autopilot wants every pod's resources fitted to its rules. Workload Identity is on, so the Cloud SQL proxies act as the site's
# Google service account with no key stored. standard-rwo (pd-balanced), the overlay's StorageClass, is GKE's own.
# Then (the Cloud guide, kit/docs/cloud-guide.html#gcp): Cloud SQL for MySQL 8 and for Postgres, the site's bucket and its HMAC key, the Google
# service account with the Cloud SQL Client role and its Workload Identity binding for Kubernetes service account
# "cloud-sql" in the site's namespace (`up` prints the command), and Artifact Registry only for images you build. Their
# names go in <site>/cloud-gke.env.
# Not tested here: only a real Google Cloud project can.
set -euo pipefail
PROJECT="${PROJECT:?PROJECT=<your Google Cloud project>}"
REGION="${REGION:-us-central1}"
NAME="${NAME:-creator-kit}"
VERSION="${VERSION:-1.35}"     # the k3d test cluster's minor (k8s/test/k3d.sh)
g() { echo "+ gcloud $*" >&2; gcloud --project "$PROJECT" "$@"; }
case "${1:-}" in
    up)
        g services enable container.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com
        # one zone's nodes (a regional cluster would triple them); two e2-standard-4 (4 vCPU, 16 GB): analytics +
        # live + social + monitoring fit, as on EKS's two m7i.xlarge
        g container clusters create "$NAME" --location "$REGION-a" --cluster-version "$VERSION" \
            --release-channel regular --workload-pool "$PROJECT.svc.id.goog" \
            --machine-type e2-standard-4 --num-nodes 2 --disk-size 50 \
            --enable-ip-alias --addons GcePersistentDiskCsiDriver
        g container clusters get-credentials "$NAME" --location "$REGION-a"
        cat <<EOF
Cluster $NAME is up, and kubectl's context is it. For the Cloud SQL proxies (site namespace = its ID_PREFIX):
  gcloud iam service-accounts add-iam-policy-binding <CLOUD_SQL_SA> --project $PROJECT \\
      --role roles/iam.workloadIdentityUser --member "serviceAccount:$PROJECT.svc.id.goog[<namespace>/cloud-sql]"
EOF
        ;;
    down)
        g container clusters delete "$NAME" --location "$REGION-a" --quiet
        ;;
    *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
