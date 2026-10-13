#!/usr/bin/env python3
"""The site's dashboards and alert rules as one Grafana gets them, by profile (creator kit step A6).

    render.py --profile <kit|cloud> --site <site.env> [--site <more KEY=value>] <dashboards dir> <out dir>
    render.py --profile <puppi3|staging> <dashboards dir> <out dir>      (puppi3's own: puppi3.py)

Reads the dashboards in <dashboards dir>/<SRC_FOLDER>/ (single files, or folders put together by parts.py) and the
alert rules in alerts.yml. What it writes is made fresh each run, never edited or committed.

The source names no site: where a site's own value goes it says @NAME@ (PLACEHOLDERS below), and each profile
fills them in. Everything else that names a site is the ID_PREFIX "puppi3" (uids, counters, container names), which
the kit's swaps rename.

  kit      for a kit site's own Grafana (kit/monitoring/; kit/kit.sh runs it each time), from its profile:
           <out dir>/dashboards/*.json and <out dir>/alerting/<ID_PREFIX>.yml (the alert rules, rendered the same way)
  cloud    kit, for a kit site on Kubernetes (k8s/components/monitoring/; k8s/up.sh runs it each time): Health's and
           Social's container panels read the kubelet's cAdvisor (the site's namespace, by pod, named after their
           Deployment or StatefulSet), the disk tile and alert the fullest PersistentVolumeClaim, Traefik's routers
           are all @file, and the listener counts take the Icecast relays' own listeners instead of the relays
           (json-exporter's icecast_relay_listeners). Compact JSON: a dashboard is one ConfigMap (1 MiB at most).
  puppi3, staging   puppi3's NAS (deploy.sh's grafana topic), from puppi3.py next to this file, which isn't
           part of the kit.

Takes both of Grafana's file formats: classic JSON ("uid", "panels") and v2 ("apiVersion", "metadata", "spec",
used by Platforms for its show/hide rules), where a query names its datasource as {"name": <uid>}.
"""
import argparse
import datetime
import json
import pathlib
import re
import sys
import zoneinfo

import parts

SRC_FOLDER = "site"  # the dashboards' source folder; each profile names the Grafana folder itself
ALERTS = pathlib.Path(__file__).parent / "alerts.yml"
# The placeholders in the dashboards and alert rules, and what fills them (for a kit site, from its profile)
PLACEHOLDERS = {
    "SITE_HOST": "the site's address (SITE_HOST)",
    "LIVE_HOST": "the live stream's address (LIVE_HOST, else live.<SITE_HOST>)",
    "SITE_NAME": "the site's name (SITE_NAME, else SITE_HOST): the dashboards' Grafana folder",
    "SITE_TIMEZONE": "the site's time zone (SITE_TIMEZONE, else Etc/UTC)",
    "TZ_NAME": "the time zone in words (\"<it> time\")",
    "TZ_HOURS": "hours behind UTC in winter (the MySQL fallback when it has no time zone tables)",
    "GHOST_SITE_UUID": "Ghost's site_uuid, which the web analytics queries pass (kit.sh asks Ghost for it)",
    "DISK_MOUNT": "the disk the site's data is on (DISK_MOUNT, else /)",
    "DJ_SOFTWARE": "what sends the live stream",
    "NTFY_URL": "the ntfy server alerts go to (NTFY_URL, else https://ntfy.sh; set but empty = no phone alerts)",
    "NTFY_TOPIC": "its topic (NTFY_TOPIC, else <ID_PREFIX>-alerts)",
}
PLACEHOLDER = re.compile(r"@([A-Z][A-Z0-9_]*)@")
# what the source must not name (it says @NAME@ there instead): puppi3's own values
SOURCE_PRIVATE = re.compile(r"(?i)puppi3\.party|nas\.pet|NVMe2|Toronto|Traktor|butterwoof|3f21f009-")


def fill(text, values, what):
    """text with its @NAME@s filled in; stops on one with no value"""
    missing = sorted(set(PLACEHOLDER.findall(text)) - set(values))
    if missing:
        sys.exit(f"render: {what} has placeholders with no value: {', '.join('@' + m + '@' for m in missing)}")
    return PLACEHOLDER.sub(lambda m: values[m.group(1)], text)


def fill_all(value, values, what):
    """fill() on every string of a dashboard, keys too (value mappings are keyed by the value)"""
    if isinstance(value, dict):
        return {fill(k, values, what): fill_all(x, values, what) for k, x in value.items()}
    if isinstance(value, list):
        return [fill_all(x, values, what) for x in value]
    return fill(value, values, what) if isinstance(value, str) else value


