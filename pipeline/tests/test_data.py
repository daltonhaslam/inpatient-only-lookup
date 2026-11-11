"""Checks on the committed tables: they run without the raw CMS files."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DERIVED = ROOT / "pipeline" / "derived"


def load(path):
    return json.loads(path.read_text())


class Ledger(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.years = {entry["year"]: entry for entry in load(DERIVED / "years.json")}

    def removed(self, year):
        return len(self.years[year]["january"]["removed"])

    def test_counts_cms_published(self):
        self.assertEqual(self.removed(2021), 298)
        self.assertEqual(self.removed(2026), 285)
        self.assertEqual(self.removed(2027), 637)
        self.assertEqual(self.removed(2023), 11)
        self.assertEqual(self.removed(2025), 1)

    def test_cy2022_returns_all_but_five(self):
        returned = set(self.years[2022]["january"]["added"])
        removed_2021 = set(self.years[2021]["january"]["removed"])
        self.assertEqual(removed_2021 - returned, {"01486", "01638", "22630", "23472", "27702"})
        self.assertEqual(returned - removed_2021, {"0643T"})

    def test_list_sizes(self):
        sizes = {year: self.years[year]["start"] for year in self.years}
        self.assertEqual({y: sizes[y] for y in (2020, 2021, 2022, 2026, 2027)},
                         {2020: 1740, 2021: 1438, 2022: 1728, 2026: 1438, 2027: 813})


class Codes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.history = load(DERIVED / "ipo-history.json")
        cls.other = load(DERIVED / "other-codes.json")
        cls.periods = load(DERIVED / "periods.json")

    def last_span(self, code):
        return self.history[code]["spans"][-1]

    def test_knee_replacement_left_in_2018(self):
        events = [(e["date"], e["type"]) for e in self.history["27447"]["events"]]
        self.assertEqual(events, [("2017-01-01", "listed"), ("2018-01-01", "removed")])
        self.assertEqual(self.last_span("27447")["exemption"]["kind"], "before-2020")

    def test_hip_replacement_had_two_years(self):
        exemption = self.last_span("27130")["exemption"]
        self.assertEqual((exemption["kind"], exemption["from"], exemption["through"]), ("two-year", "2020-01-01", "2021-12-31"))

    def test_lumbar_fusion_removed_2021_and_stayed_off(self):
        span = self.last_span("22630")
        self.assertEqual((span["state"], span["removed"], span["exemption"]["kind"]), ("off", "2021-01-01", "indefinite"))
        self.assertEqual(span["exemption"]["two_year_text"], {"from": "2023-01-01", "through": "2025-12-31"})

    def test_a_code_removed_returned_and_removed_again(self):
        types = [e["type"] for e in self.history["27132"]["events"]]
        self.assertEqual(types, ["listed", "removed", "returned", "removed"])
        self.assertEqual(self.last_span("27132")["removed"], "2026-01-01")

    def test_spans_are_contiguous_and_sorted(self):
        dates = [p["date"] for p in self.periods]
        for code, record in self.history.items():
            starts = [span["from"] for span in record["spans"]]
            self.assertEqual(starts, sorted(starts), code)
            self.assertEqual(starts[0], dates[0], code)
            self.assertTrue(all(start in dates for start in starts), code)

    def test_every_off_span_after_a_removal_has_an_exemption_record(self):
        for code, record in self.history.items():
            for span in record["spans"]:
                self.assertEqual(span["removed"] is None, span["exemption"] is None, code)
                if span["state"] != "off":
                    self.assertIsNone(span["removed"], code)

    def test_ever_listed_and_never_listed_do_not_overlap(self):
        self.assertFalse(set(self.history) & set(self.other))
        self.assertIn("99213", self.other)


class Labels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.labels = load(ROOT / "data" / "labels.json")
        cls.groups = {group["id"] for group in load(ROOT / "data" / "groups.json")}
        cls.history = load(DERIVED / "ipo-history.json")

    def test_every_listed_code_has_a_label_and_nothing_else_does(self):
        self.assertEqual(set(self.labels), set(self.history))

    def test_label_shape(self):
        for code, item in self.labels.items():
            label = item["label"]
            self.assertTrue(8 <= len(label) <= 80, code)
            self.assertFalse(label.endswith("."), code)
            self.assertEqual(label, label.strip(), code)
            self.assertIn(item["group"], self.groups, code)
            self.assertTrue(item["family"], code)
            self.assertEqual(bool(item.get("addon")), label.endswith("(add-on)"), code)
            self.assertLessEqual(len(item["keywords"]), 6, code)
            self.assertFalse(re.search(r"[<>]", label + " ".join(item["keywords"]) + item["family"]), code)

    def test_every_group_is_used(self):
        self.assertEqual({item["group"] for item in self.labels.values()}, self.groups)


class Rules(unittest.TestCase):
    def test_citations_are_well_formed(self):
        for key, item in load(ROOT / "pipeline" / "citations.json")["citations"].items():
            self.assertRegex(item["cite"], r"^\d+ FR \d+$", key)
            self.assertLessEqual(len(item["quote"]), 400, key)

    def test_no_code_has_an_exemption_end_yet(self):
        # Change this when CMS ends an exemption through rulemaking and rules.json records it.
        self.assertEqual(load(ROOT / "pipeline" / "rules.json")["exemption_ends"], {})


if __name__ == "__main__":
    unittest.main()
