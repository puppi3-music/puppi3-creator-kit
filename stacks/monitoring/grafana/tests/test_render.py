"""render.py: a kit site's dashboards and alert rules, made from the source with its own values and modules.

    python3 -m unittest discover -s stacks/monitoring/grafana/tests
"""
import json
import pathlib
import re
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import render  # noqa: E402

DASHBOARDS = HERE.parent / "provisioning" / "dashboards" / "json"
SITE = {"SITE_HOST": "radio.test", "SITE_NAME": "Test Radio", "ID_PREFIX": "test-radio", "SITE_TIMEZONE": "America/New_York",
        "MODULES": "analytics,social,live,monitoring", "NETWORKS": "", "PETS": "false", "NTFY_URL": "https://ntfy.sh"}
STATS_RULES = ["instagram", "youtube", "soundcloud", "bluesky", "threads", "tiktok", "mixcloud", "ghost"]


class Values(unittest.TestCase):
    def test_fill(self):
        self.assertEqual(render.fill("at @SITE_HOST@/x", {"SITE_HOST": "a.test"}, "t"), "at a.test/x")
        with self.assertRaises(SystemExit):
            render.fill("@SITE_HOST@ @NOPE@", {"SITE_HOST": "a.test"}, "t")
        # keys too: value mappings are keyed by the value
        self.assertEqual(render.fill_all({"@SITE_HOST@": ["@SITE_HOST@", 1, None]}, {"SITE_HOST": "a"}, "t"), {"a": ["a", 1, None]})

    def test_std_hours(self):
        self.assertEqual(render.std_hours("America/New_York"), 5)
        self.assertEqual(render.std_hours("Etc/UTC"), 0)
        self.assertEqual(render.std_hours("Europe/Berlin"), -1)
        self.assertEqual(render.std_hours("Not/AZone"), 0)

    def test_read_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = pathlib.Path(tmp) / "a.env", pathlib.Path(tmp) / "b.env"
            a.write_text('# a comment\nSITE_HOST="one.test"\nID_PREFIX=one\n  SITE_NAME = no\n#PETS=true\n')
            b.write_text("SITE_HOST='two.test'\nEMPTY=\n")
            self.assertEqual(render.read_profile([a, b]), {"SITE_HOST": "two.test", "ID_PREFIX": "one", "EMPTY": ""})

    def kit_values(self, **site):
        with tempfile.TemporaryDirectory() as tmp:
            f = pathlib.Path(tmp) / "site.env"
            f.write_text("".join(f"{k}={v}\n" for k, v in {**SITE, **site}.items()))
            return render.kit_values([f])

    def test_kit_values(self):
        k = self.kit_values()
        self.assertEqual(k["off"], {"pets"})
        self.assertEqual(k["values"]["LIVE_HOST"], "live.radio.test")
        self.assertEqual(k["values"]["TZ_HOURS"], "5")
        self.assertEqual(k["values"]["NTFY_TOPIC"], "test-radio-alerts")
        self.assertEqual(self.kit_values(PETS="true")["off"], set())
        # pets need the social module (the bridge counts them)
        self.assertEqual(self.kit_values(PETS="true", MODULES="analytics")["off"], {"social", "live", "pets"})
        self.assertEqual(self.kit_values(NETWORKS="ghost, bluesky")["networks"], {"ghost", "bluesky"})
        self.assertTrue(self.kit_values(NTFY_URL="")["ntfy_off"])
        with self.assertRaises(SystemExit):
            self.kit_values(ID_PREFIX="")

    def test_by_workload(self):
        # Prometheus's label_replace: each regex anchored at both ends, each later one wins where it matches
        rules = re.findall(r'"name", "\$1", "pod", "([^"]+)"', render.by_workload("m"))
        self.assertEqual(len(rules), 4)

        def name(pod):
            out = None
            for r in rules:
                m = re.fullmatch(r, pod)
                if m:
                    out = m.group(1)
            return out
        self.assertEqual(name("ghost-7d9c5b8f6-x2kqz"), "ghost")  # a Deployment's pod
        self.assertEqual(name("postiz-ghost-bridge-6f7b8c9d5-b2c4d"), "postiz-ghost-bridge")
        self.assertEqual(name("mysql-0"), "mysql")  # a StatefulSet's
        self.assertEqual(name("tb-setup-x2kqz"), "tb-setup")  # a Job's
        self.assertEqual(name("tinyice"), "tinyice")