def std_hours(tz):
    """the zone's hours behind UTC in January (New York: 5); 0 for a zone Python doesn't know"""
    try:
        return -round(datetime.datetime(2026, 1, 15, tzinfo=zoneinfo.ZoneInfo(tz)).utcoffset().total_seconds() / 3600)
    except Exception:  # an unknown zone: Grafana and MySQL say so themselves
        return 0


def check_source(text, what, values):
    """the source names no site's own value, and has a value for each placeholder"""
    left = sorted({m.group(0) for m in SOURCE_PRIVATE.finditer(text)})
    if left:
        sys.exit(f"render: {what} names {', '.join(left)}: put a placeholder there instead (PLACEHOLDERS)")
    fill(text, values, what)


def nas():
    try:
        import puppi3  # puppi3's own profile, not in the kit
    except ModuleNotFoundError:
        sys.exit("render: the puppi3 and staging profiles are puppi3's own (puppi3.py), not here")
    return puppi3


def puppi3(src, out):
    nas().puppi3(src, out)


def staging(src, out):
    nas().staging(src, out)


# ---------- kit: a kit site's own Grafana ----------
# The kit's Grafana has the same datasource uids (kit/monitoring/grafana/datasources/) and its stacks keep the names
# the panels use (tinybird-local, postiz-ghost-bridge, postiz-postgres), so a kit site's copy fills in the placeholders
# and renames what carries the ID_PREFIX (uids, counters, containers); then drops what its MODULES, PETS and NETWORKS
# leave out.
NETWORK_ROWS = {"The site (Ghost)": "ghost", "Bluesky": "bluesky", "Instagram": "instagram", "Mixcloud": "mixcloud",
                "SoundCloud": "soundcloud", "Threads": "threads", "TikTok": "tiktok", "YouTube": "youtube"}
NETWORK_ANNOTATIONS = {"Instagram posts": "instagram", "YouTube posts": "youtube", "SoundCloud posts": "soundcloud",
                       "Bluesky posts": "bluesky", "Threads posts": "threads", "TikTok posts": "tiktok",
                       "Mixcloud posts": "mixcloud"}
# what each switched-off part's panels, variables, annotations and alert rules show (matched on the source's text)
OFF = {
    "analytics": [r'"(uid|name|datasourceUid)": "ghost-analytics"', r"datasourceUid: ghost-analytics\b",
                  r'puppi3-page-hits@file'],
    "social": [r'"(uid|name)": "(postiz-pg|bridge-instagram)"', r"datasourceUid: (postiz-pg|bridge-instagram)\b",
               r'job="puppi3-pets"', r"postiz-ghost-bridge", r"puppi3_"],
    "live": [r"tinyice_", r"_live_(stalls|reconnects)", r"@LIVE_HOST@", r"/live\.json"],
    "pets": [r"puppy_pets", r"/pets\.json"],
}
# what the kit's swaps rename, so none may be left (the site's own values are placeholders: private_check)
LEFTOVERS_KIT = [r"puppi3", r"Puppi3", r"website-"]
# and on Kubernetes, what only Docker has
LEFTOVERS_CLOUD = [r"node_filesystem", r"@docker", r"compose_project", r"Dockge", r"container_[a-z_]+\{name[=!]", r"docs site"]
SAFE = "bcdfghjklmnpqrstvwxz2456789"  # the letters Kubernetes makes pod names' random parts from


def by_workload(x):
    """a pod's series labelled name = its Deployment's, StatefulSet's or Job's name (ghost-7d9c5b8f6-x2kqz, mysql-0 and
    tb-setup-x2kqz -> ghost, mysql and tb-setup), as Compose's container names were: steady across restarts. Each
    later step wins where it matches"""
    x = f'label_replace({x}, "name", "$1", "pod", "(.+)")'
    x = f'label_replace({x}, "name", "$1", "pod", "(.+)-[0-9]+")'
    x = f'label_replace({x}, "name", "$1", "pod", "(.+)-[{SAFE}]{{5}}")'
    return f'label_replace({x}, "name", "$1", "pod", "(.+)-[{SAFE}]{{6,10}}-[{SAFE}]{{5}}")'


