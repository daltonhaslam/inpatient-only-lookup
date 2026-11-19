"""The hospital tests' shared anchors: the plan's OHSU (380009) as the FY 2027 impact file has it, and
crosswalk.json meta.rates as build.py writes it. Not a test module (run_tests.py discovers test*.py);
importable because discovery puts this directory on sys.path."""

# crosswalk.json meta.rates (and hospitals.json meta.rates): FY 2027 Tables 1A/1B and 1D, CN.
RATES = {"operating": 6848.00, "capital": 539.95, "labor_share": 0.66, "operating_wi_le1": 6848.00, "labor_share_le1": 0.62}

# OHSU's payment factors (price.PAYMENT_FACTORS), then its whole impact-file row as exposure_sources loads it.
OHSU_FACTORS = {"wi": 1.1907, "gaf": 1.126962466, "tchop": 0.31139, "tchcp": 0.22928, "dshopp": 0.07045, "dshcpp": 0.10036}
OHSU = {"name": "Ohsu Hospital And Clinics", "state": "OR", **OHSU_FACTORS, "caseta44": 4098.35, "ime_caseta44": 4552.82, "type": 7}
