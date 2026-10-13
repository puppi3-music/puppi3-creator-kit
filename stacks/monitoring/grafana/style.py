#!/usr/bin/env python3
"""The dashboards' shared look, so moving from one to the next feels like one tool:
the same top links and header nav everywhere (both keep the time range), a shared crosshair, the same
tooltip/legend and bar/line styles, multi-number tiles in one row, and one colour per meaning (COLOURS).

  python3 stacks/monitoring/grafana/style.py           make every dashboard follow it (rewrites the files)
  python3 stacks/monitoring/grafana/style.py --check   fail if one doesn't (pre-commit hook)

Takes both of Grafana's file formats (classic and v2), and the folder dashboards parts.py puts together (a fix
rewrites only the parts it changes). Colours aren't changed, only checked: a fixed (or "shades of") colour not in
COLOURS stops --check, so pick one that means the same thing elsewhere (or add it here and to the analytics guide's
"Colours" section; the panel is panel-<id>.json in a folder dashboard).
"""
import json
import os
import sys

import parts

HERE = os.path.dirname(os.path.abspath(__file__))   # stacks/monitoring/grafana/
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
DASHBOARDS = os.path.join(HERE, 'provisioning', 'dashboards', 'json', 'site')

# The dashboards in the header nav and top links, in order (Post and Page are opened from other dashboards' tables, so not
# listed).
NAV = [('puppi3-overview', 'Overview'), ('puppi3-health', 'Health'), ('puppi3-traffic', 'Traffic'),
       ('puppi3-growth', 'Growth'), ('puppi3-members', 'Members & Newsletters'),
       ('puppi3-content', 'Content & Engagement'), ('puppi3-social', 'Social'), ('puppi3-platforms', 'Platforms')]
EXTRA_NAV = {'puppi3-post': '**▸ ${label} post**', 'puppi3-page': '**▸ Page: ${page:text}**'}  # outside NAV: marked after the list
NAV_PANEL_ID = 9000
KEEP_TIME = '?${__url_time_range}'  # the header nav's links carry the time range, like the top links
# ...except from these, whose range isn't one the viewer picked (Post's starts at the post): their links
# open the others on their usual range
OWN_TIME = {'puppi3-post'}

COLOURS = {  # fixed colour -> what it means, on every dashboard
    'purple': 'visitors, traffic',
    'light-purple': 'pageviews, requests (the second traffic number)',
    'green': 'members, sign-ups, subscribes',
    'blue': 'engagement: comments, clicks, newsletters (on Platforms, each network\'s engagement lines)',
    'yellow': 'likes (on Platforms, in the reach & engagement charts\' hover breakdown)',
    '#E535C8': 'Ghost, the site as a network (magenta, apart from Instagram\'s pink): its posts counts, the "Ghost posts" annotation lines and the site\'s section on Platforms',
    '#B28CFF': 'social posts (the "Social posts" annotation lines; on Post, a post from a network not in NETWORK_COLOURS)',
    '#FF4FA3': 'the live stream and the puppy',
    'orange': 'worth a look (unsubscribes, bounces)',
    'red': 'trouble (errors, threats, failures)',
    'text': 'a neutral number beside a coloured one',
    # each network's own colour; a second number of the same network is 'text'
    '#E1306C': 'Instagram', '#F58529': "Instagram's second line (link taps)", '#FF0000': 'YouTube',
    '#FF5500': 'SoundCloud', '#1185FE': 'Bluesky', '#8f8f8f': 'Threads', '#FE2C55': 'TikTok', '#5000FF': 'Mixcloud',
    '#4285F4': 'Google Search', '#F38020': 'Cloudflare',
}
# Each network's colour on Platforms (keys = the bridge's NETWORKS), which Post draws that network's post in: written
# into Post's hidden `colour` variable (Grafana's fieldConfig colours don't take variables, so its panels set theirs
# from it with a configFromData transformation); a network missing here gets social-post violet
NETWORK_COLOURS = {'ghost': '#E535C8', 'instagram': '#E1306C', 'tiktok': '#FE2C55', 'threads': '#8f8f8f',
                   'bluesky': '#1185FE', 'youtube': '#FF0000', 'soundcloud': '#FF5500', 'mixcloud': '#5000FF'}
NETWORK_COLOUR_VAR = ('puppi3-post', 'colour')

TOOLTIP = {'mode': 'multi', 'sort': 'desc'}
BARS = {'fillOpacity': 60, 'lineWidth': 1, 'showPoints': 'never'}
LINES = {'lineWidth': 2, 'showPoints': 'auto'}
LINE_FILL = 10  # line-only charts; a line drawn over bars stays unfilled
# A stat showing several numbers with their names: one row of columns, each name centred above its number.
# Grafana's "auto" orientation wraps them into a grid (a number sits on the next row's name), and its wide
# layout puts each name at a cell's left edge and the number at the right, next to the following name.
NAMED_STAT = {'orientation': 'vertical', 'wideLayout': False, 'justifyMode': 'center'}


def is_v2(d):
    return d.get('apiVersion', '').startswith('dashboard.grafana.app')


def panels(d):
    """Each panel as (type, fieldConfig, options, panel id); a missing fieldConfig/options is a loose {}."""
    if is_v2(d):
        for e in d['spec']['elements'].values():
            if e['kind'] == 'Panel':
                vz = e['spec']['vizConfig']
                vs = vz.get('spec', {})
                yield vz.get('group') or vz['kind'], vs.get('fieldConfig', {}), vs.get('options', {}), e['spec'].get('id')
    else:
        def walk(ps):
            for p in ps:
                if p.get('type') == 'row':
                    yield from walk(p.get('panels', []))
                else:
                    yield p['type'], p.get('fieldConfig', {}), p.get('options', {}), p.get('id')
        yield from walk(d['panels'])


