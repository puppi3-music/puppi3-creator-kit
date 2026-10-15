#!/usr/bin/env python3
"""The big dashboards are kept as a folder of small files, put together into the one JSON file Grafana reads.

  python3 stacks/monitoring/grafana/parts.py build <dashboards dir> <out dir>   every dashboard as one file (deploy.sh runs it)
  python3 stacks/monitoring/grafana/parts.py split <file.json> [folder]          a v2 dashboard -> folder (an export from Grafana too)

A folder dashboard (v2 format, rows only), e.g. stacks/monitoring/grafana/provisioning/dashboards/json/site/8-platforms/:
  dashboard.json          the file minus spec.layout and spec.elements
  NN-<row title>/row.json  one row: title, section variables, show/hide rule, grid items (where each panel sits)
  NN-<row title>/panel-<id>.json   each panel of that row ({"kind": "Panel", "spec": ...})
Rows go in folder-name order; elements come out in layout order. A plain *.json dashboard is used as it is.
Files that aren't JSON (the dashboard's CLAUDE.md) are left alone: never read, never removed.
split without a folder writes <file>/ next to the file and removes the file (turning it into a folder dashboard);
it rewrites only the parts that changed and removes the ones that are gone.
style.py, ro-tables.py and render.py read the dashboards through load(), so they take both forms.
"""
import json
import os
import re
import shutil
import sys

DASHBOARD = 'dashboard.json'
ROW = 'row.json'
SAFE = re.compile(r'^[A-Za-z0-9_-]+$')


class PartsError(Exception):
    pass


def dump(d, ascii_=True):
    return json.dumps(d, indent=2, ensure_ascii=ascii_) + '\n'


def refs(o, acc=None):
    """Element names a layout (or row) points at, in order."""
    acc = [] if acc is None else acc
    if isinstance(o, dict):
        if o.get('kind') == 'ElementReference':
            acc.append(o['name'])
        for v in o.values():
            refs(v, acc)
    elif isinstance(o, list):
        for v in o:
            refs(v, acc)
    return acc


def slug(title):
    s = re.sub(r'\$\{(\w+)[^}]*\}', r'\1', title or '').lower()  # ${source:text} -> source
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:40].strip('-')
    return s or 'top'


def _read(path):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        raise PartsError(f'{path}: {e}')


def parts(d):
    """{relative path: text} of the files split writes for dashboard d."""
    spec = d.get('spec')
    layout = (spec or {}).get('layout', {})
    if not spec or layout.get('kind') != 'RowsLayout' or set(layout.get('spec', {})) != {'rows'}:
        raise PartsError('only a v2 dashboard laid out in rows can be split')
    elements = spec.get('elements', {})
    top = {k: v for k, v in d.items() if k != 'spec'}
    top['spec'] = {k: v for k, v in spec.items() if k not in ('layout', 'elements')}
    out = {DASHBOARD: dump(top)}
    seen = set()
    for i, row in enumerate(layout['spec']['rows'], 1):
        folder = f'{i:02d}-{slug(row.get("spec", {}).get("title"))}'
        out[f'{folder}/{ROW}'] = dump(row)
        for name in refs(row):
            if name in seen:
                raise PartsError(f'element {name} is used twice')
            if name not in elements:
                raise PartsError(f'row {folder} points at element {name}, which is missing')
            if not SAFE.match(name):
                raise PartsError(f'element name {name!r} can\'t be a file name')
            seen.add(name)
            out[f'{folder}/{name}.json'] = dump(elements[name])
    unused = [n for n in elements if n not in seen]
    if unused:
        raise PartsError(f'elements no row shows: {", ".join(unused)}')
    return out


