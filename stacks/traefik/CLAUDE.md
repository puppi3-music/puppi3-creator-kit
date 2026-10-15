# stacks/traefik/

Traefik in front of everything (pinned `v3.7.13`, ports 80/443, a file provider watching `dynamic/`, the local plugins
in `plugins-local/`). In a kit site, `kit/kit.sh` copies the `dynamic/` files into the site's `data/traefik/dynamic/`
as `kit-*.yml` (`puppi3.yml` as `kit-site.yml`), beside the site's own `lan-only.yml` (`kit/setup.sh` writes it).

- Two guards: every home-network-only router (`traefik.<LAN_DOMAIN>`, `tinyice.<LAN_DOMAIN>`, `grafana.<LAN_DOMAIN>`)
  gets `lan-only@file` (the site's `lan-only.yml`); every public route gets `cloudflare-only@file`
  (`dynamic/cloudflare-only.yml`: Cloudflare's ranges plus `TRUSTED_EXTRA`).
- The https entrypoint trusts forwarded headers only from Cloudflare (`forwardedHeaders.trustedIPs`, the same list:
  keep it, cloudflare-only.yml and real-ip.yml in step). Cloudflare keeps a visitor's own X-Forwarded-For in front and
  Ghost takes the leftmost, so the site's routers also use `real-ip@file` (`dynamic/real-ip.yml`, local plugin
  `plugins-local/src/creatorkit/realip/`), and so do Postiz's and the kit's Grafana's public routers (their sign-in
  limits count by address; Kubernetes' `social.yml` and `monitoring.yml` the same): X-Forwarded-For and X-Real-Ip become `CF-Connecting-IP` when the client is
  in Cloudflare's ranges, else the client's own address. It's on the site's main router, so if it fails to load the
  site 404s.
- `dynamic/page-hit-country.yml`: the page-hit route only, after real-ip (local plugin
  `plugins-local/src/creatorkit/pagehitcountry/`). Ghost's tracker sends `payload.location` guessed from the browser's
  time zone, never the IP, null for UTC (privacy browsers, scrapers); only then it's set to Cloudflare's
  `CF-IPCountry` (not XX/T1); bodies over 64 KB, non-JSON or unreadable pass as they came; if it fails, page hits 404
  and the site is fine. Yaegi (Traefik's Go interpreter) loses `m[k], _ = f()` and mixes up embedded-interface
  methods, so avoid both. Traffic's Top locations shows a blank country as "Unknown".
- Each plugin has its tests beside it (`<name>_test.go`: `go test` in its folder; `kit/check.sh` runs them with
  gofmt and go vet, and the commit hook when a plugin changed). Yaegi never loads a `_test.go`, and k8s's ConfigMap
  lists each plugin's files by name, so they never reach Traefik. realip's: who's believed (only Cloudflare's
  ranges), spoofed headers, IPv6, another proxy's header; pagehitcountry's: when it fills the country, everything it
  leaves alone, a body over 64 KB whole.
- `plugins-local/src/creatorkit/stagingbar/`: puts its `html` option before `</head>` of text/html responses and drops
  Accept-Encoding so pages arrive unpacked: a staging copy's marks (a middleware in a dynamic file of that site's own;
  no route here uses it). If it fails to load, only routers using it 404.
- The plugins' module path is `creatorkit/<name>`: the folder under `plugins-local/src/`, each `go.mod` and
  `.traefik.yml`, and the `--experimental.localPlugins.*.moduleName` flags in `compose.yaml`, k8s's
  `base/traefik.yaml` (with its ConfigMap's `items`, in `base/kustomization.yaml`'s `traefik-plugins`) must agree. Plugins load at Traefik's start:
  a plugin change needs a Traefik restart; a new one goes in (compose flag + plugin + its dynamic file, restart)
  before any route uses it (dynamic files apply at once).
- Both entrypoints have `respondingTimeouts.readTimeout=900` (Traefik v3 cuts a request still arriving at 60 s): big
  uploads to Ghost Admin.
- `dynamic/puppi3.yml` (the site's routes: Ghost prio 50, `/.ghost/analytics` (+ page-hit-country) and
  `/.ghost/stats` 110, ActivityPub 300; `/.site/click` (POST) and `/.puppy/pets` 110 -> the bridge). In the file
  provider, not labels, so they change without restarting Ghost. Other routes live as labels in their stacks: the
  bridge's (`stacks/postiz/CLAUDE.md`), TinyIce's (`stacks/icecast/CLAUDE.md`). A new site router also needs adding
  to Health's router list in Grafana (`stacks/monitoring/grafana/CLAUDE.md`).
- `dynamic/{puppi3,cloudflare-only,real-ip}.yml` are Go templates (Traefik's file provider renders them, with Sprig)
  on Traefik's environment, which `compose.yaml` fills from the instance profile (`SITE_HOST`, `ID_PREFIX`, `MODULES`,
  `BEHIND_CLOUDFLARE`, `TRUSTED_EXTRA`, `TLS_RESOLVER`; `SITE_HOST` required, the rest empty = the templates' neutral
  defaults: no `TRUSTED_EXTRA`, `BEHIND_CLOUDFLARE` true, `cf`). Router names are `<ID_PREFIX>-…` (Health's regexes,
  the 5xx alert); the analytics routes need `analytics` in `MODULES`, clicks `social`, pets `pets`.
  `BEHIND_CLOUDFLARE=false`: cloudflare-only allows everyone and real-ip trusts nobody as Cloudflare (192.0.2.255/32:
  the plugin refuses an empty list). `TRUSTED_EXTRA` (`none` = no others) = e.g. the home network. For a second site
  on the same templates (e.g. a staging copy): `ENTRYPOINT`, `TLS_RESOLVER=none` (no tls block; `self` = a tls block
  with no resolver, https on Traefik's own certificate, for `kit/test.sh`; label routers then log "nonexistent
  certificate resolver" and still work), `*_UPSTREAM` (Ghost, analytics, Tinybird, bridge addresses),
  `SITE_MIDDLEWARES`/`ADMIN_MIDDLEWARES` (extra middlewares on Ghost's router / an added `/ghost/` router),
  `UPSTREAM_PROXY` (real-ip believes that proxy's `X-Real-Ip`: the realip plugin's `header` option, default
  `CF-Connecting-IP`). `cf` = Cloudflare's DNS challenge (`CLOUDFLARE_DNS_API_TOKEN`), `le` = Let's Encrypt's TLS
  challenge (can't pass Cloudflare's proxy).
- `compose.yaml`'s mounts use `DATA_DIR` (`instances/CLAUDE.md`); the dashboard is at `traefik.<LAN_DOMAIN>`.
