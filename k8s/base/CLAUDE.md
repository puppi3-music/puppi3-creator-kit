# k8s/base/

What every site runs, whatever its modules and overlay: Traefik and Ghost. The modules are `k8s/components/`, MySQL
too (`k8s/components/CLAUDE.md`); `up.sh` and the rest: `k8s/CLAUDE.md`.

- Traefik: Traefik's own image at the Compose version; the local plugins `realip` and `pagehitcountry` are ConfigMap
  `traefik-plugins` (the stack's files; `items` put each back under `/plugins-local/src/creatorkit/<name>/`, a
  changed plugin = a new ConfigMap name = a restart, which plugins need). Not root, so entrypoints
  `web` :8000 and `https` :8443 behind a LoadBalancer Service on 80/443 (`externalTrafficPolicy: Local`, for the
  visitor's address); the Compose stack's flags otherwise (timeouts, Cloudflare's trusted ranges, the `cf`/`le`
  resolvers on a small PVC, metrics on :8082 with Service `traefik-metrics`). Routes come only from the file
  provider: ConfigMap `traefik-dynamic` = the stacks' own templates (`puppi3.yml` as `site.yml`, `cloudflare-only`,
  `real-ip`, `page-hit-country`) plus `k8s/base/traefik/{lan-only,dashboard}.yml`; a module's component adds its route
  files to it (`behavior: merge`). Traefik reads the mounted ConfigMap folder without doubling (checked). Its
  environment is the `site` ConfigMap plus `GHOST_UPSTREAM=http://ghost:2368`; the other upstreams' defaults are
  already the Services' names (`traffic-analytics`, `tinybird-local`, `postiz-ghost-bridge`), so keep those names.
- Ghost: `ghost:<version>-alpine` (the Compose stack's exact version), 1 replica, `Recreate`, settings as environment (no `config.production.json`), MySQL at
  Service `mysql` (an init container waits for it), content on PVC `ghost-content`; mail (`mail__*`, as the NAS's
  config file's `mail`) from the site's optional `secrets/ghost-mail.env` (Secret `ghost-mail`, envFrom, optional:
  without it Ghost's Direct mail; `kit/examples/ghost-mail.env.example`, which Compose reads too); probes ask
  `/ghost/api/admin/site/` with `X-Forwarded-Proto: https`.
