# kit/theme/

The kit's theme: Ghost's Source (MIT) with the kit's hooks, so a kit site looks like its own. A site may use its own
theme instead (the Theme guide, `kit/docs/theme-guide.html`; `KIT.md` lists the kit's parts to add to it). Trying it:
`kit/theme-test/CLAUDE.md`. The rest of the kit: `kit/CLAUDE.md`.

This file and `KIT.md` are the kit's notes, not the theme's: `kit/theme-zip.sh` leaves both out of the zip.

- Source as released (the files `KIT.md` lists left out; its README is `SOURCE-README.md`), plus `assets/kit/`
  (`kit.js`: `window.site`, `/.site/click` beacons for links out, the Social preview button on `/p/<uuid>/`, the Shared posts button (to the bridge's `/ghost/social-preview/`) only inside
  Ghost Admin's View site (framed by a `/ghost/` page, not a `/ghost/` page or srcdoc itself, so not Settings' design previews), icons on
  links to other platforms (Patreon, Substack, Vimeo, SoundCloud...: `.kit-platform-link`) in the footer's secondary
  navigation; `live-bar.js`: the LIVE NOW player (no mascot); live = any source but the mp3 it plays and TinyIce's own
  `/_…`, so the source mount can be renamed (a `data-mount` attribute would name it) (a theme may add
  `window.site.livePup`); `kit.css`), `partials/kit/` (the bar, the icon sprite), and the edits to `default.hbs`,
  `partials/components/footer.hbs` (the credit line "Theme: Puppi3's Creator Kit by DJ Puppi3", `.kit-credit`, which
  the licence's 7(b) term asks copies to keep) and `package.json` (the `live_stream_url` setting) that `KIT.md` lists.
- Upgrading Source: copy the new tag over and re-apply those edits (`KIT.md`). Use Source's classes (`gh-outer`,
  `gh-inner`, `--ghost-accent-color`) so the kit's parts follow its layout and the site's accent colour.
- `kit/theme-zip.sh`: builds `kit/dist/puppi3-creator-kit-theme.zip` (git-ignored; needs zip and unzip, which a
  minimal Linux lacks), fails if another site's names are in it (the list is in the script: keep comments generic
  too), then runs gscan. `kit/test.sh`, k8s's test and the release (`.github/workflows/release.yml`) build it with it.
- The short links are `kit/redirects.yaml`, uploaded on their own, not in the zip (`kit/CLAUDE.md`).
