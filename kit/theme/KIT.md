# The kit's theme

Ghost's **Source** theme, v1.7.6 (https://github.com/TryGhost/Source, MIT: `LICENSE` and `SOURCE-README.md` are its
own), with Puppi3's Creator Kit's hooks added. Source ships its built CSS and JS (`assets/built/`), so nothing here is
rebuilt: the kit's additions are files of their own, plus the few edits listed below.

## What the kit adds (its own files)
- `assets/kit/kit.js`: `window.site` (`beacon`, `sendClick`), click beacons for links followed to other sites
  (`POST /.site/click?kind=out&to=&from=`, counted by the kit's bridge), the **Social preview** button on draft
  previews (`/p/<uuid>/` -> `/ghost/social-preview/<uuid>/`, the bridge's page, staff only), and icons beside links
  to the other platforms a creator is on (Vimeo, Twitch, Discord, Patreon, Ko-fi, Substack, Etsy, Behance, Apple
  Podcasts, SoundCloud, Mixcloud, Bandcamp, Spotify, Beatport, Resident Advisor) in the footer's secondary
  navigation (Ghost Admin -> Settings -> Navigation -> Secondary). Ghost's own social accounts (Settings -> General)
  are shown by Source's footer already.
- `assets/kit/live-bar.js`: the **LIVE NOW** bar's player (with no mascot: `window.site.livePup` stands in when a
  theme adds one). Plays, pauses and hiccups go out as beacons (`kind=play|stall|reconnect`).
- `assets/kit/kit.css`: the bar, the button, the platform link icons (`.kit-platform-link`), in Source's accent colour.
- `partials/kit/live-bar.hbs`: the bar: shown while `/live-status.json` (the kit's live module) lists a source other
  than the stream it plays and TinyIce's own (`/_...`), so the mounts can be renamed in TinyIce (a `data-mount`
  attribute names one instead); plays the **Live stream URL** setting; empty = no bar.
- `partials/kit/icons.hbs`: the bar's play/pause and the platforms' icons (`#kit-i-<name>`).

## What the kit changes in Source's files (re-apply after an upgrade)
- `default.hbs`: `kit/kit.css` after `built/screen.css`; `{{> "kit/icons"}}` and `{{> "kit/live-bar"}}` before
  `.gh-viewport`; `kit/kit.js` (and `kit/live-bar.js` with `live_stream_url`) after `built/source.js`. Each marked
  with a "Puppi3's Creator Kit" comment.
- `partials/components/footer.hbs`: the credit line "Theme: Puppi3's Creator Kit by DJ Puppi3" after "Powered by
  Ghost" (`.kit-credit`). The kit's licence (its `LICENSE`, section 7(b)) asks copies and changed versions to keep it.
  Then a "Source" link to the kit's repo (`.kit-source`), which offers visitors the source as the AGPL asks: a
  changed copy points it at its own changed source.
- `package.json`: `name` `puppi3-creator-kit`, `description`, `version` (the kit theme's own), `author`, `keywords`,
  `source_theme` (which Source it's built on), Source's dev fields dropped, and the setting `live_stream_url`
  (Ghost allows 20 theme settings: Source uses 19, this is the 20th).
- Left out of Source's repo: its build tooling (gulpfile, pnpm files, renovate) and its own AGENTS.md/CLAUDE.md (the
  `CLAUDE.md` here is the kit's notes, left out of the zip like this file).

## Upgrading Source
Copy the new tag over this folder (the same files left out), put the edits above back, bump `source_theme.version`
and `version`, run `kit/theme-zip.sh`, and check it in a Ghost: `kit/theme-test/` (a throwaway local Ghost and a
browser test of the LIVE NOW bar, the button, the beacons and the platform icons; CONTRIBUTING.md has the commands).

## Building
`kit/theme-zip.sh` -> `kit/dist/puppi3-creator-kit-theme.zip`: gscan, and a check that no other site's address, private
name or value got in (the list is in the script). Short links: `kit/redirects.yaml` (uploaded on their own, not in the
zip).
