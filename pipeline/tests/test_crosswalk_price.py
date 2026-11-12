"""National MS-DRG payment amounts for the crosswalk."""
import unittest

import fetch
from crosswalk.group import Ref
from crosswalk.price import drg_payment, family_range

RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


class WithGivenTables(unittest.TestCase):
    ref = Ref(
        table5={"001": {"weight": 2.0}, "002": {"weight": 1.0}},
        rates={"operating_wi_gt1": 100.0, "capital": 10.0},
        drg_titles={"001": {"title": "One with MCC"}, "002": {"title": "One without MCC"}},
    )

    def test_payment_is_weight_times_operating_plus_capital(self):
        self.assertEqual(drg_payment("001", self.ref), 220.0)

    def test_family_range(self):
        self.assertEqual(family_range(["001", "002"], self.ref), {
            "drgs": [{"drg": "001", "title": "One with MCC", "weight": 2.0, "amount": 220.0},
                     {"drg": "002", "title": "One without MCC", "weight": 1.0, "amount": 110.0}],
            "low": 110.0, "high": 220.0})

    def test_unknown_or_empty_fails(self):
        with self.assertRaises(ValueError):
            drg_payment("003", self.ref)
        with self.assertRaises(ValueError):
            family_range([], self.ref)


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class WithCmsTables(unittest.TestCase):
    def test_drg_165_from_the_correction_notice_tables(self):
        # CN Table 5 weight 1.9294 x (Table 1A full-update operating $6,848.00 + Table 1D
        # capital $539.95) = $14,254.31 national, before any hospital's adjusters.
        amount = drg_payment("165", Ref.load())
        self.assertEqual(amount, round(1.9294 * (6848.00 + 539.95), 2))
        self.assertEqual(amount, 14254.31)

    def test_major_chest_family(self):
        ref = Ref.load()
        found = family_range(["163", "164", "165"], ref)
        self.assertEqual(found["low"], drg_payment("165", ref))
        self.assertEqual(found["high"], drg_payment("163", ref))
        self.assertEqual(found["drgs"][0], {"drg": "163", "title": "Major Chest Procedures with MCC",
                                            "weight": 4.4892, "amount": 33165.99})

    def test_ungroupable_drgs_have_no_price(self):
        with self.assertRaises(ValueError):
            drg_payment("998", Ref.load())


if __name__ == "__main__":
    unittest.main()
