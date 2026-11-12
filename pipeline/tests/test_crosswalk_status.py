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

    def test_tier_3_adjudicated(self):
        other = rec([("0BTC0ZZ",)], [("I2510", "typical")])
        result = self.tier(LUNG, other, final=LUNG)
        self.assertEqual(result["tier"], 3)
        self.assertIn("two passes disagreed; an adjudicator chose", result["why"].lower())

    def test_unmappable_has_no_tier(self):
        gone = {"code": "X", "mappable": False, "unmapped_reason": "packaged"}
        result = self.tier(gone)
        self.assertIsNone(result["tier"])
        self.assertEqual(status.review_status("X", "00000000", [], {}, result["tier"])["status"], "unreviewed")


def review(verdict="agree", credential="CCS", fp="aaaa1111", date="2026-11-12", code="X"):
    return {"code": code, "fp": fp, "credential": credential, "verdict": verdict, "date": date,
            "name": None, "reason": None}


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
        result = self.status([review(credential="CPC"), review(credential="CPC")])
        self.assertEqual(result["status"], "one-agrees")
        self.assertTrue(result["needs_inpatient_credential"])

    def test_tier_3_two_agrees_need_tiebreak(self):
        self.assertEqual(self.status([review(), review()], tier=3)["status"], "agree-needs-tiebreak")
        self.assertEqual(self.status([review(), review()], tier={"tier": 3, "why": ""})["status"], "agree-needs-tiebreak")

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


class Ingest(unittest.TestCase):
    def run_ingest(self, directory, **kwargs):
        out = io.StringIO()
        path = Path(directory) / "reviews.json"
        path.write_text("[]")
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

    def test_credential_normalization(self):
        self.assertEqual([reviews.normalize_credential(v) for v in ("ccs-p", "MD/DO", "md or do", "Nurse", "")],
                         ["CCS-P", "MD or DO", "MD or DO", "Other", "Other"])


if __name__ == "__main__":
    unittest.main()
