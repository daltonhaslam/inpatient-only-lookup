"""National MS-DRG payment amounts for the crosswalk."""
import unittest

import fetch
from crosswalk.group import Ref
from crosswalk.price import NATIONAL, drg_payment, family_range, hospital_drg_payment, hospital_outpatient, per_year

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


# crosswalk.json meta.rates, as build.py writes it.
META_RATES = {"operating": 6848.00, "capital": 539.95, "labor_share": 0.66,
              "operating_wi_le1": 6848.00, "labor_share_le1": 0.62}
OHSU = {"wi": 1.1907, "gaf": 1.126962466, "tchop": 0.31139, "tchcp": 0.22928, "dshopp": 0.07045, "dshcpp": 0.10036}


class AtAHospital(unittest.TestCase):
    """The plan's fixture: OHSU (380009) as the FY 2027 impact file has it."""

    def test_ohsu_drg_165(self):
        paid = hospital_drg_payment(1.9294, OHSU, META_RATES)
        self.assertEqual(round(paid["total"], 2), 22116.60)
        self.assertEqual(round(paid["addons"], 2), 6067.07)
        self.assertEqual(round(paid["ime_operating"], 2), 4632.08)
        self.assertEqual(paid["addons"], paid["ime"] + paid["dsh"])
        self.assertEqual(paid["ime"], paid["ime_operating"] + paid["ime_capital"])

    def test_ohsu_drg_163(self):
        paid = hospital_drg_payment(4.4892, OHSU, META_RATES)
        self.assertEqual(round(paid["total"], 2), 51459.44)
        self.assertEqual(round(paid["addons"], 2), 14116.45)

    def test_ohsu_outpatient_apc_5183(self):
        self.assertEqual(round(hospital_outpatient(3584.95, OHSU["wi"], 0.6), 2), 3995.14)

    def test_per_year_rounds_the_unrounded_per_case(self):
        per_case = hospital_drg_payment(1.9294, OHSU, META_RATES)["addons"]
        self.assertEqual(per_year(10, per_case), 60670.69)
        self.assertNotEqual(per_year(10, per_case), round(10 * round(per_case, 2), 2))

    def test_low_wage_index_uses_table_1b(self):
        rates = dict(META_RATES, operating_wi_le1=100.0, labor_share_le1=0.5)
        paid = hospital_drg_payment(1.0, dict(OHSU, wi=0.8), rates)
        self.assertAlmostEqual(paid["operating"], 100.0 * (0.5 * 0.8 + 0.5))

    def test_national_has_no_add_ons_and_matches_the_national_amount(self):
        paid = hospital_drg_payment(1.9294, NATIONAL, META_RATES)
        self.assertEqual((paid["ime"], paid["dsh"], paid["addons"]), (0, 0, 0))
        self.assertEqual(round(paid["total"], 2), 14254.31)


if __name__ == "__main__":
    unittest.main()