class KitRender(unittest.TestCase):
    """The whole render, as kit.sh runs it, for a site with some parts switched off."""

    def lacks(self, text, what, where=""):
        """like assertNotIn, without printing a whole dashboard when it fails"""
        self.assertFalse(re.search(what, text), f"{where} still has {what}")

    def render(self, profile="kit", **site):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        f = pathlib.Path(tmp.name) / "site.env"
        f.write_text("".join(f"{k}={v}\n" for k, v in {**SITE, **site}.items()))
        out = pathlib.Path(tmp.name) / "out"
        render.PROFILES[profile](str(DASHBOARDS), str(out), [str(f)])
        dashboards = {p.name: p.read_text() for p in sorted((out / "dashboards").glob("*.json"))}
        alerts = (out / "alerting" / f"{({**SITE, **site})['ID_PREFIX']}.yml").read_text()
        return dashboards, alerts

    def test_every_value_filled_and_renamed(self):
        dashboards, alerts = self.render()
        self.assertTrue(dashboards)
        for name, text in {**dashboards, "alerts": alerts}.items():
            with self.subTest(name):
                self.lacks(text, r"@[A-Z][A-Z0-9_]*@", name)
                self.lacks(text, r"(?i)puppi3", name)
                self.lacks(text, r"example\.com", name)
        for name, text in dashboards.items():
            d = json.loads(text)
            uid = d["metadata"]["name"] if "spec" in d else d["uid"]
            self.assertTrue(uid.startswith("test-radio-"), f"{name}: {uid}")
        self.assertIn("radio.test", "".join(dashboards.values()))
        self.assertIn("test_radio_", "".join(dashboards.values()), "the counters' prefix: ID_PREFIX with - as _")
        for net in STATS_RULES:
            self.assertIn(f"uid: test-radio-stats-{net}", alerts)
        self.lacks(alerts, "deleteRules", "the alert rules")

    def test_networks_left_out(self):
        dashboards, alerts = self.render(NETWORKS="ghost,bluesky")
        platforms = json.loads(dashboards["8-platforms.json"])
        rows = [r["spec"]["title"] for r in platforms["spec"]["layout"]["spec"]["rows"]]
        for title, net in render.NETWORK_ROWS.items():
            if net in ("ghost", "bluesky"):
                self.assertIn(title, rows)
            else:
                self.assertNotIn(title, rows)
        # every element a row shows is there, and none is left that no row shows
        shown = {n for r in platforms["spec"]["layout"]["spec"]["rows"] for n in render.parts.refs(r)}
        self.assertEqual(shown, set(platforms["spec"]["elements"]))
        self.assertIn("uid: test-radio-stats-bluesky", alerts)
        self.lacks(alerts.split("deleteRules:")[0], "uid: test-radio-stats-instagram", "the alert rules")
        # Grafana keeps a provisioned rule whose entry is gone: deleted by uid
        deleted = re.findall(r"uid: (\S+)", alerts.split("deleteRules:")[1])
        self.assertIn("test-radio-stats-instagram", deleted)
        self.assertNotIn("test-radio-stats-bluesky", deleted)

    def test_modules_left_out(self):
        dashboards, alerts = self.render(MODULES="analytics,monitoring")
        text = "".join(dashboards.values())
        self.lacks(text, "tinyice_", "the dashboards")
        self.lacks(text, "postiz-ghost-bridge", "the dashboards")
        self.lacks(alerts.split("deleteRules:")[0], "tinyice_", "the alert rules")
        # a dashboard with nothing left goes, and the others' links to it too
        self.assertNotIn("6-social.json", dashboards)
        self.lacks(text, "/d/test-radio-social", "the dashboards")

    def test_no_phone_alerts(self):
        _, alerts = self.render(NTFY_URL="")
        self.lacks(alerts, "\ncontactPoints:", "the alert rules")
        self.lacks(alerts, "notification_settings", "the alert rules")
        self.assertIn("deleteContactPoints:", alerts)
        self.assertIn("uid: test-radio-ntfy", alerts)

    def test_cloud(self):
        dashboards, alerts = self.render(profile="cloud")
        for name, text in dashboards.items():
            with self.subTest(name):
                self.assertEqual(text.count("\n"), 1, "one line: a dashboard is one ConfigMap")
                for left in render.LEFTOVERS_CLOUD:
                    self.lacks(text, left, name)
        # the queries read the site's namespace (in JSON, so the quotes escaped)
        self.assertTrue(r'namespace=\"test-radio\"' in "".join(dashboards.values()), "no query reads the namespace")


if __name__ == "__main__":
    unittest.main()
