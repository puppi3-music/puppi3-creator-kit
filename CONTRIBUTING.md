# Contributing to Puppi3's Creator Kit

Thanks for helping. Fixes, new networks, better docs and test reports from your own site are all welcome.

## The licence

The kit is under the GNU AGPL-3.0 ([LICENSE](LICENSE)). What you contribute is under the same licence, as part of
the kit, and you keep the copyright to it. Send only work you have the right to share that way. Keep the author
credit (the copyright line, and the theme footer's "Theme: Puppi3's Creator Kit by DJ Puppi3") as it is.

## Where things are

| Part | Folder | Notes for whoever works there |
|---|---|---|
| The Compose kit: `setup.sh`, `kit.sh`, the profiles, monitoring | `kit/` | `kit/CLAUDE.md`, and the one in each of its folders |
| The kit's theme (Ghost's Source plus the kit's parts) | `kit/theme/` | `kit/theme/CLAUDE.md`; `kit/theme/KIT.md` lists every change to Source's files |
| Kubernetes: base, components, overlays, migration | `k8s/` | `k8s/CLAUDE.md`, and the one in each of its folders |
| The services: Traefik, Ghost, the social bridge, the stream | `stacks/` | a `CLAUDE.md` in each stack's folder |
| The dashboards and alert rules | `stacks/monitoring/grafana/` | its `CLAUDE.md` |
| Every setting and its default | `instances/example.env`, the `.env.example`s, `kit/examples/` | their comments are the Settings reference |
| The guides | `kit/docs/` | built by `docs/build-docs.py` |

The `CLAUDE.md` files are the working notes for each folder, for people and coding assistants alike: read the one
next to what you change, and keep it true in the same change.

## Making a change

1. Turn on the checks that run at each commit: `git config core.hooksPath .githooks`.
2. Make the change, with what goes with it:
   - **A new setting** needs a commented line in its example file (`instances/example.env`, a stack's
     `.env.example`, `kit/examples/` or `k8s/examples/`). The comment is what the Settings reference says, so write it
     in plain words. The build fails on a setting that's read but not documented, or documented but not read.
   - **A service** added to a module needs its line in `kit/profiles/` (with its module's profile and `logging: *logs`,
     or Docker keeps its whole log) and its counterpart under `k8s/`.
   - **The theme**: keep the kit's parts in their own files where you can; any edit to Source's own files goes in
     `kit/theme/KIT.md`, so an upgrade of Source can put it back.
   - **Names**: nothing site-specific in the kit (no real addresses, accounts or home-network names, comments
     included). Use `example.com`. The build and `kit/theme-zip.sh` fail on the names they know.
3. Update the guide that describes what you changed (`kit/docs/`), in the same plain style: for someone setting up
   or running a site, not for someone reading the code.
4. Run the checks that fit (below), and say in the pull request which ones you ran.

## The checks

| What you changed | Run | Time |
|---|---|---|
| Anything, before a pull request | `kit/check.sh`: the checks below that need no Docker (the guides, dashboards, the bridge and its tests, the Traefik plugins' tests, shell scripts) and that every path a file names is there. GitHub runs it on every push and pull request too (`.github/workflows/check.yml`) | seconds |
| The bridge (`stacks/postiz/ghost-bridge/`) | its tests: `node --test` in `stacks/postiz/ghost-bridge-test/` (Node 22.13 or later; captions, links, what a post turns into on each network, run dry against a fake Postiz, and each network's numbers collected from made-up API answers). A fix or a new rule gets a test there | seconds |
| A Traefik plugin (`stacks/traefik/plugins-local/`) | its tests: `go test` in the plugin's folder (Go 1.22 or later) | seconds |
| The dashboard scripts (`parts.py`, `render.py`) | their tests: `python3 -m unittest discover -s stacks/monitoring/grafana/tests` | seconds |
| Any guide, setting or example | `python3 docs/build-docs.py --check` (the commit hook runs it too) | seconds |
| The theme | `kit/theme-zip.sh` (Ghost's gscan, and no site-specific names), then the theme test: `docker compose -f kit/theme-test/compose.yaml up -d`, and `npm install` (once) and `node test.mjs` in `kit/theme-test/` (a local Ghost and a browser test; `down -v` after) | minutes |
| The Compose kit, a stack, the bridge | `kit/test.sh`: a throwaway site, `kit.test`, checked end to end (the site, the theme, a stream, the bridge, the dashboards), then removed | several minutes |
| Dashboards or alert rules | `python3 stacks/monitoring/grafana/style.py --check` and `ro-tables.py --check` (the hook runs both) | seconds |
| An image's version (a compose file, k8s's YAML, a Dockerfile) | `python3 k8s/test/image-pins.py`: every image at an exact version, the same in every file (the hook runs it). A bump is one edit in all of them, with its `kit/CHANGELOG.md` line | seconds |
| A new file, or anything with an address or name in it | `python3 kit/scrub.py --names` (no site's own names in the kit's files; without `--names` it also runs gitleaks for secrets, in Docker) | seconds |
| The README's screenshots (after a visible change to the theme or the dashboards) | `kit/demo/demo.sh`: a made-up demo site, photographed and removed; writes `kit/docs/images/` | several minutes |
| Anything in `k8s/` | `k8s/test/test.sh --render-only` first; then `k8s/test/test.sh` (with `--overlay k3d-eks` or `k3d-gke` for a cloud overlay, `--migrate` for the migration) on a local k3d cluster (for now on a Mac with Docker Desktop: below) | 1-16 min |

`kit/test.sh` and `kit/demo/demo.sh` run on Linux, a Mac, or Windows inside WSL2 (Ubuntu, with the repo cloned
into WSL's own folders, not `/mnt/c`, and Docker Desktop's WSL integration on). They need Docker, ports 80, 443 and
8222 free (`LIVE_PORT=<another>` moves the stream's), Python 3, ffmpeg (and cwebp for the demo), and the browser:
`npm install` and `npx playwright install --with-deps chromium` in `kit/theme-test/`. Each says what's missing. On
Linux, setup asks for sudo once (each container's folders get their owners). The Kubernetes test (`k8s/test/test.sh`)
runs only on a Mac with Docker Desktop for now; making it run on Linux too is a welcome change. It leaves
`k8s/images/built.env` naming its cluster's registry: delete it before using `k8s/up.sh` on a real cluster.

None of them touch a real site, cluster or cloud account. What only a real cloud can show (its permissions, load
balancer, database network) is for whoever runs one: say what you tried.

A site runs the kit's published images and theme (each release's, below), so to try a changed bridge (or analytics
setup job) on a site of your own, build them from your copy: `KIT_BUILD=1 kit/kit.sh <folder> up -d` (the tests and
the demo always do). A changed image for Kubernetes: `k8s/build-images.sh` (the Setup guide's "The images"). A changed
theme: `kit/theme-zip.sh` builds the zip in `kit/dist/`.

## Releases

A release is a version tag, `v` + `kit/VERSION`, with a `## <version>` section in `kit/CHANGELOG.md` saying what it
changes for a site already running. The tag starts `.github/workflows/release.yml`: the kit's three images for amd64
and arm64 on GitHub's registry (`ghcr.io/puppi3-music/puppi3-creator-kit/<name>:<version>`), and a GitHub Release
with the theme's zip and that section as its notes. It stops if the tag and `kit/VERSION` differ or the section is
missing. Only the maintainer tags.

Each change in a section gets a `###` heading saying what it does, a paragraph or two, then `**Your site:**`
(what to run, if anything) and `**Restarts:**` (what goes down, and for how long), each its own paragraph: as list
items they'd run into a list above them. Wrap lines as usual: the workflow joins them, since GitHub's release notes
break wherever the text does.

## Writing

Commit messages and the guides use plain words: say what changed and why, the way you'd tell the site's owner.
Commit subjects look like `Area: what changed, another thing`.
