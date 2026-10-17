#!/usr/bin/env python3
"""The demo site's made-up content (kit/demo/demo.sh): writes the Admin API requests' bodies into <dir> and prints
one line per request (method, path, body file), plus <dir>/members.csv. Reads the uploaded pictures' answers
(<dir>/pic<n>.json). Every name and word here is made up."""
import csv
import datetime as dt
import json
import random
import sys

d = sys.argv[1]
random.seed(7)
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
pics = [json.load(open(f"{d}/pic{i}.json"))["images"][0]["url"] for i in range(6)]


def lexical(paragraphs):
    def text(t):
        return {"type": "text", "version": 1, "text": t, "detail": 0, "format": 0, "mode": "normal", "style": ""}
    kids = [{"type": "paragraph", "version": 1, "direction": None, "format": "", "indent": 0, "children": [text(p)]}
            for p in paragraphs]
    return json.dumps({"root": {"type": "root", "version": 1, "direction": None, "format": "", "indent": 0,
                                "children": kids}})


POSTS = [
    ("Night Owl Session 42: deep house till sunrise", "mixes",
     ["Three hours, one long build, recorded live last Friday.",
      "The tracklist is below; the full set is on the stream archive."]),
    ("Five records I can't stop playing this month", "picks",
     ["A short list from the crate: two reissues, one debut, and two I found by accident."]),
    ("Behind the decks: how I plan a set", "notes",
     ["I start from the last track and work backwards.", "Here's the whole process, with the notes I keep."]),
    ("Live this Saturday from the rooftop", "live",
     ["Doors at nine, the stream starts at ten. Bring a jacket."]),
    ("New mix: Low Tide (ambient, 58 minutes)", "mixes",
     ["Slow, warm and mostly beatless, for the end of a long week."]),
    ("A year of Night Owl Radio", "notes",
     ["Fifty-two sessions, eleven guests and one very patient neighbour. Thank you for listening."]),
]

out = []
for i, (title, tag, paras) in enumerate(POSTS):
    when = now - dt.timedelta(days=27 - i * 5, hours=random.randint(0, 6))
    body = {"posts": [{"title": title, "status": "published", "published_at": when.isoformat().replace("+00:00", "Z"),
                       "feature_image": pics[i], "tags": [{"name": tag}], "lexical": lexical(paras),
                       "custom_excerpt": paras[0]}]}
    json.dump(body, open(f"{d}/post{i}.json", "w"))
    out.append(("POST", "/posts/", f"{d}/post{i}.json"))

# a draft, for the Social preview's shot (not a post*.json: visits.py gives those their visits)
# with a music link, so the preview shows the featured link
paras = ["Recorded on the roof last Saturday, rain and all.", "Two hours of warm house; the tracklist is below."]
body = json.loads(lexical(paras))
body["root"]["children"].append({"type": "paragraph", "version": 1, "direction": None, "format": "", "indent": 0,
                                 "children": [{"type": "link", "version": 1, "rel": None, "target": None, "title": None,
                                               "url": "https://soundcloud.com/example/night-owl-session-43",
                                               "direction": None, "format": "", "indent": 0, "children": [
                                                   {"type": "text", "version": 1, "text": "Listen on SoundCloud",
                                                    "detail": 0, "format": 0, "mode": "normal", "style": ""}]}]})
json.dump({"posts": [{"title": "Night Owl Session 43: back on the rooftop", "status": "draft", "feature_image": pics[3],
                      "tags": [{"name": "mixes"}], "lexical": json.dumps(body), "custom_excerpt": paras[0]}]},
          open(f"{d}/draft.json", "w"))
out.append(("POST", "/posts/", f"{d}/draft.json"))


nav = [{"label": l, "url": u} for l, u in [("SoundCloud", "https://soundcloud.com/example"),
                                             ("Mixcloud", "https://www.mixcloud.com/example/"),
                                             ("Bandcamp", "https://example.bandcamp.com/")]]
json.dump({"settings": [{"key": "description", "value": "Late-night house and ambient, live every Saturday."},
                        {"key": "accent_color", "value": "#7f53ac"}, {"key": "cover_image", "value": pics[0]},
                        {"key": "secondary_navigation", "value": json.dumps(nav)}]}, open(f"{d}/settings.json", "w"))
out.append(("PUT", "/settings/", f"{d}/settings.json"))

first = ["alex", "sam", "jo", "kai", "rio", "noa", "lee", "ari", "max", "eli", "fin", "ida", "ola", "tao", "uma"]
with open(f"{d}/members.csv", "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["email", "name", "subscribed_to_emails", "created_at"])
    for n in range(64):
        name = random.choice(first)
        when = now - dt.timedelta(days=random.triangular(0, 30, 2), hours=random.randint(0, 23))
        w.writerow([f"{name}{n}@example.com", name.title(), "true", when.strftime("%Y-%m-%dT%H:%M:%S.000Z")])

for line in out:
    print("\t".join(line))
