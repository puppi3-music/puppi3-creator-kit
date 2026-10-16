#!/usr/bin/env python3
"""Copies the shared docs styles and script into each guide, so every guide is one file that
works on its own: send just posting-guide.html (or any of them) and its search, contents list and
theme switch still work.

It builds the kit's guides too (KIT_PAGES, in kit/docs/: the same shared styles and script, their own neutral
header). The kit's Settings reference is written first, from the kit's example files
(kit/docs/settings_reference.py), and its checks fail the build like a stale page, as does a private name
(settings_reference's PRIVATE_WORDS) anywhere in a kit page (or the shared styles and script they carry), and a
link to a page or section that isn't there (links(): the kit's guides online are checked against kit/docs/).
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
from html.parser import HTMLParser

DOCS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(DOCS)
KIT_PAGES = ["../kit/docs/setup-guide.html", "../kit/docs/operations-guide.html",
             "../kit/docs/networks-guide.html", "../kit/docs/cloud-guide.html", "../kit/docs/theme-guide.html",
             "../kit/docs/posting-guide.html", "../kit/docs/analytics-guide.html",
             "../kit/docs/settings-reference.html"]  # kit/docs/index.html is the kit's plain front page
# A site's own guides: every page in docs/ but index.html (a plain front page). The kit's repo has none.
PAGES = sorted(p for p in os.listdir(DOCS) if p.endswith(".html") and p != "index.html")

# The kit's guides online (the kit's repo's GitHub Pages). A site's own guides link there for the kit's part, and
# links() checks each such link against kit/docs/, which is what's online once the kit's repo has this copy.
KIT_ONLINE = "https://puppi3-music.github.io/puppi3-creator-kit/kit/docs/"

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


class _Links(HTMLParser):
    """A page's ids, and the links it makes (not the ones inside its script or styles)."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.hrefs, self.skip = set(), [], 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        if a.get("id"):
            self.ids.add(a["id"])
        if tag == "a" and a.get("href") and not self.skip:
            self.hrefs.append(a["href"])

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1


def links():
    """Every link from a guide to a page or a section must arrive: within the page (#id), to another guide
    (page.html#id) or file, and to the kit's guides online (KIT_ONLINE), checked against kit/docs/. So a renamed
    section can't quietly leave a link from another guide going nowhere."""
    seen = {}

    def parse(path):
        if path not in seen:
            p = _Links()
            with open(path, encoding="utf-8") as f:
                p.feed(f.read())
            seen[path] = p
        return seen[path]

    pages = [os.path.normpath(os.path.join(DOCS, p)) for p in PAGES + KIT_PAGES + ["../kit/docs/index.html"]]
    if os.path.exists(os.path.join(DOCS, "index.html")):
        pages.append(os.path.join(DOCS, "index.html"))
    out = []
    for page in pages:
        for href in parse(page).hrefs:
            if href.startswith(KIT_ONLINE):
                path, _, anchor = href[len(KIT_ONLINE):].partition("#")
                target = os.path.join(REPO, "kit", "docs", path.split("?")[0] or "index.html")
            elif re.match(r"[a-z][a-z0-9+.-]*:|//", href, re.I):
                continue
            else:
                path, _, anchor = href.partition("#")
                path = path.split("?")[0]
                target = os.path.normpath(os.path.join(os.path.dirname(page), path)) if path else page
                if path.endswith("/") or path in (".", "./"):
                    target = os.path.join(target, "index.html")
            where = os.path.relpath(page, REPO)
            if not os.path.exists(target):
                out.append(f"build-docs: {where} links to {href}, which isn't there")
            elif anchor and target.endswith(".html") and anchor not in parse(target).ids:
                out.append(f"build-docs: {where} links to {href}, a section that isn't there")
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
    words = private_words() + links()
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