def cloud_swaps(p):
    """Kubernetes' versions of the Docker-only queries and texts, put ahead of the kit's swaps (matched on the source's text)"""
    pods = f'namespace="{p}",container!="",container!="POD"'
    postiz = pods + ',pod=~"postiz.*"'
    cpu = lambda sel: f'sum by (name) ({by_workload(f"rate(container_cpu_usage_seconds_total{{{sel}}}[5m])")}) * 100'
    mem = lambda sel: f'sum by (name) ({by_workload(f"container_memory_working_set_bytes{{{sel}}}")})'
    relays = "icecast_relay_listeners"  # each relay is one listener on TinyIce: count the relays' listeners instead
    return [(re.compile(a), (lambda b: lambda m: b)(b)) for a, b in [
        (r'sum by \(name\) \(rate\(container_cpu_usage_seconds_total\{name=~"website-puppi3[^"]*"\}\[5m\]\)\) \* 100', cpu(pods)),
        (r'container_memory_working_set_bytes\{name=~"website-puppi3[^"]*"\}', mem(pods)),
        (r'sum by \(name\) \(rate\(container_cpu_usage_seconds_total\{container_label_com_docker_compose_project="postiz",'
         r'name!=""\}\[5m\]\)\) \* 100', cpu(postiz)),
        (r'sum by \(name\) \(container_memory_working_set_bytes\{container_label_com_docker_compose_project="postiz",'
         r'name!=""\}\)', mem(postiz)),
        (r'node_filesystem_avail_bytes\{job="node",mountpoint="@DISK_MOUNT@"\} / '
         r'node_filesystem_size_bytes\{job="node",mountpoint="@DISK_MOUNT@"\}',
         f'min(kubelet_volume_stats_available_bytes{{namespace="{p}"}} / kubelet_volume_stats_capacity_bytes{{namespace="{p}"}})'),
        (r"puppi3-\[a-z-\]\+@file\|live-status@docker\|puppi3-social-preview@docker", f"{p}-[a-z-]+@file|live-status@file"),
        (r"sum\(tinyice_listeners_total\)",
         f"sum(tinyice_listeners_total) - (count({relays}) or vector(0)) + (sum({relays}) or vector(0))"),
        (r"sum by \(mount\) \(tinyice_stream_listeners_current\)",
         f"sum by (mount) (tinyice_stream_listeners_current) + (sum by (mount) ({relays}) - count by (mount) ({relays})"
         f" or sum by (mount) (tinyice_stream_listeners_current) * 0)"),
        (r"NAS disk free \(@DISK_MOUNT@\)", "Disk free (the fullest volume)"),
        (r"Free space on @DISK_MOUNT@, where the stacks, MySQL, Tinybird and the deploy backups live\.",
         f"Free space on the site's fullest volume (its PersistentVolumeClaims: MySQL, Tinybird, Ghost's content and the "
         f"rest; kubectl -n {p} get pvc)."),
        (r"NAS disk @DISK_MOUNT@ is nearly full", "A volume is nearly full"),
        (r"Less than 10% free on @DISK_MOUNT@ \(stacks, MySQL, Tinybird, deploy backups\)\.",
         f"Less than 10% free on one of the site's volumes (kubectl -n {p} get pvc)."),
        (r"The website's containers: Ghost, MySQL, web analytics \(traffic-analytics, Tinybird\), the Postiz bridge, TinyIce "
         r"and the docs site\. Postiz itself is on the Social dashboard\.",
         "Every pod of the site, by workload: Ghost, MySQL, web analytics, Postiz and the bridge, TinyIce and its relays. "
         "Postiz's are also on the Social dashboard."),
        (r"Memory in use \(working set\) of the website's containers\. Postiz itself is on the Social dashboard\.",
         "Memory in use (working set) of every pod of the site, by workload. Postiz's are also on the Social dashboard."),
        (r"Everything in the postiz stack", "Postiz's pods: Postiz, its Postgres and Redis, Temporal and the bridge"),
        (r"each container in the postiz stack, the bridge included", "each of Postiz's pods, the bridge included"),
        (r"People listening to the live stream right now, all mounts\.",
         "People listening to the live stream right now, all mounts (the relays' listeners, not the relays)."),
        (r"Listeners per mount \(TinyIce\)\.", "Listeners per mount (TinyIce and its relays)."),
    ]]


def read_profile(paths):
    vals = {}
    for path in paths:
        for line in pathlib.Path(path).read_text().splitlines():
            m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                vals[m.group(1)] = m.group(2).strip().strip("\"'")
    return vals


