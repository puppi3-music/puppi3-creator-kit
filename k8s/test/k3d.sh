#!/usr/bin/env bash
# This Mac's test cluster for the kit (k3d: k3s in Docker), never a real one:
#   k8s/test/k3d.sh up      1 server + 2 agents, k3s's own Traefik left out (the kit brings its own), a registry for
#                           k8s/build-images.sh --registry k3d (localhost:5111), the site's ports on 9080 and 9443,
#                           the stream source on 8222, and the clouds' StorageClass names (gp3) on k3s's local-path
#                           storage, so the cloud overlays' volumes bind unchanged (made again if it's already up)
#   k8s/test/k3d.sh down    deletes the cluster and its registry
#   k8s/test/k3d.sh env     prints the export that points kubectl at it (eval "$(k8s/test/k3d.sh env)")
# Its kubeconfig is a file of its own (~/.config/k3d/kubeconfig-creator-kit.yaml); ~/.kube/config isn't touched.
set -euo pipefail

NAME=creator-kit
K3S=rancher/k3s:v1.35.5-k3s1   # pinned; Phase D sets it to the clouds' Kubernetes minor
# The clouds' StorageClasses (EKS: gp3), here on k3s's local-path provisioner
storage_classes() {
    local kc; kc="$(k3d kubeconfig write "$NAME")"
    for sc in gp3 standard-rwo; do   # eks's, gke's
        # defaultVolumeType local, as k3s's own class: hostPath volumes give the kubelet no volume stats (Health's disk)
        printf 'apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: %s\n  annotations:\n    creator-kit/stands-in-for: cloud\n    defaultVolumeType: local\nprovisioner: rancher.io/local-path\nreclaimPolicy: Delete\nvolumeBindingMode: WaitForFirstConsumer\n' "$sc"
        echo ---
    done | KUBECONFIG="$kc" kubectl apply -f - >/dev/null
}
case "${1:-}" in
    up)
        if k3d cluster list -o json | grep -q "\"name\": *\"$NAME\""; then storage_classes; echo "k3d cluster $NAME is already up"; exit 0; fi
        k3d cluster create "$NAME" --image "$K3S" --servers 1 --agents 2 \
            --k3s-arg '--disable=traefik@server:*' \
            --registry-create "k3d-$NAME-registry:0.0.0.0:5111" \
            -p 9080:80@loadbalancer -p 9443:443@loadbalancer -p 8222:8222@loadbalancer \
            --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait >/dev/null
        k3d kubeconfig write "$NAME" >/dev/null
        storage_classes
        echo "k3d cluster $NAME is up: eval \"\$($0 env)\""
        ;;
    down)
        k3d cluster delete "$NAME" >/dev/null 2>&1 || true
        k3d registry delete "k3d-$NAME-registry" >/dev/null 2>&1 || true
        echo "k3d cluster $NAME deleted"
        ;;
    env)
        echo "export KUBECONFIG=$(k3d kubeconfig write "$NAME")"
        ;;
    *) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
