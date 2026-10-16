# k8s/components/analytics/

Ghost's own analytics on Kubernetes. The other components: `k8s/components/CLAUDE.md`; `up.sh` and the rest: `k8s/CLAUDE.md`.

Module `analytics`: `tinybird-local` StatefulSet (the stack's digest; ClickHouse and Redis
volumes; started trimmed by the Ghost stack's script (no MCP or Kafka server, no CSV worker; `image-pins.py` keeps
the copies equal): ~1.8 GB idle, so request 2Gi; limit 4Gi, room for an unchanged start (~2.4 GB with one CSV worker
at `PYTHON_CPU_COUNT=2`; with five workers 3Gi was OOM-killed in a loop); startup
probe with a 5 s timeout, as Compose's), `traffic-analytics` Deployment (salts on a small PVC), and `tb-setup` as a
Job: init containers copy Ghost's schema files out of Ghost's image and run the stack's `setup.sh` with
`TB_SETUP_EXIT=1`, then `save-tokens` puts the tokens into Secret `tinybird-tokens` with a server-side apply through
the API (ServiceAccount + Role: create secrets, get/patch only that one). Ghost and traffic-analytics take it as
`envFrom`, not optional, so their pods wait (CreateContainerConfigError until it exists) and Ghost starts with the
tokens. The Ghost patch is a JSON patch that appends: a strategic merge puts new env first, before `SITE_HOST`,
and `$(SITE_HOST)` wouldn't expand. Traefik's routes are already in the site's template.
