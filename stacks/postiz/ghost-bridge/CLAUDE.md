# stacks/postiz/ghost-bridge/

The bridge (`postiz-ghost-bridge`): shares each Ghost post to the networks through Postiz, draws the social previews,
and collects every network's numbers. Before opening a module, read `docs/bridge-map.md` (which file has what,
exports, import rules); keep it current when files or exports change (pre-commit checks it). Module paths
(`share/…`, `stats/…`) are from `ghost-bridge/`, as in the map. The stack (compose, the settings it passes, Postiz):
`stacks/postiz/CLAUDE.md`; the tests: `stacks/postiz/ghost-bridge-test/CLAUDE.md`.

| Folder | What it is |
|---|---|
| `share/` | Sharing a post, seasonal profile pictures, the weekly summary (own CLAUDE.md) |
| `stats/` | Every number the bridge collects and serves (own CLAUDE.md) |
| `pages/` | The preview pages: dry-run previews, the draft Social preview and its saves, the "All N photos" pages (`preview-routes.mjs`); `preview-render.mjs` only renders them, from what the bridge collected and the settings it passes in. What they show: `share/CLAUDE.md` |

- 23 modules in folders by purpose. Top level: `ghost-bridge.mjs` (start-up, routes, webhook), `config.mjs` (settings,
  log, posted/custom.json), `services.mjs` (Postiz API + alerts, its db, Ghost Admin API); `share/` (share =
  handlePost + upNextDoc, content = post + captions, media = `IMAGE_RULES`, ntfy, pfp = seasonal profile pictures,
  weekly = the weekly summary), `pages/` (preview-render draws, preview-routes = dry-run/photo/draft pages), `stats/`
  (stats = startStats + routes, history = posts over time + helpers, performance, timing, post, store, instagram,
  youtube, soundcloud, social = Bluesky/Threads/TikTok/Mixcloud, site = Ghost/Cloudflare/Search, live =
  shows/clicks/pets); never `data/`. Import rules: helpers in stats/history.mjs (no stats module imports
  stats/stats.mjs), ntfy never imports services. The commit hook checks that every module loads (no import of a name
  another doesn't export) and the map (`.githooks/bridge-check.mjs`).
- SIGTERM exits at once, or after a share in progress (compose's `stop_grace_period: 5m`).
- The webhook: fails closed without `GHOST_WEBHOOK_SECRET` (compose requires it too), bodies >8 MB get 413. Ghost sends `post.published` only on the move to published, never for edits; a republish sends it
  again, but `posted.json` stops a repeat, and one that arrives while that post is still being shared is skipped
  (`sharing`); shares at the same time each add their own entry, one write at a time. `X-Ghost-Signature` is
  `sha256=<hex>, t=<ms>`, hex = HMAC-SHA256(secret, rawBody + t), refused more than 10 minutes off. Ghost takes only
  .mp4/.webm/.ogv video and .mp3/.wav/.ogg/.m4a audio, and converts nothing.
- `ghost-bridge/Dockerfile` (+ `.dockerignore`: only the `.mjs` files): the bridge with its code inside, which the kit
  publishes and Kubernetes runs; the NAS's stack keeps its `dockerfile_inline` base with the code mounted (the same
  Node: `image-pins.py`). deploy.sh sends both files with the stack; the NAS doesn't use them.
