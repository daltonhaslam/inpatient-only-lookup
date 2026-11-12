"""MS-DRG surgical-family grouping, checked against the raw v44 files.

Skipped when data/raw/ is absent (a fresh clone), like test_raw.py.
"""
import copy
import unittest

import fetch
from crosswalk import group as group_module
from crosswalk import sources
from crosswalk.group import Ref, group

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())

# Pancreaticoduodenectomy (Whipple): partial pancreatectomy, duodenal resection, partial
# gastrectomy, choledochojejunostomy, gastrojejunostomy.
WHIPPLE = ["0FBG0ZZ",   # Excision of Pancreas, Open Approach
           "0DT90ZZ",   # Resection of Duodenum, Open Approach
           "0DB60ZZ",   # Excision of Stomach, Open Approach
           "0F190ZB",   # Bypass Common Bile Duct to Small Intestine, Open Approach
           "0D160ZA"]   # Bypass Stomach to Jejunum, Open Approach


class RefObject(unittest.TestCase):
    def test_given_tables_are_used_and_unknown_names_rejected(self):
        ref = Ref(table5={"165": {"weight": 1.0}})
        self.assertEqual(ref.table5, {"165": {"weight": 1.0}})
        with self.assertRaises(TypeError):
            Ref(not_a_table={})
        with self.assertRaises(AttributeError):
            ref.not_a_table

    @unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
    def test_load_is_shared_and_reads_the_loaders(self):
        self.assertIs(Ref.load(), Ref.load())
        self.assertIs(Ref.load().proc_index, sources.load_proc_index())


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class Group(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ref = Ref.load()

    def group(self, codes, dx, **kwargs):
        return group(codes, dx, self.ref, **kwargs)

    def test_codes_exist(self):
        for code in WHIPPLE + ["0BTC0ZZ", "0DTE0ZZ", "0D1B0Z4", "0YQ50ZZ"]:
            self.assertIn(code, self.ref.pcs)

    def test_lobectomy_for_lung_cancer(self):
        self.assertEqual(self.group(["0BTC0ZZ"], "C3411"), {
            "mdc": "04", "drgs": ["163", "164", "165"], "family": "Major Chest Procedures",
            "basis": "in-mdc", "or_codes": ["0BTC0ZZ"], "mdc_ambiguous": False})

    def test_colectomy_with_ileostomy(self):
        result = self.group(["0DTE0ZZ", "0D1B0Z4"], "C189")
        self.assertEqual((result["mdc"], result["drgs"], result["basis"]), ("06", ["329", "330", "331"], "in-mdc"))
        self.assertEqual(result["or_codes"], ["0DTE0ZZ", "0D1B0Z4"])

    def test_whipple_for_pancreatic_cancer(self):
        result = self.group(WHIPPLE, "C250")
        self.assertEqual((result["mdc"], result["drgs"], result["family"], result["basis"]),
                         ("07", ["405", "406", "407"], "Pancreas, Liver and Shunt Procedures", "in-mdc"))

    def test_whipple_for_duodenal_cancer(self):
        # Ruling R5: assert what v44 does. C170 is an MDC 06 diagnosis, and 0FBG0ZZ (pancreas)
        # has no MDC 06 row, so the pancreas family is out of reach. Among the MDC 06 rows, the
        # partial gastrectomy and gastrojejunostomy (326-328, Stomach, Esophageal and Duodenal)
        # outrank the duodenal resection (329-331) and the biliary bypass (356-358) in Appendix D.
        result = self.group(WHIPPLE, "C170")
        self.assertEqual((result["mdc"], result["drgs"], result["family"], result["basis"]),
                         ("06", ["326", "327", "328"], "Stomach, Esophageal and Duodenal Procedures", "in-mdc"))
        self.assertNotEqual(result["drgs"], ["405", "406", "407"])

    def test_or_procedure_outside_the_diagnosis_mdc_is_unrelated(self):
        # Appendicitis (MDC 06) with a lobectomy, which has no MDC 06 row.
        result = self.group(["0BTC0ZZ"], "K3580")
        self.assertTrue(result["basis"].startswith("unrelated"))
        self.assertEqual(result, {
            "mdc": "06", "drgs": ["981", "982", "983"],
            "family": "Extensive O.R. Procedures Unrelated to Principal Diagnosis",
            "basis": "unrelated-extensive", "or_codes": ["0BTC0ZZ"], "mdc_ambiguous": False})

    def test_nonextensive_unrelated(self):
        # Inguinal hernia repair (non-extensive, MDC 06 only) for lung cancer (MDC 04).
        self.assertEqual(self.ref.unrelated["0YQ50ZZ"], "nonextensive")
        result = self.group(["0YQ50ZZ"], "C3411")
        self.assertEqual((result["drgs"], result["basis"]), (["987", "988", "989"], "unrelated-nonextensive"))
        # One extensive code makes the whole case extensive.
        result = self.group(["0YQ50ZZ", "0DTE0ZZ"], "C3411")
        self.assertEqual((result["drgs"], result["basis"]), (["981", "982", "983"], "unrelated-extensive"))

    def test_no_or_procedure_groups_by_diagnosis(self):
        expected = {"mdc": "04", "drgs": ["180", "181", "182"], "family": "Respiratory Neoplasms",
                    "basis": "medical", "or_codes": [], "mdc_ambiguous": False}
        self.assertEqual(self.group([], "C3411"), expected)
        self.assertEqual(self.group(["BW03ZZZ"], "C3411"), expected)      # valid PCS, not in Appendix E
        self.assertEqual(self.group(["5A1955Z"], "C3411"), expected)      # non-OR (MV > 96 hours)

    def test_medical_drgs_are_only_medical(self):
        # Appendix B lists A0221 for craniotomy DRGs 023-024 too; the medical family drops them.
        self.assertEqual(self.group([], "A0221")["drgs"], ["094", "095", "096"])

    def test_diagnosis_with_no_medical_drg_fails(self):
        with self.assertRaises(ValueError):
            self.group([], "O0900")          # MDC 14 code that groups only to 998

    def test_bad_input_fails(self):
        with self.assertRaises(ValueError):
            self.group(["0BTC0Z"], "C3411")
        with self.assertRaises(ValueError):
            self.group(["0BTC0ZZ"], "C341")  # not billable
        with self.assertRaises(ValueError):
            self.group(["0BTC0ZZ"], "C3411", sex="X")

    def test_appendix_e_subrange_is_ranked_by_its_family(self):
        # 0YQ50ZZ's row is 350-352, a part of the Appendix D class 350-355.
        result = self.group(["0YQ50ZZ"], "K4090")
        self.assertEqual((result["drgs"], result["family"], result["basis"]),
                         (["350", "351", "352"], "Hernia Procedures", "in-mdc"))

    def test_conditional_families_need_their_condition(self):
        # A single aortic valve replacement also has rows in 212 (concomitant aortic and mitral)
        # and 216-218 (with cardiac catheterization); without those it is 219-221.
        self.assertEqual(self.group(["02RF0KZ"], "I350")["drgs"], ["219", "220", "221"])
        cath = "4A023N7"     # non-OR; rows in 212, 216-218, 233-234, 275, 286-287
        self.assertEqual(self.group(["02RF0KZ", cath], "I350")["drgs"], ["216", "217", "218"])
        # Coronary bypass: 235-236 alone, 233-234 with catheterization, 231-232 with PTCA.
        self.assertEqual(self.group(["021009W"], "I2510")["drgs"], ["235", "236"])
        self.assertEqual(self.group(["021009W", cath], "I2510")["drgs"], ["233", "234"])
        self.assertEqual(self.group(["021009W", "0270346"], "I2510")["drgs"], ["231", "232"])
        # Lumbar fusion: single level 450-451; anterior plus posterior 402; 2+ levels 447-448.
        self.assertEqual(self.group(["0SG00AJ"], "M4316")["drgs"], ["450", "451"])
        self.assertEqual(self.group(["0SG00A0", "0SG00AJ"], "M4316")["drgs"], ["402"])
        self.assertEqual(self.group(["0SG10AJ"], "M4316")["drgs"], ["447", "448"])
        # Known miss (documented in _in_mdc): aortic plus mitral is 212 in v44.
        self.assertEqual(self.group(["02RF0KZ", "02RG07Z"], "I350")["drgs"], ["216", "217", "218"])
        # Kidney transplant: 650-651 needs hemodialysis.
        self.assertEqual(self.group(["0TY00Z0"], "N186")["drgs"], ["652"])
        self.assertEqual(self.group(["0TY00Z0", "5A1D70Z"], "N186")["drgs"], ["650", "651"])

    def test_diagnosis_specific_families(self):
        # Hysterectomy: malignancy vs non-malignancy families, by principal diagnosis.
        self.assertEqual(self.group(["0UT90ZZ"], "C541")["drgs"], ["731", "732", "733"])
        self.assertEqual(self.group(["0UT90ZZ"], "D259")["drgs"], ["742", "743"])
        # Hip replacement: hip fracture family only with a hip-fracture principal diagnosis.
        self.assertEqual(self.group(["0SR9019"], "S72001A")["drgs"], ["521", "522"])
        self.assertEqual(self.group(["0SR9019"], "M1611")["drgs"], ["469", "470"])

    def test_pre_mdc(self):
        def pre(codes, dx):
            result = self.group(codes, dx)
            self.assertEqual((result["mdc"], result["basis"]), ("00", "pre-mdc"), codes)
            return result["drgs"]
        self.assertEqual(pre(["02YA0Z0"], "I5022"), ["001", "002"])           # heart transplant
        self.assertEqual(pre(["5A1522H"], "J9601"), ["003"])                  # ECMO (non-OR)
        self.assertEqual(pre(["0CTS0ZZ"], "C320"), ["011", "012", "013"])     # laryngectomy
        self.assertEqual(pre(["0FYG0Z0"], "E1065"), ["010"])                  # pancreas transplant
        self.assertEqual(pre(["0FYG0Z0", "0TY00Z0"], "E1065"), ["008"])       # with kidney
        self.assertEqual(pre(["0FYG0Z0", "0TY00Z0", "5A1D70Z"], "E1065"), ["019"])  # and hemodialysis
        # Tracheostomy: 011-013 for a face, mouth and neck diagnosis; otherwise 004, or 003
        # with a major OR procedure; MV > 96 hours overrides the diagnosis.
        self.assertEqual(pre(["0B110F4"], "C320"), ["011", "012", "013"])
        self.assertEqual(pre(["0B110F4"], "J9601"), ["004"])
        self.assertEqual(pre(["0B110F4", "0BTC0ZZ"], "C3411"), ["003"])
        self.assertEqual(pre(["0B110F4", "5A1955Z"], "C320"), ["004"])

    def test_pre_mdc_parts_alone_do_not_reach_pre_mdc(self):
        self.assertEqual(self.group(["0TY00Z0"], "N186")["basis"], "in-mdc")    # kidney alone: MDC 11
        self.assertEqual(self.group(["5A1955Z"], "J9601")["basis"], "medical")  # MV alone

    def test_every_pre_mdc_code_is_understood(self):
        # No Pre-MDC code raises (unknown row pattern, family missing from Appendix D), and
        # only the codes that need a partner fall through to the diagnosis's MDC.
        partner_only = {"ventilation", "kidney", "hemodialysis"}
        for code, rows in self.ref.proc_index.items():
            pre = [row for row in rows if row["mdc"] == sources.PRE_MDC]
            if pre:
                basis = self.group([code], "J9601")["basis"]
                self.assertEqual(basis != "pre-mdc", group_module._pre_role(code, pre) in partner_only, code)

    def test_sex_split_diagnosis(self):
        # A510 is MDC 12 for a male and MDC 13 for a female.
        self.assertEqual(self.group([], "A510", sex="F")["mdc"], "13")
        self.assertEqual(self.group([], "A510", sex="M")["mdc"], "12")
        # Unknown sex: the MDC a procedure belongs to (hysterectomy is MDC 13 only) ...
        result = self.group(["0UT90ZZ"], "A510")
        self.assertEqual((result["mdc"], result["mdc_ambiguous"]), ("13", False))
        # ... else the first, flagged.
        result = self.group([], "A510")
        self.assertEqual((result["mdc"], result["mdc_ambiguous"]), ("12", True))
        self.assertEqual(result["drgs"], ["727", "728"])

    def test_shared_tables_are_not_mutated(self):
        before = copy.deepcopy((self.ref.proc_index["0BTC0ZZ"], self.ref.dx_drgs["C3411"]))
        self.group(["0BTC0ZZ"], "C3411")["drgs"].append("999")
        self.group([], "C3411")["drgs"].append("999")
        self.assertEqual((self.ref.proc_index["0BTC0ZZ"], self.ref.dx_drgs["C3411"]), before)
        self.assertEqual(self.group(["0BTC0ZZ"], "C3411")["drgs"], ["163", "164", "165"])


if __name__ == "__main__":
    unittest.main()
