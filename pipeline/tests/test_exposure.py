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

import citations
import fetch
import parse
from crosswalk import build, checks, exposure, exposure_checks
from crosswalk.price import NATIONAL, hospital_drg_payment
from hospital_fixture import RATES

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "crosswalk"
FACTS = {"deductibles": {"year": 2027, "part_a_inpatient": 1776, "part_b": 292, "source": "s", "url": "u"},
         "opps_labor_share": {"value": 0.6, "cite": "c"},
         "asc_additions_2027": {"count": 2, "also_added": ["64629"], "cite": "c"},
         "expected": {"hospitals_offered": [1, 2], "teaching_in_file": 2,
                      "shares": {"11111": {"asc_share": 316.996, "opps_share": 716.99, "asc_more": False}}}}


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
    pages, and the deductible quotes on the pinned fact sheet, by test_raw.py)."""
    facts = fetch.read_json(exposure.FACTS)
    quoted = fetch.read_json(fetch.PIPELINE / "citations.json")["citations"]

    def test_deductibles_are_in_the_fact_sheet_quotes(self):
        deductibles = self.facts["deductibles"]
        quotes = " ".join(deductibles["quotes"])
        self.assertIn("will be ${:,} in 2027".format(deductibles["part_a_inpatient"]), quotes)
        self.assertIn("will be ${:,} in 2027".format(deductibles["part_b"]), quotes)
        self.assertTrue(deductibles["url"].startswith("https://www.cms.gov/newsroom/"))

    def test_the_deductible_check_reads_figures_and_quotes_from_the_page_text(self):
        facts = {"deductibles": dict(self.facts["deductibles"])}
        page = "<p>" + "</p><p>".join(facts["deductibles"]["quotes"]) + "</p>"
        self.assertEqual(citations.deductible_problems(page, facts), [])
        typo = {"deductibles": dict(facts["deductibles"], part_b=293)}
        self.assertEqual(citations.deductible_problems(page, typo), ["deductibles: part_b $293 is in no quote"])
        self.assertEqual(len(citations.deductible_problems("<p>CMS changed the page</p>", facts)), 2)

    def test_a_drifted_fact_sheet_is_adopted_only_while_its_quotes_verify(self):
        source = {"id": "deductibles-2027", "kind": "fact_sheet", "url": self.facts["deductibles"]["url"]}
        page = ("<nav>new menu</nav><p>" + "</p><p>".join(self.facts["deductibles"]["quotes"]) + "</p>").encode()
        adopt, message = citations.quoted_page_change(source, page)
        self.assertTrue(adopt, message)
        self.assertIn("deductible quotes still match", message)
        adopt, message = citations.quoted_page_change(source, b"<p>The 2027 deductible will be announced soon.</p>")
        self.assertFalse(adopt)
        self.assertIn("no longer match -> FAIL, needs a person", message)
        self.assertFalse(citations.quoted_page_change(dict(source, url="https://www.cms.gov/other"), page)[0])

    def test_a_missing_or_unpinned_fact_sheet_is_a_problem_not_an_error(self):
        facts = {"deductibles": dict(self.facts["deductibles"])}
        absent = {"id": "no-such-download-xyz", "kind": "fact_sheet", "url": facts["deductibles"]["url"]}
        self.assertIn("is not downloaded", citations.verify_deductibles([absent], facts)[0])
        self.assertIn("no source", citations.verify_deductibles([], facts)[0])

    def test_the_build_gate_fails_on_a_mistyped_deductible(self):
        report = checks.Report()
        exposure_checks._deductibles(report, types.SimpleNamespace(facts={"deductibles": dict(self.facts["deductibles"])}), sources=[])
        self.assertEqual(report.failures, 1)
        self.assertTrue(report.lines[0].startswith("FAIL deductibles on CMS's fact sheet"), report.lines)

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
        self.assertIn("FAIL patient-share anchors", "\n".join(report.lines))

    def test_a_formula_error_fails_the_hand_checked_anchors(self):
        t = tables(opps={})
        doc = {"codes": {"11111": {"difference": {}}}}
        with mock.patch.object(exposure, "source_meta", return_value={}), \
                mock.patch.object(exposure, "COINSURANCE", 0.25):
            table = exposure.shares_table(doc, t)
            report = checks.Report()
            exposure_checks._shares(report, doc, table, t)
        lines = "\n".join(report.lines)
        self.assertIn("ok patient shares recompute", lines)      # the producer agrees with itself
        self.assertIn("FAIL patient-share anchors", lines)

    def test_a_missing_code_is_reported_not_raised(self):
        t = tables(opps={})
        doc = {"codes": {"11111": {"difference": {}}, "33333": {"difference": {}}}}
        with mock.patch.object(exposure, "source_meta", return_value={}):
            table = exposure.shares_table(doc, t)
        del table["codes"]["33333"]
        report = checks.Report()
        exposure_checks._shares(report, doc, table, t)
        self.assertIn("33333: missing from the table", "\n".join(report.lines))


class RunAll(unittest.TestCase):
    def test_any_error_while_checking_is_a_fail_line_and_no_tables(self):
        def broken(*args):
            raise KeyError("expected")

        report = checks.Report()
        with mock.patch.object(exposure, "load_tables", return_value=None), \
                mock.patch.object(exposure, "assemble", return_value={"hospitals.json": {}}), \
                mock.patch.object(exposure_checks, "run", broken):
            self.assertEqual(exposure_checks.run_all(report, {}, {}), {})
        self.assertEqual(report.failures, 1)
        self.assertIn("FAIL hospital and patient-share tables check:", report.lines[0])
        self.assertIn("KeyError: 'expected'", "\n".join(report.lines))

    def test_no_rate_and_no_copay_give_none_not_zero(self):
        self.assertEqual(exposure.patient_share("64629", tables()), {
            "asc_rate": None, "asc_share": None, "opps_copay": None, "opps_share": None,
            "opps_capped": None, "asc_more": None})


class AscAdditionsCheck(unittest.TestCase):
    def test_the_stated_count_plus_64629_passes(self):
        report = asc_report(tables(additions={"11111": "G2", "22222": "G2", "64629": "N1"}))
        self.assertEqual(report.failures, 0, report.lines)
        self.assertIn("+ 64629", report.lines[0])

    def test_a_list_without_64629_fails(self):
        report = asc_report(tables())
        self.assertEqual(report.failures, 1)
        self.assertIn("beyond the IPO removals are none; the rule adds exactly 64629", "\n".join(report.lines))

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


class DrgWeights(unittest.TestCase):
    @staticmethod
    def doc(*weights):
        families = [{"drgs": [{"drg": "165", "weight": w, "amount": 0}]} for w in weights]
        return {"codes": {"3248%d" % i: {"inpatient": {"families": [family]}} for i, family in enumerate(families)}}

    def check(self, doc, weights):
        report = checks.Report()
        exposure_checks._weights(report, doc, {"meta": {"drg_weights": weights}})
        return report

    def test_table5_weights_for_the_crosswalk_drgs(self):
        t = types.SimpleNamespace(table5={"165": {"weight": 1.9294}, "166": {"weight": 2.0}})
        self.assertEqual(exposure.drg_weights(self.doc(1.9294), t), {"165": 1.9294})
        self.assertEqual(self.check(self.doc(1.9294), {"165": 1.9294}).failures, 0)

    def test_a_drg_with_two_weights_fails(self):
        self.assertEqual(self.check(self.doc(1.9294, 1.93), {"165": 1.9294}).failures, 1)

    def test_a_missing_or_extra_drg_fails(self):
        self.assertEqual(self.check(self.doc(1.9294), {}).failures, 1)
        self.assertEqual(self.check(self.doc(1.9294), {"165": 1.9294, "166": 2.0}).failures, 1)


class HospitalRates(unittest.TestCase):
    DOC = {"meta": {"rates": dict(RATES, combined=7387.95, version="v")}}

    def check(self, shipped):
        report = checks.Report()
        exposure_checks._rates(report, self.DOC, {"meta": {"rates": shipped}})
        return report

    def test_the_five_rates_the_formula_reads_pass(self):
        self.assertEqual(sorted(exposure.HOSPITAL_RATES), sorted(RATES))
        self.assertEqual(self.check(dict(RATES)).failures, 0)

    def test_a_changed_missing_or_extra_rate_fails(self):
        self.assertEqual(self.check(dict(RATES, capital=540.0)).failures, 1)
        self.assertEqual(self.check({k: v for k, v in RATES.items() if k != "labor_share"}).failures, 1)
        self.assertEqual(self.check(dict(RATES, combined=7387.95)).failures, 1)


class HospitalsCheck(unittest.TestCase):
    ROW = {"name": "A", "state": "OR", "wi": 1.0, "gaf": 1.0, "tchop": 0.1, "tchcp": 0.0, "dshopp": 0.0, "dshcpp": 0.0,
           "caseta44": 10.0, "ime_caseta44": None, "type": 0}

    def check(self, impact, table=None):
        t = types.SimpleNamespace(impact=impact, facts=FACTS)
        with mock.patch.object(exposure, "source_meta", return_value={}):
            table = table or exposure.hospitals_table(t)
        report = checks.Report()
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
                     "ok national mode reproduces every DRG amount:", "ok DRG weights for the hospital view:",
                     "ok IPPS rates for the hospital view:",
                     "ok CY 2027 ASC additions reconcile to the rule: 619 codes",
                     "ok hospital states:", "ok 2024 DRG volume:", "ok patient shares recompute:",
                     "ok no CPT descriptor text in the hospital and patient-share tables:"):
            self.assertIn(line, self.checks_text)

    def test_every_table_named_in_tables_is_written(self):
        self.assertTrue(all((self.out / name).is_file() for name in exposure.TABLES))

    def test_ohsu_row(self):
        self.assertEqual(self.read(exposure.HOSPITALS)["hospitals"]["380009"]["tchop"], 0.31139)
        self.assertEqual({drg: self.read(exposure.VOLUME)["volume"]["380009"][drg] for drg in ("163", "164", "165")},
                         {"163": 15, "164": 34, "165": 11})

    def test_32480_shares(self):
        share = self.read(exposure.SHARES)["codes"]["32480"]
        self.assertEqual((round(share["asc_share"]), round(share["opps_share"])), (317, 717))
        self.assertEqual(self.read(exposure.SHARES)["meta"]["deductibles"]["part_b"], 292)

    def test_asc_additions(self):
        table = self.read(exposure.ASC_NEW)
        self.assertEqual((table["meta"]["count"], table["meta"]["ipo_removed_2027"], table["meta"]["also_added"]),
                         (619, 618, ["64629"]))


class Gates(unittest.TestCase):
    """build.gated_write: crosswalk.json has its own gate; the derived tables and the workbook have theirs."""
    DOC = {"codes": {"11111": {}}}

    def write(self, out, crosswalk_failures=0, table_failures=0, allow_missing=False):
        report = checks.Report()
        for n in range(crosswalk_failures):
            report.check("crosswalk check %d" % n, ["broken"], "")
        calls = []

        def run_all(rep, doc, removed):
            calls.append(doc)
            for n in range(table_failures):
                rep.check("table check %d" % n, ["broken"], "")
            return {name: {"new": True} for name in exposure.TABLES}

        with mock.patch.object(exposure_checks, "run_all", run_all), \
                mock.patch.object(build.workbook, "write") as sheet:
            lines = build.gated_write(report, self.DOC, types.SimpleNamespace(removed={}), Path(out), allow_missing)
        return report, lines, calls, sheet

    def previous(self, out):
        for name in ("crosswalk.json", "crosswalk.xlsx") + exposure.TABLES:
            (Path(out) / name).write_text("previous\n")

    def test_crosswalk_fails_nothing_written_and_the_tables_not_built(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.previous(tmp)
            report, lines, calls, sheet = self.write(tmp, crosswalk_failures=1)
            self.assertEqual(calls, [], "the hospital and patient-share work must not run")
            sheet.assert_not_called()
            for name in ("crosswalk.json", "crosswalk.xlsx") + exposure.TABLES:
                self.assertEqual((Path(tmp) / name).read_text(), "previous\n", name)
            self.assertIn("skip hospital and patient-share tables: not checked: the crosswalk failed", "\n".join(report.lines))
            self.assertEqual(lines, ["1 crosswalk check(s) failed. crosswalk.json, crosswalk.xlsx and %s were left as they were."
                                     % ", ".join(exposure.TABLES)])

    def test_tables_fail_crosswalk_still_written_tables_untouched_workbook_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.previous(tmp)
            report, lines, calls, sheet = self.write(tmp, table_failures=2)
            self.assertEqual(json.loads((Path(tmp) / "crosswalk.json").read_text()), self.DOC)
            for name in exposure.TABLES:
                self.assertEqual((Path(tmp) / name).read_text(), "previous\n", name)
            sheet.assert_not_called()
            self.assertFalse((Path(tmp) / "crosswalk.xlsx").exists(), "a workbook that disagrees with crosswalk.json")
            self.assertEqual(report.failures, 2)
            self.assertEqual(lines[0], "Crosswalk checks passed. Wrote crosswalk.json (1 codes).")
            self.assertEqual(lines[1], "2 hospital and patient-share check(s) failed. %s were left as they were." % ", ".join(exposure.TABLES))
            self.assertIn("crosswalk.xlsx was not built: it needs those tables. The previous one was removed", lines[2])

    def test_tables_fail_under_allow_missing_the_workbook_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.previous(tmp)
            _, lines, _, sheet = self.write(tmp, table_failures=1, allow_missing=True)
            sheet.assert_not_called()
            self.assertEqual((Path(tmp) / "crosswalk.xlsx").read_text(), "previous\n")
            self.assertEqual(len(lines), 2)

    def test_both_pass_everything_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.previous(tmp)
            report, lines, _, sheet = self.write(tmp)
            self.assertEqual(report.failures, 0)
            for name in exposure.TABLES:
                self.assertEqual(json.loads((Path(tmp) / name).read_text()), {"new": True}, name)
            sheet.assert_called_once()
            self.assertEqual(lines[1:], ["Hospital and patient-share checks passed. Wrote %s." % ", ".join(exposure.TABLES),
                                         "Wrote crosswalk.xlsx."])


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class TablesFailClosed(unittest.TestCase):
    def test_a_corrupted_hospital_factor_fails_the_tables_only(self):
        assemble = exposure.assemble

        def corrupted(*args, **kwargs):
            tables = assemble(*args, **kwargs)
            ohsu = tables[exposure.HOSPITALS]["hospitals"]["380009"]
            tables[exposure.HOSPITALS]["hospitals"]["380009"] = dict(ohsu, tchop=ohsu["tchop"] + 0.001)
            return tables

        with tempfile.TemporaryDirectory() as tmp:
            previous = Path(tmp) / exposure.HOSPITALS
            previous.write_text('{"previous": true}\n')
            args = ["--passes", str(FIXTURE / "passes"), "--adjudications", str(FIXTURE / "adjudications.json"),
                    "--out", tmp, "--checks", str(Path(tmp) / "checks.txt"), "--allow-missing"]
            with mock.patch.object(exposure, "assemble", corrupted), mock.patch("sys.stdout"):
                self.assertEqual(build.main(args), 1)
            self.assertEqual(previous.read_text(), '{"previous": true}\n')
            self.assertTrue((Path(tmp) / "crosswalk.json").exists(), "the crosswalk has its own gate")
            self.assertFalse((Path(tmp) / exposure.SHARES).exists())
            text = (Path(tmp) / "checks.txt").read_text()
            self.assertIn("FAIL OHSU fixture:", text)
            self.assertIn("Crosswalk checks passed. Wrote crosswalk.json", text)
            self.assertIn("1 hospital and patient-share check(s) failed.", text)

    def test_a_changed_file_layout_fails_the_tables_with_a_report(self):
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
            self.assertIn("FAIL hospital and patient-share tables read:", text)
            self.assertIn("impact file: no header with columns", text)
            self.assertTrue((Path(tmp) / "crosswalk.json").exists(), "the crosswalk has its own gate")
            self.assertFalse(any((Path(tmp) / name).exists() for name in exposure.TABLES))


if __name__ == "__main__":
    unittest.main()
