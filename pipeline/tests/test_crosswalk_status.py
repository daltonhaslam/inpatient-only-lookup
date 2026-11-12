"""Tiering, review status and the review CSV ingest."""
import io
import json
import tempfile
import unittest
from pathlib import Path

import fetch
from crosswalk import reviews, status
from crosswalk.group import Ref

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


def rec(sets, dx, code="X"):
    return {"code": code, "mappable": True, "unmapped_reason": None,
            "pcs_sets": [{"codes": list(s), "note": "n"} for s in sets],
            "principal_dx": [{"code": c, "condition": "x", "role": r} for c, r in dx],
            "rationale": "r", "confidence": "high"}


LUNG = rec([("0BTC0ZZ",)], [("C3411", "typical")])


@unittest.skipUnless(RAW_PRESENT, "CMS source files not downloaded")
class Tiering(unittest.TestCase):
    ref = Ref.load()

    def tier(self, a, b=None, final=None):
        passes = {"a": {"X": a}, "b": {"X": b or a}}
        return status.tier("X", passes, final or a, self.ref)

    def test_tier_1(self):
        result = self.tier(LUNG)
        self.assertEqual(result, {"tier": 1, "why": status.TIER1_WHY})

    def test_tier_2_several_codes_together(self):
        result = self.tier(rec([("0BTC0ZZ", "0BTD0ZZ")], [("C3411", "typical")]))
        self.assertEqual(result["tier"], 2)
        self.assertIn("several PCS codes", result["why"])

    def test_tier_2_passes_chose_different_pcs_same_family(self):
        result = self.tier(LUNG, rec([("0BTD0ZZ",)], [("C3411", "typical")]))
        self.assertEqual(result["tier"], 2)
        self.assertIn("different PCS codes but the same DRG family", result["why"])

    def test_tier_2_medical_basis(self):
        result = self.tier(rec([("0BJ08ZZ",)], [("J189", "typical")]))
        self.assertEqual(result["tier"], 2)
        self.assertIn("groups by diagnosis", result["why"])

    def test_tier_2_unrelated_basis(self):
        result = self.tier(rec([("0BTC0ZZ",)], [("I2510", "typical")]))
        self.assertEqual(result["tier"], 2)
        self.assertIn("unrelated", result["why"])

    def test_tier_2_any_or_basis(self):
        result = self.tier(rec([("0DTJ0ZZ",)], [("F209", "typical")]))
        self.assertEqual(result["tier"], 2)
        self.assertIn("any-operating-room", result["why"])

    def test_tier_3_depends_on_dx(self):
        result = self.tier(rec([("0BTC0ZZ",)], [("C3411", "typical"), ("I2510", "alternative")]))
        self.assertEqual(result, {"tier": 3, "why": status.TIER3_DX_WHY})

    def test_tier_3_depends_on_variant(self):
        result = self.tier(rec([("0BTC0ZZ",), ("0YQ50ZZ",)], [("C3411", "typical")]))
        self.assertEqual(result, {"tier": 3, "why": status.TIER3_VARIANT_WHY})

    def test_tier_3_depends_on_dx_and_variant(self):
        both = rec([("0BTC0ZZ",), ("0YQ50ZZ",)], [("C3411", "typical"), ("I2510", "alternative")])
        self.assertEqual(status.split_drivers(both, self.ref), (True, True))
        self.assertEqual(self.tier(both), {"tier": 3, "why": status.TIER3_BOTH_WHY})

    def test_split_drivers(self):
        self.assertEqual(status.split_drivers(LUNG, self.ref), (False, False))
        by_dx = rec([("0BTC0ZZ",)], [("C3411", "typical"), ("I2510", "alternative")])
        self.assertEqual(status.split_drivers(by_dx, self.ref), (True, False))
        same = rec([("0BTC0ZZ",), ("0BTD0ZZ",)], [("C3411", "typical")])
        self.assertEqual(status.split_drivers(same, self.ref), (False, False))

    def test_tier_3_adjudicated(self):
        other = rec([("0BTC0ZZ",)], [("I2510", "typical")])
        result = self.tier(LUNG, other, final=LUNG)
        self.assertEqual(result, {"tier": 3, "why": status.TIER3_ADJUDICATED_WHY})
        self.assertNotIn("principal diagnosis", result["why"])

    def test_tier_3_adjudicated_but_split_says_what_splits_it(self):
        split = rec([("0BTC0ZZ",), ("0YQ50ZZ",)], [("C3411", "typical")])
        result = self.tier(LUNG, split, final=split)
        self.assertEqual(result, {"tier": 3, "why": status.TIER3_VARIANT_WHY})

    def test_unmappable_has_no_tier(self):
        gone = {"code": "X", "mappable": False, "unmapped_reason": "packaged"}
        result = self.tier(gone)
        self.assertIsNone(result["tier"])
        self.assertEqual(status.review_status("X", "00000000", [], {}, result["tier"])["status"], "unreviewed")


