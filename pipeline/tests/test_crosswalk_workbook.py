"""The downloadable workbook: tabs, named ranges, and amounts as formulas (not pasted values).

Numbers are checked against crosswalk.json and the OHSU fixture by crosswalk/verify_workbook.py,
which needs the `formulas` package in a scratch venv and so is not part of this suite.
"""
import tempfile
import unittest
from pathlib import Path

import openpyxl

from crosswalk import workbook

DRGS = [{"drg": "165", "title": "Major Chest Procedures without CC/MCC", "weight": 1.9294, "amount": 14254.31},
        {"drg": "163", "title": "Major Chest Procedures with MCC", "weight": 4.0, "amount": 29551.8}]
YELLOW = "FFF2A8"


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
                     "rates": {"operating": 6848.0, "capital": 539.95, "labor_share": 0.66, "labor_share_le1": 0.62,
                               "operating_wi_le1": 6800.0},
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


OHSU = {"name": "Ohsu Hospital And Clinics", "state": "OR", "wi": 1.1907, "gaf": 1.126962466, "tchop": 0.31139,
        "tchcp": 0.22928, "dshopp": 0.07045, "dshcpp": 0.10036, "caseta44": 4098.35, "ime_caseta44": 4552.82, "type": 7}


def hospitals():
    """hospitals.json's shape: OHSU, a teaching hospital with no MA ratio, a nameless hospital."""
    return {"meta": {"source": {"label": "Impact file", "landing": "https://example.test/impact", "file": "impact.txt"},
                     "columns": {"wi": "FY 2027 Wage Index", "gaf": "GAF", "tchop": "TCHOP", "tchcp": "TCHCP",
                                 "dshopp": "DSHOPP", "dshcpp": "DSHCPP", "caseta44": "CASETA44",
                                 "ime_caseta44": "IME_CASETA44", "name": "Name", "type": "Provider Type"},
                     "opps_labor_share": 0.6, "opps_labor_share_cite": "91 FR 70328",
                     "maryland": "Maryland hospitals are paid under the state's all-payer model, not the IPPS."},
            "hospitals": {"380009": OHSU,
                          "050242": dict(OHSU, name="=Teaching No Ratio", state="CA", ime_caseta44=None),
                          "090012": dict(OHSU, name=None, state="DC", tchop=0.0, tchcp=0.0, dshopp=0.0, dshcpp=0.0, wi=0.9)},
            "maryland": {"210001": {"name": "Meritus Medical Center", "state": "MD"}}}


def shares():
    """patient-shares.json's shape: 32480 compared; no entry for the packaged code."""
    return {"meta": {"deductibles": {"year": 2027, "part_a_inpatient": 1776, "part_b": 292, "source": "CMS fact sheet",
                                     "url": "https://example.test/deductibles"},
                     "sources": [{"id": "asc-2027-aa", "label": "AA", "landing": "https://example.test/aa", "file": "aa"}]},
            "codes": {"32480": {"asc_rate": 1584.98, "asc_share": 316.996, "opps_copay": 716.99, "opps_share": 716.99,
                                "opps_capped": False, "asc_more": False}}}


def build(tmp, crosswalk=None, reviews=()):
    return openpyxl.load_workbook(workbook.write(crosswalk or doc(), Path(tmp) / "x.xlsx", reviews=list(reviews),
                                                 hospitals=hospitals(), shares=shares()))


def named(wb, name):
    """(sheet, cell) a single-cell defined name points at."""
    sheet, ref = wb.defined_names[name].attr_text.split("!")
    return sheet.strip("'"), ref.replace("$", "")


