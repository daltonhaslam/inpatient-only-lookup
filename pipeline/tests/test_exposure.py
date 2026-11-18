"""The hospital-view and patient-share tables (exposure.py) and their fail-closed checks.

The first classes use small made-up tables; the last ones build from the pinned CMS files and
are skipped when data/raw/ is absent.
"""
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import fetch
import parse
from crosswalk import build, checks, exposure, exposure_checks
from crosswalk.price import NATIONAL, hospital_drg_payment

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crosswalk"
FACTS = {"deductibles": {"year": 2027, "part_a_inpatient": 1776, "part_b": 292, "source": "s", "url": "u"},
         "opps_labor_share": {"value": 0.6, "cite": "c"},
         "asc_additions_2027": {"count": 2, "also_added": ["64629"], "cite": "c"}}
RATES = {"operating": 6848.00, "capital": 539.95, "labor_share": 0.66, "operating_wi_le1": 6848.00, "labor_share_le1": 0.62}


def tables(**changes):
    t = types.SimpleNamespace(
        facts=FACTS, asc_rates={"11111": 1584.98, "22222": 10000.00, "33333": 500.00},
        copays={"11111": {"national": None, "minimum": 716.99}, "22222": {"national": None, "minimum": 2000.00},
                "33333": {"national": 150.00, "minimum": 100.00}, "64629": {"national": None, "minimum": None}},
        asc_2026={"99999": {"ci": "", "pi": "A2"}},
        asc_2027={code: {"ci": "CH", "pi": "G2"} for code in ("11111", "22222", "64629", "99999")},
        additions={"11111": "G2", "22222": "G2"})
    t.__dict__.update(changes)
    return t


REMOVED = {"11111": "2027-01-01", "22222": "2027-01-01", "33333": "2026-01-01"}


def asc_report(t, removed=REMOVED):
    report = checks.Report()
    table = exposure.asc_new_table(removed, t)
    with mock.patch.object(exposure, "source_meta", return_value={}):
        exposure_checks._asc_new(report, table, removed, t)
    return report


class Facts(unittest.TestCase):
    """pipeline/facts.json says only what its sources say (the FR quotes are checked on their
    pages by test_raw.py)."""
    facts = fetch.read_json(exposure.FACTS)
    quoted = fetch.read_json(fetch.PIPELINE / "citations.json")["citations"]

    def test_deductibles_are_in_the_fact_sheet_quotes(self):
        deductibles = self.facts["deductibles"]
        quotes = " ".join(deductibles["quotes"])
        self.assertIn("will be ${:,} in 2027".format(deductibles["part_a_inpatient"]), quotes)
        self.assertIn("will be ${:,} in 2027".format(deductibles["part_b"]), quotes)
        self.assertTrue(deductibles["url"].startswith("https://www.cms.gov/newsroom/"))

    def test_asc_additions_and_labor_share_are_quoted_from_the_rule(self):
        additions = self.facts["asc_additions_2027"]
        quotes = " ".join(self.quoted[key]["quote"] for key in additions["citations"])
        self.assertIn("adding %d procedures" % additions["count"], quotes)
        for code in additions["also_added"]:
            self.assertIn("CPT code %s" % code, quotes)
        self.assertEqual(self.quoted[additions["citations"][-1]]["cite"], additions["cite"])
        labor = self.facts["opps_labor_share"]
        self.assertIn("is %d percent" % round(labor["value"] * 100), self.quoted[labor["citation"]]["quote"])
        self.assertEqual(self.quoted[labor["citation"]]["cite"], labor["cite"])


class PatientShare(unittest.TestCase):
    def test_32480_like(self):
        self.assertEqual(exposure.patient_share("11111", tables()), {
            "asc_rate": 1584.98, "asc_share": 316.996, "opps_copay": 716.99, "opps_share": 716.99,
            "opps_capped": False, "asc_more": False})

    def test_hospital_share_is_capped_at_the_part_a_deductible(self):
        share = exposure.patient_share("22222", tables())
        self.assertEqual((share["opps_share"], share["opps_capped"]), (1776, True))
        self.assertEqual(share["asc_share"], 2000.0)
        self.assertTrue(share["asc_more"])

    def test_national_unadjusted_copayment_wins_over_the_minimum(self):
        self.assertEqual(exposure.patient_share("33333", tables())["opps_copay"], 150.00)

    def test_shares_check_recomputes_and_fails_on_a_changed_share(self):
        t = tables(opps={})
        doc = {"codes": {"11111": {"difference": {}}, "33333": {"difference": {}}, "44444": {"difference": None}}}
        with mock.patch.object(exposure, "source_meta", return_value={}):
            table = exposure.shares_table(doc, t)
        self.assertEqual(sorted(table["codes"]), ["11111", "22222", "33333"])
        report = checks.Report()
        exposure_checks._shares(report, doc, table, t)
        self.assertEqual(report.failures, 0, report.lines)
        table["codes"]["11111"] = dict(table["codes"]["11111"], opps_share=717.0)
        report = checks.Report()
        exposure_checks._shares(report, doc, table, t)
        self.assertIn("11111: shares do not recompute", "\n".join(report.lines))

    def test_no_rate_and_no_copay_give_none_not_zero(self):
        self.assertEqual(exposure.patient_share("64629", tables()), {
            "asc_rate": None, "asc_share": None, "opps_copay": None, "opps_share": None,
            "opps_capped": None, "asc_more": None})


