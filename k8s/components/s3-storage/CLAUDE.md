# k8s/components/s3-storage/

Ghost's files in a bucket. The other components: `k8s/components/CLAUDE.md`; `up.sh` and the rest: `k8s/CLAUDE.md`.

Phase D part 1 (the `local` overlay now, the clouds later): Ghost's images, media and
files in a bucket, keys `content/images|media|files/...` (the NAS's own layout, so they copy across as they are);
themes and settings stay on `ghost-content`. The adapter is **`KitS3Storage.js`**: Ghost 6's own built-in
`S3Storage` (it has one: saving, resized images through `saveRaw`, multipart uploads) with `serve()` streaming from
the bucket (content type, a year's cache, byte ranges, 304, 404) instead of Ghost's 301 to a separate CDN address,
so files stay at `https://<site>/content/...` (Cloudflare caches them) and the bucket stays private. Mounted from
ConfigMap `ghost-s3-adapter` beside Ghost's own adapters (`/var/lib/ghost/current/core/server/adapters/storage/`),
no image of its own; configured by `storage__...` environment (media and files as feature settings over the
images' ones; Ghost parses numbers and booleans in env). `cdnUrl` = the site, so Ghost stores new files as
`__GHOST_URL__/content/...` (checked), the same as with local storage: no link changes either way. Bucket and
region from ConfigMap `s3`; keys, when there are any, envFrom Secret `s3` (optional; with none the AWS SDK's chain,
IRSA on EKS). Ghost's `envFrom` is `[]` in the base and every component appends (`/envFrom/-`): an `add` of the
whole list would drop the other's.
`endpoint.yaml`: Ghost's patch for a bucket somewhere other than AWS (S3_ENDPOINT, path-style): s3-gateway, gke and
k3d-eks add it.
