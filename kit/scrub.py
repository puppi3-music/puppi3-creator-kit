#!/usr/bin/env python3
"""The scrub check before the kit goes public: are the files the kit's own repo will carry free of secrets and of
puppi3.party's own names, NAS and owner? The kit's repo starts with fresh history (plans/creator-kit.md, Publishing),
so what matters there is these files as they are now. This repo's whole history is scanned for secrets too, in case
it's ever made public.

1. Secrets: gitleaks (in Docker, pinned below) over this repo's whole git history, and over the kit's files.
2. Private names: puppi3.party's addresses, NAS, home network and owner (settings_reference.PRIVATE_WORDS plus
   EXTRA below) in the kit's files, apart from the few mentions ALLOW lists on purpose. Here the kit's files are what
   kit/export.py would write for the kit's repo (its list, the moves, kit/kit-repo/, the marked blocks left out); in
   the kit's own repo, every file it has.

    python3 kit/scrub.py              # both; per file, how many lines name what (exit 1 on any finding)
    python3 kit/scrub.py -v           # ...with every line
    python3 kit/scrub.py --names      # only the private names (no Docker)

Nothing is changed: it only reports. A finding is fixed in the file, or, if the mention is meant to stay in the kit
(the author credit, a list of words to check for), added to ALLOW with its reason.
"""
import fnmatch
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GITLEAKS = "ghcr.io/gitleaks/gitleaks:v8.30.1"

# Beyond PRIVATE_WORDS (which the guides' build uses too): the owner's names and email, the home network, the NAS's paths
EXTRA = re.compile(r"REDACTED|REDACTED|REDACTED\.|/home/REDACTED|REDACTED@", re.I)

# Mentions meant to stay: (file pattern, line pattern, why)
ALLOW = [
    ("kit/scrub.py", r".", "this check's own lists"),
    ("kit/docs/settings_reference.py", r"PRIVATE_WORDS", "the guides' list of private words"),
    ("kit/theme-zip.sh", r"grep -n -i -E", "the theme zip's list of private words"),
    ("docs/build-docs.py", r"KIT_SUBS|\(\"puppi3\.party\"", "the guides' swaps of puppi3's addresses for example.com's"),
    ("*", r"Copyright \(c\) 2026 puppi3-music \(DJ Puppi3\)", "the copyright line"),
    ("README.md", r"^By puppi3-music \(DJ Puppi3\)", "the author credit"),
    ("*", r"github\.com/puppi3-music/puppi3-creator-kit|puppi3-music\.github\.io/puppi3-creator-kit",
     "the kit's own repo and its guides online"),
    ("kit/theme/package.json", r"\"(name|email)\": \"(\d+\+)?puppi3-music", "the theme's author (GitHub's no-reply address)"),
    ("README.md", r"Traktor, Mixxx", "a list of DJ software"),
    ("stacks/monitoring/grafana/render.py", r"^SOURCE_PRIVATE = |^LEFTOVERS_CLOUD = ",
     "the dashboards' own checks for names that mustn't be in them"),
]


def kit_files():
    """{path in the kit's repo: its contents}. Here, what kit/export.py would write; in the kit's own repo (which has
    no export.py), every file it has."""
    if os.path.isfile(os.path.join(REPO, "kit", "export.py")):
        sys.path.insert(0, os.path.join(REPO, "kit"))
        import export
        return {d: export.content(d, s) for d, s in export.plan().items()}
    out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout.split("\n")
    files = {}
    for f in sorted(f for f in out if f and os.path.isfile(os.path.join(REPO, f))):
        with open(os.path.join(REPO, f), "rb") as fh:
            files[f] = fh.read()
    return files


def private_words():
    spec = importlib.util.spec_from_file_location("settings_reference",
                                                  os.path.join(REPO, "kit", "docs", "settings_reference.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.PRIVATE_WORDS


def allowed(path, line):
    return any(fnmatch.fnmatch(path, p) and re.search(l, line) for p, l, _ in ALLOW)


def names(files, verbose):
    words = private_words()
    found = 0
    for f, data in files.items():
        try:
            lines = data.decode("utf-8").split("\n")
        except UnicodeDecodeError:
            continue   # images, fonts
        hits = []
        for n, line in enumerate(lines, 1):
            w = sorted(set(m.group(0).lower() for r in (words, EXTRA) for m in r.finditer(line)))
            if w and not allowed(f, line):
                hits.append((n, w, line))
        if hits:
            found += len(hits)
            print(f"{f}: {len(hits)} line(s): " + ", ".join(sorted(set(x for _, w, _ in hits for x in w))))
            if verbose:
                for n, _, line in hits:
                    print(f"    {n}: {line.strip()[:160]}")
    return found


def gitleaks(files):
    """Exit 1 from gitleaks means leaks (its report says where, redacted); anything else non-zero is a failure to run."""
    bad = 0
    runs = [("this repo's whole history", ["-v", f"{REPO}:/repo:ro"], ["git", "/repo", "--log-opts=--all"])]
    with tempfile.TemporaryDirectory() as tmp:
        for f, data in files.items():
            dst = os.path.join(tmp, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as out:
                out.write(data)
        runs.append(("the kit's files", ["-v", f"{tmp}:/repo:ro"], ["dir", "/repo"]))
        for what, mounts, args in runs:
            r = subprocess.run(["docker", "run", "--rm"] + mounts + [GITLEAKS] + args +
                               ["--redact", "--no-banner", "--report-format", "json", "--report-path", "/dev/stdout"],
                               capture_output=True, text=True)
            if r.returncode not in (0, 1):
                print(f"gitleaks ({what}) didn't run: {r.stderr.strip()[-300:]}")
                bad += 1
                continue
            leaks = json.loads(r.stdout or "[]")
            print(f"gitleaks, {what}: " + (f"{len(leaks)} finding(s)" if leaks else "no secrets found"))
            for l in leaks:
                print(f"    {l.get('File')}:{l.get('StartLine')} {l.get('RuleID')}"
                      + (f" (commit {l['Commit'][:8]})" if l.get("Commit") else ""))
            bad += len(leaks)
    return bad


def main():
    args = sys.argv[1:]
    files = kit_files()
    print(f"The kit's files: {len(files)}")
    bad = 0 if "--names" in args else gitleaks(files)
    found = names(files, "-v" in args)
    print(f"Private names: {found} line(s)" if found else "Private names: none")
    sys.exit(1 if bad or found else 0)


if __name__ == "__main__":
    main()
