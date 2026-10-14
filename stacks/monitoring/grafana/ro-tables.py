#!/usr/bin/env python3
"""The tables of Ghost's database that the dashboards and alert rules read (MySQL queries on
ghost-mysql), against the ones grafana_ro may read (TABLES in stacks/ghost/grafana-ro.sh).

  python3 stacks/monitoring/grafana/ro-tables.py           list them
  python3 stacks/monitoring/grafana/ro-tables.py --check   fail if a query reads a table grafana_ro can't, or takes a dashboard
                                          variable in any form but "${x:percentencode}" (pre-commit hook)

A variable can be set to anything from the URL, and Grafana's quoting formats don't escape backslashes (and :json
leaves a plain value bare), so the one safe form is URL-encoded inside double quotes, decoded in the query with
REPLACE (see the Post dashboard's member queries).
"""
import json
import os
import re
import sys

import parts

HERE = os.path.dirname(os.path.abspath(__file__))   # stacks/monitoring/grafana/
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DASHBOARDS = os.path.join(HERE, 'provisioning', 'dashboards', 'json', 'site')
ALERTS = os.path.join(HERE, 'alerts.yml')
GRANTS = os.path.join(ROOT, 'stacks', 'ghost', 'grafana-ro.sh')
DATASOURCE = 'ghost-mysql'


def tables(sql):
    sql = re.sub(r'--[^\n]*|/\*.*?\*/', ' ', sql, flags=re.S)
    ctes = {n.lower() for n in re.findall(r'(?:\bwith|,)\s*(?:recursive\s+)?`?(\w+)`?\s+as\s*\(', sql, re.I)}
    found = set()
    # FROM/JOIN a [x], b [y]: each name after FROM or JOIN, and after a comma that follows a table and alias
    for m in re.finditer(r'\b(?:from|join)\s+((?:`?\w+`?(?:\s+(?:as\s+)?(?!on\b|where\b|join\b|left\b|inner\b|group\b|order\b|limit\b)\w+)?\s*,\s*)*`?\w+`?)', sql, re.I):
        for part in m.group(1).split(','):
            name = part.strip().split()[0].strip('`').lower()
            # dual and JSON_TABLE(...) (Page's members by network) read no table
            if name not in ctes and name not in ('dual', 'json_table') and not name.startswith('information_schema'):
                found.add(name)
    return found


def dashboard_sql():
    """(file, sql) for each MySQL query on ghost-mysql: a query's datasource is the nearest one above it
    (v1: target or panel `datasource: {uid}`, v2: query `datasource: {name}`)."""
    def walk(o, ds, f):
        if isinstance(o, dict):
            if 'datasource' in o:
                d = o['datasource']
                ds = (d.get('uid') or d.get('name')) if isinstance(d, dict) else d
            if isinstance(o.get('rawSql'), str) and ds == DATASOURCE:
                yield f, o['rawSql']
            for v in o.values():
                yield from walk(v, ds, f)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v, ds, f)
    for name, d, _ in parts.load(DASHBOARDS):
        yield from walk(d, None, name)


def alert_sql():
    """Alert rules (YAML, read as text): each `rawSql: >-` block under `datasourceUid: ghost-mysql`."""
    with open(ALERTS) as fh:
        lines = fh.read().split('\n')
    ds = None
    for i, line in enumerate(lines):
        m = re.match(r'\s*datasourceUid:\s*(\S+)', line)
        if m:
            ds = m.group(1)
        m = re.match(r'(\s*)rawSql:\s*(.*)$', line)
        if m and ds == DATASOURCE:
            indent, rest = len(m.group(1)), m.group(2)
            if rest and rest[0] not in '>|':
                yield 'alerts.yml', rest.strip('\'"')
                continue
            block = []
            for nxt in lines[i + 1:]:
                if nxt.strip() and len(nxt) - len(nxt.lstrip()) <= indent:
                    break
                block.append(nxt)
            yield 'alerts.yml', '\n'.join(block)


VARIABLE = re.compile(r'\$\{(\w+)(?::(\w+))?[^}]*\}|\$(\w+)|\[\[(\w+)')


def unsafe_variables(sql):
    """Each dashboard variable in sql not written as "${x:percentencode}" (macros like $__timeFilter are fine)."""
    bad = []
    for m in VARIABLE.finditer(sql):
        name = m.group(1) or m.group(3) or m.group(4)
        if name.startswith('__'):
            continue
        quoted = sql[m.start() - 1:m.start()] == '"' and sql[m.end():m.end() + 1] == '"'
        if not (m.group(1) and m.group(2) == 'percentencode' and quoted):
            bad.append(m.group(0))
    return bad


def granted():
    with open(GRANTS) as fh:
        m = re.search(r'^TABLES="([^"]*)"', fh.read(), re.M)
    if not m:
        sys.exit(f'ro-tables: no TABLES="..." in {os.path.relpath(GRANTS, ROOT)}')
    return set(m.group(1).split())


def main():
    used, unsafe = {}, []
    for f, sql in [*dashboard_sql(), *alert_sql()]:
        for t in tables(sql):
            used.setdefault(t, set()).add(f)
        unsafe += [f'{f}: {v}' for v in unsafe_variables(sql)]
    if unsafe:
        print('ro-tables: a variable in Ghost SQL must be written "${x:percentencode}" (decoded with REPLACE in the'
              ' query, as on the Post dashboard), not:\n  ' + '\n  '.join(unsafe), file=sys.stderr)
        sys.exit(1)
    allowed = granted()
    if '--check' not in sys.argv:
        for t in sorted(used):
            print(f"{t:32} {'' if t in allowed else 'NOT GRANTED  '}{', '.join(sorted(used[t]))}")
        for t in sorted(allowed - set(used)):
            print(f'{t:32} granted, but no query reads it')
        return
    missing = sorted(set(used) - allowed)
    if missing:
        print(f'ro-tables: Grafana reads tables grafana_ro may not: {", ".join(missing)}.', file=sys.stderr)
        print(f'  Add them to TABLES in {os.path.relpath(GRANTS, ROOT)}, then run it on the NAS (and refresh staging).',
              file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except parts.PartsError as e:
        sys.exit(f'ro-tables: {e}')
