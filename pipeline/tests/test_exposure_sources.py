"""Loaders for the hospital view and the patient share, checked against the raw CMS files.

The anchors are the plan's: OHSU (380009) as the impact file and the 2024 discharge file have
it, and 32480's patient shares. Skipped when data/raw/ is absent (a fresh clone).
"""
import unittest

import fetch
import parse
from crosswalk import exposure_sources as xs
from crosswalk import sources

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())

OHSU = {"name": "Ohsu Hospital And Clinics", "state": "OR", "wi": 1.1907, "gaf": 1.126962466,
        "tchop": 0.31139, "tchcp": 0.22928, "dshopp": 0.07045, "dshcpp": 0.10036,
        "caseta44": 4098.35, "ime_caseta44": 4552.82, "type": 7}


class StateOfCcn(unittest.TestCase):
    def test_first_two_digits_name_the_state(self):
        self.assertEqual(xs.state_of("380009"), "OR")
        self.assertEqual(xs.state_of("210001"), "MD")
        self.assertEqual(xs.state_of("400001"), "PR")
        self.assertEqual(xs.state_of("670128"), "TX")    # Texas's second state code

    def test_unknown_state_code_fails(self):
        with self.assertRaises(parse.ParseError):
            xs.state_of("990001")


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class Sources(unittest.TestCase):
    def test_every_loader_names_a_pinned_source(self):
        ids = {source["id"] for source in fetch.load_sources()}
        for name, source_id in xs.SOURCE_OF.items():
            self.assertTrue(callable(getattr(xs, name)), name)
            self.assertIn(source_id, ids, name)

    def test_impact_file_ohsu(self):
        self.assertEqual(xs.load_impact()["380009"], OHSU)

    def test_impact_file_counts(self):
        impact = xs.load_impact()
        self.assertEqual(len(impact), 3075)
        self.assertEqual(sum(1 for h in impact.values() if h["tchop"] > 0), 1327)
        self.assertEqual(sum(1 for ccn in impact if ccn.startswith("21")), 43)
        # CMS leaves IME_CASETA44 blank where the hospital has no MA IME cases.
        self.assertEqual(sum(1 for h in impact.values() if h["ime_caseta44"] is None), 1771)
        # Three rows have no name ("blank" = unknown in the variable descriptions).
        self.assertEqual(sorted(ccn for ccn, h in impact.items() if h["name"] is None), ["090012", "420117", "670330"])

    def test_impact_names_decode_cp1252(self):
        self.assertEqual(xs.load_impact()["670128"]["name"], "Baylor Scott & White Medical Center – Pflugerville")

    def test_drg_volume_ohsu(self):
        volume = xs.load_drg_volume()
        self.assertEqual({drg: volume["380009"][drg] for drg in ("163", "164", "165")}, {"163": 15, "164": 34, "165": 11})
        self.assertGreaterEqual(min(n for drgs in volume.values() for n in drgs.values()), 11)

    def test_mup_states(self):
        self.assertEqual(xs.load_mup_states()["380009"], "OR")

    def test_copays_32480(self):
        # CMS prints "." for the national unadjusted copayment and gives 20% as the minimum.
        self.assertEqual(xs.load_copays()["32480"], {"national": None, "minimum": 716.99})
        self.assertEqual(xs.copay(xs.load_copays()["32480"]), 716.99)
        self.assertIsNone(xs.copay(xs.load_copays().get("64629")))     # SI N: no copayment

    def test_asc_share_32480(self):
        self.assertEqual(round(sources.load_asc()["32480"] * 0.2), 317)

    def test_asc_addenda(self):
        aa26, aa27 = xs.load_asc_2026(), xs.load_asc_2027()
        self.assertNotIn("32480", aa26)                     # inpatient-only in 2026
        self.assertEqual(aa27["32480"], {"ci": "CH", "pi": "G2"})
        self.assertEqual(aa27["64629"], {"ci": "CH", "pi": "N1"})
        self.assertIn("27447", aa26)

    def test_asc_additions(self):
        additions = xs.load_asc_additions()
        self.assertEqual(len(additions), 619)
        self.assertIn("64629", additions)
        self.assertEqual(additions["32480"], "G2")


if __name__ == "__main__":
    unittest.main()
