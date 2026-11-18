"""The derived tables behind the hospital view and the patient share (see build.py).

    hospitals.json        every hospital the picker offers, with its FY 2027 impact-file factors,
                          and the Maryland hospitals it names but does not offer; meta.drg_weights
                          has the Table 5 weight of every DRG the crosswalk prices and meta.rates
                          the IPPS rates the hospital formula reads, copied from crosswalk.json
                          (the browser's card model carries neither, and crosswalk.json must not
                          change): the browser's hospital math reads only this meta
    drg-volume.json       2024 traditional Medicare discharges by hospital, for the DRGs the
                          crosswalk uses
    asc-new-2027.json     the codes CMS adds to the ASC covered procedures list for CY 2027
    patient-shares.json   for each compared code and each of those: the patient's share at an
                          ASC and in the hospital outpatient department

assemble() builds them from crosswalk.json and the pinned files; exposure_checks checks them;
build.py writes them only when every check passes. Codes only: no CPT descriptor text.
"""
import functools
import types

import fetch
import history
import parse
from crosswalk import exposure_sources as xs
from crosswalk import sources

FACTS = fetch.PIPELINE / "facts.json"
# The derived tables, by file name.
HOSPITALS, VOLUME = "hospitals.json", "drg-volume.json"
ASC_NEW, SHARES = "asc-new-2027.json", "patient-shares.json"
TABLES = tuple(sorted((HOSPITALS, VOLUME, ASC_NEW, SHARES)))
MARYLAND = "21"
MARYLAND_REASON = "Maryland hospitals are paid under the state's all-payer model, not the IPPS."
# The crosswalk.json meta.rates keys price.hospital_drg_payment reads, shipped in hospitals.json meta.
HOSPITAL_RATES = ("operating", "operating_wi_le1", "capital", "labor_share", "labor_share_le1")
COINSURANCE = 0.2                 # Part B coinsurance: the ASC share, and Addendum B's minimum copayment

SOURCE_LABELS = {
    "ipps-2027-impact": ("FY 2027 IPPS final rule impact file, correction notice", xs.IMPACT_MEMBER),
    "mup-inp-2024": ("Medicare Inpatient Hospitals - by Provider and Service, data year 2024", None),
    "asc-2027-additions": ("CY 2027 ASC final rule (CMS-1850-FC), Final Additions to the List of ASC Covered Procedures",
                           xs.ADDITIONS_MEMBER),
    "asc-2027-aa": ("CY 2027 ASC final rule (CMS-1850-FC), Addendum AA", sources.ASC_AA),
    "addenda-2027": ("CY 2027 OPPS final rule (CMS-1850-FC), Addendum B", history.ADDENDUM_B),
}


def load_tables():
    """Everything assemble() reads besides crosswalk.json, as one namespace."""
    return types.SimpleNamespace(
        impact=xs.load_impact(), volume=xs.load_drg_volume(), mup_states=xs.load_mup_states(),
        copays=xs.load_copays(), asc_rates=sources.load_asc(), opps=sources.load_opps(),
        asc_2026=xs.load_asc_2026(), asc_2027=xs.load_asc_2027(), additions=xs.load_asc_additions(),
        table5=sources.load_table5(), facts=fetch.read_json(FACTS))


@functools.lru_cache(maxsize=None)
def source_meta(source_id):
    """{"id", "label", "landing", "file"} for a pinned source (cached: treat as read-only)."""
    source = next(s for s in fetch.load_sources() if s["id"] == source_id)
    label, member = SOURCE_LABELS[source_id]
    path = fetch.raw_path(source)
    name = parse.pick_member(path, member).rsplit("/", 1)[-1] if member else path.name
    return {"id": source_id, "label": label, "landing": source["landing"], "file": name}


def crosswalk_drgs(doc):
    """Every MS-DRG the crosswalk prices, sorted."""
    return sorted({row["drg"] for entry in doc["codes"].values() if entry["inpatient"]
                   for family in entry["inpatient"]["families"] for row in family["drgs"]})


def drg_weights(doc, t):
    """{DRG: FY 2027 Table 5 weight} for every MS-DRG the crosswalk prices, for the hospital view."""
    return {drg: t.table5[drg]["weight"] for drg in crosswalk_drgs(doc)}


def compared_codes(doc):
    """The codes with an outpatient-inpatient comparison (849 in the published crosswalk)."""
    return sorted(code for code, entry in doc["codes"].items() if entry["difference"] is not None)


# ---------------------------------------------------------------- tables

