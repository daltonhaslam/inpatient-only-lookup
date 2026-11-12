"""Loaders for the revenue-at-stake crosswalk, checked against the raw CMS files.

Skipped when data/raw/ is absent (a fresh clone), like test_raw.py.
"""
import unittest
from unittest import mock

import fetch
import parse
from crosswalk import sources

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


class Helpers(unittest.TestCase):
    def test_expand_drg_ranges(self):
        self.assertEqual(sources._expand("163-165"), ["163", "164", "165"])
        self.assertEqual(sources._expand("005"), ["005"])
        self.assertEqual(sources._expand("928-929,934"), ["928", "929", "934"])
        with self.assertRaises(parse.ParseError):
            sources._expand("165-163")

    def test_money(self):
        self.assertEqual(sources._money("$3,584.95 "), 3584.95)
        self.assertEqual(sources._money("1584.98"), 1584.98)
        self.assertIsNone(sources._money("."))
        self.assertIsNone(sources._money(""))


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class Sources(unittest.TestCase):
    def test_every_loader_names_a_pinned_source(self):
        ids = {source["id"] for source in fetch.load_sources()}
        for name, source_id in sources.SOURCE_OF.items():
            self.assertTrue(callable(getattr(sources, name)), name)
            self.assertIn(source_id, ids, name)

    def test_code_sets(self):
        pcs = sources.load_pcs()
        self.assertEqual(pcs["0BTC0ZZ"], "Resection of Right Upper Lung Lobe, Open Approach")
        self.assertNotIn("0BT", pcs)            # section headers are not valid codes
        cm = sources.load_cm()
        self.assertEqual(cm["C3411"], "Malignant neoplasm of upper lobe, right bronchus or lung")
        self.assertNotIn("C341", cm)            # not billable

    def test_drg_titles(self):
        titles = sources.load_drg_titles()
        self.assertEqual(titles["165"], {"title": "Major Chest Procedures without CC/MCC", "mdc": "04", "type": "SURG"})
        self.assertEqual(titles["180"]["type"], "MED")
        self.assertEqual(titles["981"]["mdc"], None)

    def test_table5_uses_the_correction_notice_weights(self):
        table5 = sources.load_table5()
        self.assertEqual(table5["163"]["weight"], 4.4892)
        self.assertEqual(table5["164"]["weight"], 2.5157)
        self.assertEqual(table5["165"], {"weight": 1.9294, "gmlos": 1.9, "amlos": 2.3})
        self.assertEqual(set(table5), set(sources.load_drg_titles()) - {"998", "999"})

    def test_rates(self):
        rates = sources.load_rates()
        self.assertEqual(rates["operating_wi_gt1"], 6848.00)
        self.assertEqual(rates["operating_wi_le1"], 6848.00)
        self.assertEqual(rates["labor_share_gt1"], 0.66)
        self.assertEqual(rates["labor_share_le1"], 0.62)
        self.assertEqual(rates["capital"], 539.95)
        self.assertEqual(rates["source"], "ipps-2027-table1")

    def test_procedure_index(self):
        index = sources.load_proc_index()
        self.assertIn({"mdc": "04", "drgs": ["163", "164", "165"], "family": "Major Chest Procedures", "non_or": False},
                      index["0BTC0ZZ"])
        rows = {(row["mdc"], tuple(row["drgs"])) for row in index["0DTE0ZZ"]}
        self.assertIn(("05", ("361", "362")), rows)
        self.assertIn(("06", ("329", "330", "331")), rows)
        self.assertIn(("07", ("405", "406", "407")), {(row["mdc"], tuple(row["drgs"])) for row in index["0FBG0ZZ"]})
        # A blank code continues the previous one.
        self.assertEqual([row["mdc"] for row in index["0016070"]], ["01", "17", "17", "21", "24"])
        # Trailing * marks a non-OR procedure; Pre-MDC rows are MDC "00".
        self.assertTrue(all(row["non_or"] for row in index["00H004Z"]))
        self.assertIn({"mdc": "00", "drgs": ["001", "002"], "family": "Heart Transplant or Implant of Heart Assist System",
                       "non_or": False}, index["02HA0QZ"])
        # Rows CMS printed without a category take the Appendix D title.
        self.assertTrue(all(row["family"] for rows in index.values() for row in rows))

    def test_index_codes_are_valid_and_drgs_exist(self):
        pcs, titles = sources.load_pcs(), sources.load_drg_titles()
        for code, rows in sources.load_proc_index().items():
            self.assertIn(code, pcs)
            for row in rows:
                for drg in row["drgs"]:
                    self.assertIn(drg, titles, code)

    def test_hierarchy(self):
        hierarchy = sources.load_hierarchy()
        self.assertEqual(hierarchy["04"][0], ("163", "164", "165"))
        self.assertIn(("411", "412", "413", "414", "415", "416", "417", "418", "419"), hierarchy["07"])
        self.assertEqual(hierarchy["00"][0], ("018",))
        titles = sources.load_drg_titles()
        for mdc, families in hierarchy.items():
            for drg in (drg for family in families for drg in family):
                self.assertIn(drg, titles)
                if mdc != "00":     # Pre-MDC also ranks medical DRGs (bone marrow transplant, CAR-T)
                    self.assertEqual(titles[drg]["type"], "SURG", drg)

    def test_principal_diagnosis_mdc(self):
        dx_mdc = sources.load_dx_mdc()
        self.assertEqual(dx_mdc["C3411"], ["04"])
        self.assertEqual(dx_mdc["Z9282"], ["23"])        # Appendix B also lists MDC 01 (secondary-dx logic)
        self.assertEqual(dx_mdc["A510"], ["12", "13"])   # assigned by sex
        self.assertEqual(dx_mdc["B20"], ["25"])
        self.assertLessEqual(set(dx_mdc), set(sources.load_cm()))

    def test_principal_diagnosis_drgs(self):
        dx_drgs = sources.load_dx_drgs()
        self.assertEqual(dx_drgs["C3411"], ["180", "181", "182"])
        self.assertEqual(dx_drgs["A0221"], ["023", "024", "094", "095", "096"])   # MDC 25 row dropped
        self.assertEqual(dx_drgs["J705"], ["205", "206"])                       # MDC 22 row dropped
        self.assertEqual(set(dx_drgs), set(sources.load_dx_mdc()))
        # CMS prints B20 as 969-977; 971-973 no longer exist in Appendix A.
        self.assertEqual(dx_drgs["B20"], ["969", "970", "974", "975", "976", "977"])

    def test_principal_diagnosis_pre_mdc_drgs(self):
        pre = sources.load_dx_pre_drgs()
        self.assertEqual(pre["C320"], ["011", "012", "013"])     # face, mouth and neck
        self.assertEqual(pre["E1165"], ["008", "010", "019"])    # diabetes, transplant DRGs
        self.assertNotIn("C3411", pre)

    def test_unrelated_designation(self):
        unrelated = sources.load_unrelated()
        self.assertEqual(unrelated["0BTC0ZZ"], "extensive")
        self.assertEqual(unrelated["00BF0ZZ"], "nonextensive")
        self.assertNotIn("00H004Z", unrelated)            # non-OR
        index = sources.load_proc_index()
        self.assertEqual(set(unrelated), {code for code, rows in index.items() if not rows[0]["non_or"]})

    def test_outpatient_tables(self):
        self.assertEqual(sources.load_opps()["32480"], {"si": "J1", "apc": "5183", "rate": 3584.95})
        self.assertEqual(sources.load_apc_titles()["5183"], "Level 3 Vascular Procedures")
        self.assertEqual(sources.load_asc()["32480"], 1584.98)
        self.assertEqual(sources.load_opps_proposed()["32480"], {"si": "J1", "apc": "5182", "rate": 1777.99})

    def test_missing_proposed_file_warns_and_returns_nothing(self):
        with mock.patch.object(sources, "_path", return_value=fetch.RAW / "absent" / "absent.zip"):
            with self.assertWarns(UserWarning):
                self.assertEqual(sources.load_opps_proposed.__wrapped__(), {})


if __name__ == "__main__":
    unittest.main()