def review(verdict="agree", credential="CCS", fp="aaaa1111", date="2026-11-12", code="X", name=None, ts=None):
    return {"code": code, "fp": fp, "credential": credential, "verdict": verdict, "date": date,
            "ts": ts or date + " 09:00:00", "name": name, "reason": None}


class ReviewStatus(unittest.TestCase):
    def status(self, rows, tier=1, resolutions=None):
        return status.review_status("X", "aaaa1111", rows, resolutions or {}, tier)

    def test_no_reviews(self):
        self.assertEqual(self.status([]), {"status": "unreviewed", "agrees": 0, "disputes": 0, "stale": 0, "last": None})

    def test_one_agree(self):
        self.assertEqual(self.status([review()])["status"], "one-agrees")

    def test_two_agrees_with_inpatient_credential_confirm(self):
        result = self.status([review(credential="CPC"), review(credential="CCS", date="2026-11-13")])
        self.assertEqual((result["status"], result["agrees"], result["last"]), ("confirmed", 2, "2026-11-13"))

    def test_two_cpc_agrees_do_not_confirm(self):
        result = self.status([review(credential="CPC"), review(credential="CPC", date="2026-11-13")])
        self.assertEqual(result["status"], "one-agrees")
        self.assertTrue(result["needs_inpatient_credential"])

    def test_tier_3_two_agrees_need_tiebreak(self):
        two = [review(), review(date="2026-11-13")]
        self.assertEqual(self.status(two, tier=3)["status"], "agree-needs-tiebreak")
        self.assertEqual(self.status(two, tier={"tier": 3, "why": ""})["status"], "agree-needs-tiebreak")

    def test_one_named_reviewer_agreeing_twice_does_not_confirm(self):
        rows = [review(name="Jane Doe", credential="CCS"), review(name="  jane   DOE ", credential="CIC", date="2026-11-13")]
        result = self.status(rows)
        self.assertEqual((result["status"], result["agrees"]), ("one-agrees", 2))
        self.assertNotIn("needs_inpatient_credential", result)
        self.assertEqual(self.status(rows + [review(name="Sam Lee", credential="CPC")])["status"], "confirmed")

    def test_anonymous_reviewers_count_by_credential_and_hour(self):
        same_hour = [review(ts="2026-11-12 09:05:00"), review(ts="2026-11-12 09:55:00")]
        self.assertEqual(self.status(same_hour)["status"], "one-agrees")
        self.assertEqual(self.status([review(ts="2026-11-12 09:05:00"), review(ts="2026-11-12 10:05:00")])["status"], "confirmed")
        self.assertEqual(self.status([review(ts="2026-11-12 09:05:00"), review(credential="CPC", ts="2026-11-12 09:06:00")])["status"],
                         "confirmed")

    def test_reviewer_key(self):
        self.assertEqual(status.reviewer_key(review(name=" Jane  Doe ")), "name:jane doe")
        self.assertEqual(status.reviewer_key(review(credential="CIC", ts="2026-11-12 14:59:59")), "anon:CIC:2026-11-12 14")

    def test_old_fingerprint_is_stale(self):
        result = self.status([review(fp="oldoldol")])
        self.assertEqual((result["status"], result["stale"], result["agrees"]), ("unreviewed", 1, 0))

    def test_agree_plus_dispute_is_disputed_even_with_later_agrees(self):
        self.assertEqual(self.status([review(), review("wrong")])["status"], "disputed")
        rows = [review(), review("wrong"), review(), review()]
        self.assertEqual(self.status(rows)["status"], "disputed")

    def test_resolution_confirms_even_tier_3_and_disputed(self):
        resolutions = {"X:aaaa1111": {"decision": "kept", "by": "DH", "date": "2026-11-20"}}
        self.assertEqual(self.status([review("wrong")], tier=3, resolutions=resolutions)["status"], "confirmed")

    def test_other_codes_ignored(self):
        self.assertEqual(self.status([review(code="Y")])["status"], "unreviewed")


