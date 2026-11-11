import datetime
import unittest

import history


REGIMES = [
    {"removed_from": "2020-01-01", "kind": "two-year", "years": 2},
    {"removed_from": "2021-01-01", "kind": "indefinite", "two_year_text_until": "2026-01-01"},
    {"removed_from": "2026-01-01", "kind": "indefinite"},
]


def snap(**codes):
    return dict(codes)


def exemption(year, ended=None):
    return history.exemption_for(datetime.date(year, 1, 1), REGIMES, ended)


def periods(*dates):
    return [{"id": d[:7], "date": d, "source": "x", "basis": "quarterly"} for d in dates]


class Transition(unittest.TestCase):
    def test_classifies_each_kind_of_change(self):
        before = snap(A="C", B="C", C="C", D="J1", E="C")
        after = snap(A="J1", B="D", D="C", E="C", F="C")   # C leaves the file
        change = history.transition(before, after)
        self.assertEqual(change, {"removed": ["A"], "retired": ["B", "C"], "new": ["F"], "added": ["D"]})

    def test_code_marked_discontinued_then_listed_counts_as_new(self):
        change = history.transition(snap(A="D"), snap(A="C"))
        self.assertEqual(change["new"], ["A"])


class CodeHistory(unittest.TestCase):
    P = periods("2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01", "2026-01-01")

    def events(self, *statuses):
        snapshots = [snap(X=s) if s is not None else {} for s in statuses]
        return history.code_history("X", snapshots, self.P, REGIMES)

    def test_removed_returned_removed(self):
        h = self.events("C", "J1", "C", "C", "T")
        self.assertEqual([(e["date"], e["type"]) for e in h["events"]], [
            ("2020-01-01", "listed"), ("2021-01-01", "removed"), ("2022-01-01", "returned"), ("2026-01-01", "removed")])
        self.assertEqual([s["state"] for s in h["spans"]], ["ipo", "off", "ipo", "off"])
        self.assertEqual(h["spans"][1]["removed"], "2021-01-01")
        self.assertEqual(h["spans"][3]["removed"], "2026-01-01")

    def test_new_code_is_new_not_listed(self):
        h = self.events(None, "C", "C", "C", "C")
        self.assertEqual(h["events"], [{"date": "2021-01-01", "type": "new", "si": "C"}])

    def test_existing_code_put_on_the_list_is_added(self):
        h = self.events("E1", "C", "C", "C", "C")
        self.assertEqual([e["type"] for e in h["events"]], ["added"])

    def test_retired_code_has_no_exemption(self):
        h = self.events("C", None, None, None, None)
        self.assertEqual([e["type"] for e in h["events"]], ["listed", "retired"])
        self.assertIsNone(h["spans"][-1]["exemption"])

    def test_status_change_while_off_the_list_keeps_the_removal_date(self):
        h = self.events("C", "J1", "T", "T", "N")
        self.assertEqual([s["removed"] for s in h["spans"][1:]], ["2021-01-01"] * 3)

    def test_removal_date_survives_a_file_the_code_is_missing_from(self):
        h = self.events("C", "J1", None, "J1", "J1")
        self.assertEqual([s["removed"] for s in h["spans"]], [None, "2021-01-01", None, "2021-01-01"])

    def test_never_listed_span_has_no_removal(self):
        h = self.events("J1", "J1", "C", "C", "C")
        self.assertIsNone(h["spans"][0]["removed"])
        self.assertIsNone(h["spans"][0]["exemption"])


class Exemption(unittest.TestCase):
    def test_removed_in_2020_is_two_years(self):
        e = exemption(2020)
        self.assertEqual((e["kind"], e["through"]), ("two-year", "2021-12-31"))

    def test_removed_in_2021_is_indefinite_with_the_two_year_text_window(self):
        e = exemption(2021)
        self.assertEqual((e["kind"], e["through"]), ("indefinite", None))
        self.assertEqual(e["two_year_text"], {"from": "2023-01-01", "through": "2025-12-31"})

    def test_removed_in_2026_has_no_two_year_text_window(self):
        e = exemption(2026)
        self.assertEqual((e["kind"], e["two_year_text"]), ("indefinite", None))

    def test_removed_in_2024_window_would_start_in_2026_so_there_is_none(self):
        self.assertIsNone(exemption(2024)["two_year_text"])

    def test_removed_before_2020(self):
        self.assertEqual(exemption(2018)["kind"], "before-2020")

    def test_ended_exemption_runs_through_the_day_before(self):
        e = exemption(2026, datetime.date(2030, 1, 1))
        self.assertEqual(e["through"], "2029-12-31")


class EndedExemption(unittest.TestCase):
    P = periods("2020-01-01", "2021-01-01", "2022-01-01", "2026-01-01")

    def test_an_end_date_applies_only_to_removals_before_it(self):
        snapshots = [snap(X="C"), snap(X="J1"), snap(X="C"), snap(X="J1")]
        h = history.code_history("X", snapshots, self.P, REGIMES, {"X": "2025-01-01"})
        self.assertEqual(h["spans"][1]["exemption"]["through"], "2024-12-31")
        self.assertIsNone(h["spans"][3]["exemption"]["through"])


class Periods(unittest.TestCase):
    def test_rule_inside_the_quarterly_range_without_a_january_file_is_an_error(self):
        sources = [
            {"id": "b-2020-01", "kind": "addendum_b", "effective": "2020-01-01"},
            {"id": "b-2021-04", "kind": "addendum_b", "effective": "2021-04-01"},
            {"id": "addenda-2021", "kind": "rule_addenda", "cy": 2021},
        ]
        with self.assertRaises(ValueError):
            history.build_periods(sources)

    def test_correction_replaces_original_and_rules_fill_the_ends(self):
        sources = [
            {"id": "b-2020-01", "kind": "addendum_b", "effective": "2020-01-01"},
            {"id": "b-2020-01-corr", "kind": "addendum_b", "effective": "2020-01-01", "corrects": "b-2020-01"},
            {"id": "b-2020-04", "kind": "addendum_b", "effective": "2020-04-01"},
            {"id": "addenda-2019", "kind": "rule_addenda", "cy": 2019},
            {"id": "addenda-2020", "kind": "rule_addenda", "cy": 2020},
            {"id": "addenda-2021", "kind": "rule_addenda", "cy": 2021},
        ]
        got = [(p["id"], p["source"], p["basis"]) for p in history.build_periods(sources)]
        self.assertEqual(got, [
            ("2019-01", "addenda-2019", "annual"),
            ("2020-01", "b-2020-01-corr", "quarterly"),
            ("2020-04", "b-2020-04", "quarterly"),
            ("2021-01", "addenda-2021", "final-rule"),
        ])


if __name__ == "__main__":
    unittest.main()
