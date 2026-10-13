# docs/

`build-docs.py` builds the kit's guides (in `kit/docs/`), with the shared styles and script in `assets/`.
`bridge-map.md` is the map of the bridge's modules (`stacks/postiz/CLAUDE.md`): read it before opening the bridge's
code; the commit hook checks it's current.

- Each guide (`kit/docs/*.html`, `KIT_PAGES`) is one self-contained file, so it works when sent alone; its search
  covers only itself. The shared UI (top bar and its "All guides" link, shown only over http(s), search, contents
  list, light/dark theme, copy buttons, table layout incl. phone cards) lives in `assets/docs.css` and `docs.js`;
  build-docs copies them between the `<!-- shared styles/script -->` markers in each page. Edit the assets, never the
  copies. The commit hook runs it; `--check` only reports stale pages.
- The Settings reference (`kit/docs/settings-reference.html`) is written first, between its `generated` markers, by
  `kit/docs/settings_reference.py` from the example files (`kit/CLAUDE.md`); its checks fail the build: a setting read
  but not documented, documented but not read, or a private name in it.
- The build also fails on a private name (`settings_reference.PRIVATE_WORDS`) anywhere in a guide or in `assets/`, so
  keep the assets' comments neutral too.
- Every h3 has an id (`<section-id>-<slug>`), used by search results and the contents list. A new guide goes in
  `KIT_PAGES`, the commit hook's `git add` and a card on `kit/docs/index.html`.
- The guides are for someone setting up or running a site, not for someone reading the code: plain words, what a thing
  is for and what to do. The CLAUDE.md files keep the code side.