def kit_values(paths, cloud=False):
    v = read_profile(paths)
    p = v.get("ID_PREFIX") or sys.exit("render: the profile has no ID_PREFIX")
    host = v.get("SITE_HOST") or sys.exit("render: the profile has no SITE_HOST")
    modules = {m.strip() for m in v.get("MODULES", "").split(",") if m.strip()}
    off = {m for m in ("analytics", "social", "live") if m not in modules}
    if v.get("PETS", "false") != "true" or "social" in off:
        off.add("pets")
    networks = {n.strip() for n in v.get("NETWORKS", "").split(",") if n.strip()}  # empty = all
    tz = v.get("SITE_TIMEZONE") or "Etc/UTC"
    name = v.get("SITE_NAME") or host
    values = {
        "SITE_HOST": host, "LIVE_HOST": v.get("LIVE_HOST") or "live." + host, "SITE_NAME": name,
        "SITE_TIMEZONE": tz, "TZ_NAME": tz, "TZ_HOURS": str(std_hours(tz)),
        # the site's Ghost's site_uuid (kit.sh asks Ghost once it's up; until then the Tinybird panels are empty)
        "GHOST_SITE_UUID": v.get("GHOST_SITE_UUID") or "00000000-0000-0000-0000-000000000000",
        "DISK_MOUNT": v.get("DISK_MOUNT") or "/", "DJ_SOFTWARE": "the DJ software",
        "NTFY_URL": (v.get("NTFY_URL") or "https://ntfy.sh").rstrip("/"), "NTFY_TOPIC": v.get("NTFY_TOPIC") or f"{p}-alerts",
    }
    mp = p.replace("-", "_")
    containers = "|".join([f"{p}-ghost", f"{p}-db", f"{p}-traffic-analytics-1", f"{p}-tinybird-local-1",
                           f"{p}-tinybird-sync-1", "postiz-ghost-bridge", "tinyice"])
    routers = f"{p}-[a-z-]+@file|live-status@docker|{p}-social-preview@docker"
    swaps = [  # (regex, replacement or function), in order
        (r"/d/puppi3-([a-z]+)", lambda m: f"/d/{p}-{m.group(1)}"),
        (PLACEHOLDER, lambda m: values[m.group(1)]),
        (r"website-puppi3\|puppi3-db-1\|puppi3-traffic-analytics-1\|puppi3-tinybird-local-1\|"
         r"puppi3-tinybird-sync-1\|postiz-ghost-bridge\|tinyice\|docs", lambda m: containers),
        (r"puppi3-\[a-z-\]\+@file\|live-status@docker\|puppi3-social-preview@docker", lambda m: routers),
        (r'container_label_com_docker_compose_project="postiz",name!=""',
         lambda m: f'container_label_com_docker_compose_project="{p}",name=~"postiz.*"'),
        (r"\bpuppi3_", lambda m: mp + "_"),
        (r"NAS disk", lambda m: "Disk"),
        (r"the postiz \.env", lambda m: "secrets/postiz.env"),
        (r"puppi3 · ", lambda m: f"{name} · "),
        (r"\bpuppi3\b", lambda m: p),
    ]
    if cloud:
        swaps = cloud_swaps(p) + swaps
    leftovers = LEFTOVERS_KIT + (LEFTOVERS_CLOUD if cloud else [])
    # NTFY_URL set but empty: no phone alerts (a site tried before it's public); the rules still show in Grafana
    ntfy_off = v.get("NTFY_URL") == ""
    return dict(p=p, name=name, off=off, networks=networks, swaps=swaps, leftovers=leftovers, cloud=cloud,
                values=values, ntfy_off=ntfy_off)


def kit_swap(value, k):
    if isinstance(value, dict):  # keys too: value mappings are keyed by the value ("@SITE_HOST@": "Your own site")
        return {kit_swap(key, k): kit_swap(x, k) for key, x in value.items()}
    if isinstance(value, list):
        return [kit_swap(x, k) for x in value]
    if isinstance(value, str):
        for pattern, repl in k["swaps"]:
            value = re.sub(pattern, repl, value)
    return value


def is_off(thing, k):
    text = json.dumps(thing) if not isinstance(thing, str) else thing
    return any(re.search(pat, text) for part in k["off"] for pat in OFF[part])


def net_off(net, k):
    return bool(k["networks"]) and net not in k["networks"]