class Workbook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wb = build(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_tabs(self):
        self.assertEqual(self.wb.sheetnames, ["Read me", "Crosswalk", "Per year", "PCS detail", "Inputs", "Hospitals",
                                              "DRG weights", "APC rates", "Review log"])

    def test_named_ranges(self):
        for name in ("OpStd", "CapRate", "LaborShare", "WageIndex", "IME", "DSH", "CapGAF", "OppsLaborShare", "OppsWageIndex",
                     "CapIME", "CapDSH", "MARatio", "HospitalCCN", "HospitalRow", "OpStdHigh", "OpStdLow",
                     "LaborShareHigh", "LaborShareLow", "DrgNum", "DrgWeight", "ApcNum", "ApcRate", "HospCCN", "HospName",
                     "HospState", "HospWI", "HospGAF", "HospTCHOP", "HospTCHCP", "HospDSHOPP", "HospDSHCPP", "HospMARatio"):
            self.assertIn(name, self.wb.defined_names)

    def test_inputs_ccn_cell(self):
        sheet, ref = named(self.wb, "HospitalCCN")
        ws = self.wb[sheet]
        cell = ws[ref]
        self.assertEqual(sheet, "Inputs")
        self.assertIsNone(cell.value)                       # blank = national
        self.assertEqual(cell.number_format, "@")           # a typed CCN keeps its leading zero
        self.assertEqual(cell.fill.fgColor.rgb[-6:], YELLOW)
        self.assertIn("Hospital CCN (blank = national)", ws.cell(row=cell.row, column=1).value)
        row = ws[named(self.wb, "HospitalRow")[1]].value
        for text in ("MATCH(", "HospCCN", 'RIGHT("00000"&'):     # a CCN typed as a number still matches
            self.assertIn(text, row)
        status = ws.cell(row=cell.row, column=3).value
        self.assertTrue(status.startswith("="))
        for text in ("CCN not found", "Maryland", "HospName", "national values"):
            self.assertIn(text, status)

    def test_each_factor_is_your_value_else_ccn_else_national(self):
        inputs = self.wb["Inputs"]
        national = {"WageIndex": 1, "CapGAF": 1, "IME": 0, "CapIME": 0, "DSH": 0, "CapDSH": 0, "MARatio": None}
        lookup = {"WageIndex": "HospWI", "CapGAF": "HospGAF", "IME": "HospTCHOP", "CapIME": "HospTCHCP",
                  "DSH": "HospDSHOPP", "CapDSH": "HospDSHCPP", "MARatio": "HospMARatio"}
        for name, default in national.items():
            _, ref = named(self.wb, name)
            r = inputs[ref].row
            own, ccn, nat, used = (inputs.cell(row=r, column=c) for c in (2, 3, 4, 5))
            self.assertEqual(ref, "E%d" % r, name)                 # the name points at the value used
            self.assertIsNone(own.value, name)                     # your value: blank, yellow
            self.assertEqual(own.fill.fgColor.rgb[-6:], YELLOW, name)
            self.assertIn(lookup[name], ccn.value, name)
            self.assertIn("HospitalRow", ccn.value, name)
            self.assertEqual(nat.value, default, name)
            self.assertEqual(used.value, '=IF(ISNUMBER(B{0}),B{0},IF(ISNUMBER(C{0}),C{0},{1}))'.format(
                r, '""' if default is None else "D%d" % r), name)

    def test_rates_come_from_the_data(self):
        inputs = self.wb["Inputs"]
        want = {"OpStdHigh": 6848.0, "OpStdLow": 6800.0, "LaborShareHigh": 0.66, "LaborShareLow": 0.62, "CapRate": 539.95,
                "OppsLaborShare": 0.6}
        for name, value in want.items():
            r = inputs[named(self.wb, name)[1]].row
            self.assertEqual(inputs.cell(row=r, column=4).value, value, name)
            self.assertIsNone(inputs.cell(row=r, column=2).value, name)
        for name, rule in (("LaborShare", "IF(WageIndex>1,LaborShareHigh,LaborShareLow)"),
                           ("OpStd", "IF(WageIndex>1,OpStdHigh,OpStdLow)"), ("OppsWageIndex", "WageIndex")):
            r = inputs[named(self.wb, name)[1]].row
            self.assertEqual(inputs.cell(row=r, column=3).value, "=" + rule, name)
            self.assertIsNone(inputs.cell(row=r, column=2).value, name)
            self.assertEqual(inputs.cell(row=r, column=5).value, "=IF(ISNUMBER(B{0}),B{0},C{0})".format(r), name)

    def test_rates_are_never_retyped(self):
        other = doc()
        other["meta"]["rates"].update(labor_share=0.67, labor_share_le1=0.61)
        with tempfile.TemporaryDirectory() as tmp:
            wb = build(tmp, other)
        inputs = wb["Inputs"]
        self.assertEqual(inputs.cell(row=inputs[named(wb, "LaborShareHigh")[1]].row, column=4).value, 0.67)
        self.assertEqual(inputs.cell(row=inputs[named(wb, "LaborShareLow")[1]].row, column=4).value, 0.61)

    def test_hospitals_tab(self):
        ws = self.wb["Hospitals"]
        header = [c.value for c in ws[5]]
        self.assertEqual(header[:3], ["CCN", "Name", "State"])
        for column in ("FY 2027 Wage Index", "GAF", "TCHOP", "TCHCP", "DSHOPP", "DSHCPP", "CASETA44", "IME_CASETA44"):
            self.assertTrue(any(column in h for h in header), column)
        rows = [[c.value for c in row] for row in ws.iter_rows(min_row=6)]
        self.assertEqual([r[0] for r in rows], ["050242", "090012", "380009"])     # sorted; Maryland not offered
        self.assertEqual(ws["A6"].data_type, "s")
        self.assertEqual((ws["B6"].value, ws["B6"].data_type), ("=Teaching No Ratio", "s"))
        self.assertIsNone(ws["B7"].value)                                          # CMS left the name blank
        ohsu = dict(zip(header, rows[2]))
        self.assertEqual(ohsu["Operating IME (TCHOP)"], 0.31139)
        self.assertEqual(ohsu["MA ratio (IME_CASETA44 / CASETA44)"], '=IF(ISNUMBER(K8),K8/J8,"")')
        self.assertIn("https://example.test/impact", ws["A3"].value)
        self.assertIn("Maryland", ws["A4"].value)
        self.assertEqual(self.wb.defined_names["HospCCN"].attr_text, "'Hospitals'!$A$6:$A$8")

    def test_amounts_are_formulas(self):
        ws = self.wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        for r in (3, 4):        # the two families of 32480
            for name in ("Outpatient rate", "Inpatient low", "Inpatient high", "IME + DSH low", "IME + DSH high",
                         "Gap low", "Gap high"):
                self.assertTrue(str(ws["%s%d" % (header[name], r)].value).startswith("="), (name, r))
        self.assertIn("OpStd*(LaborShare*WageIndex+1-LaborShare)*(1+IME+DSH)+CapRate*CapGAF*(1+CapIME+CapDSH)",
                      ws["%s3" % header["Inpatient low"]].value)
        self.assertIn("OpStd*(LaborShare*WageIndex+1-LaborShare)*(IME+DSH)+CapRate*CapGAF*(CapIME+CapDSH)",
                      ws["%s3" % header["IME + DSH low"]].value)
        self.assertIn("OppsLaborShare*OppsWageIndex+1-OppsLaborShare", ws["%s3" % header["Outpatient rate"]].value)
        self.assertEqual(ws["%s4" % header["Caveat"]].value.split(" The DRG")[0], workbook.ALT_FLAG["dx"])

    def test_packaged_code_has_blank_inpatient_cells(self):
        ws = self.wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        self.assertEqual(ws["A2"].value, "11008")
        for name in ("Outpatient rate", "Inpatient low", "Inpatient high", "IME + DSH low", "IME + DSH high", "Gap low",
                     "Gap high", "DRG family", "Patient share at ASC (national)",
                     "Patient share at hospital outpatient (national)", "ASC costs patient more"):
            self.assertIsNone(ws["%s2" % header[name]].value, name)
        self.assertIn("Packaged", ws["%s2" % header["Caveat"]].value)

    def test_patient_shares(self):
        ws = self.wb["Crosswalk"]
        header = {c.value: c.column_letter for c in ws[1]}
        for r in (3, 4):        # national values, on every family row of the code
            self.assertEqual(ws["%s%d" % (header["Patient share at ASC (national)"], r)].value, 316.996)
            self.assertEqual(ws["%s%d" % (header["Patient share at hospital outpatient (national)"], r)].value, 716.99)
            self.assertEqual(ws["%s%d" % (header["ASC costs patient more"], r)].value, "No")
        self.assertEqual(workbook.yes_no(True), "Yes")
        self.assertIsNone(workbook.yes_no(None))

    def test_per_year_tab(self):
        ws = self.wb["Per year"]
        header = {c.value: c.column_letter for c in ws[5]}
        self.assertEqual([r[0].value for r in ws.iter_rows(min_row=6, max_row=7)], [163, 165])
        total = ws.max_row
        self.assertEqual((total, ws["A%d" % total].value), (8, "Total"))
        trad, ma = header["Traditional Medicare cases a year"], header["MA cases a year (blank = estimate)"]
        for r in (6, 7):
            for letter in (trad, ma):
                self.assertIsNone(ws["%s%d" % (letter, r)].value)
                self.assertEqual(ws["%s%d" % (letter, r)].fill.fgColor.rgb[-6:], YELLOW)
        cell = lambda name: ws["%s7" % header[name]].value      # noqa: E731
        self.assertEqual(cell("MA cases used"),
                         '=IF(ISNUMBER({ma}7),{ma}7,IF(AND(IME>0,ISNUMBER(MARatio),ISNUMBER({t}7)),ROUND({t}7*MARatio,0),""))'
                         .format(ma=ma, t=trad))
        self.assertIn("(IME+DSH)", cell("IME + DSH per case (traditional)"))
        self.assertIn("*IME", cell("Operating IME per case (MA)"))
        self.assertNotIn("DSH", cell("Operating IME per case (MA)"))
        self.assertEqual(cell("IME + DSH a year, traditional"), '=IF(ISNUMBER({t}7),ROUND({t}7*{e}7,2),"")'.format(
            t=trad, e=header["IME + DSH per case (traditional)"]))
        self.assertIn("ROUND(", cell("Operating IME a year, MA"))
        for name in ("IME + DSH a year, traditional", "Operating IME a year, MA", "Add-ons a year"):
            self.assertEqual(ws["%s%d" % (header[name], total)].value, "=SUM(%s6:%s7)" % (header[name], header[name]))
        self.assertEqual(ws.freeze_panes, "C6")

    def test_layout(self):
        ws = self.wb["Crosswalk"]
        self.assertEqual(ws.freeze_panes, "C2")
        self.assertTrue(ws.auto_filter.ref)
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
        self.assertIn("Built with Claude Code; mappings by two AI passes plus adjudication; under review by credentialed coders.", text)
        self.assertIn(workbook.BADGE, text)
        self.assertIn("/revenue-at-stake/help-review/", text)
        for words in ("Hospital CCN", "Per year", "42 CFR 412.105(g)", "Uncompensated care", "$1,776", "$292",
                      "https://example.test/impact", "https://example.test/aa"):
            self.assertIn(words, text)


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
                    "name": self.NAME, "profile": "=HYPERLINK(1)", "reason": "+cmd|' /C calc'!A0"},
                   {"code": "32480", "fp": "3fa9c1d2", "verdict": "agree", "credential": "CIC", "date": "2026-11-12",
                    "name": "-2+3", "reason": "\tx"}]
        with tempfile.TemporaryDirectory() as tmp:
            wb = build(tmp, bad, reviews)
        log = wb["Review log"]
        self.assertEqual((log["F2"].value, log["F2"].data_type), (self.NAME, "s"))
        self.assertEqual((log["G2"].value, log["G2"].data_type), ("=HYPERLINK(1)", "s"))
        self.assertEqual(log["G1"].value, "Profile")
        self.assertEqual((log["H2"].value, log["H2"].data_type), ("+cmd|' /C calc'!A0", "s"))
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