class AscAdditionsCheck(unittest.TestCase):
    def test_the_stated_count_passes(self):
        self.assertEqual(asc_report(tables()).failures, 0)

    def test_64629_on_top_passes(self):
        report = asc_report(tables(additions={"11111": "G2", "22222": "G2", "64629": "N1"}))
        self.assertEqual(report.failures, 0, report.lines)
        self.assertIn("+ 64629", report.lines[0])

    def test_any_other_extra_code_fails(self):
        report = asc_report(tables(additions={"11111": "G2", "22222": "G2", "99999": "A2"}))
        self.assertEqual(report.failures, 1)

    def test_a_short_count_fails(self):
        report = asc_report(tables(additions={"11111": "G2"}))
        self.assertEqual(report.failures, 1)
        self.assertIn("1 IPO removals on the list, the rule states 2", "\n".join(report.lines))

    def test_a_code_already_on_the_2026_list_fails(self):
        report = asc_report(tables(asc_2026={"22222": {"ci": "", "pi": "G2"}}))
        self.assertIn("22222: already on the CY 2026 Addendum AA", "\n".join(report.lines))

    def test_a_new_hcpcs_code_fails(self):
        aa = {code: {"ci": "NI" if code == "22222" else "CH", "pi": "G2"} for code in ("11111", "22222")}
        report = asc_report(tables(asc_2027=aa))
        self.assertIn("22222: a new HCPCS code (comment indicator NI)", "\n".join(report.lines))


class NationalMode(unittest.TestCase):
    def doc(self, amount):
        family = {"drgs": [{"drg": "165", "weight": 1.9294, "amount": amount}]}
        return {"meta": {"rates": RATES}, "codes": {"32480": {"inpatient": {"families": [family]}}}}

    def test_national_formula_reproduces_the_amount(self):
        report = checks.Report()
        exposure_checks._national(report, self.doc(14254.31))
        self.assertEqual(report.failures, 0)

    def test_a_cent_of_drift_fails(self):
        report = checks.Report()
        exposure_checks._national(report, self.doc(14254.32))
        self.assertEqual(report.failures, 1)

    def test_a_hospital_with_no_ime_or_dsh_has_zero_add_ons(self):
        paid = hospital_drg_payment(1.9294, dict(NATIONAL, wi=1.1907, gaf=1.12), RATES)
        self.assertEqual((paid["ime"], paid["dsh"], paid["addons"]), (0.0, 0.0, 0.0))


class HospitalsCheck(unittest.TestCase):
    ROW = {"name": "A", "state": "OR", "wi": 1.0, "gaf": 1.0, "tchop": 0.1, "tchcp": 0.0, "dshopp": 0.0, "dshcpp": 0.0,
           "caseta44": 10.0, "ime_caseta44": None, "type": 0}

    def check(self, impact, table=None):
        t = types.SimpleNamespace(impact=impact, facts=FACTS)
        with mock.patch.object(exposure, "source_meta", return_value={}):
            table = table or exposure.hospitals_table(t)
        report = checks.Report()
        with mock.patch.object(exposure_checks, "HOSPITALS", (1, 2)), mock.patch.object(exposure_checks, "TEACHING_IN_FILE", 2):
            exposure_checks._hospitals(report, table, t)
        return report, table

    def test_maryland_is_named_but_not_offered(self):
        impact = {"380009": self.ROW, "210001": dict(self.ROW, state="MD")}
        report, table = self.check(impact)
        self.assertEqual(report.failures, 0, report.lines)
        self.assertEqual(list(table["hospitals"]), ["380009"])
        self.assertEqual(table["maryland"], {"210001": {"name": "A", "state": "MD"}})
        self.assertEqual(table["meta"]["counts"], {"offered": 1, "teaching": 1, "in_file": 2, "teaching_in_file": 2, "maryland": 1})

    def test_a_maryland_hospital_offered_fails(self):
        impact = {"380009": self.ROW, "210001": dict(self.ROW, state="MD")}
        _, table = self.check(impact)
        table["hospitals"]["210001"] = table["maryland"].pop("210001")
        report, _ = self.check(impact, table)
        self.assertIn("210001: Maryland hospital offered", "\n".join(report.lines))

    def test_out_of_range_count_fails(self):
        impact = {"%06d" % n: self.ROW for n in range(380001, 380004)}
        report, _ = self.check(impact)
        self.assertIn("3 hospitals offered, expected 1-2", "\n".join(report.lines))


