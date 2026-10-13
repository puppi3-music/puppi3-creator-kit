#!/usr/bin/env python3
"""A cloud overlay's k3d twin must run the cloud's own manifests, give or take the stand-ins (plan: "Testing EKS and
GKE on k3d"). Compares the two renders of one site (k8s/up.sh <site> <overlay> --render's rendered.yaml):

    twin-diff.py <cloud render> <twin render>

and prints every difference that isn't on the list below, exiting 1 if there's any. Allowed:
  - what components/k3d-standins/ adds (the database stand-ins, the S3 gateway, their logins)
  - the site's values (ConfigMaps cloud and s3, which the aliases and the ServiceAccount's role are filled from)
  - Secrets' contents (the stand-ins' keys)
  - Ghost reaching the gateway (its endpoint, path-style: k3d-eks; gke has them for Cloud Storage already)
  - each Cloud SQL proxy's image and script (k3d-gke: a TCP forwarder to the stand-ins)
Generated names' hash suffixes are ignored.
"""
import re
import sys

import yaml

STANDIN_ONLY = {("StatefulSet", "standin-mysql"), ("Service", "standin-mysql"), ("StatefulSet", "standin-postgres"),
                ("Service", "standin-postgres"), ("StatefulSet", "s3"), ("Service", "s3"),
                ("Secret", "s3"), ("Secret", "cloud")}
VALUES = {("ConfigMap", "cloud"), ("ConfigMap", "s3")}
GHOST_GATEWAY_ENV = {"storage__KitS3Storage__endpoint", "storage__KitS3Storage__forcePathStyle"}


def load(path):
    docs = [d for d in yaml.safe_load_all(open(path)) if d]
    # generated ConfigMaps and Secrets end in -<10 characters>: take that off everywhere they're named
    hashed = {d["metadata"]["name"] for d in docs if d["kind"] in ("ConfigMap", "Secret")
              and re.search(r"-[a-z0-9]{10}$", d["metadata"]["name"])}
    text = yaml.safe_dump_all(docs, sort_keys=True)
    for name in sorted(hashed, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", name[:-11], text)
    return {(d["kind"], d["metadata"]["name"]): d for d in yaml.safe_load_all(text) if d}


def allowed(key, d):
    """d with the allowed differences taken out"""
    kind, name = key
    if key in VALUES:
        d.pop("data", None)
    if kind == "Secret":
        d.pop("data", None)
    if kind == "Service" and d.get("spec", {}).get("type") == "ExternalName":
        d["spec"].pop("externalName", None)      # from ConfigMap cloud
    if kind == "ServiceAccount":
        d.get("metadata", {}).pop("annotations", None)   # the role, from ConfigMap cloud
    if key == ("Deployment", "ghost"):
        c = d["spec"]["template"]["spec"]["containers"][0]
        c["env"] = [e for e in c.get("env", []) if e["name"] not in GHOST_GATEWAY_ENV]
    pod = d.get("spec", {}).get("template", {}).get("spec", {})
    for c in pod.get("initContainers", []):
        if c["name"] == "cloud-sql-proxy":
            c.pop("image", None)
            c.pop("args", None)
    return d


def diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                yield f"{path}.{k}: only in the twin"
            elif k not in b:
                yield f"{path}.{k}: only in the cloud's"
            else:
                yield from diff(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            yield from diff(x, y, f"{path}[{i}]")
    elif a != b:
        yield f"{path}: {str(a)[:80]!r} -> {str(b)[:80]!r}"


cloud, twin = load(sys.argv[1]), load(sys.argv[2])
bad = []
for key in sorted(set(cloud) | set(twin)):
    if key not in twin:
        bad.append(f"{key[0]}/{key[1]}: missing from the twin")
    elif key not in cloud:
        if key not in STANDIN_ONLY:
            bad.append(f"{key[0]}/{key[1]}: only in the twin, and not a stand-in")
    else:
        bad += [f"{key[0]}/{key[1]}{line}" for line in diff(allowed(key, cloud[key]), allowed(key, twin[key]))]
print("\n".join(bad) if bad else f"the twin differs only by the stand-ins ({len(twin) - len(cloud)} resources)")
sys.exit(1 if bad else 0)
