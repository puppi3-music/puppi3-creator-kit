# kit/theme-test/

Tries the kit's theme (`kit/theme/CLAUDE.md`) in a muted Chromium, and holds the Playwright the kit's other browser
scripts use (`kit/test.sh`, `kit/demo/shots.mjs`). The rest of the kit: `kit/CLAUDE.md`.

- `test.mjs`: `docker compose -f kit/theme-test/compose.yaml up -d`, then `npm install` (once) and `node test.mjs`
  here; `down -v` after. A throwaway Ghost on `localhost:2398` with `kit/theme/` mounted live; the test sets the site
  up (it deletes all posts, so it refuses anything but localhost) and checks the hooks in a muted Chromium with the
  live status and stream faked; then signs the browser in to Ghost Admin (the API's session cookie) to check View
  site has the Shared posts button and Settings' design previews don't.
- `kit-site.mjs`: `kit/test.sh`'s browser, on the running test site through its Traefik: looks like a visitor's Chrome
  (or Ghost's tracker skips it) arriving through Cloudflare, whose browser says UTC, so the country comes from
  page-hit-country. Prints one JSON line: what it saw and which beacons went out.
- `kit/local-site.sh` checks Playwright and its Chromium are here: `npm install` and
  `npx playwright install --with-deps chromium`.
