# stacks/

One Compose file per service group: `traefik/`, `ghost/` (Ghost, MySQL, analytics; `puppi3/` before kit 1.2.0), `postiz/` (Postiz and the
bridge), `icecast/` (the stream), and `monitoring/grafana/` (the dashboards and alert rules, which `kit/monitoring/`'s
Grafana and k8s's monitoring module load). Each folder with more than a compose file has its own CLAUDE.md.

- `kit/compose.yaml` includes them as one project, with `kit/profiles/<stack>.yaml` adding the Compose profiles (one
  per module) and the kit's paths and names. Profiles never go in the stack files themselves: each one also runs on
  its own (one project per stack, e.g. under a stack manager), and a stack run without `--profile` would skip those
  services. `k8s/` builds from the same files (images, Traefik's dynamic files and plugins, the bridge's code).
- Site values come from the instance profile (`instances/CLAUDE.md`): `kit.sh` passes the site's `site.env`; a stack
  run on its own reads it as a global .env beside the stacks. `SITE_HOST` and `DATA_DIR` are required (`${VAR:?…}`),
  and the Ghost stack's `GHOST_DATA_DIR`, so a stack with no profile stops instead of starting as another site on
  empty folders. Every other default is neutral.
- Each stack's secrets: `.env.example` lists its keys (its comments are the Settings reference's text). A kit site
  keeps them in its folder's `secrets/<stack>.env`; never put a `.env` in `stacks/`.
- Bind mounts are absolute (`${DATA_DIR}/<stack>/...`, the Ghost stack's `${GHOST_DATA_DIR}/...`), never `./...`: a stack manager that runs compose inside its
  own container turns a relative mount into a path inside that container, and the host makes it empty. Build contexts
  and `env_file` are read where compose runs, so those stay relative.
- Shared external networks: `proxy` (Traefik and what it routes to) and `monitoring` (Prometheus and what it
  scrapes). `kit.sh` makes both.
- A site that keeps the kit inside its own repo may put its own notes for a folder in a `CLAUDE.site.md` beside the
  folder's CLAUDE.md: read both there.
- Keep the files neutral: no real addresses, private paths or home-network names, comments included (say
  `SITE_HOST`, `LAN_DOMAIN`, "the server", "a stack manager"). `python3 kit/scrub.py` checks.
