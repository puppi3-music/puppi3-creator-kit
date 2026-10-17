# kit/demo/

The README's screenshots (`kit/docs/images/*.webp`). The README only says the shots are from a made-up site: the
scripts are for contributors (`CONTRIBUTING.md`). The rest of the kit: `kit/CLAUDE.md` (`local-site.sh`, which
this shares with `kit/test.sh`).

- `demo.sh [--keep]`: takes them from a throwaway demo site (`kit/local-site.sh`, like test.sh; `kit/sites/demo`:
  demo.test, "Night Owl Radio", `ID_PREFIX=demo`, `NETWORKS=ghost`), removed after. Everything in it is made up: posts
  with pictures drawn by ffmpeg's `gradients` and a cover (`content.py`; Ghost's own sample post deleted, its picture
  is on Ghost's servers), 64 members (CSV import with `created_at`), music links, a live stream (ffmpeg), and a month
  of visits (`visits.py`: one real page hit's shape copied into ~6,000 rows over 30 days, sent to Tinybird's events
  API with `payload` as an object, `parsedReferrer` for the source; the answer counts only its first chunk, so it
  counts the table). Stand-ins, demo only: Traefik joins blackbox's network as demo.test and live.demo.test, and
  blackbox skips certificate checks (Traefik's own), so the uptime tiles read UP.
- `shots.mjs` (muted Chromium, `kit/theme-test/`'s Playwright): the home page with the LIVE NOW bar on a laptop and a
  phone, Grafana's Traffic and Overview (30 days) and Health's tiles (kiosk mode); `preview`: a draft's Social preview
  (`content.py`'s one draft, not a `post*.json` so it gets no visits), signed in to Ghost Admin from the page
  (Playwright's own requests don't get the browser's `demo.test` mapping); the draft has a SoundCloud link, so the
  featured link shows. For it, after Grafana's shots (so the made-up networks are never in the numbers), demo.sh gives
  the bridge a Ghost custom integration's Admin API key and swaps Postiz for a stand-in (`demo-postiz-standin`, node,
  alias `postiz` on the `_postiz` network; the EXIT trap removes it before the site, or its network can't go; `--keep`
  leaves it: `docker rm -f` it first) that lists Bluesky, Threads, Instagram and TikTok: with DRY_RUN the bridge asks
  Postiz only for that list, so no network accounts are needed.
- Needs the same ports as test.sh (`LIVE_PORT` too), ffmpeg with `gradients` (4.4+), cwebp.
