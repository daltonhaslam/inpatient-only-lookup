"""National FY2027 IPPS payment for an MS-DRG: the unadjusted national figure.

amount = Table 5 weight x (Table 1A operating standardized amount, full update, wage index
> 1 + Table 1D capital federal rate), from the correction-notice (CN) tables. No wage index,
IME, DSH, outlier or other hospital-specific adjuster is applied, so published examples that
include a hospital's adjusters run higher.

hospital_drg_payment and hospital_outpatient are the same payments at one hospital (wage index,
capital GAF, IME and DSH from the FY 2027 impact file): the reference the browser's hospital view
and the build's checks are held to.
"""


def drg_payment(drg, ref):
    """The national FY2027 payment for one MS-DRG, to the cent."""
    if drg not in ref.table5:
        raise ValueError("MS-DRG %s has no FY2027 Table 5 weight" % drg)
    rates = ref.rates
    return round(ref.table5[drg]["weight"] * (rates["operating_wi_gt1"] + rates["capital"]), 2)


# A hospital with no adjustment: what the national figure assumes.
NATIONAL = {"wi": 1.0, "gaf": 1.0, "tchop": 0.0, "tchcp": 0.0, "dshopp": 0.0, "dshcpp": 0.0}


def hospital_drg_payment(weight, hospital, rates):
    """The FY2027 IPPS payment for an MS-DRG of this weight at a hospital, unrounded.

    hospital has the impact file's factors (wi, gaf, tchop, tchcp, dshopp, dshcpp); rates is
    crosswalk.json meta.rates. Operating base = weight x standardized amount x (labor share x
    wage index + 1 - labor share), from Table 1A when the wage index is above 1, else 1B; capital
    base = weight x capital rate x GAF; IME and DSH are each base times the hospital's operating
    and capital factor. Uncompensated care, outliers, VBP/HRRP/HACRP and hospital-specific rates
    are left out. Round only what is shown; total is the unrounded sum.
    """
    wi = hospital["wi"]
    standardized, share = ((rates["operating"], rates["labor_share"]) if wi > 1
                           else (rates["operating_wi_le1"], rates["labor_share_le1"]))
    operating = weight * standardized * (share * wi + 1 - share)
    capital = weight * rates["capital"] * hospital["gaf"]
    paid = {"operating": operating, "capital": capital,
            "ime_operating": operating * hospital["tchop"], "ime_capital": capital * hospital["tchcp"],
            "dsh_operating": operating * hospital["dshopp"], "dsh_capital": capital * hospital["dshcpp"]}
    paid["ime"] = paid["ime_operating"] + paid["ime_capital"]
    paid["dsh"] = paid["dsh_operating"] + paid["dsh_capital"]
    paid["addons"] = paid["ime"] + paid["dsh"]
    paid["total"] = operating + capital + paid["addons"]
    return paid


def hospital_outpatient(rate, wi, labor_share):
    """An APC's national rate wage-adjusted for a hospital: rate x (labor share x wi + 1 - labor
    share), unrounded. OPPS pays no IME or DSH."""
    return rate * (labor_share * wi + 1 - labor_share)


def per_year(count, per_case):
    """A yearly figure: count x the unrounded per-case amount, rounded to the cent once."""
    return round(count * per_case, 2)


def family_range(drgs, ref):
    """{"drgs": [{"drg", "title", "weight", "amount"}], "low", "high"} for a family's DRGs."""
    if not drgs:
        raise ValueError("no MS-DRGs to price")
    rows = []
    for drg in drgs:
        amount = drg_payment(drg, ref)      # fails first for a DRG with no weight
        rows.append({"drg": drg, "title": ref.drg_titles[drg]["title"],
                     "weight": ref.table5[drg]["weight"], "amount": amount})
    amounts = [row["amount"] for row in rows]
    return {"drgs": rows, "low": min(amounts), "high": max(amounts)}
