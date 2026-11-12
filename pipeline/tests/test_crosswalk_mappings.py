"""Mapping record validator, fingerprint, final_mapping and the mapper CLI helpers."""
import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import fetch
from crosswalk import mapper, mappings
from crosswalk.group import Ref

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


def record(code="32480", sets=(("0BTC0ZZ",),), dx=(("C3411", "typical"),)):
    return {"code": code, "mappable": True, "unmapped_reason": None,
            "pcs_sets": [{"codes": list(codes), "note": "n"} for codes in sets],
            "principal_dx": [{"code": c, "condition": "x", "role": r} for c, r in dx],
            "rationale": "r", "confidence": "high"}


class Fingerprint(unittest.TestCase):
    def test_stable_under_reordering(self):
        a = record(sets=(("0BTC0ZZ", "0DTE0ZZ"), ("0BTD0ZZ",)), dx=(("C3411", "typical"), ("C3412", "alternative")))
        b = record(sets=(("0BTD0ZZ",), ("0DTE0ZZ", "0BTC0ZZ")), dx=(("C3412", "alternative"), ("C3411", "typical")))
        b["rationale"] = "different words"
        self.assertEqual(mappings.fingerprint(a), mappings.fingerprint(b))
        self.assertRegex(mappings.fingerprint(a), r"^[0-9a-f]{8}$")

    def test_changes_when_a_code_changes(self):
        self.assertNotEqual(mappings.fingerprint(record()), mappings.fingerprint(record(sets=(("0BTD0ZZ",),))))
        self.assertNotEqual(mappings.fingerprint(record()), mappings.fingerprint(record(dx=(("C3412", "typical"),))))

    def test_set_boundaries_matter(self):
        together = record(sets=(("0BTC0ZZ", "0BTD0ZZ"),))
        apart = record(sets=(("0BTC0ZZ",), ("0BTD0ZZ",)))
        self.assertNotEqual(mappings.fingerprint(together), mappings.fingerprint(apart))


class WithGivenTables(unittest.TestCase):
    ref = Ref(pcs={"0BTC0ZZ": "x", "0BTD0ZZ": "x", "0BTD4ZZ": "x"}, cm={"C3411": "x", "C3412": "x"})

    def errors(self, rec):
        return mappings.validate_record(rec, self.ref)

    def test_valid_record(self):
        self.assertEqual(self.errors(record()), [])

    def test_rejects_unknown_pcs_code(self):
        self.assertTrue(any("0BTC0ZX" in e for e in self.errors(record(sets=(("0BTC0ZX",),)))))

    def test_rejects_unknown_or_dotted_dx(self):
        self.assertTrue(self.errors(record(dx=(("C34.11", "typical"),))))
        self.assertTrue(self.errors(record(dx=(("C9999", "typical"),))))

    def test_mappable_needs_sets_and_one_typical(self):
        self.assertTrue(self.errors(record(sets=())))
        self.assertTrue(self.errors(record(sets=((),))))
        self.assertTrue(self.errors(record(dx=())))
        self.assertTrue(self.errors(record(dx=(("C3411", "alternative"),))))
        self.assertTrue(self.errors(record(dx=(("C3411", "typical"), ("C3412", "typical")))))
        self.assertTrue(self.errors(record(sets=(("0BTC0ZZ",),) * 7)))

    def test_unmapped_record(self):
        good = {"code": "00100", "mappable": False, "unmapped_reason": "anesthesia code"}
        self.assertEqual(self.errors(good), [])
        self.assertTrue(self.errors(dict(good, unmapped_reason=None)))
        self.assertTrue(self.errors(dict(good, pcs_sets=[{"codes": ["0BTC0ZZ"]}])))

    def test_confidence_and_rationale(self):
        self.assertTrue(self.errors(dict(record(), confidence="sure")))
        self.assertTrue(self.errors(dict(record(), rationale="")))

    def test_approach_difference_is_a_warning_not_an_error(self):
        mixed = record(sets=(("0BTC0ZZ",), ("0BTD4ZZ",)))
        self.assertEqual(self.errors(mixed), [])
        self.assertEqual(len(mappings.approach_warnings(mixed)), 1)
        self.assertEqual(mappings.approach_warnings(record(sets=(("0BTC0ZZ",), ("0BTD0ZZ",)))), [])


