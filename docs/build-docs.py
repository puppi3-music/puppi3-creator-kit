#!/usr/bin/env python3
"""Copies the shared docs styles and script into each guide, so every guide is one file that
works on its own: send just posting-guide.html (or any of them) and its search, contents list and
theme switch still work.

It builds the kit's guides too (KIT_PAGES, in kit/docs/: the same shared styles and script, their own neutral
header). The kit's Settings reference is written first, from the kit's example files
(kit/docs/settings_reference.py), and its checks fail the build like a stale page, as does a private name
(settings_reference's PRIVATE_WORDS) anywhere in a kit page (or the shared styles and script they carry).
A site that keeps the kit in its own repo may have guides of its own in docs/ (PAGES): built the same way.

Edit docs/assets/docs.css and docs/assets/docs.js, never the copies inside the pages. The
pre-commit hook runs this when any of them change; to run it by hand:

    python3 docs/build-docs.py           # update the pages
    python3 docs/build-docs.py --check   # only report pages that are out of date (exit 1 if any)
"""
import importlib.util
import os
import re
import sys

DOCS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(DOCS)
KIT_PAGES = ["../kit/docs/setup-guide.html", "../kit/docs/operations-guide.html",
             "../kit/docs/theme-guide.html", "../kit/docs/posting-guide.html", "../kit/docs/analytics-guide.html",
             "../kit/docs/settings-reference.html"]  # kit/docs/index.html is the kit's plain front page
# A site's own guides: every page in docs/ but index.html (a plain front page). The kit's repo has none.
PAGES = sorted(p for p in os.listdir(DOCS) if p.endswith(".html") and p != "index.html")

CSS_BLOCK = re.compile(r"<!-- shared styles:.*?<!-- /shared styles -->", re.S)
JS_BLOCK = re.compile(r"<!-- shared script:.*?<!-- /shared script -->", re.S)


def read(name):
    with open(os.path.join(DOCS, "assets", name), encoding="utf-8") as f:
        text = f.read().strip()
    closer = "</style" if name.endswith(".css") else "</script"
    if closer in text.lower():
        sys.exit(f"build-docs: assets/{name} contains {closer}>, which would end the inlined block early")
    return text


def build(page, css, js):
    path = os.path.join(DOCS, page)
    with open(path, encoding="utf-8") as f:
        html = f.read()
    css_block = ("<!-- shared styles: from docs/assets/docs.css, copied in by docs/build-docs.py -->\n"
                 f"<style>\n{css}\n</style>\n<!-- /shared styles -->")
    js_block = ("<!-- shared script: from docs/assets/docs.js, copied in by docs/build-docs.py -->\n"
                f"<script>\n{js}\n</script>\n<!-- /shared script -->")
    new = html
    # styles: replace the earlier copy, or go after the page's own styles
    if CSS_BLOCK.search(new):
        new = CSS_BLOCK.sub(lambda m: css_block, new)
    else:
        i = new.lower().rindex("</style>") + len("</style>")
        new = new[:i] + "\n" + css_block + new[i:]
    # script: replace the earlier copy, or go just before </body>
    if JS_BLOCK.search(new):
        new = JS_BLOCK.sub(lambda m: js_block, new)
    else:
        i = new.lower().rindex("</body>")
        new = new[:i] + js_block + "\n" + new[i:]
    return path, html, new


def settings_reference(check):
    spec = importlib.util.spec_from_file_location("settings_reference",
                                                  os.path.join(REPO, "kit", "docs", "settings_reference.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main(check)


def private_words():
    """The kit's pages are for anyone: none of them may name puppi3's site or NAS (settings_reference's list)."""
    spec = importlib.util.spec_from_file_location("settings_reference",
                                                  os.path.join(REPO, "kit", "docs", "settings_reference.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = []
    for page in KIT_PAGES + ["../kit/docs/index.html", "assets/docs.css", "assets/docs.js"]:
        with open(os.path.join(DOCS, page), encoding="utf-8") as f:
            found = sorted(set(m.group(0) for m in mod.PRIVATE_WORDS.finditer(f.read())))
        if found:
            out.append(f"build-docs: {os.path.normpath(page)} says " + ", ".join(found) + " (the kit's pages are for anyone)")
    return out


def main():
    check = "--check" in sys.argv[1:]
    problems = settings_reference(check)
    for p in problems:
        print(p)
    css, js = read("docs.css"), read("docs.js")
    stale = []
    for page in PAGES + KIT_PAGES:
        path, old, new = build(page, css, js)
        if old != new:
            stale.append(page)
            if not check:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(new)
    words = private_words()
    for p in words:
        print(p)
    problems = problems + words
    if check:
        print("build-docs: out of date: " + ", ".join(stale) if stale else "build-docs: all pages up to date")
        sys.exit(1 if stale or problems else 0)
    print("build-docs: updated " + ", ".join(stale) if stale else "build-docs: all pages already up to date")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
