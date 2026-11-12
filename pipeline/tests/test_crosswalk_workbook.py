"""The downloadable workbook: tabs, named ranges, and amounts as formulas (not pasted values).

Numbers are checked against crosswalk.json by crosswalk/verify_workbook.py, which needs the
`formulas` package in a scratch venv and so is not part of this suite.
"""
import tempfile
import unittest
from pathlib import Path

import openpyxl

from crosswalk import workbook

DRGS = [{"drg": "165", "title": "Major Chest Procedures without CC/MCC", "weight": 1.9294, "amount": 14254.31},
        {"drg": "163", "title": "Major Chest Procedures with MCC", "weight": 4.0, "amount": 29551.8}]


def doc():
    outpatient = {"si": "J1", "apc": "5361", "apc_title": "Level 1 Laparoscopy", "rate": 3584.95, "asc": 2000.0,
                  "proposed": None, "packaged": False}
    family = {"condition": "lung cancer", "dx": {"code": "C3411", "title": "Malignant neoplasm of upper lobe"},
              "mdc": "04", "family": "Major Chest Procedures", "basis": "in-mdc", "drgs": DRGS, "low": 14254.31,
              "high": 29551.8, "index_rows": [{"pcs": "0BTC0ZZ", "mdc": "04", "drgs": ["163", "164", "165"],
                                              "family": "Major Chest Procedures", "non_or": False}]}
    alt = dict(family, condition="other", drgs=DRGS[:1], low=14254.31, high=14254.31, index_rows=[])
    mapped = {"pcs_sets": [{"codes": [{"code": "0BTC0ZZ", "title": "Excision of Right Upper Lung Lobe"}], "note": "right upper"}],
              "principal_dx": [], "fp": "3fa9c1d2", "rationale": "", "passes_agree": True, "adjudication": None}
    packaged = {"si": "N", "apc": None, "apc_title": None, "rate": None, "asc": None, "proposed": None, "packaged": True}
    review = {"status": "unreviewed", "agrees": 0, "disputes": 0, "stale": 0, "last": None}
    return {"meta": {"built": "2026-11-11", "counts": {"codes": 2, "removed_2026": 1, "removed_2027": 1},
                     "rates": {"operating": 6848.0, "capital": 539.95, "labor_share": 0.66, "labor_share_le1": 0.62},
                     "sources": {"ipps-2027-table5": {"label": "T5", "landing": "https://example.test/t5", "file": "t5"},
                                 "addenda-2027": {"label": "Add B", "landing": "https://example.test/b", "file": "b"}}},
            "codes": {
                "32480": {"removed": "2026-01-01", "label": "Lobectomy", "group": "thoracic", "family": "x",
                          "outpatient": outpatient, "inpatient": {"families": [family, alt], "low": 1, "high": 2},
                          "mapping": mapped, "tier": {"tier": 3, "why": "The DRG family depends on the principal diagnosis. Reviewers wanted."},
                          "review": review, "difference": None, "batch": "b-1"},
                "11008": {"removed": "2027-01-01", "label": "Packaged thing", "group": "skin", "family": "y",
                          "outpatient": packaged, "inpatient": None, "mapping": None, "tier": None, "review": review,
                          "difference": None, "batch": None}}}


