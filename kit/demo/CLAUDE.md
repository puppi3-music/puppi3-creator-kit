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
  phone, Grafana's Traffic and Overview (30 days) and Health's tiles (kiosk mode). No social preview shot: it needs
  Postiz with real networks connected.
- Needs the same ports as test.sh (`LIVE_PORT` too), ffmpeg with `gradients` (4.4+), cwebp.