def build(folder):
    """The dashboard kept in folder, as one dict (fails, naming the file, on anything left over or missing)."""
    d = _read(os.path.join(folder, DASHBOARD))
    spec = d.get('spec', {})
    if 'layout' in spec or 'elements' in spec:
        raise PartsError(f'{folder}/{DASHBOARD}: has layout/elements, which belong in the row folders')
    rows, elements = [], {}
    for sub in sorted(os.listdir(folder)):
        path = os.path.join(folder, sub)
        if sub.startswith('.') or sub == DASHBOARD or os.path.isfile(path) and not sub.endswith('.json'):
            continue
        if not os.path.isfile(os.path.join(path, ROW)):
            raise PartsError(f'{path}: not a row folder (no {ROW})')
        row = _read(os.path.join(path, ROW))
        rows.append(row)
        names = refs(row)
        for name in names:
            if name in elements:
                raise PartsError(f'{path}: element {name} is used twice')
            if not os.path.isfile(os.path.join(path, name + '.json')):
                raise PartsError(f'{path}: its {ROW} shows {name}, but there\'s no {name}.json')
            elements[name] = _read(os.path.join(path, name + '.json'))
        extra = [f for f in sorted(os.listdir(path))
                 if f.endswith('.json') and f != ROW and f[:-5] not in names]
        if extra:
            raise PartsError(f'{path}: {", ".join(extra)} not shown by its {ROW}')
    spec['layout'] = {'kind': 'RowsLayout', 'spec': {'rows': rows}}
    spec['elements'] = elements
    return d


def changes(d, folder):
    """(written, removed): relative paths that split(d, folder) would change."""
    want = parts(d)
    have = set()
    if os.path.isdir(folder):
        for base, dirs, files in os.walk(folder):
            dirs[:] = [x for x in dirs if not x.startswith('.')]
            have |= {os.path.relpath(os.path.join(base, f), folder) for f in files if f.endswith('.json')}
    written = []
    for rel, text in want.items():
        if rel not in have:
            written.append(rel)
            continue
        with open(os.path.join(folder, rel), encoding='utf-8') as fh:
            if fh.read() != text:
                written.append(rel)
    return written, sorted(have - set(want))


def split(d, folder):
    written, removed = changes(d, folder)
    want = parts(d)
    for rel in written:
        path = os.path.join(folder, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(want[rel])
    for rel in removed:
        os.remove(os.path.join(folder, rel))
    for base, dirs, files in sorted(os.walk(folder), reverse=True):  # row folders left empty
        if base != folder and not os.listdir(base):
            os.rmdir(base)
    return written, removed


def load(folder):
    """[(file name Grafana gets, dashboard, source path)] for the dashboards in a Grafana folder's directory."""
    out = []
    for entry in sorted(os.listdir(folder)):
        path = os.path.join(folder, entry)
        if entry.endswith('.json') and os.path.isfile(path):
            out.append((entry, _read(path), path))
        elif os.path.isfile(os.path.join(path, DASHBOARD)):
            out.append((entry + '.json', build(path), path))
    names = [n for n, _, _ in out]
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise PartsError(f'{folder}: {", ".join(twice)} is there both as a file and as a folder')
    return out


def build_all(src, out):
    """Each Grafana folder in src -> out/<folder>/<name>.json (plain files copied byte for byte)."""
    for gf in sorted(os.listdir(src)):
        if not os.path.isdir(os.path.join(src, gf)) or gf.startswith('.'):
            continue
        os.makedirs(os.path.join(out, gf), exist_ok=True)
        for name, d, path in load(os.path.join(src, gf)):
            dest = os.path.join(out, gf, name)
            if os.path.isfile(path):
                shutil.copyfile(path, dest)
            else:
                with open(dest, 'w', encoding='utf-8') as fh:
                    fh.write(dump(d))


def main(args):
    if len(args) == 3 and args[0] == 'build':
        build_all(args[1], args[2])
    elif args[:1] == ['split'] and len(args) in (2, 3):
        src = args[1]
        folder = args[2] if len(args) == 3 else src[:-5] if src.endswith('.json') else sys.exit(__doc__)
        written, removed = split(_read(src), folder)
        for rel in written:
            print(f'{os.path.join(folder, rel)}: written')
        for rel in removed:
            print(f'{os.path.join(folder, rel)}: removed')
        if len(args) == 2:
            os.remove(src)
            print(f'{src}: removed (now {folder}/)')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except PartsError as e:
        sys.exit(f'parts: {e}')
