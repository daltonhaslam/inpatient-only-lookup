"""Tiering (how much to trust a mapping before a coder looks) and review status.

tier() is computed from the mapping passes, never hand-set; review_status() folds the ingested
reviews (data/crosswalk/reviews.json) and resolutions (resolutions.json) for one code and its
current mapping fingerprint. Standard library only.
"""
from crosswalk import group as grouper
from crosswalk.mappings import families

INPATIENT_CREDS = frozenset({"CCS", "CIC", "CDIP", "CCDS", "RHIA", "RHIT", "MD or DO"})
STATUSES = ("unreviewed", "one-agrees", "disputed", "agree-needs-tiebreak", "confirmed")

TIER1_WHY = "Two separate AI mapping passes agree on one DRG family; not yet checked by a coder."
TIER3_DX_WHY = "The DRG family depends on the principal diagnosis. Reviewers wanted."
TIER3_VARIANT_WHY = ("The DRG family depends on which variant of the operation is done and how it is coded. "
                     "Reviewers wanted.")
TIER3_BOTH_WHY = ("The DRG family depends on the principal diagnosis and on which variant of the operation is done. "
                  "Reviewers wanted.")
TIER3_ADJUDICATED_WHY = "Two AI mapping passes disagreed; an adjudicating pass chose this mapping. Reviewers wanted."
TIER3_UNGROUPABLE_WHY = "The grouper could not place every mapped combination. Reviewers wanted."


def _bases(rec, ref):
    """Set of (basis, drgs) the grouper gives each pcs_set x principal_dx of a mappable record."""
    found = set()
    for entry in rec["pcs_sets"]:
        for dx in rec["principal_dx"]:
            result = grouper.group(entry["codes"], dx["code"], ref)
            found.add((result["basis"], tuple(result["drgs"])))
    return found


def split_drivers(rec, ref):
    """(by_dx, by_variant) for a mappable record: whether its DRG families differ by principal
    diagnosis (one PCS set groups differently under two diagnoses) and by PCS set (one diagnosis
    groups differently under two sets). A combination the grouper rejects counts as its own family."""
    grid = {}
    for i, entry in enumerate(rec["pcs_sets"]):
        for dx in rec["principal_dx"]:
            try:
                grid[i, dx["code"]] = tuple(grouper.group(entry["codes"], dx["code"], ref)["drgs"])
            except ValueError as error:
                grid[i, dx["code"]] = ("error", str(error))
    sets, dxs = range(len(rec["pcs_sets"])), [dx["code"] for dx in rec["principal_dx"]]
    by_dx = any(len({grid[i, dx] for dx in dxs}) > 1 for i in sets)
    by_variant = any(len({grid[i, dx] for i in sets}) > 1 for dx in dxs)
    return by_dx, by_variant


def _tier3_split_why(final, ref):
    by_dx, by_variant = split_drivers(final, ref)
    if by_dx and by_variant:
        return TIER3_BOTH_WHY
    return TIER3_VARIANT_WHY if by_variant else TIER3_DX_WHY


def _tier2_reasons(passes_for_code, final, ref):
    reasons = []
    if any(len(entry["codes"]) > 1 for entry in final["pcs_sets"]):
        reasons.append("several PCS codes are reported together")
    sets = {frozenset(frozenset(entry["codes"]) for entry in rec["pcs_sets"]) for rec in passes_for_code}
    if len(sets) > 1:
        reasons.append("the passes chose different PCS codes but the same DRG family")
    for basis, drgs in sorted(_bases(final, ref)):
        if basis == "medical":
            reasons.append("it groups by diagnosis (basis medical: no operating-room procedure in MS-DRG terms)")
        elif basis.startswith("unrelated"):
            reasons.append("the operating-room procedure is unrelated to the principal diagnosis's MDC")
        elif drgs in grouper.ANY_OR_FAMILIES:
            reasons.append("the family is the MDC's any-operating-room-procedure family")
    return list(dict.fromkeys(reasons))


def tier(code, passes, final, ref):
    """{"tier": 1|2|3, "why": str}, or {"tier": None, "why": ...} for an unmappable code.

    Tier 3: the final mapping groups to more than one DRG family (the why says whether diagnosis,
    operation variant or both split it), or the passes disagreed and an adjudicating pass chose a
    single family. Tier 2: one family, but several PCS codes together, different PCS codes
    from the two passes, or a basis other than in-MDC surgical. Tier 1: everything else.
    """
    if not final.get("mappable"):
        return {"tier": None, "why": "Not mappable to an ICD-10-PCS operation."}
    recs = [rec for rec in (passes.get("a", {}).get(code), passes.get("b", {}).get(code)) if rec]
    mappable = [rec for rec in recs if rec.get("mappable")]
    disagreed = len(mappable) < len(recs) or (len(recs) == 2 and families(recs[0], ref) != families(recs[1], ref))
    final_families = families(final, ref)
    if any(item[0] == "error" for item in final_families):
        return {"tier": 3, "why": TIER3_UNGROUPABLE_WHY}
    if len(final_families) > 1:
        return {"tier": 3, "why": _tier3_split_why(final, ref)}
    found = set().union(*(families(rec, ref) for rec in mappable + [final]))
    if disagreed or len(found) > 1:
        return {"tier": 3, "why": TIER3_ADJUDICATED_WHY}
    reasons = _tier2_reasons(mappable + [final], final, ref)
    if reasons:
        return {"tier": 2, "why": "One DRG family, but " + "; ".join(reasons) + ". Not yet checked by a coder."}
    return {"tier": 1, "why": TIER1_WHY}


def review_status(code, fp, reviews, resolutions, tier=None):
    """tier is the number or the dict tier() returns.

    {"status", "agrees", "disputes", "stale", "last"} for one code at its current fingerprint.

    agrees/disputes count reviews of the current fingerprint; stale counts reviews of an older
    one, which never count. Any current dispute makes the status "disputed" until the mapping
    changes or a resolution settles it. Confirmed: two agrees including an inpatient credential;
    a Tier 3 code needs a resolution instead (two agrees show "agree-needs-tiebreak"). Two agrees
    with no inpatient credential stay "one-agrees" and carry needs_inpatient_credential.
    """
    tier_number = tier.get("tier") if isinstance(tier, dict) else tier
    mine = [row for row in reviews if row["code"] == code]
    current = [row for row in mine if row["fp"] == fp]
    agrees = [row for row in current if row["verdict"] == "agree"]
    disputes = [row for row in current if row["verdict"] == "wrong"]
    result = {"status": "unreviewed", "agrees": len(agrees), "disputes": len(disputes),
              "stale": len(mine) - len(current), "last": max((row["date"] for row in current), default=None)}
    if "%s:%s" % (code, fp) in resolutions:
        result["status"] = "confirmed"
    elif disputes:
        result["status"] = "disputed"
    elif len(agrees) >= 2:
        if not any(row["credential"] in INPATIENT_CREDS for row in agrees):
            result["status"] = "one-agrees"
            result["needs_inpatient_credential"] = True
        else:
            result["status"] = "agree-needs-tiebreak" if tier_number == 3 else "confirmed"
    elif agrees:
        result["status"] = "one-agrees"
    return result
