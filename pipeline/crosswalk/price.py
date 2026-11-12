"""National FY2027 IPPS payment for an MS-DRG: the unadjusted national figure.

amount = Table 5 weight x (Table 1A operating standardized amount, full update, wage index
> 1 + Table 1D capital federal rate), from the correction-notice (CN) tables. No wage index,
IME, DSH, outlier or other hospital-specific adjuster is applied, so published examples that
include a hospital's adjusters run higher.
"""


def drg_payment(drg, ref):
    """The national FY2027 payment for one MS-DRG, to the cent."""
    if drg not in ref.table5:
        raise ValueError("MS-DRG %s has no FY2027 Table 5 weight" % drg)
    rates = ref.rates
    return round(ref.table5[drg]["weight"] * (rates["operating_wi_gt1"] + rates["capital"]), 2)


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
