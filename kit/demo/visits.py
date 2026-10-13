#!/usr/bin/env python3
"""A month of made-up visits for the demo site (kit/demo/demo.sh): copies the shape of one real page hit
(<event.json>, Tinybird's answer to SELECT * FROM analytics_events LIMIT 1) into NDJSON rows over the last 30 days,
on the demo's posts (<post*.json.out>, the Admin API's answers), from made-up sources and countries."""
import datetime as dt
import json
import random
import sys
import uuid

random.seed(11)
sample = json.load(open(sys.argv[1]))["data"][0]
payload0 = json.loads(sample["payload"]) if isinstance(sample["payload"], str) else sample["payload"]
# (sent as an object: the events table reads its columns from $.payload.*)
posts = [json.load(open(f))["posts"][0] for f in sys.argv[2:]]
site = payload0.get("href", "https://demo.test/").split("/")[2]
pages = [("/", None)] + [(f"/{p['slug']}/", p) for p in posts]

# (referrer, Ghost's source name, medium), weight
SOURCES = [(("", "", ""), 30), (("https://www.google.com/", "Google", "search"), 22),
           (("https://l.instagram.com/", "Instagram", "social"), 18), (("https://bsky.app/", "Bluesky", "social"), 9),
           (("https://www.reddit.com/", "Reddit", "social"), 6), (("https://soundcloud.com/", "SoundCloud", ""), 8),
           (("https://duckduckgo.com/", "DuckDuckGo", "search"), 4), (("https://t.co/", "Twitter", "social"), 3)]
COUNTRIES = [("DE", 26), ("GB", 14), ("US", 18), ("NL", 9), ("FR", 7), ("CA", 6), ("ES", 5), ("SE", 4), ("JP", 3),
             ("BR", 3), ("AU", 3)]
# (user agent, os, browser, device)
AGENTS = [("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", "ios", "safari", "mobile-ios"),
          ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "macos", "chrome", "desktop"),
          ("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", "android", "chrome", "mobile-android"),
          ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "windows", "chrome", "desktop")]


def pick(pairs):
    return random.choices([p for p, _ in pairs], [w for _, w in pairs])[0]


def stamp(t):
    s = sample["timestamp"]
    return t.strftime("%Y-%m-%d %H:%M:%S") + (s[19:] if len(s) > 19 and s[19] == "." else "")


now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
for day in range(30, -1, -1):
    date = now - dt.timedelta(days=day)
    base = 40 + (30 - day) * 3                                    # a growing month
    base *= 1.5 if date.weekday() >= 5 else 1                     # busier at the weekend
    for post_day in (27 - i * 5 for i in range(len(posts))):      # a bump the day a post goes out and after
        if 0 <= post_day - day <= 2:
            base *= 1.8 - 0.3 * (post_day - day)
    for _ in range(int(random.gauss(base, base * 0.1))):
        t = date.replace(hour=0, minute=0, second=0) + dt.timedelta(seconds=random.triangular(0, 86400, 75600))
        if t > now:
            continue
        session, source, country, agent = str(uuid.uuid4()), pick(SOURCES), pick(COUNTRIES), random.choice(AGENTS)
        first = random.choices(pages, [3] + [2 + (i == len(posts) - 1 and 4) for i in range(len(posts))])[0]
        visit = [first] + random.sample(pages, k=min(len(pages), random.choice([0, 0, 0, 1, 1, 2])))
        for n, (path, post) in enumerate(visit):
            p = dict(payload0)
            ref = source if n == 0 else (f"https://{site}{visit[n - 1][0]}", "", "")
            p.update({"pathname": path, "href": f"https://{site}{path}", "location": country, "user-agent": agent[0],
                      "os": agent[1], "browser": agent[2], "device": agent[3], "event_id": str(uuid.uuid4()),
                      "parsedReferrer": {"url": ref[0], "source": ref[1], "medium": ref[2]}})
            if "post_uuid" in p:
                p["post_uuid"] = post["uuid"] if post else "undefined"
            if "post_type" in p:
                p["post_type"] = "post" if post else "null"
            row = {k: v for k, v in sample.items() if k != "inserted_at"}   # (Tinybird stamps that itself)
            row.update(timestamp=stamp(t + dt.timedelta(seconds=40 * n)), session_id=session, payload=p)
            print(json.dumps(row))