def hospitals_table(t):
    offered = {ccn: row for ccn, row in sorted(t.impact.items()) if not ccn.startswith(MARYLAND)}
    maryland = {ccn: {"name": row["name"], "state": row["state"]}
                for ccn, row in sorted(t.impact.items()) if ccn.startswith(MARYLAND)}
    labor = t.facts["opps_labor_share"]
    return {
        "meta": {
            "source": source_meta("ipps-2027-impact"),
            "columns": dict([("name", "Name"), ("type", "Provider Type")] + list(xs.IMPACT_FACTORS)),
            "state": "from the CCN's first two digits",
            "counts": {"offered": len(offered), "teaching": sum(1 for row in offered.values() if row["tchop"] > 0),
                       "in_file": len(t.impact), "teaching_in_file": sum(1 for row in t.impact.values() if row["tchop"] > 0),
                       "maryland": len(maryland)},
            "maryland": MARYLAND_REASON,
            "provider_types": {str(code): label for code, label in sorted(xs.PROVIDER_TYPES.items())},
            "opps_labor_share": labor["value"], "opps_labor_share_cite": labor["cite"],
        },
        "hospitals": offered,
        "maryland": maryland,
    }


def volume_table(doc, t, offered):
    drgs = crosswalk_drgs(doc)
    used = set(drgs)
    volume, dropped = {}, {}
    for ccn, counts in sorted(t.volume.items()):
        kept = {drg: n for drg, n in sorted(counts.items()) if drg in used}
        if not kept:
            continue
        if ccn in offered:
            volume[ccn] = kept
        else:
            dropped[ccn] = "Maryland (all-payer model)" if ccn.startswith(MARYLAND) else "not in the FY 2027 impact file"
    return {
        "meta": {
            "source": source_meta("mup-inp-2024"), "data_year": 2024, "column": "Tot_Dschrgs",
            "suppressed_below": xs.MUP_SUPPRESSED_BELOW,
            "missing": "CMS does not publish counts under 11: a hospital or DRG with no count had under 11 discharges or none",
            "drgs": drgs,
            "counts": {"hospitals": len(volume), "rows": sum(len(counts) for counts in volume.values()),
                       "dropped": len(dropped)},
            "dropped": dropped,
        },
        "volume": volume,
    }


def asc_new_table(removed, t):
    fact = t.facts["asc_additions_2027"]
    codes = {code: {"pi": pi, "ipo_removed": removed.get(code) == "2027-01-01"}
             for code, pi in sorted(t.additions.items())}
    return {
        "meta": {"source": source_meta("asc-2027-additions"), "cite": fact["cite"], "count": len(codes),
                 "ipo_removed_2027": sum(1 for item in codes.values() if item["ipo_removed"]),
                 "also_added": sorted(code for code, item in codes.items() if not item["ipo_removed"])},
        "codes": codes,
    }


def patient_share(code, t):
    """{"asc_rate", "asc_share", "opps_copay", "opps_share", "opps_capped", "asc_more"} for a code.

    asc_share is 20% of the CY 2027 national ASC rate, exact (three decimals at most); opps_share
    is Addendum B's copayment capped at the Part A inpatient deductible. asc_more compares the two
    unrounded; it and any figure a file lacks are None."""
    cap = t.facts["deductibles"]["part_a_inpatient"]
    rate = t.asc_rates.get(code)
    asc_share = None if rate is None else round(rate * COINSURANCE, 3)
    copay = xs.copay(t.copays.get(code))
    opps_share = None if copay is None else min(copay, cap)
    return {"asc_rate": rate, "asc_share": asc_share, "opps_copay": copay, "opps_share": opps_share,
            "opps_capped": None if copay is None else copay > cap,
            "asc_more": None if None in (asc_share, opps_share) else asc_share > opps_share}


def shares_table(doc, t):
    deductibles = t.facts["deductibles"]
    codes = sorted(set(compared_codes(doc)) | set(t.additions))
    return {
        "meta": {
            "deductibles": {key: deductibles[key] for key in ("year", "part_a_inpatient", "part_b", "source", "url")},
            "asc_share": "20% of the CY 2027 national ASC payment rate (Addendum AA), unrounded",
            "opps_share": ("CY 2027 Addendum B national unadjusted copayment, or where CMS prints none, its minimum "
                           "unadjusted copayment (20% of the national rate), capped at the Part A inpatient deductible"),
            "units": ("dollars; asc_rate, opps_copay and opps_share to two decimals as CMS prints them, "
                      "asc_share exact (up to three decimals)"),
            "sources": [source_meta("asc-2027-aa"), source_meta("addenda-2027")],
            "counts": {"codes": len(codes), "compared": len(compared_codes(doc)), "asc_new_2027": len(t.additions)},
        },
        "codes": {code: patient_share(code, t) for code in codes},
    }


def assemble(doc, removed, t):
    """{file name: document} for the four derived tables."""
    hospitals = hospitals_table(t)
    hospitals["meta"]["drg_weights"] = drg_weights(doc, t)
    hospitals["meta"]["rates"] = {key: doc["meta"]["rates"][key] for key in HOSPITAL_RATES}
    return {HOSPITALS: hospitals, VOLUME: volume_table(doc, t, hospitals["hospitals"]),
            ASC_NEW: asc_new_table(removed, t), SHARES: shares_table(doc, t)}