def kit_drop_classic(d, k):
    def keep(panels):
        out = []
        for panel in panels:
            if panel.get("type") == "row":
                panel["panels"] = keep(panel.get("panels", []))
                out.append(panel)
            elif not is_off(panel, k):
                out.append(panel)
        return out
    d["panels"] = keep(d.get("panels", []))
    for key in ("annotations", "templating"):
        if isinstance(d.get(key), dict):
            d[key]["list"] = [x for x in d[key].get("list", []) if not is_off(x, k)]
    return any(panel.get("type") not in ("row", "text") for panel in d["panels"])


def kit_drop_v2(spec, k):
    elements = spec.get("elements", {})
    gone = {name for name, e in elements.items() if is_off(e, k)}

    def row_off(row):
        title = row.get("spec", {}).get("title", "")
        return title in NETWORK_ROWS and net_off(NETWORK_ROWS[title], k)
    rows = spec.get("layout", {}).get("spec", {}).get("rows")
    if rows is not None:
        for row in rows:
            if row_off(row):
                gone |= set(parts.refs(row))
    for name in gone:
        elements.pop(name, None)

    def walk(value):
        if isinstance(value, dict):
            return {key: walk(x) for key, x in value.items()}
        if isinstance(value, list):
            return [walk(x) for x in value
                    if not (isinstance(x, dict) and x.get("spec", {}).get("element", {}).get("name") in gone)]
        return value
    layout = walk(spec.get("layout", {}))
    if rows is not None:  # rows left with nothing in them go too
        layout["spec"]["rows"] = [r for r in layout["spec"]["rows"] if not row_off(r) and parts.refs(r)]
        for r in layout["spec"]["rows"]:
            r["spec"]["variables"] = [x for x in r["spec"].get("variables", []) if not is_off(x, k)]
            if not r["spec"]["variables"]:
                del r["spec"]["variables"]
    spec["layout"] = layout

    def var_off(x):
        m = re.match(r"(has|every|sort|show)_([a-z]+)$", x.get("spec", {}).get("name", ""))
        return is_off(x, k) or bool(m and net_off(m.group(2), k))
    spec["variables"] = [x for x in spec.get("variables", []) if not var_off(x)]
    spec["annotations"] = [a for a in spec.get("annotations", []) if not is_off(a, k) and not (
        a.get("spec", {}).get("name") in NETWORK_ANNOTATIONS
        and net_off(NETWORK_ANNOTATIONS[a["spec"]["name"]], k))]
    return any(e.get("spec", {}).get("vizConfig", {}).get("group") != "text" for e in elements.values())


def kit_alerts(text, k):
    """The alert rules: rules for parts that are off dropped (and groups left empty), then the swaps."""
    lines = text.splitlines(keepends=True)
    blocks, cur = [], []  # split at each rule ("      - uid:") and each group ("  - orgId:")
    for line in lines:
        if re.match(r"(      - uid:|  - orgId:|groups:)", line) and cur:
            blocks.append(cur)
            cur = []
        cur.append(line)
    blocks.append(cur)
    out, dropped = [], []
    for b in blocks:
        body = "".join(b)
        m = re.match(r"      - uid: puppi3-stats-([a-z]+)", body)
        if body.startswith("      - uid:") and (is_off(body, k) or (m and net_off(m.group(1), k))):
            dropped.append(kit_swap(re.match(r"      - uid: (\S+)", body).group(1), k))
            # keep the comment lines that introduce the next rule or section
            keep = []
            for line in reversed(b):
                if line.strip().startswith("#") or not line.strip():
                    keep.insert(0, line)
                else:
                    break
            out.append(keep)
        else:
            out.append(b)
    # a group with no rules left goes
    final, i = [], 0
    while i < len(out):
        b = out[i]
        if b and b[0].startswith("  - orgId:"):
            rules = []
            j = i + 1
            while j < len(out) and not (out[j] and (out[j][0].startswith("  - orgId:"))):
                if out[j] and out[j][0].startswith("      - uid:"):
                    rules.append(j)
                j += 1
            if not rules:
                i = j
                continue
        final.append(b)
        i += 1
    body = "".join("".join(b) for b in final)
    body = body[body.index("apiVersion:"):]  # the source's header is about the source
    head = (f"# {k['name']}'s alert rules -> ntfy, made by kit/kit.sh (render.py --profile kit) from\n"
            "# stacks/monitoring/grafana/alerts.yml: edit that, not this. Grafana reads it when it\n"
            f"# starts. Each rule has the label project={k['p']}, which Overview's \"Alerts firing now\" filters on.\n")
    if k["ntfy_off"]:
        # no contact point, and no rule naming one: Grafana's own notification policy (nothing set up = nothing sent)
        body = re.sub(r"\ncontactPoints:\n.*?\n(?=groups:)", "\n", body, flags=re.S)
        body = re.sub(r"\n        notification_settings: \{ receiver: [^}]*\}", "", body)
        head += "# NTFY_URL is empty: no phone alerts (the rules still show in Grafana).\n"
    body = kit_swap(body, k)
    left = [x for x in k["leftovers"] if re.search(x, body)]
    if left:
        sys.exit(f"render: the kit's alert rules still have puppi3's {', '.join(left)} (add a swap for it)")
    # Grafana keeps a provisioned rule (and contact point) whose file entry is gone, and its UI can't delete one:
    # those of switched-off parts are deleted by uid (Grafana skips one it doesn't have)
    if dropped:
        body += "\ndeleteRules:\n" + "".join(f"  - orgId: 1\n    uid: {u}\n" for u in dropped)
    if k["ntfy_off"]:
        body += f"\ndeleteContactPoints:\n  - orgId: 1\n    uid: {k['p']}-ntfy\n"
    return head + body


