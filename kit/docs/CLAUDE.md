# kit/docs/

The kit's own guides, for someone running a site (no code), built by `docs/build-docs.py` (`docs/CLAUDE.md`). The rest
of the kit: `kit/CLAUDE.md`.

- build-docs' `KIT_PAGES`: the shared styles and script, their own neutral header, a blue palette and Puppi3's puppy
  as the mark: her theme's `puppi3-icon.png`, the headphones puppy, drawn flat (`images/kit-puppy.svg`; the same SVG
  is each page's header mark and, inline, its tab icon, and the README's top); build-docs also fails on
  `PRIVATE_WORDS` anywhere in a kit page or the shared assets.
- A site that keeps the kit in its repo links its own guides to these online (the kit's GitHub Pages: build-docs'
  `KIT_ONLINE`), and build-docs checks every such link against this folder: renaming a section here means
  repointing them.
- `index.html` is their front page: a card per guide, each with her puppy on a sitting body in her own colours (inline
  SVG, shared `#kp-*` parts in a hidden defs block after `<body>`; no headphones there, only on the mark) in that
  guide's outfit; the tail wags and the head tilts on hover, props float or spin (all off under reduced motion).
- `setup-guide.html` (by hand): requirements, Cloudflare or not, the folder (setup's questions), Compose, the try-out
  and its switch to the real site, finishing by hand (mail, theme, redirects, Postiz, webhook, `#finish-numbers` in
  short with the Networks guide for each network, ntfy, streaming, Grafana), Kubernetes (overlays, images, up),
  EKS/GKE (what to make, in short; each step with its commands is the Cloud guide), the tests: keep it current with
  `setup.sh`'s questions and printed steps, `up.sh` and the overlays.
- `networks-guide.html` (by hand, for whoever runs a site): how sharing and the numbers fit together, Postiz
  (connecting, the redirect address `https://postiz.<site>/integrations/social/<name>`, reconnecting), each network's
  app step by step (Instagram, Threads, TikTok, Bluesky, YouTube, SoundCloud, Mixcloud, the site itself, Cloudflare,
  Google Search: permissions, which box each address goes in, the keys, what goes wrong), checking the numbers
  arrive, what each key can do (`#safety`). Its steps were done on real accounts in 2026, from
  a running site's notes; the networks' portals move their menus, so check a step against the portal when one changes.
  Keep it current with the collectors (`stacks/postiz/ghost-bridge/stats/CLAUDE.md`), `stacks/postiz/.env.example`
  and Postiz's version.
- `cloud-guide.html` (by hand): a busy stretch on EKS or GKE and back, for a Compose site: Cloudflare's cache rule
  (`#caching`), the costs (mid-2026 list prices), each cloud set up once with its commands (aws, eksctl, helm;
  gcloud), the cluster's folder, the first try, the move and coming home (the generic part is the Operations guide's
  `#move-to-kubernetes`/`#move-back-to-compose`, linked, not repeated), tearing down, the first time on each cloud,
  troubleshooting. Not yet run on a real cloud. Keep it current with `k8s/clusters/`, the overlays'
  `cloud.env.example`, `k8s/migrate/` and `up.sh`.
- `operations-guide.html` (by hand): updating (git pull, `pull --ignore-buildable`, images, theme and redirects by
  `git diff` from the noted version), backups (the folder plus Compose's four Tinybird volumes,
  `<ID_PREFIX>_tinybird_*`/`_traffic_analytics_data`, which `down -v` deletes; stopped tar, running dumps, restore
  through `kit.sh create` so Compose owns the volumes; Kubernetes), moving (another machine; `to-cloud.sh`/`to-nas.sh`
  for a kit site: a second folder for the cluster, same `ID_PREFIX` and secrets), troubleshooting (the alerts and
  what each means, `#trouble-alerts`: keep it current with `stacks/monitoring/grafana/alerts.yml`; sharing a post
  again: points to the Posting guide's Shared posts page (no more editing `posted.json`); Postiz's publishing jobs in Temporal, and
  its page on the host's 127.0.0.1:8233), commands. Its
  backup and restore commands were tried on a throwaway site: keep them true to `kit.sh`, the stacks' volumes and
  `k8s/migrate/`. Putting a nightly copy back was tried on `kit/test.sh --keep`'s site: Ghost's posts and files came
  back, Postiz's `dropdb --force` + `psql` ran clean and Postiz came back healthy, but that site's Postiz had no
  rows to compare; rows and grants coming back were seen on a lone `postgres:17.11-alpine` with a reader connected.
- `theme-guide.html` (by hand, for the site's owner): the kit's theme (Source plus the kit's parts; installing and
  updating it), Source's settings as Ghost Admin shows them (`kit/theme/package.json`'s `config.custom`; Ghost Admin's
  own labels and menu paths, like Settings → Theme → Change theme, Customize's Brand and Theme tabs, Labs → Redirects
  → Edit, are in the Ghost image's admin bundle, `core/built/admin/assets/settings-*.js` and
  `design-and-theme-modal-*.js`: check them there after a Ghost update, as all the guides name them), the LIVE NOW
  bar, the Social preview button, the platforms `kit.js` gives icons ("Links to your other platforms", `#platforms`),
  the short links (`kit/redirects.yaml`), another theme (what it lacks, adding the kit's parts from
  `kit/theme/KIT.md`), and a mascot's extras a theme of one's own can feed (`#own-a-mascot-s-extras`: seasonal
  pictures in `assets/images/pfp/` with `seasons.json`, the pets route). Keep it current with `kit/theme/` and
  `kit/redirects.yaml`.
- `posting-guide.html` (for whoever posts: the bridge's tags, captions, media, notifications, finishing Instagram and
  TikTok) and `analytics-guide.html` (each dashboard, the verdicts, When to post) are by hand too: keep them current
  with the bridge (`stacks/postiz/ghost-bridge/share/CLAUDE.md` for posting,
  `stacks/postiz/ghost-bridge/stats/CLAUDE.md` for the numbers) and the dashboards. The Posting guide's notifications
  include the seasonal profile picture reminder (a theme with outfits only), the Analytics guide the pets panels
  (`PETS`).
- `settings-reference.html` is written by `settings_reference.py` between its `generated` markers (the rest of the
  page is by hand): `site.env` from `instances/example.env`, each `secrets/<stack>.env` from its examples, k8s's files
  from `k8s/examples/` and the overlays' `cloud.env.example`, the bridge's fixed settings (literal values in
  `stacks/postiz/compose.yaml`, with the comment beside each), and which keys setup asks for, makes or fills in (read
  from `kit/setup.sh`; a fixed value it writes, like `database__connection__database=ghost`, is shown instead of the
  stack example's own). Its checks stop build-docs (and the pre-commit hook, which runs when any of those files are
  staged): a `${VAR}` in a kit compose file, profile or Traefik template that no example documents (or `SET_FOR_YOU`
  lists), a documented key nothing reads (git grep outside the examples), private names (`PRIVATE_WORDS`). So a new
  setting needs a commented line in its example; the comments there are the reference's text: plain words, one
  comment block per group of keys, a blank line after a file's header.
- `images/`: the puppy mark and the README's screenshots (`*.webp`, from `kit/demo/`).