def uid(d):
    return d['metadata']['name'] if is_v2(d) else d['uid']


def nav_markdown(me):
    sep, bar = '&nbsp;&nbsp;·&nbsp;&nbsp;', '&nbsp;&nbsp;|&nbsp;&nbsp;'
    keep = '' if me in OWN_TIME else KEEP_TIME
    items = [f'**▸ {t}**' if u == me else f'[{t}](/d/{u}{keep})' for u, t in NAV]
    if me in EXTRA_NAV:
        items.append(EXTRA_NAV[me])
    return ('**@SITE_HOST@**' + bar + sep.join(items) + bar   # @SITE_HOST@: filled in by render.py
            + '[Site ↗](https://@SITE_HOST@)' + sep + '[Ghost admin ↗](https://@SITE_HOST@/ghost/)')


def top_links(me):
    return [{'title': t, 'type': 'link', 'url': f'/d/{u}', 'icon': 'dashboard', 'tooltip': '', 'tags': [],
             'asDropdown': False, 'targetBlank': False, 'includeVars': False, 'keepTime': me not in OWN_TIME}
            for u, t in NAV]


def style_timeseries(fc, opts):
    opts['tooltip'] = dict(TOOLTIP)
    leg = opts.setdefault('legend', {})  # shown or not stays the panel's (none for one series)
    leg.update({'displayMode': 'list', 'placement': 'bottom'})
    cu = fc['defaults'].setdefault('custom', {})
    bar_series = False
    for ov in fc.get('overrides', []):
        props = {p['id']: p for p in ov.get('properties', [])}
        if props.get('custom.drawStyle', {}).get('value') != 'bars':
            continue
        bar_series = True
        if 'custom.fillOpacity' in props:
            props['custom.fillOpacity']['value'] = BARS['fillOpacity']
        else:
            ov['properties'].append({'id': 'custom.fillOpacity', 'value': BARS['fillOpacity']})
    if cu.get('drawStyle') == 'bars':
        cu.update(BARS)
    elif cu.get('drawStyle', 'line') == 'line':
        for k, v in LINES.items():
            if not (k == 'showPoints' and cu.get(k) == 'always'):  # sparse points (one per send) stay marked
                cu[k] = v
        cu['fillOpacity'] = 0 if bar_series else LINE_FILL


def apply(d):
    """Make d follow the shared style; returns the fixed colours it uses that aren't in COLOURS."""
    me, top = uid(d), (d['spec'] if is_v2(d) else d)
    top['links'] = top_links(me)  # the same links in the same places on every dashboard
    if is_v2(d):  # one cursor across a dashboard's charts
        top['cursorSync'] = 'Crosshair'
    else:
        top['graphTooltip'] = 1
    bad = []
    if is_v2(d) and me == NETWORK_COLOUR_VAR[0]:
        var = next(v for v in top['variables'] if v['spec']['name'] == NETWORK_COLOUR_VAR[1])
        table = json.dumps(NETWORK_COLOURS, separators=(', ', ': '))
        var['spec']['query']['spec']['infinityQuery']['root_selector'] = (
            f'[$merge([{{"colour": [$lookup($merge([{table}]), network), "#B28CFF"][0]}}])]')
        bad += [f'{NETWORK_COLOUR_VAR[1]} variable: {c}' for c in NETWORK_COLOURS.values() if c not in COLOURS]
    for kind, fc, opts, pid in panels(d):
        if kind == 'text' and pid == NAV_PANEL_ID:
            opts['content'] = nav_markdown(me)
        if kind == 'timeseries':
            style_timeseries(fc, opts)
        if kind == 'table':
            opts['cellHeight'] = 'sm'
        if kind == 'stat' and opts.get('textMode') == 'value_and_name':
            opts.update(NAMED_STAT)
        colours = [fc.get('defaults', {}).get('color', {})] + [
            p['value'] for ov in fc.get('overrides', []) for p in ov.get('properties', [])
            if p['id'] == 'color' and isinstance(p['value'], dict)]
        bad += [f'panel {pid}: {c.get("fixedColor")}' for c in colours
                if c.get('mode') in ('fixed', 'shades') and c.get('fixedColor') not in COLOURS]
    return bad


def dump(d, text):
    ascii_ = json.dumps(json.loads(text), indent=2, ensure_ascii=True) + '\n' == text
    return json.dumps(d, indent=2, ensure_ascii=ascii_) + '\n'


def main():
    check = '--check' in sys.argv[1:]
    failed = False
    for _, d, path in parts.load(DASHBOARDS):
        name = os.path.relpath(path, ROOT)
        for b in apply(d):
            print(f'{name}: colour not in stacks/monitoring/grafana/style.py COLOURS ({b})')
            failed = True
        if os.path.isdir(path):  # a folder dashboard (parts.py): compared and rewritten part by part
            written, removed = parts.changes(d, path) if check else parts.split(d, path)
            for rel in written + removed:
                part = os.path.join(name, rel)
                print(f'{part}: differs from the shared style (run python3 stacks/monitoring/grafana/style.py)' if check else f'{part}: updated')
            failed |= check and bool(written or removed)
            continue
        text = open(path, encoding='utf-8').read()
        new = dump(d, text)
        if new != text:
            if check:
                print(f'{name}: differs from the shared style (run python3 stacks/monitoring/grafana/style.py)')
                failed = True
            else:
                open(path, 'w', encoding='utf-8').write(new)
                print(f'{name}: updated')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    try:
        main()
    except parts.PartsError as e:
        sys.exit(f'style: {e}')