@unittest.skipUnless(RAW_PRESENT, "data/raw/ not downloaded")
class AgainstTheRealFiles(unittest.TestCase):
    ref = Ref.load()
    WHIPPLE = ["0FBG0ZZ", "0DT90ZZ", "0DB60ZZ", "0F190ZB", "0D160ZA"]

    def test_real_validator_rejects_invalid_pcs(self):
        self.assertEqual(mappings.validate_record(record(), self.ref), [])
        self.assertTrue(mappings.validate_record(record(sets=(("0BTC0ZX",),)), self.ref))

    def test_final_mapping_prefers_adjudication_then_agreeing_pass_a(self):
        a = record()
        b = record(sets=(("0BTD0ZZ",),))           # a different lobe, same family
        passes = {"a": {"32480": a}, "b": {"32480": b}}
        settled = record(code="32480", dx=(("C3412", "typical"),))
        self.assertIs(mappings.final_mapping("32480", passes, {"32480": settled}, self.ref), settled)
        self.assertIs(mappings.final_mapping("32480", passes, {}, self.ref), a)

    def test_final_mapping_refuses_disagreement_and_gaps(self):
        a = record(code="48150", sets=(self.WHIPPLE,), dx=(("C250", "typical"),))
        b = record(code="48150", sets=(self.WHIPPLE,), dx=(("C170", "typical"),))   # duodenal: other family
        passes = {"a": {"48150": a}, "b": {"48150": b}}
        with self.assertRaises(ValueError):
            mappings.final_mapping("48150", passes, {}, self.ref)
        with self.assertRaises(ValueError):
            mappings.final_mapping("48150", {"a": {"48150": a}, "b": {}}, {}, self.ref)

    def test_both_unmappable_agree(self):
        rec = {"code": "00100", "mappable": False, "unmapped_reason": "anesthesia code"}
        self.assertIs(mappings.final_mapping("00100", {"a": {"00100": rec}, "b": {"00100": rec}}, {}, self.ref), rec)

    def test_load_passes_reads_pass_folders_and_unmappable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a").mkdir()
            (root / "a" / "m01.json").write_text(json.dumps([record()]))
            (root / "unmappable.json").write_text(json.dumps([{"code": "00100", "mappable": False,
                                                              "unmapped_reason": "anesthesia code"}]))
            passes = mappings.load_passes(root)
        self.assertEqual(sorted(passes["a"]), ["00100", "32480"])
        self.assertEqual(sorted(passes["b"]), ["00100"])


@unittest.skipUnless(RAW_PRESENT, "data/raw/ not downloaded")
class MapperBatches(unittest.TestCase):
    def test_batching_rule(self):
        batches, unmappable = mapper.mapping_batches()
        codes = [c for chunk in batches.values() for c in chunk]
        self.assertEqual((len(codes), len(unmappable)), (852, 70))
        self.assertEqual(len(codes) + len(unmappable), 922)
        self.assertEqual(list(batches)[:2], ["m01", "m02"])
        self.assertEqual(len(batches), 22)
        self.assertTrue(all(len(chunk) <= 40 for chunk in batches.values()))
        self.assertFalse(any("00100" <= c <= "01999" for c in codes))
        self.assertEqual(set(unmappable.values()), {"anesthesia code", "packaged: no separate outpatient payment"})

    def check(self, records, name="smoke.json"):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / name
            path.write_text(json.dumps(records))
            out = io.StringIO()
            with redirect_stdout(out), self.assertRaises(SystemExit) as raised:
                mapper.main(["check", str(path)])
        return raised.exception.code, out.getvalue()

    def test_check_prints_families_and_exits_zero(self):
        code, out = self.check([record()])
        self.assertEqual(code, 0)
        self.assertIn("Major Chest Procedures", out)
        self.assertIn("163/164/165", out)

    def test_check_exits_one_on_errors(self):
        code, out = self.check([record(sets=(("0BTC0ZX",),))])
        self.assertEqual(code, 1)
        self.assertIn("0BTC0ZX", out)

    def test_check_compares_file_codes_with_the_batch(self):
        batches, _ = mapper.mapping_batches()
        wrong = [copy.deepcopy(record(code=batches["m01"][0]))]
        code, out = self.check(wrong, name="m01.json")
        self.assertEqual(code, 1)
        self.assertIn("missing from the file", out)


if __name__ == "__main__":
    unittest.main()