def kit(src, out, sites, cloud=False):
    k = kit_values(sites, cloud)
    files = parts.load(pathlib.Path(src) / SRC_FOLDER)
    if not files:
        sys.exit(f"render: no dashboards in {src}/{SRC_FOLDER}")
    dest = pathlib.Path(out) / "dashboards"
    if dest.is_dir():  # what's there is the last run's: a dashboard now switched off must go
        for old in dest.glob("*.json"):
            old.unlink()
    dest.mkdir(parents=True, exist_ok=True)
    kept, gone = [], []
    for name, d, _ in files:
        check_source(json.dumps(d, ensure_ascii=False), name, k["values"])
        if "spec" in d:
            shows = kit_drop_v2(d["spec"], k)
            d = kit_swap(d, k)
            uid = d["metadata"]["name"]
        else:
            shows = kit_drop_classic(d, k)
            d = kit_swap(d, k)
            d["id"] = None
            uid = d["uid"]
        (kept if shows else gone).append((name, d, uid))
    # nothing left to show (Social and Platforms without the social module): the header nav and top links lose it too
    gone_re = "|".join(re.escape(uid) for _, _, uid in gone) or "(?!)"
    nav_re = re.compile(rf"(&nbsp;&nbsp;·&nbsp;&nbsp;)?\[[^\]]*\]\(/d/({gone_re})(\?[^)]*)?\)")

    def unlink(value):
        if isinstance(value, dict):
            return {key: unlink(x) for key, x in value.items()}
        if isinstance(value, list):
            return [unlink(x) for x in value
                    if not (isinstance(x, dict) and re.fullmatch(rf"/d/({gone_re})", str(x.get("url", ""))))]
        if isinstance(value, str):
            return nav_re.sub("", value)
        return value
    for name, d, _ in kept:
        d = unlink(d)
        text = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
        left = [x for x in k["leftovers"] if re.search(x, text)]
        if k["cloud"]:
            text = json.dumps(d, separators=(",", ":"), ensure_ascii=False) + "\n"
        if left:
            sys.exit(f"render: the kit's {name} still has puppi3's {', '.join(left)} (add a swap for it)")
        (dest / name).write_text(text)
    source = ALERTS.read_text()
    check_source(source, ALERTS.name, k["values"])
    alerts = kit_alerts(source, k)
    adest = pathlib.Path(out) / "alerting"
    adest.mkdir(parents=True, exist_ok=True)
    for old in adest.glob("*.yml"):
        old.unlink()
    (adest / f"{k['p']}.yml").write_text(alerts)


PROFILES = {"puppi3": puppi3, "staging": staging, "kit": kit, "cloud": lambda src, out, sites: kit(src, out, sites, True)}
SITE_PROFILES = {"kit", "cloud"}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], usage=__doc__.split("\n\n")[1].strip())
    ap.add_argument("--profile", required=True, choices=sorted(PROFILES))
    ap.add_argument("--site", action="append", default=[], help="kit, cloud: the site's profile (KEY=value files, later wins)")
    ap.add_argument("src")
    ap.add_argument("out")
    a = ap.parse_args()
    if (a.profile in SITE_PROFILES) != bool(a.site):
        ap.error("--site goes with --profile kit or cloud (and only with them)")
    try:
        if a.profile in SITE_PROFILES:
            PROFILES[a.profile](a.src, a.out, a.site)
        else:
            PROFILES[a.profile](a.src, a.out)
    except parts.PartsError as e:
        sys.exit(f"render: {e}")
