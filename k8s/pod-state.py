#!/usr/bin/env python3
"""k8s/up.sh's wait: reads `kubectl get deployment,statefulset,job,pod -o json` on stdin and prints one of
  ready                         every Job finished, every Deployment and StatefulSet ready
  waiting <name> ...            what isn't yet
  stuck <pod> <container> <reason> ...   one line each for a pod that won't get there by itself: a crash loop, an
                                image that can't be pulled, a config error (but not a pod waiting for tb-setup's
                                Secret tinybird-tokens, which it will get)
"""
import json
import sys

STUCK = ("CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "InvalidImageName")
stuck, waiting = [], []
for i in json.load(sys.stdin)["items"]:
    kind, name = i["kind"], i["metadata"]["name"]
    st, sp = i.get("status", {}), i.get("spec", {})
    if kind in ("Deployment", "StatefulSet"):
        want = sp.get("replicas", 1)
        if (st.get("readyReplicas", 0) < want or st.get("updatedReplicas", 0) < want
                or st.get("observedGeneration", 0) < i["metadata"].get("generation", 0)):
            waiting.append(name)
    elif kind == "Job":
        if not st.get("succeeded"):
            waiting.append(name)
    elif kind == "Pod":
        for c in st.get("initContainerStatuses", []) + st.get("containerStatuses", []):
            w = c.get("state", {}).get("waiting") or {}
            reason, msg = w.get("reason", ""), w.get("message", "")
            if reason in STUCK or (reason == "CreateContainerConfigError" and "tinybird-tokens" not in msg):
                last = (c.get("lastState", {}).get("terminated") or {}).get("reason", "")
                stuck.append("stuck %s %s %s%s: %s" % (name, c["name"], reason, " (%s)" % last if last else "", msg[:200]))
print("\n".join(stuck) if stuck else ("waiting " + " ".join(waiting) if waiting else "ready"))
