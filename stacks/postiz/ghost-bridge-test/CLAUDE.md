# stacks/postiz/ghost-bridge-test/

The bridge's tests. The bridge: `stacks/postiz/ghost-bridge/CLAUDE.md` (what each module does: `docs/bridge-map.md`).

The bridge's tests: `ghost-bridge-test/` (beside the code, not in it: the load check imports every `.mjs` one folder
down, and the image takes every `.mjs` at any depth), Node's own runner, nothing to install: `node --test` there
(Node >= 22.13, for `node:sqlite`; `kit/check.sh` runs them, and GitHub with it). `env.mjs` first in each file: a clean
environment (the bridge's defaults, `SITE_HOST=example.com`), as config.mjs reads it once at load. `content` (bodyText,
links, the featured link, #clip, captions fitted to every network's limit, tagLink's short links against
`kit/redirects.yaml`'s rules), `stats` (history.mjs's helpers: gains per day, 30-day sums, sitePath/siteLinks),
`schedule` (WEEKLY_SUMMARY_AT, seasons, ntfy's cut), `later` (notifications kept for a Story's own time, against a fake ntfy; `zonedTime`), `share` (`handlePost` run as a draft preview, fully dry, against a
fake Postiz that only lists channels: each network's status, caption, media and notifications), `shared` (sharing
again: handlePost's `again`, `only` (some networks, or #bigdrop's Story apart from Instagram's feed post; the rest keep their results) and posted.json's `earlier`, a Story set for later (`storyAt`, "not yet" on the list until then), the Shared posts page (scheduled and drafts on page 1 only) and `POST .../share`'s checks, through
serveDraftPreview against fake-web's Ghost and Postiz), `postgres` (pgQuery's
three sign-ins, a forged SCRAM server, errors). The numbers collectors, one poll each against made-up answers in the
APIs' real shapes: `social` (Bluesky, Threads, TikTok, Mixcloud, Postiz's own), `site` (Ghost + Tinybird, Cloudflare,
Search Console with a key made in the test), `live` (shows over time, clicks, pets and their caps), `instagram`,
`youtube`, `soundcloud`. Their helpers: `fake-web.mjs` (fetch replaced: `web.on(address, answer)`, `web.asked`,
`web.unanswered`), `fake-postgres.mjs` (password, md5 or SCRAM), `collectors.mjs` (its own data folder, the clock and
timers stopped at `NOW`, startStats as ghost-bridge.mjs starts it: `poll(name, prev)`). The seams they use:
startStats' `run(name)` and `live`, `poll*Stats` exported by instagram/youtube/soundcloud.mjs; every collector timer
is `unref()`'d (the server keeps the bridge running). A fix or a new rule gets its test there.