CODES = {"32480", "44150", "48150"}


class Ingest(unittest.TestCase):
    def run_ingest(self, directory, **kwargs):
        out = io.StringIO()
        path = Path(directory) / "reviews.json"
        path.write_text("[]")
        kwargs.setdefault("codes", CODES)
        count = reviews.ingest(FIXTURES / "review_agree.csv", FIXTURES / "review_wrong.csv", reviews_path=path, out=out, **kwargs)
        return count, json.loads(path.read_text()), out.getvalue()

    def test_rows_never_carry_emails_or_phi(self):
        with tempfile.TemporaryDirectory() as tmp:
            count, rows, printed = self.run_ingest(tmp, yes=True)
            text = json.dumps(rows)
            self.assertEqual(count, 8)
            for banned in ("example.com", "example.org", "Inpatient facility", "Both", "Smith", "1234567", "01/02/1950"):
                self.assertNotIn(banned, text)
            self.assertNotIn("Smith", printed)
            reasons = {r["reason"] for r in rows if r["verdict"] == "wrong"}
            self.assertIn("Approach differs from what we code.; 0FT00ZZ", reasons)
            self.assertEqual(sum(r["reason"] is None for r in rows if r["verdict"] == "wrong"), 2)
            self.assertTrue(all(r["reason"] is None for r in rows if r["verdict"] == "agree"))
            first = rows[0]
            self.assertEqual((first["code"], first["fp"], first["credential"], first["name"]),
                             ("32480", "aaaa1111", "CCS", "Jane Doe, CCS"))
            self.assertIn("MD or DO", {r["credential"] for r in rows})

    def test_flags_and_dedupe(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, _, printed = self.run_ingest(tmp, yes=True)
            self.assertIn("FLAG: 44150: 3+ responses within 120 seconds", printed)
            self.assertIn("none from an inpatient credential", printed)
            self.assertIn("dispute text dropped", printed)
            path = Path(tmp) / "reviews.json"
            again = reviews.ingest(FIXTURES / "review_agree.csv", FIXTURES / "review_wrong.csv",
                                   reviews_path=path, out=io.StringIO(), yes=True)
            self.assertEqual(again, 0)
            self.assertEqual(len(json.loads(path.read_text())), 8)

    def test_declining_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reviews.json"
            path.write_text("[]")
            result = reviews.ingest(FIXTURES / "review_agree.csv", FIXTURES / "review_wrong.csv",
                                    reviews_path=path, out=io.StringIO(), confirm=lambda prompt: "n")
            self.assertIsNone(result)
            self.assertEqual(json.loads(path.read_text()), [])

    def test_claims_counted_by_batch_without_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            claims = Path(tmp) / "claims.json"
            self.run_ingest(tmp, yes=True, claims_path=FIXTURES / "review_claims.csv", claims_out=claims)
            self.assertEqual(json.loads(claims.read_text()), {"m01": 2, "m02": 1})
            self.assertNotIn("Pat", claims.read_text())

    def test_phi_patterns(self):
        for text in ("john smith 123-45-6789 born March 3 1960", "born 3 Mar 1960", "Dr. Jones said",
                     "Patient Lee had it", "pt Garcia", "Mrs Ng", "x" * 300 + " 123-45-6789"):
            self.assertTrue(reviews.has_phi(text), text)
        self.assertFalse(reviews.has_phi("Approach differs; use 0FT00ZZ for the open case."))

    def test_phi_scan_runs_before_truncation(self):
        log = []
        self.assertIsNone(reviews._clean_reason(["x" * 290 + " 123-45-6789"], log, "X"))
        self.assertEqual(len(reviews._clean_reason(["y" * 400], log, "X")), 280)

    def _wrong_csv(self, tmp, reason):
        path = Path(tmp) / "w.csv"
        path.write_text("Timestamp,Code,Mapping reviewed,Your credential,Your reasoning\n"
                        '11/12/2026 11:00:00,48150,cccc3333 x,CIC,"%s"\n' % reason)
        return path

    def test_reviewer_example_dropped_and_survivors_printed(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            path = Path(tmp) / "reviews.json"
            bad = self._wrong_csv(tmp, "john smith 123-45-6789 born March 3 1960")
            reviews.ingest(FIXTURES / "review_agree.csv", bad, reviews_path=path, out=out, yes=True)
            self.assertNotIn("123-45-6789", path.read_text())
            self.assertNotIn("123-45-6789", out.getvalue())
            ok = self._wrong_csv(tmp, "PCS approach is off")
            path.write_text("[]")
            out = io.StringIO()
            reviews.ingest(FIXTURES / "review_agree.csv", ok, reviews_path=path, out=out, yes=True)
            self.assertIn("REASON (48150, 2026-11-12 11:00:00): PCS approach is off", out.getvalue())

    def test_drop_reasons_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reviews.json"
            ok = self._wrong_csv(tmp, "PCS approach is off")
            reviews.ingest(FIXTURES / "review_agree.csv", ok, reviews_path=path, out=io.StringIO(),
                           yes=True, drop_reasons=True)
            self.assertTrue(all(r["reason"] is None for r in json.loads(path.read_text())))

    def test_rows_whose_code_is_not_a_crosswalk_code_are_dropped_and_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            agree = Path(tmp) / "a.csv"
            agree.write_text("Timestamp,Code,Mapping reviewed,Your credential,Name to show in the credit list\n"
                             "11/12/2026 09:00:00,32480,aaaa1111 x,CCS,\n"
                             "11/12/2026 09:01:00,<b>hi</b>,aaaa1111 x,CCS,\n"
                             '11/12/2026 09:02:00,"=HYPERLINK(""https://evil.test"")",aaaa1111 x,CCS,\n'
                             "11/12/2026 09:03:00,99213,aaaa1111 x,CCS,\n"
                             "11/12/2026 09:04:00,3248,aaaa1111 x,CCS,\n")
            path = Path(tmp) / "reviews.json"
            out = io.StringIO()
            count = reviews.ingest(agree, self._wrong_csv(tmp, "ok"), reviews_path=path, out=out, yes=True, codes=CODES)
            self.assertEqual(count, 2)
            self.assertEqual(sorted(r["code"] for r in json.loads(path.read_text())), ["32480", "48150"])
            printed = out.getvalue()
            self.assertIn("a.csv row 3 skipped (Code is not a CPT/HCPCS code)", printed)
            self.assertIn("a.csv row 4 skipped (Code is not a CPT/HCPCS code)", printed)
            self.assertIn("a.csv row 5 skipped (99213 is not in the crosswalk)", printed)
            self.assertIn("a.csv row 6 skipped (Code is not a CPT/HCPCS code)", printed)
            self.assertNotIn("HYPERLINK", printed)
            self.assertNotIn("<b>", printed)

    def test_default_code_set_is_the_crosswalk(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "crosswalk.json"
            doc.write_text(json.dumps({"meta": {}, "codes": {"32480": {}, "0095T": {}}}))
            self.assertEqual(reviews.crosswalk_codes(doc), {"32480", "0095T"})

    def test_display_name_gets_the_phi_scan_before_it_is_cut(self):
        log = []
        self.assertIsNone(reviews._clean_name("Mrs Garcia", log, "X"))
        self.assertIsNone(reviews._clean_name("x" * 85 + " 123-45-6789", log, "X"))
        self.assertEqual(len(log), 2)
        self.assertTrue(all("123-45-6789" not in line and "Garcia" not in line for line in log))
        self.assertEqual(reviews._clean_name("  Jane   Doe, CCS ", log, "X"), "Jane Doe, CCS")
        self.assertEqual(len(reviews._clean_name("y" * 100, log, "X")), reviews.NAME_LIMIT)

    def test_preview_shows_code_credential_and_name_of_every_new_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, rows, printed = self.run_ingest(tmp, yes=True)
            self.assertEqual(printed.count("NEW ("), len(rows))
            self.assertIn("NEW (32480, 2026-11-12 09:00:00): agree, credential CCS, name Jane Doe, CCS", printed)
            self.assertIn("NEW (32480, 2026-11-12 09:30:00): agree, credential MD or DO, name (none)", printed)
            self.assertIn("NEW (48150, 2026-11-12 11:00:00): wrong, credential CIC, name (none)", printed)

    def test_credential_normalization(self):
        self.assertEqual([reviews.normalize_credential(v) for v in ("ccs-p", "MD/DO", "md or do", "Nurse", "")],
                         ["CCS-P", "MD or DO", "MD or DO", "Other", "Other"])


if __name__ == "__main__":
    unittest.main()


class ProfileLinks(unittest.TestCase):
    def test_accepted_and_normalized(self):
        self.assertEqual(reviews.clean_profile("  https://www.linkedin.com/in/jane-doe?utm=x#top "), "https://www.linkedin.com/in/jane-doe")
        self.assertEqual(reviews.clean_profile("https://orcid.org/0000-0000-0000-0000?a=b"), "https://orcid.org/0000-0000-0000-0000?a=b")

    def test_rejected(self):
        for bad in ("http://linkedin.com/in/x", "javascript:alert(1)", "https://linkedin.com/in/ jane", "https://jane@linkedin.com/in/x",
                    "https://u:p@example.org/", "https://", "https:///path", "https://example.org/" + "a" * 200, "", None, "linkedin.com/in/x"):
            self.assertIsNone(reviews.clean_profile(bad), bad)

    def _csv(self, tmp, name, profile):
        path = Path(tmp) / "a.csv"
        path.write_text("Timestamp,Code,Mapping reviewed,Your credential,Name to show in the credit list,"
                        "Link to your LinkedIn or other professional profile\n"
                        '11/12/2026 09:00:00,32480,aaaa1111 x,CCS,%s,%s\n' % (name, profile))
        return path

    def _run(self, name, profile):
        with tempfile.TemporaryDirectory() as tmp:
            out, path = io.StringIO(), Path(tmp) / "reviews.json"
            path.write_text("[]")
            reviews.ingest(self._csv(tmp, name, profile), FIXTURES / "review_wrong.csv", reviews_path=path, out=out, yes=True, codes=CODES)
            rows = [r for r in json.loads(path.read_text()) if r["ts"] == "2026-11-12 09:00:00"]
            return rows[0], out.getvalue()

    def test_ingest_keeps_profile_and_prints_it(self):
        row, printed = self._run("Jane Doe", "https://www.linkedin.com/in/jane?trk=1")
        self.assertEqual(row["profile"], "https://www.linkedin.com/in/jane")
        self.assertIn("name Jane Doe, profile https://www.linkedin.com/in/jane", printed)
        self.assertNotIn("PROFILE (", printed)

    def test_ingest_rejects_bad_and_drops_without_name(self):
        self.assertIsNone(self._run("Jane Doe", "http://example.org/x")[0]["profile"])
        row, printed = self._run("", "https://www.linkedin.com/in/jane")
        self.assertIsNone(row["profile"])
        self.assertIn("no name to link", printed)

    def test_missing_column_is_null(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reviews.json"
            path.write_text("[]")
            reviews.ingest(FIXTURES / "review_agree.csv", FIXTURES / "review_wrong.csv", reviews_path=path, out=io.StringIO(), yes=True, codes=CODES)
            self.assertTrue(all(r["profile"] is None for r in json.loads(path.read_text())))

    def test_unknown_host_is_flagged(self):
        _, printed = self._run("Jane Doe", "https://janedoe.example/about")
        self.assertIn("PROFILE (32480): janedoe.example — check before approving", printed)

    def test_resolution_problems(self):
        good = {"X:aaaa1111": {"decision": "kept", "by": "Jane Doe", "by_profile": "https://orcid.org/0000-0000-0000-0000"}}
        self.assertEqual(reviews.resolution_problems(good), [])
        bad = {"X:aaaa1111": {"by": "Jane Doe", "by_profile": "http://x.org"}, "Y:bbbb2222": {"by_profile": "https://x.org"}}
        self.assertEqual(len(reviews.resolution_problems(bad)), 2)
