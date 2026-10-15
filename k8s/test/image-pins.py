#!/usr/bin/env python3
"""image-pins.py: every image the kit runs is at an exact version, the same in Compose and Kubernetes.

Fails on a tag that floats (none, `latest`, `6-alpine`, `8.0`, `17-alpine`...) and on an image whose tag differs
between the files (per major version and variant: postgres 16 and 17-alpine can both be there) (Compose's stacks, the kit's profiles and monitoring, k8s's manifests, the Dockerfiles, the few
scripts that name an image). A version bump is then one deliberate edit, in every file at once, with its line in
kit/CHANGELOG.md. Exact means at least three numbers (`6.69.0-alpine`, `v3.7.13`, `1.8.1.3`), two for PostgreSQL
(its versions are `17.11`), or a digest (`@sha256:...`).

Not checked: images the kit builds itself (`creator-kit/...`, `...:local`: their bases are) and names made from
a variable. A site's repo may list its own folders in `.image-pins` at the top: `skip <folder>/` (nothing there is
checked) or `own <folder>/` (exact, but its versions may differ from the rest: a staging copy where an upgrade is
tried first). The kit's repo has none.

Also Tinybird's start script (tinybird-local without its MCP and Kafka servers and CSV workers): the same in every
file that has it (TINYBIRD_START), and Tinybird pinned to the image it was tried on (TINYBIRD_TRIED). A new Tinybird
image fails here until kit/test.sh has run on it (its "Tinybird trimmed" check) and TINYBIRD_TRIED names it.

Run from anywhere; the pre-commit hook runs it when a compose file, k8s YAML, Dockerfile or one of SCRIPTS is
staged. Exit 1 on any problem.
"""
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SITE_FILE = ROOT / ".image-pins"
# PostgreSQL's versions are major.minor
TWO_PART = {"postgres"}

YAML_IMAGE = re.compile(r"""^\s*-?\s*image:\s*["']?([^\s"'#]+)""")
FROM = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)", re.I)
ARG = re.compile(r"^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)", re.I)
# (file, pattern, what the match is: an image, or a package for npx, or a base image's tag)
SCRIPTS = (
    ("k8s/migrate/migrate.sh", re.compile(r'"image":\s*"([^"]+)"'), "image"),
    ("k8s/migrate/migrate.sh", re.compile(r"^BOX=(\S+)"), "image"),
    ("k8s/build-images.sh", re.compile(r"^av=(\S+)"), "alpine"),
    ("kit/theme-zip.sh", re.compile(r"npx -y (gscan@\S+)"), "npm"),
)
# Tinybird's start script: in these files (a site's own copies are found too), from `set -e` to its last line
TINYBIRD_START = ("stacks/ghost/compose.yaml", "k8s/components/analytics/tinybird.yaml")
TINYBIRD_REPO = "tinybirdco/tinybird-local"
TINYBIRD_TRIED = "@sha256:16c661bba64b99d904d9384ac414ee7ffa9d09d12bf77a42d41885408a2d8963"
START_END = "exec /usr/bin/supervisord\n"


def site_lists():
    """The site's `skip` and `own` folders (.image-pins), as tuples for startswith."""
    lists = {"skip": [], "own": []}
    if SITE_FILE.exists():
        for n, line in enumerate(SITE_FILE.read_text().splitlines(), 1):
            line = line.split("#", 1)[0].split()
            if not line:
                continue
            if len(line) != 2 or line[0] not in lists:
                sys.exit("image-pins: .image-pins:%d: expected `skip <folder>/` or `own <folder>/`" % n)
            lists[line[0]].append(line[1])
    return tuple(lists["skip"]), tuple(lists["own"])


SKIP, OWN_VERSIONS = site_lists()


def tracked():
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if not p.startswith(SKIP)]


def kind(path):
    name = path.rsplit("/", 1)[-1]
    if name.lower() == "dockerfile":
        return "dockerfile"
    if not name.endswith((".yaml", ".yml")):
        return None
    if path.startswith("k8s/") or path.startswith("kit/profiles/") or "compose" in name:
        return "yaml"
    return None


def refs():
    """(file, line, image) for every image named."""
    found = []
    for path in tracked():
        k = kind(path)
        if not k:
            continue
        args = {}
        for n, line in enumerate((ROOT / path).read_text().splitlines(), 1):
            if k == "yaml":
                m = YAML_IMAGE.match(line)
                if m:
                    found.append((path, n, m.group(1)))
                # a compose file's dockerfile_inline: FROM ...
                m = FROM.match(line)
                if m:
                    found.append((path, n, m.group(1)))
            else:
                m = ARG.match(line)
                if m:
                    args[m.group(1)] = m.group(2)
                m = FROM.match(line)
                if m:
                    image = re.sub(r"\$\{(\w+)\}", lambda a: args.get(a.group(1), a.group(0)), m.group(1))
                    found.append((path, n, image))
    for path, pattern, what in SCRIPTS:
        for n, line in enumerate((ROOT / path).read_text().splitlines(), 1):
            for m in pattern.finditer(line):
                v = m.group(1)
                found.append((path, n, "alpine:" + v if what == "alpine" else v))
    return found


