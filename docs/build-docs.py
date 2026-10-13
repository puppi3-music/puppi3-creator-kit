#!/usr/bin/env python3
"""Copies the shared docs styles and script into each guide, so every guide is one file that
works on its own: send just posting-guide.html (or any of them) and its search, contents list and
theme switch still work.

It builds the kit's guides too (KIT_PAGES, in kit/docs/: the same shared styles and script, their own neutral
header). The kit's Settings reference is written first, from the kit's example files
(kit/docs/settings_reference.py), and its checks fail the build like a stale page, as does puppi3's name or
her NAS's anywhere in a kit page (or the shared styles and script they carry).

Shared guides (SHARED: the posting and analytics guides) are written once, as puppi3's page, and the kit's copy is
made from it (kit/docs/, never edited by hand):
  - <template data-only="kit">...</template>: only in the kit's copy (a template shows nothing in puppi3's page);
  - data-only="puppi3" on an element: left out of the kit's copy;
  - data-kit="text" on an element: the kit's copy has that text inside it instead (plain text: use a template for
    markup); data-kit-<attr>="value": the kit's copy has that attribute value (e.g. a meta's content);
  - KIT_SUBS: puppi3's addresses swapped for example.com's everywhere;
  - the kit's palette, puppy mark and tab icon (from setup-guide.html) instead of puppi3's colours.
The kit's copy may link only to the kit's pages (and their ids), and may not say puppi3 except in the kit's name.

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
PAGES = ["repo-guide.html", "social-runbook.html", "posting-guide.html", "site-guide.html", "analytics-guide.html", "cloud-runbook.html"]  # index.html is the plain front page
KIT_PAGES = ["../kit/docs/setup-guide.html", "../kit/docs/operations-guide.html",
             "../kit/docs/theme-guide.html", "../kit/docs/settings-reference.html"]  # kit/docs/index.html is the kit's plain front page
# puppi3's page -> the kit's copy, made from it (after the shared parts are copied in)
SHARED = {"posting-guide.html": "../kit/docs/posting-guide.html", "analytics-guide.html": "../kit/docs/analytics-guide.html"}
# In the kit's own repo there are no puppi3 pages: the shared guides' kit copies are pages of their own
PAGES = [p for p in PAGES if os.path.isfile(os.path.join(DOCS, p))]
for _src in [s for s in SHARED if not os.path.isfile(os.path.join(DOCS, s))]:
    KIT_PAGES.append(SHARED.pop(_src))
# Addresses in a shared guide, as the kit's copy says them (longest first)
KIT_SUBS = [("postiz.puppi3.party", "postiz.example.com"), ("grafana.nas.pet", "grafana.example.com"),
            ("puppi3.party", "example.com"), ("puppi3_music", "yourname"), ("#puppi3", "#yourname")]

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


TAG = re.compile(r"<(/?)([a-zA-Z][\w-]*)(\s[^>]*)?>", re.S)


def element_end(html, start, name):
    """The index just after the element whose opening tag starts at html[start], counting nested ones of its name."""
    depth = 0
    for m in TAG.finditer(html, start):
        if m.group(2).lower() != name:
            continue
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    sys.exit(f"build-docs: no closing </{name}> for the element at {start}")


def kit_copy(src, out):
    """puppi3's shared guide -> the kit's copy (see the docstring); returns (path, old, new, problems)."""
    with open(os.path.join(DOCS, src), encoding="utf-8") as f:
        html = f.read()
    html = re.sub(r'<template data-only="kit">(.*?)</template>', lambda m: m.group(1), html, flags=re.S)
    while (m := re.search(r'<([a-zA-Z][\w-]*)\b[^>]*\sdata-only="puppi3"[^>]*>', html)):
        html = html[:m.start()] + html[element_end(html, m.start(), m.group(1).lower()):]
    while (m := re.search(r'<([a-zA-Z][\w-]*)(\b[^>]*?)\sdata-kit="([^"]*)"([^>]*)>', html)):
        end = element_end(html, m.start(), m.group(1).lower())
        close = html.rindex("</", m.start(), end)
        html = html[:m.start()] + f"<{m.group(1)}{m.group(2)}{m.group(4)}>" + m.group(3) + html[close:]
    html = re.sub(r'(<[^>]*?)\s([\w-]+)="[^"]*"([^>]*?)\sdata-kit-\2="([^"]*)"', r'\1 \2="\4"\3', html)
    for a, b in KIT_SUBS:
        html = html.replace(a, b)
    with open(os.path.join(DOCS, "../kit/docs/setup-guide.html"), encoding="utf-8") as f:
        frame = f.read()
    palette = re.compile(r':root\{.*?\n:root\[data-theme="dark"\]\{.*?\n\}\n', re.S)
    marks = "".join(line + "\n" for line in frame.split("\n") if ".mark" in line and "{" in line)
    html = palette.sub(lambda m: palette.search(frame).group(0) + marks, html, count=1)
    icon = re.search(r'<link rel="icon"[^>]*>\n', frame)  # the kit's puppy as the tab's icon
    if icon and 'rel="icon"' not in html:
        html = html.replace('<meta charset="utf-8">\n', '<meta charset="utf-8">\n' + icon.group(0), 1)
    html = html.replace("<!doctype html>\n", "<!doctype html>\n<!-- Made by docs/build-docs.py from docs/" + src
                        + " (edit that page and its data-only/data-kit marks, never this copy) -->\n", 1)
    problems = []
    found = sorted(set(re.findall(r"puppi3(?!'s Creator Kit)", html, re.I)) | set(
        m.group(0) for m in kit_words().finditer(html)))
    if found:
        problems.append(f"build-docs: the kit's {os.path.basename(out)} says " + ", ".join(found)
                        + f" (mark it in docs/{src})")
    kit_dir = os.path.join(DOCS, "../kit/docs")
    for href in re.findall(r'href="([^"]+)"', JS_BLOCK.sub("", html)):
        if re.match(r"(https?:|mailto:|data:)", href):
            continue
        page, _, anchor = href.partition("#")
        target = html if not page else None
        if page:
            try:
                with open(os.path.join(kit_dir, page), encoding="utf-8") as f:
                    target = f.read()
            except OSError:
                target = None
                if page in SHARED:   # another shared guide's kit copy: check its source's ids
                    with open(os.path.join(DOCS, page), encoding="utf-8") as f:
                        target = f.read()
        if target is None or (anchor and f'id="{anchor}"' not in target):
            problems.append(f"build-docs: the kit's {os.path.basename(out)} links to {href}, which the kit doesn't have"
                            f" (mark it in docs/{src})")
    path = os.path.join(DOCS, out)
    try:
        with open(path, encoding="utf-8") as f:
            old = f.read()
    except OSError:
        old = ""
    return path, old, html, problems


def kit_words():
    spec = importlib.util.spec_from_file_location("settings_reference",
                                                  os.path.join(REPO, "kit", "docs", "settings_reference.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.PRIVATE_WORDS


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
    for src, out in SHARED.items():
        path, old, new, probs = kit_copy(src, out)
        for p in probs:
            print(p)
        problems = problems + probs
        if old != new:
            stale.append(out)
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
