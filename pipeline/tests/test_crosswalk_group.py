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

    def test_a_failing_derived_table_shows_its_cause(self):
        with self.assertRaisesRegex(RuntimeError, "Ref.rank failed: .*items"):
            Ref(hierarchy=None).rank

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
        # 212 needs aortic + mitral + a concomitant procedure; 216-218 needs a catheterization.
        self.assertEqual(self.group(["02RF0KZ", "02RG07Z"], "I350")["drgs"], ["219", "220", "221"])
        self.assertEqual(self.group(["02RF0KZ", "02RG07Z", cath], "I350")["drgs"], ["212"])
        self.assertEqual(self.group(["02RF0KZ", "021009W"], "I350")["drgs"], ["219", "220", "221"])
        # Coronary bypass: 235-236 alone (also with two grafts), 233-234 with catheterization,
        # 231-232 with PTCA.
        self.assertEqual(self.group(["021009W"], "I2510")["drgs"], ["235", "236"])
        self.assertEqual(self.group(["021009W", "021109W"], "I2510")["drgs"], ["235", "236"])
        self.assertEqual(self.group(["021009W", cath], "I2510")["drgs"], ["233", "234"])
        self.assertEqual(self.group(["021009W", "0270346"], "I2510")["drgs"], ["231", "232"])
        # Lumbar fusion: single level 450-451; anterior column (qualifier J) plus posterior
        # column (qualifier 1) is 402; two codes from one column list, or a 2+ level code, 447-448.
        self.assertEqual(self.group(["0SG00AJ"], "M4316")["drgs"], ["450", "451"])
        self.assertEqual(self.group(["0SG00AJ", "0SG0071"], "M4316")["drgs"], ["402"])
        self.assertEqual(self.group(["0SG00AJ", "0SG30AJ"], "M4316")["drgs"], ["447", "448"])
        self.assertEqual(self.group(["0SG10AJ"], "M4316")["drgs"], ["447", "448"])
        # Bilateral hip replacement: two codes of the same kind do pair outside MDC 05, from
        # two different sites (test_bilateral_joints_need_two_sites).
        self.assertEqual(self.group(["0SR9019", "0SRB019"], "M1611")["drgs"], ["461", "462"])
        # Bile duct exploration: 411-413 only with a cholecystectomy, else 408-410.
        self.assertEqual(self.group(["0FC90ZZ"], "K8050")["drgs"], ["408", "409", "410"])
        self.assertEqual(self.group(["0FT40ZZ", "0FC90ZZ"], "K8000")["drgs"], ["411", "412", "413"])
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

    def test_hip_and_knee_revisions(self):
        # v44 has no 466-468. Revision root (0SW) is 449. A removal (0SP) is listed under
        # 403-404 (with a periprosthetic joint infection principal diagnosis) and 463-465, both
        # above 469-470, and no class lists removal "and" replacement except 461-462 (as one
        # site): so a removal plus replacement of one joint goes where the removal does.
        def drgs(codes, dx):
            for code in codes:
                self.assertIn(code, self.ref.pcs)
            self.assertIn(dx, self.ref.cm)
            return self.group(codes, dx)["drgs"]
        wound = ["463", "464", "465"]
        # Knee revision for mechanical loosening: removal + replacement, right knee.
        self.assertEqual(drgs(["0SPC0JZ", "0SRC0J9"], "T84032A"), wound)
        # Hip revision for dislocation of the prosthesis: removal + replacement, left hip.
        self.assertEqual(drgs(["0SPB0JZ", "0SRB0J9"], "T84021A"), wound)
        # Infected knee prosthesis: removal with spacer insertion, or removal + replacement.
        self.assertEqual(drgs(["0SPC0JZ", "0SHC08Z"], "T8453XA"), ["403", "404"])
        self.assertEqual(drgs(["0SPC0JZ", "0SRC0J9"], "T8453XA"), ["403", "404"])
        # Removal alone; revision root; replacement alone of a previously replaced joint.
        self.assertEqual(drgs(["0SPC0JZ"], "T84032A"), wound)
        self.assertEqual(drgs(["0SWC0JZ"], "T84032A"), ["449"])
        self.assertEqual(drgs(["0SRC0J9"], "T84032A"), ["469", "470"])
        # Primary total knee stays 469-470.
        result = self.group(["0SRD0J9"], "M1711")
        self.assertIn("M1711", self.ref.cm)
        self.assertEqual((result["mdc"], result["drgs"], result["basis"]), ("08", ["469", "470"], "in-mdc"))
        # Conversion to total hip with removal of femoral hardware: 498-499 ranks above 469-470.
        self.assertEqual(drgs(["0SR90J9", "0QP604Z"], "M1611"), ["498", "499"])

    def test_bilateral_joints_need_two_sites(self):
        # 461-462 needs codes from two of its sites (right hip, left knee ...); acetabular and
        # femoral surfaces of one hip, or femoral and tibial of one knee, are one site.
        self.assertEqual(self.group(["0SRA0J9", "0SRR0J9"], "M1611")["drgs"], ["469", "470"])
        self.assertEqual(self.group(["0SRT0J9", "0SRV0J9"], "M1711")["drgs"], ["469", "470"])
        self.assertEqual(self.group(["0SRC0J9", "0SRD0J9"], "M1711")["drgs"], ["461", "462"])
        # A revision on one side (cluster 0SPC0JZ+0SRC0J9, a right knee site) with a left knee
        # replacement is two sites: the cluster's 461-462 row replaces the removal's 463-465.
        self.assertEqual(self.group(["0SPC0JZ", "0SRC0J9", "0SRD0J9"], "M1711")["drgs"], ["461", "462"])
        # Bilateral knee revision: 461-462, also with a periprosthetic infection diagnosis (an
        # open ambiguity: v44 does not say whether 403-404 would win; see the module docstring).
        bilateral = ["0SPC0JZ", "0SRC0J9", "0SPD0JZ", "0SRD0J9"]
        self.assertEqual(self.group(bilateral, "M1711")["drgs"], ["461", "462"])
        self.assertEqual(self.group(bilateral, "T8453XA")["drgs"], ["461", "462"])

    def test_joint_site_pairs_are_the_bilateral_clusters(self):
        pairs = {frozenset(entry) for entries in self.ref.joint_sites.values() for entry in entries
                 if len(entry) > 1}
        clusters = {frozenset(code for group in cluster["groups"] for code in group)
                    for cluster in self.ref.clusters if any(row["drgs"][0] == "461" for row in cluster["rows"])}
        self.assertEqual(pairs, clusters)
        self.assertEqual(len(pairs), 1528)

    def test_procedure_clusters(self):
        # A cluster with a row here whose condition holds is grouped in place of its codes.
        def drgs(codes, dx):
            for code in codes:
                self.assertIn(code, self.ref.pcs)
            self.assertIn(dx, self.ref.cm)
            return self.group(codes, dx)["drgs"]
        # Mastectomy with axillary node resection: 582-583, not the node resection's 579-581.
        self.assertEqual(drgs(["07T50ZZ"], "C50911"), ["579", "580", "581"])
        self.assertEqual(drgs(["07T50ZZ", "0HTT0ZZ"], "C50911"), ["582", "583"])
        # Resection of uterus, cervix and supporting structures: radical hysterectomy 734-735,
        # for malignancy too (the uterus code's 731-733 row gives way).
        self.assertEqual(drgs(["0UT40ZZ", "0UT90ZZ", "0UTC0ZZ"], "D259"), ["734", "735"])
        self.assertEqual(drgs(["0UT40ZZ", "0UT90ZZ", "0UTC0ZZ"], "C539"), ["734", "735"])
        # Repair of small intestine with stoma repair: minor bowel 344-346, not 329-331.
        self.assertEqual(drgs(["0DQ80ZZ"], "K5730"), ["329", "330", "331"])
        self.assertEqual(drgs(["0DQ80ZZ", "0WQFXZ2"], "K5730"), ["344", "345", "346"])
        # Bladder repair with stoma repair: minor bladder 662-664, not major bladder 653-655.
        self.assertEqual(drgs(["0TQB0ZZ"], "N320"), ["653", "654", "655"])
        self.assertEqual(drgs(["0TQB0ZZ", "0WQFXZ2"], "N320"), ["662", "663", "664"])
        self.assertEqual(drgs(["0TQB0ZZ", "0WQFXZZ"], "N320"), ["662", "663", "664"])
        self.assertEqual(self.group(["0UT90ZZ", "0UTC0ZZ"], "D259")["drgs"], ["742", "743"])
        # Pre-MDC: insertion of a short-term heart assist system with removal of one is 001-002.
        self.assertEqual(self.group(["02HA0RS"], "I5022")["drgs"], ["215"])
        result = self.group(["02HA0RS", "02PA0RZ"], "I5022")
        self.assertEqual((result["drgs"], result["basis"]), (["001", "002"], "pre-mdc"))
        # MDC 10 lists knee liner removal and replacement under 628-630; neither code alone.
        self.assertEqual(self.group(["0SRC0J9"], "E6601")["basis"], "unrelated-extensive")
        self.assertEqual(self.group(["0SPC09Z", "0SRC0J9"], "E6601")["drgs"], ["628", "629", "630"])

    def test_non_or_combinations(self):
        # Appendix E Part 3: a bile duct stent exchange is non-OR, though the insertion is OR.
        self.assertEqual(self.group(["0FHB7DZ"], "K8050")["drgs"], ["408", "409", "410"])
        result = self.group(["0FHB7DZ", "0FPB7DZ"], "K8050")
        self.assertEqual((result["basis"], result["or_codes"]), ("medical", []))

    def test_any_or_procedure_families(self):
        # v44 DRGs defined as a principal diagnosis plus ANY O.R. procedure (no Appendix E rows).
        def family(codes, dx):
            result = self.group(codes, dx)
            self.assertEqual(result["basis"], "in-mdc", (codes, dx))
            return result["drgs"]
        antepartum = ["817", "818", "819"]
        self.assertEqual(family(["0UT50ZZ"], "O00101"), antepartum)    # salpingectomy, ectopic
        self.assertEqual(family(["10T20ZZ"], "O00101"), antepartum)    # ectopic resection
        self.assertEqual(family(["0UVC0ZZ"], "O3431"), antepartum)     # cerclage
        self.assertEqual(family(["0DTJ4ZZ"], "O99611"), antepartum)    # appendectomy in pregnancy
        self.assertEqual(family(["0DTJ4ZZ"], "O080"), ["769"])          # post-abortion diagnosis
        self.assertEqual(family(["0WJG0ZZ"], "A419"), ["853", "854", "855"])
        self.assertEqual(family(["0W9G0ZZ"], "T8143XA"), ["856", "857", "858"])   # non-extensive too
        self.assertEqual(family(["0DTJ4ZZ"], "F329"), ["876"])
        self.assertEqual(family(["0DTJ4ZZ"], "B20"), ["969", "970"])

    def test_any_or_families_have_no_appendix_e_rows(self):
        named = {drg for rows in self.ref.proc_index.values() for row in rows for drg in row["drgs"]}
        for mdc, families in group_module._ANY_OR.items():
            for drgs, _ in families:
                self.assertIn(tuple(drgs), self.ref.hierarchy[mdc])
                self.assertFalse(named & set(drgs), drgs)

    def test_delivery_families_need_a_delivery(self):
        self.assertEqual(self.group(["10D00Z1", "0UT70ZZ"], "O80")["drgs"], ["783", "784", "785"])
        self.assertEqual(self.group(["10E0XZZ", "0UT70ZZ"], "O80")["drgs"], ["796", "797", "798"])
        self.assertEqual(self.group(["10D00Z1"], "O80")["drgs"], ["786", "787", "788"])

    def test_medical_drops_drgs_the_case_cannot_show(self):
        self.assertEqual(self.group([], "A419")["drgs"], ["871", "872"])          # 870 needs MV > 96 hours
        self.assertEqual(self.group(["5A1955Z"], "A419")["drgs"], ["870", "871", "872"])
        self.assertEqual(self.group([], "I214")["drgs"], ["280", "281", "282"])   # 283-285: expired

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