class Volume(unittest.TestCase):
    def test_only_crosswalk_drgs_for_offered_hospitals_and_the_rest_listed_as_dropped(self):
        doc = {"codes": {"32480": {"inpatient": {"families": [{"drgs": [{"drg": "163"}, {"drg": "165"}]}]}}}}
        t = types.SimpleNamespace(volume={"380009": {"163": 15, "165": 11, "470": 99}, "210001": {"163": 12},
                                          "999999": {"470": 50}, "010120": {"165": 20}})
        with mock.patch.object(exposure, "source_meta", return_value={}):
            table = exposure.volume_table(doc, t, {"380009": {}})
        self.assertEqual(table["volume"], {"380009": {"163": 15, "165": 11}})
        self.assertEqual(table["meta"]["dropped"], {"010120": "not in the FY 2027 impact file",
                                                    "210001": "Maryland (all-payer model)"})
        self.assertEqual(table["meta"]["drgs"], ["163", "165"])


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class FixtureBuildTables(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        args = ["--passes", str(FIXTURE / "passes"), "--adjudications", str(FIXTURE / "adjudications.json"),
                "--out", str(cls.out), "--checks", str(cls.out / "checks.txt"), "--allow-missing"]
        with mock.patch("sys.stdout"):
            cls.status = build.main(args)
        cls.checks_text = (cls.out / "checks.txt").read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def read(self, name):
        return json.loads((self.out / name).read_text())

    def test_tables_written_and_checks_pass(self):
        self.assertEqual(self.status, 0, self.checks_text)
        for line in ("ok hospitals from the impact file: 3032 offered", "ok OHSU fixture:",
                     "ok national mode reproduces every DRG amount:", "ok CY 2027 ASC additions reconcile to the rule: 619 codes",
                     "ok hospital states:", "ok 2024 DRG volume:", "ok patient shares recompute:",
                     "ok no CPT descriptor text in the hospital and patient-share tables:"):
            self.assertIn(line, self.checks_text)

    def test_every_table_named_in_tables_is_written(self):
        self.assertTrue(all((self.out / name).is_file() for name in exposure.TABLES))

    def test_ohsu_row(self):
        self.assertEqual(self.read("hospitals.json")["hospitals"]["380009"]["tchop"], 0.31139)
        self.assertEqual({drg: self.read("drg-volume.json")["volume"]["380009"][drg] for drg in ("163", "164", "165")},
                         {"163": 15, "164": 34, "165": 11})

    def test_32480_shares(self):
        share = self.read("patient-shares.json")["codes"]["32480"]
        self.assertEqual((round(share["asc_share"]), round(share["opps_share"])), (317, 717))
        self.assertEqual(self.read("patient-shares.json")["meta"]["deductibles"]["part_b"], 292)

    def test_asc_additions(self):
        table = self.read("asc-new-2027.json")
        self.assertEqual((table["meta"]["count"], table["meta"]["ipo_removed_2027"], table["meta"]["also_added"]),
                         (619, 618, ["64629"]))


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class TablesFailClosed(unittest.TestCase):
    def test_a_corrupted_hospital_factor_fails_and_writes_nothing(self):
        assemble = exposure.assemble

        def corrupted(*args, **kwargs):
            tables = assemble(*args, **kwargs)
            ohsu = tables["hospitals.json"]["hospitals"]["380009"]
            tables["hospitals.json"]["hospitals"]["380009"] = dict(ohsu, tchop=ohsu["tchop"] + 0.001)
            return tables

        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / "hospitals.json"
            previous.write_text('{"previous": true}\n')
            args = ["--passes", str(FIXTURE / "passes"), "--adjudications", str(FIXTURE / "adjudications.json"),
                    "--out", tmp, "--checks", str(Path(tmp) / "checks.txt"), "--allow-missing"]
            with mock.patch.object(exposure, "assemble", corrupted), mock.patch("sys.stdout"):
                self.assertEqual(build.main(args), 1)
            self.assertEqual(previous.read_text(), '{"previous": true}\n')
            self.assertFalse((Path(tmp) / "crosswalk.json").exists())
            self.assertFalse((Path(tmp) / "patient-shares.json").exists())
            text = (Path(tmp) / "checks.txt").read_text()
            self.assertIn("FAIL OHSU fixture:", text)

    def test_a_changed_file_layout_fails_with_a_report_and_writes_nothing(self):
        def broken():
            raise parse.ParseError("impact file: no header with columns")

        with tempfile.TemporaryDirectory() as tmp:
            checks_file = Path(tmp) / "checks.txt"
            checks_file.write_text("All checks passed.\n")
            args = ["--passes", str(FIXTURE / "passes"), "--adjudications", str(FIXTURE / "adjudications.json"),
                    "--out", tmp, "--checks", str(checks_file), "--allow-missing"]
            with mock.patch.object(exposure, "load_tables", broken), mock.patch("sys.stdout"):
                self.assertEqual(build.main(args), 1)
            text = checks_file.read_text()
            self.assertIn("FAIL hospital and patient-share sources read:", text)
            self.assertIn("impact file: no header with columns", text)
            self.assertFalse((Path(tmp) / "crosswalk.json").exists())
            self.assertFalse(any((Path(tmp) / name).exists() for name in exposure.TABLES))


if __name__ == "__main__":
    unittest.main()