def split(image):
    """(repository, tag or digest), with Docker Hub's default prefixes taken off."""
    if "@" in image:
        repo, ref = image.split("@", 1)
        return repo, "@" + ref
    name, _, tag = image.rpartition(":") if ":" in image.rsplit("/", 1)[-1] else (image, "", "")
    for prefix in ("docker.io/library/", "docker.io/", "library/"):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name, tag


def exact(repo, tag):
    if tag.startswith("@sha256:"):
        return True
    m = re.match(r"^v?(\d+(?:\.\d+)*)", tag)
    if not m:
        return False
    parts = m.group(1).count(".") + 1
    return parts >= (2 if repo.rsplit("/", 1)[-1] in TWO_PART else 3)


def line(repo, tag):
    """What must agree: one repository's major version and variant (postgres 16 and 17-alpine are two on purpose)."""
    m = re.match(r"^v?(\d+)(?:\.\d+)*(.*)$", tag)
    return repo if not m else "%s:%s%s" % (repo, m.group(1), m.group(2) and " (" + m.group(2).lstrip("-.") + ")")


def tinybird_starts():
    """{file: the start script} for every tracked YAML with one (a compose file's $$ read as $)."""
    found = {}
    for path in tracked():
        if kind(path) != "yaml" or path.startswith("kit/profiles/"):
            continue
        text = (ROOT / path).read_text()
        if "/tmp/kit/settings.py" not in text:
            continue
        lines = text.splitlines(keepends=True)
        start = next((i for i, l in enumerate(lines) if l.strip() == "set -e" and i + 1 < len(lines)
                      and "/tmp/kit" in lines[i + 1]), None)
        if start is None:
            found[path] = None
            continue
        indent = len(lines[start]) - len(lines[start].lstrip())
        body = []
        for l in lines[start:]:
            body.append(l[indent:] if l.strip() else "\n")
            if l.strip() + "\n" == START_END:
                break
        script = "".join(body)
        found[path] = script.replace("$$", "$") if "compose" in path.rsplit("/", 1)[-1] else script
    return found


def check_tinybird(problems):
    starts = tinybird_starts()
    for path in TINYBIRD_START:
        if (ROOT / path).exists() and path not in starts:
            problems.append("%s: Tinybird's start script (set -e ... %s) is missing" % (path, START_END.strip()))
    scripts = {s for s in starts.values()}
    if None in scripts or len(scripts) > 1:
        first = starts.get(TINYBIRD_START[0])
        differ = [p for p, s in sorted(starts.items()) if s != first]
        problems.append("Tinybird's start script differs from %s's (or isn't whole) in: %s" % (
            TINYBIRD_START[0], ", ".join(differ)))
    for path, n, image in refs():
        repo, tag = split(image)
        if repo == TINYBIRD_REPO and tag != TINYBIRD_TRIED:
            problems.append("%s:%d: Tinybird %s isn't the image its start script was tried on: run kit/test.sh with it "
                            "(\"Tinybird trimmed\" must pass), then set TINYBIRD_TRIED in k8s/test/image-pins.py"
                            % (path, n, tag))


def main():
    problems = []
    check_tinybird(problems)
    tags = defaultdict(lambda: defaultdict(list))
    for path, n, image in refs():
        if "$" in image or image.startswith("creator-kit/") or image.endswith(":local") or image == "scratch":
            continue
        if image.startswith("gscan@"):
            repo, tag = "gscan (npm)", image.split("@", 1)[1]
        else:
            repo, tag = split(image)
        where = "%s:%d" % (path, n)
        if not exact(repo, tag):
            problems.append("%s: %s isn't an exact version" % (where, image))
            continue
        if not path.startswith(OWN_VERSIONS):
            tags[line(repo, tag)][tag].append(where)
    for repo, by_tag in sorted(tags.items()):
        if len(by_tag) > 1:
            problems.append("%s at %d exact versions:\n%s" % (repo, len(by_tag), "\n".join(
                "    %s  (%s)" % (t, ", ".join(w)) for t, w in sorted(by_tag.items()))))
    for p in problems:
        print("image-pins: " + p, file=sys.stderr)
    if problems:
        sys.exit(1)
    print("image-pins: %d images, every one exact and the same everywhere" % len(tags))


if __name__ == "__main__":
    main()
