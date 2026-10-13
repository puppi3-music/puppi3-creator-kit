# Changelog

What each version of Puppi3's Creator Kit changes for a site already running. Your version is in `kit/VERSION`.
How to update: the Operations guide (`kit/docs/operations-guide.html#upgrade`).

## 1.0.1

- The theme's footer and the bridge's preview pages link the kit's source ("Source"), which the licence asks a site to
  offer its visitors. Your site: build and upload the theme again (`kit/theme-zip.sh`), then `kit/kit.sh <folder> up -d`
  for the bridge.

## 1.0.0

The first release: Ghost 6 behind Traefik, with the analytics, social, live and monitoring modules, on Docker
Compose or Kubernetes (your own cluster, Amazon EKS, Google GKE), and the kit's theme.
