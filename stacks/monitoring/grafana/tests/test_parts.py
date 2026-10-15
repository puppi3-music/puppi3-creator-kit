"""parts.py: a folder dashboard put together and split again comes back the same, and a broken folder says what's wrong.

    python3 -m unittest discover -s stacks/monitoring/grafana/tests
"""
import copy
import json
import os
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import parts  # noqa: E402

SITE = HERE.parent / "provisioning" / "dashboards" / "json" / "site"
FOLDERS = sorted(p for p in SITE.iterdir() if (p / parts.DASHBOARD).is_file())


def panel(title):
    return {"kind": "Panel", "spec": {"title": title, "vizConfig": {"group": "stat"}}}


def row(title, *names):
    return {"kind": "RowsLayoutRow", "spec": {"title": title, "layout": {"kind": "GridLayout", "spec": {"items": [
        {"kind": "GridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": n}}} for n in names]}}}}


def dashboard():
    return {"apiVersion": "dashboard.grafana.app/v2", "metadata": {"name": "test"},
            "spec": {"title": "Test", "elements": {"panel-1": panel("One"), "panel-2": panel("Two"), "panel-3": panel("Three")},
                     "layout": {"kind": "RowsLayout", "spec": {"rows": [row("First ${source:text}", "panel-2", "panel-1"),
                                                                       row("", "panel-3")]}}}}


class RepoDashboards(unittest.TestCase):
    def test_there_are_folder_dashboards(self):
        self.assertTrue(FOLDERS, f"no folder dashboards in {SITE}")

    def test_each_folder_is_what_split_writes(self):
        # a part edited by hand into another layout, or one left over, shows here (and style.py --check fixes the look)
        for folder in FOLDERS:
            with self.subTest(folder=folder.name):
                self.assertEqual(parts.changes(parts.build(str(folder)), str(folder)), ([], []))

    def test_load_takes_both_forms(self):
        names = [name for name, _, _ in parts.load(str(SITE))]
        self.assertEqual(len(names), len(set(names)))
        for folder in FOLDERS:
            self.assertIn(folder.name + ".json", names)


class SplitAndBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name) / "dash"

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip(self):
        d = dashboard()
        written, removed = parts.split(copy.deepcopy(d), str(self.dir))
        self.assertEqual(sorted(written), ["01-first-source/panel-1.json", "01-first-source/panel-2.json",
                                           "01-first-source/row.json", "02-top/panel-3.json", "02-top/row.json",
                                           "dashboard.json"])
        self.assertEqual(removed, [])
        built = parts.build(str(self.dir))
        self.assertEqual(built, d)
        # elements come out in layout order
        self.assertEqual(list(built["spec"]["elements"]), ["panel-2", "panel-1", "panel-3"])
        # again: nothing to change
        self.assertEqual(parts.split(built, str(self.dir)), ([], []))

    def test_split_removes_what_is_gone(self):
        parts.split(dashboard(), str(self.dir))
        d = dashboard()
        del d["spec"]["elements"]["panel-3"]
        d["spec"]["layout"]["spec"]["rows"].pop()
        written, removed = parts.split(d, str(self.dir))
        self.assertEqual(removed, ["02-top/panel-3.json", "02-top/row.json"])
        self.assertFalse((self.dir / "02-top").exists())
        self.assertEqual(parts.build(str(self.dir)), d)

    def test_notes_beside_the_parts_are_left_alone(self):
        parts.split(dashboard(), str(self.dir))
        (self.dir / "CLAUDE.md").write_text("notes")
        (self.dir / ".hidden").mkdir()
        self.assertEqual(parts.build(str(self.dir)), dashboard())
        parts.split(dashboard(), str(self.dir))
        self.assertTrue((self.dir / "CLAUDE.md").is_file())

    def test_slug(self):
        self.assertEqual(parts.slug("Followers by ${network:text}"), "followers-by-network")
        self.assertEqual(parts.slug(""), "top")
        self.assertEqual(parts.slug("!!!"), "top")
        self.assertLessEqual(len(parts.slug("x" * 100)), 40)


class Broken(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name) / "dash"
        parts.split(dashboard(), str(self.dir))

    def tearDown(self):
        self.tmp.cleanup()

    def assertBroken(self, pattern, fn=None):
        with self.assertRaisesRegex(parts.PartsError, pattern):
            (fn or (lambda: parts.build(str(self.dir))))()

    def test_a_panel_no_row_shows(self):
        (self.dir / "02-top" / "panel-9.json").write_text(json.dumps(panel("Stray")))
        self.assertBroken(r"panel-9\.json not shown by its row\.json")

    def test_a_panel_file_missing(self):
        (self.dir / "02-top" / "panel-3.json").unlink()
        self.assertBroken(r"shows panel-3, but there's no panel-3\.json")

    def test_a_folder_without_row_json(self):
        (self.dir / "03-new").mkdir()
        self.assertBroken(r"not a row folder")

    def test_bad_json_names_the_file(self):
        (self.dir / "01-first-source" / "panel-1.json").write_text("{ not json")
        self.assertBroken(r"panel-1\.json")

    def test_layout_left_in_dashboard_json(self):
        top = json.loads((self.dir / "dashboard.json").read_text())
        top["spec"]["elements"] = {}
        (self.dir / "dashboard.json").write_text(json.dumps(top))
        self.assertBroken(r"belong in the row folders")

    def test_split_refuses_what_it_cannot_keep(self):
        d = dashboard()
        d["spec"]["layout"]["spec"]["rows"][1] = row("", "panel-1")
        self.assertBroken(r"used twice", lambda: parts.parts(d))
        d = dashboard()
        d["spec"]["elements"]["panel-4"] = panel("Unused")
        self.assertBroken(r"elements no row shows: panel-4", lambda: parts.parts(d))
        d = dashboard()
        d["spec"]["layout"] = {"kind": "GridLayout", "spec": {"items": []}}
        self.assertBroken(r"laid out in rows", lambda: parts.parts(d))

    def test_a_dashboard_both_as_file_and_folder(self):
        (pathlib.Path(self.tmp.name) / "dash.json").write_text(json.dumps({"uid": "x", "panels": []}))
        self.assertBroken(r"both as a file and as a folder", lambda: parts.load(self.tmp.name))


if __name__ == "__main__":
    unittest.main()