class Workbook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = workbook.write(doc(), Path(cls.tmp.name) / "x.xlsx", reviews=[])
        cls.wb = openpyxl.load_workbook(path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_tabs(self):
        self.assertEqual(self.wb.sheetnames, ["Read me", "Crosswalk", "PCS detail", "Inputs", "DRG weights", "APC rates", "Review log"])

    def test_named_ranges(self):
        for name in ("OpStd", "CapRate", "LaborShare", "WageIndex", "IME", "DSH", "CapGAF", "OppsLaborShare", "OppsWageIndex",
                     "DrgNum", "DrgWeight", "ApcNum", "ApcRate"):
            self.assertIn(name, self.wb.defined_names)
        inputs = self.wb["Inputs"]
        self.assertEqual(inputs["B8"].value, 1.0)      # WageIndex
        self.assertEqual(inputs["B7"].value, 0.66)      # LaborShare
        self.assertIn("66.0%", inputs["C7"].value)
        self.assertIn("62%", inputs["C7"].value)

    def test_amounts_are_formulas(self):
        ws = self.wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        for r in (3, 4):        # the two families of 32480
            for name in ("Outpatient national rate", "Inpatient low", "Inpatient high", "Gap low", "Gap high"):
                self.assertTrue(str(ws["%s%d" % (header[name], r)].value).startswith("="), (name, r))
        self.assertIn("OpStd", ws["%s3" % header["Inpatient low"]].value)
        self.assertEqual(ws["%s4" % header["Caveat"]].value.split(" The DRG")[0], workbook.ALT_FLAG["dx"])

    def test_packaged_code_has_blank_inpatient_cells(self):
        ws = self.wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        self.assertEqual(ws["A2"].value, "11008")
        for name in ("Outpatient national rate", "Inpatient low", "Inpatient high", "Gap low", "Gap high", "DRG family"):
            self.assertIsNone(ws["%s2" % header[name]].value)
        self.assertIn("Packaged", ws["%s2" % header["Caveat"]].value)

    def test_layout(self):
        ws = self.wb["Crosswalk"]
        self.assertEqual(ws.freeze_panes, "C2")
        self.assertTrue(ws.auto_filter.ref)
        self.assertEqual(self.wb["Inputs"]["B5"].fill.fgColor.rgb[-6:], "FFF2A8")
        for sheet in self.wb:
            self.assertEqual(list(sheet.merged_cells.ranges), [])

    def test_review_log_empty_and_lookup_tabs(self):
        self.assertEqual(self.wb["Review log"]["A2"].value, "No reviews yet")
        self.assertEqual([r[0].value for r in self.wb["DRG weights"].iter_rows(min_row=6)], [163, 165])
        self.assertEqual(self.wb["APC rates"]["A6"].value, 5361)
        self.assertIn("https://example.test/t5", self.wb["DRG weights"]["A3"].value)

    def test_pcs_detail_row(self):
        ws = self.wb["PCS detail"]
        self.assertEqual([c.value for c in ws[2]][:6], ["32480", "Lobectomy", 1, "right upper", "0BTC0ZZ", "Excision of Right Upper Lung Lobe"])
        self.assertEqual(ws["H2"].value, "163, 164, 165")

    def test_read_me_text(self):
        text = " ".join(str(row[0].value) for row in self.wb["Read me"].iter_rows() if row[0].value)
        self.assertNotIn("Hirsch", text)
        self.assertIn("Built with Claude Code; mappings by two AI passes plus adjudication; under review by credentialed coders.", text)
        self.assertIn(workbook.BADGE, text)
        self.assertIn("/revenue-at-stake/help-review/", text)


class AlternativeFlag(unittest.TestCase):
    def test_says_what_selects_the_family(self):
        cases = [(None, "Alternative family (depends on diagnosis)"),
                 ({"dx": "lung cancer", "variant": None}, "Alternative family (depends on diagnosis)"),
                 ({"dx": None, "variant": "open"}, "Alternative family (depends on operation variant)"),
                 ({"dx": "lung cancer", "variant": "open"}, "Alternative family (depends on diagnosis and operation variant)"),
                 ({"dx": None, "variant": None}, "Alternative family (depends on diagnosis)")]
        for when, text in cases:
            self.assertEqual(workbook.alt_flag({"when": when} if when is not None else {}), text, when)


class FormulaInjection(unittest.TestCase):
    """Text from reviewers or data that starts like a formula is stored as text, never evaluated."""

    NAME = '=HYPERLINK("https://evil.test/","click")'

    def test_reviewer_text_and_crosswalk_text_are_plain_strings(self):
        bad = doc()
        bad["codes"]["32480"]["label"] = "=1+1"
        bad["codes"]["32480"]["inpatient"]["families"][0]["condition"] = "@SUM(A1)"
        reviews = [{"code": "32480", "fp": "3fa9c1d2", "verdict": "wrong", "credential": "CCS", "date": "2026-11-12",
                    "name": self.NAME, "reason": "+cmd|' /C calc'!A0"},
                   {"code": "32480", "fp": "3fa9c1d2", "verdict": "agree", "credential": "CIC", "date": "2026-11-12",
                    "name": "-2+3", "reason": "\tx"}]
        with tempfile.TemporaryDirectory() as tmp:
            wb = openpyxl.load_workbook(workbook.write(bad, Path(tmp) / "x.xlsx", reviews=reviews))
        log = wb["Review log"]
        self.assertEqual((log["F2"].value, log["F2"].data_type), (self.NAME, "s"))
        self.assertEqual((log["G2"].value, log["G2"].data_type), ("+cmd|' /C calc'!A0", "s"))
        self.assertEqual((log["F3"].value, log["F3"].data_type), ("-2+3", "s"))
        ws = wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        self.assertEqual((ws["%s3" % header["Plain label"]].value, ws["%s3" % header["Plain label"]].data_type), ("=1+1", "s"))
        self.assertEqual(ws["%s3" % header["Condition / principal dx"]].data_type, "s")
        self.assertEqual(ws["%s3" % header["Inpatient low"]].data_type, "f")       # the workbook's own formulas stay formulas
        pcs = wb["PCS detail"]
        self.assertEqual((pcs["B2"].value, pcs["B2"].data_type), ("=1+1", "s"))
        formulas = [c.coordinate for sheet in (log, pcs) for row in sheet.iter_rows() for c in row if c.data_type == "f"]
        self.assertEqual(formulas, [])


if __name__ == "__main__":
    unittest.main()
