"""Assembling crosswalk.json and its fail-closed checks, on a small fixture of mappings.

The fixture (fixtures/crosswalk/) maps 32480, 44150 and 48150 in both passes, adjudicates 48150
(the passes disagree on its diagnoses) and lists one packaged code (11008, SI N). The other
mappable codes have no mapping yet, so the builds here pass --allow-missing.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fetch
from crosswalk import build, checks

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crosswalk"


def run_build(out, *extra):
    args = ["--passes", str(FIXTURE / "passes"), "--adjudications", str(FIXTURE / "adjudications.json"),
            "--out", str(out), "--checks", str(Path(out) / "checks.txt")] + list(extra)
    with mock.patch("sys.stdout"):
        return build.main(args)


class DescriptorRule(unittest.TestCase):
    def test_equal_or_five_consecutive_words(self):
        grams = checks.descriptor_grams(["Remove lung lobe w/anast thing", "Short one two", "Breast reconstruction"])
        self.assertTrue(checks.copies_descriptor("we did a remove lung lobe w anast here", grams))
        self.assertTrue(checks.copies_descriptor("SHORT ONE, two", grams))
        self.assertFalse(checks.copies_descriptor("remove lung lobe w", grams))
        self.assertFalse(checks.copies_descriptor("short one two more", grams))
        # A two-word descriptor is a generic term: equal to it is not a copy.
        self.assertFalse(checks.copies_descriptor("Breast reconstruction", grams))


class Differences(unittest.TestCase):
    def test_outpatient_minus_inpatient(self):
        self.assertEqual(build.difference(3584.95, {"low": 14254.31, "high": 33165.99}),
                         {"low": round(3584.95 - 33165.99, 2), "high": round(3584.95 - 14254.31, 2)})
        self.assertIsNone(build.difference(None, {"low": 1, "high": 2}))
        self.assertIsNone(build.difference(10.0, None))

    def test_review_batches_are_chunks_of_ten_within_a_group(self):
        labels = {"%05d" % n: {"group": "heart" if n < 23 else "brain"} for n in range(30)}
        batches = build.review_batches(sorted(labels), labels)
        self.assertEqual([(b["id"], len(b["codes"])) for b in batches],
                         [("brain-1", 7), ("heart-1", 10), ("heart-2", 10), ("heart-3", 3)])
        self.assertEqual(batches[1]["codes"][0], "00000")


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class InpatientFamilies(unittest.TestCase):
    def test_sets_with_different_families_under_one_diagnosis_are_labeled_by_note(self):
        rec = {"pcs_sets": [{"codes": ["0BTC0ZZ"], "note": "lobectomy"}, {"codes": ["0BTD0ZZ"], "note": "middle lobe"},
                            {"codes": ["0YQ50ZZ"], "note": "hernia repair"}],
               "principal_dx": [{"code": "C3411", "condition": "lung cancer", "role": "typical"}]}
        result = build.inpatient(rec, build.Ref.load())
        self.assertEqual([(f["condition"], f["basis"]) for f in result["families"]],
                         [("lung cancer: lobectomy; middle lobe", "in-mdc"),
                          ("lung cancer: hernia repair", "unrelated-nonextensive")])
        self.assertEqual(result["low"], min(f["low"] for f in result["families"]))


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class FixtureBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        cls.status = run_build(cls.out, "--allow-missing")
        cls.checks_text = (cls.out / "checks.txt").read_text()
        cls.doc = json.loads((cls.out / "crosswalk.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_build_passes_its_checks(self):
        self.assertEqual(self.status, 0, self.checks_text)
        self.assertNotIn("\nFAIL ", "\n" + self.checks_text)
        self.assertIn("skip final mapping for every mappable code:", self.checks_text)

    def test_every_removed_code_is_present(self):
        meta = self.doc["meta"]
        self.assertEqual(len(self.doc["codes"]), 922)
        self.assertEqual((meta["counts"]["removed_2026"], meta["counts"]["removed_2027"]), (285, 637))
        self.assertEqual(meta["years"], {"outpatient": "CY 2027", "inpatient": "FY 2027"})
        self.assertEqual(meta["counts"]["mapped"], 3)

    def test_rates_and_sources_are_cited(self):
        meta = self.doc["meta"]
        self.assertEqual((meta["rates"]["operating"], meta["rates"]["capital"]), (6848.0, 539.95))
        self.assertIn("CN", meta["rates"]["operating_table"])
        self.assertIn("correction notice", meta["rates"]["version"])
        for source_id in ("addenda-2027", "asc-2027-aa", "ipps-2027-table5", "ipps-2027-table1", "msdrg-v44", "pcs-2027", "cm-2027"):
            entry = meta["sources"][source_id]
            self.assertTrue(entry["label"] and entry["landing"].startswith("https://www.cms.gov/") and entry["file"], source_id)
        self.assertIn("CMS-1849-CN Table 5.txt", meta["sources"]["ipps-2027-table5"]["file"])

    def test_lobectomy(self):
        code = self.doc["codes"]["32480"]
        self.assertEqual(code["removed"], "2027-01-01")
        self.assertEqual(code["outpatient"]["apc"], "5183")
        self.assertEqual((code["outpatient"]["si"], code["outpatient"]["rate"], code["outpatient"]["asc"]), ("J1", 3584.95, 1584.98))
        self.assertEqual(code["outpatient"]["proposed"], {"si": "J1", "apc": "5182", "rate": 1777.99})
        self.assertFalse(code["outpatient"]["packaged"])
        families = code["inpatient"]["families"]
        self.assertEqual(len(families), 1)
        family = families[0]
        self.assertEqual((family["condition"], family["dx"]["code"], family["mdc"], family["basis"]),
                         ("lung cancer", "C3411", "04", "in-mdc"))
        self.assertEqual([row["drg"] for row in family["drgs"]], ["163", "164", "165"])
        self.assertEqual(family["drgs"][2]["amount"], 14254.31)
        self.assertEqual((code["inpatient"]["low"], code["inpatient"]["high"]), (14254.31, family["high"]))
        self.assertEqual(code["difference"], {"low": round(3584.95 - family["high"], 2), "high": round(3584.95 - 14254.31, 2)})
        mapping = code["mapping"]
        self.assertEqual(len(mapping["pcs_sets"]), 5)
        self.assertEqual(mapping["pcs_sets"][0]["codes"][0],
                         {"code": "0BTC0ZZ", "title": "Resection of Right Upper Lung Lobe, Open Approach"})
        self.assertRegex(mapping["fp"], r"^[0-9a-f]{8}$")
        self.assertTrue(mapping["passes_agree"])
        self.assertIsNone(mapping["adjudication"])
        self.assertEqual(code["tier"]["tier"], 1)
        self.assertEqual(code["review"]["status"], "unreviewed")
        self.assertRegex(code["batch"], r"^airway-lung-\d+$")

    def test_colectomy_is_tier_2(self):
        code = self.doc["codes"]["44150"]
        self.assertEqual(code["tier"]["tier"], 2)
        self.assertEqual([f["drgs"][0]["drg"] for f in code["inpatient"]["families"]], ["329"])

    def test_whipple_shows_a_family_per_diagnosis_typical_first(self):
        code = self.doc["codes"]["48150"]
        families = code["inpatient"]["families"]
        self.assertEqual([(f["condition"], f["drgs"][0]["drg"]) for f in families],
                         [("pancreatic head cancer", "405"), ("duodenal cancer", "326")])
        self.assertEqual(code["inpatient"]["low"], min(f["low"] for f in families))
        self.assertEqual(code["inpatient"]["high"], max(f["high"] for f in families))
        self.assertFalse(code["mapping"]["passes_agree"])
        self.assertTrue(code["mapping"]["adjudication"].startswith("Fixture adjudication"))
        self.assertEqual(code["tier"]["tier"], 3)

    def test_packaged_code_has_no_comparison(self):
        code = self.doc["codes"]["11008"]
        self.assertTrue(code["outpatient"]["packaged"])
        for key in ("inpatient", "mapping", "tier", "difference", "batch"):
            self.assertIsNone(code[key], key)

    def test_unmapped_code_waits_for_its_mapping(self):
        waiting = [c for c in self.doc["codes"].values() if c["mapping"] is None and not c["outpatient"]["packaged"]]
        self.assertEqual(len(waiting), self.doc["meta"]["counts"]["mappable"] - 3)
        for code in waiting:
            self.assertIsNone(code["inpatient"])
            self.assertIsNone(code["difference"])
            self.assertIsNotNone(code["batch"])

    def test_review_batches_cover_each_mappable_code_once(self):
        batches = self.doc["meta"]["batches"]
        listed = [code for batch in batches for code in batch["codes"]]
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(len(listed), self.doc["meta"]["counts"]["mappable"])
        self.assertTrue(all(len(batch["codes"]) <= 10 for batch in batches))
        for batch in batches:
            for code in batch["codes"]:
                self.assertEqual(self.doc["codes"][code]["batch"], batch["id"])
                self.assertEqual(self.doc["codes"][code]["group"], batch["group"])

    def test_checks_report_the_known_cases_and_drg_165(self):
        text = self.checks_text
        self.assertIn("ok known cases 32480, 44150, 48150:", text)
        self.assertIn("ok DRG 165 sanity band:", text)
        self.assertIn("info DRG 165 vs the published example:", text)
        self.assertIn("14,254.31", text)
        self.assertRegex(text, r"\n(ok|skip|info) TEAM pairing")
        self.assertNotRegex(json.dumps(self.doc) + text, r"\bHirsch\b")    # (Hirschsprung is a label word)

    def test_no_descriptor_text_in_output(self):
        self.assertIn("ok no CPT descriptor text:", self.checks_text)


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class FailClosed(unittest.TestCase):
    def test_missing_mappings_fail_without_allow_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run_build(tmp), 1)
            text = (Path(tmp) / "checks.txt").read_text()
            self.assertIn("FAIL final mapping for every mappable code:", text)
            self.assertFalse((Path(tmp) / "crosswalk.json").exists())

    def test_a_corrupted_apc_rate_fails_and_leaves_the_previous_file(self):
        assemble = build.assemble

        def corrupted(*args, **kwargs):
            doc = assemble(*args, **kwargs)
            doc["codes"]["32480"]["outpatient"]["rate"] += 1.0
            return doc

        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / "crosswalk.json"
            previous.write_text('{"previous": true}\n')
            with mock.patch.object(build, "assemble", corrupted):
                self.assertEqual(run_build(tmp, "--allow-missing"), 1)
            self.assertEqual(previous.read_text(), '{"previous": true}\n')
            text = (Path(tmp) / "checks.txt").read_text()
            self.assertIn("FAIL APC rates equal Addendum B:", text)
            self.assertIn("32480", text)


if __name__ == "__main__":
    unittest.main()
