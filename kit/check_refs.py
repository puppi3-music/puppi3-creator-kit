#!/usr/bin/env python3
"""Paths the kit's files name that the kit's repo doesn't have, and Traefik plugins they load that it doesn't have
(one missing turns them all off, and the site 404s). kit/check.sh runs it on the repo it's in:

    python3 kit/check_refs.py [--here <another repo>]

With --here, a path counts as missing when that other repo has it and this one doesn't (the site repo the kit is
sent from passes itself: what's only there must not be named here). Without it, only paths that are never the kit's
(plans/, a site's own theme or infrastructure repo) count. In a site's repo that keeps the kit (scripts/kit-sync.py
there), only the kit's files are checked, as the kit's repo has them, against that repo. A mention that's fine goes in
ALLOW, with its reason.
"""
import fnmatch
import glob
import os
import re
import subprocess
import sys

# (file pattern, path pattern, why)
ALLOW = [
    ("stacks/monitoring/grafana/render.py", r"puppi3\.py", "says a site's own profile isn't in the kit"),
    ("*", r"^ghost/traffic-analytics$", "Ghost's image, not a path"),
    ("kit/scrub.py", r".", "its list of what it skips"),
    ("kit/check_refs.py", r"^scripts/kit-sync\.py$", "a site's own script, used only when it's there"),
    (".gitignore", r".", "what it keeps out"),
    ("*", r"^(kit/sites|kit/dist|k8s/images/built\.env)", "made by the kit's tools (git-ignored)"),
]
TOP = r"(?:scripts|docs|stacks|instances|plans|ghost|kit|k8s|nas-infra|theme|ghost-theme-puppi3)"
REF = re.compile(r"(?<![\w./@-])(" + TOP + r"/[\w./@*-]*[\w*/])")
NEVER = ("plans", "nas-infra", "ghost-theme-puppi3")


def problems(texts, have, here=None):
    """texts: {path: text} of the kit's files; have: the kit's paths; here: the other repo, or None."""
    out = []
    dirs = {os.path.dirname(p) for p in have}
    dirs |= {d[:i] for d in dirs for i in range(len(d)) if d[i] == "/"}
    for path, text in sorted(texts.items()):
        if path.endswith("CLAUDE.site.md"):   # a site's own notes, never the kit's
            continue
        for mod in re.findall(r"localPlugins\.\w+\.moduleName=([\w./-]+)", text):
            if f"stacks/traefik/plugins-local/src/{mod}/.traefik.yml" not in have:
                out.append(f"{path} loads Traefik's plugin {mod}, which the kit doesn't have")
        for ref in sorted(set(REF.findall(text))):
            ref = ref.rstrip(".")
            if any(fnmatch.fnmatch(path, f) and re.search(r, ref) for f, r, _ in ALLOW):
                continue
            plain = ref.rstrip("/")
            if "*" in plain or "<" in plain:
                if here and glob.glob(os.path.join(here, plain)) and not any(
                        fnmatch.fnmatch(p, plain) or p.startswith(plain.split("*")[0]) for p in have):
                    out.append(f"{path} names {ref}, which the kit doesn't have")
                continue
            if plain in have or plain in dirs:
                continue
            if plain.startswith(NEVER) or here and os.path.exists(os.path.join(here, plain)):
                out.append(f"{path} names {ref}, which the kit doesn't have")
    return out


def main():
    args = sys.argv[1:]
    if args and not (len(args) == 2 and args[0] == "--here"):
        sys.exit(__doc__)
    top = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sync = os.path.join(top, "scripts", "kit-sync.py")
    if os.path.isfile(sync):   # a site's repo that keeps the kit: only the kit's files, as the kit's repo has them
        import importlib.util
        spec = importlib.util.spec_from_file_location("kit_sync", sync)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        files = mod.files()
        found = problems({p: d.decode("utf-8", "replace") for p, d in files.items()}, set(files), top)
        for p in found:
            print(f"check_refs: {p}")
        sys.exit(1 if found else 0)
    names = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=top, capture_output=True,
                           text=True, check=True).stdout.split("\n")
    have = {n for n in names if n and os.path.isfile(os.path.join(top, n))}
    texts = {}
    for p in have:
        try:
            with open(os.path.join(top, p), encoding="utf-8") as fh:
                texts[p] = fh.read()
        except UnicodeDecodeError:
            pass
    found = problems(texts, have, os.path.abspath(args[1]) if args else None)
    for p in found:
        print(f"check_refs: {p}")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
