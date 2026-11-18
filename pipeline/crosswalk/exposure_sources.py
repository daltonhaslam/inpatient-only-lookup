"""Read the pinned CMS files behind the hospital view and the patient share.

Same contract as sources.py: each loader reads one source in data/raw/<id>/ (named in
SOURCE_OF), is cached (treat what it returns as read-only), and raises parse.ParseError when a
file no longer has the layout it had when this was written. These are kept out of sources.py on
purpose: build.py lists every sources.py source in crosswalk.json, and crosswalk.json (the
national view) must not change.

HCPCS/CPT short descriptors in the ASC and OPPS files are AMA-copyrighted and are never read
out. Hospital names are CMS's, as written in the impact file. Standard library only.
"""
import csv
import io
import re

import history
import parse
from crosswalk.sources import addendum_rows, at_least, cached, money, read_table, source_path

SOURCE_OF = {
    "load_impact": "ipps-2027-impact",          # FY 2027 impact file, correction-notice txt
    "load_drg_volume": "mup-inp-2024",          # Medicare Inpatient Hospitals by Provider and Service, DY2024
    "load_mup_states": "mup-inp-2024",
    "load_copays": "addenda-2027",              # CY2027 final Addendum B, copayment columns
    "load_asc_2026": "asc-2026-aa",             # CY2026 final ASC Addendum AA
    "load_asc_2027": "asc-2027-aa",             # CY2027 final ASC Addendum AA
    "load_asc_additions": "asc-2027-additions",  # CY2027 Final Additions to the List of ASC Covered Procedures
}

IMPACT_MEMBER = r"Impact File - Correction Notice\.txt$"
# The CY2027 file names it "CY 2027 ASC AA", the CY2026 one "Addendum AA".
ASC_AA_MEMBER = r"(?:asc|addendum)[ _-]*aa(?![a-z])"
ADDITIONS_MEMBER = r"additions to the list of asc covered procedures"

# CMS provider-number (CCN) state codes: the first two digits of the CCN. 67 is Texas's second
# code. Checked against the discharge file's own state column (exposure_checks).
CCN_STATES = {
    "01": "AL", "02": "AK", "03": "AZ", "04": "AR", "05": "CA", "06": "CO", "07": "CT", "08": "DE",
    "09": "DC", "10": "FL", "11": "GA", "12": "HI", "13": "ID", "14": "IL", "15": "IN", "16": "IA",
    "17": "KS", "18": "KY", "19": "LA", "20": "ME", "21": "MD", "22": "MA", "23": "MI", "24": "MN",
    "25": "MS", "26": "MO", "27": "MT", "28": "NE", "29": "NV", "30": "NH", "31": "NJ", "32": "NM",
    "33": "NY", "34": "NC", "35": "ND", "36": "OH", "37": "OK", "38": "OR", "39": "PA", "40": "PR",
    "41": "RI", "42": "SC", "43": "SD", "44": "TN", "45": "TX", "46": "UT", "47": "VT", "48": "VI",
    "49": "VA", "50": "WA", "51": "WV", "52": "WI", "53": "WY", "67": "TX",
}
# Provider Type key from the impact file's variable descriptions.
PROVIDER_TYPES = {0: "IPPS", 7: "Rural referral center", 8: "Indian Health Service", 14: "Medicare-dependent hospital",
                  15: "Medicare-dependent hospital and rural referral center", 16: "Sole community hospital",
                  17: "Sole community hospital and rural referral center", 21: "Essential access community hospital",
                  22: "Essential access community hospital and rural referral center"}
CCN_RE = re.compile(r"^\d{6}$")
# Each hospital factor: (key in the table, impact-file column). PAYMENT_FACTORS are the ones the
# per-case payment uses (price.hospital_drg_payment); the case counts give the MA ratio.
PAYMENT_FACTORS = (("wi", "FY 2027 Wage Index"), ("gaf", "GAF"), ("tchop", "TCHOP"), ("tchcp", "TCHCP"),
                   ("dshopp", "DSHOPP"), ("dshcpp", "DSHCPP"))
IMPACT_FACTORS = PAYMENT_FACTORS + (("caseta44", "CASETA44"), ("ime_caseta44", "IME_CASETA44"))
MUP_COLUMNS = ("Rndrng_Prvdr_CCN", "Rndrng_Prvdr_State_Abrvtn", "DRG_Cd", "Tot_Dschrgs")
MUP_SUPPRESSED_BELOW = 11


def state_of(ccn):
    """Postal abbreviation of a CCN's state, from its first two digits."""
    state = CCN_STATES.get(ccn[:2])
    if state is None:
        raise parse.ParseError("CCN %s: unknown state code %s" % (ccn, ccn[:2]))
    return state


def _number(text, what):
    try:
        return float(text)
    except ValueError:
        raise parse.ParseError("%s: not a number: %r" % (what, text)) from None


# ---------------------------------------------------------------- hospitals (FY 2027 impact file)

@cached
def load_impact():
    """{CCN: {"name", "state", "wi", "gaf", "tchop", "tchcp", "dshopp", "dshcpp", "caseta44",
    "ime_caseta44", "type"}}: every hospital in the FY 2027 impact file (correction notice),
    Maryland included. Factors are the file's numbers as written; name is None where CMS leaves
    it blank ("unknown", three rows), ime_caseta44 where CMS leaves that blank (no MA cases with
    IME); type is the Provider Type code (PROVIDER_TYPES)."""
    columns = {"ccn": r"^Provider Number$", "name": r"^Name$", "type": r"^Provider Type$"}
    columns.update({key: "^%s$" % re.escape(label) for key, label in IMPACT_FACTORS})
    hospitals = {}
    for row in read_table(SOURCE_OF["load_impact"], IMPACT_MEMBER, columns, prefer_spreadsheet=False):
        ccn = row["ccn"]
        if not ccn and not any(row.values()):
            continue
        if not CCN_RE.match(ccn) or ccn in hospitals:
            raise parse.ParseError("impact file: bad or repeated row for %r" % ccn)
        value = {"name": row["name"] or None, "state": state_of(ccn)}
        for key, label in IMPACT_FACTORS:
            if key == "ime_caseta44" and not row[key]:
                value[key] = None
                continue
            value[key] = _number(row[key], "%s %s" % (ccn, label))
            if value[key] < 0 or (key in ("wi", "gaf") and value[key] <= 0):
                raise parse.ParseError("impact file: %s %s is %s" % (ccn, label, row[key]))
        kind = int(_number(row["type"], "%s Provider Type" % ccn))
        if kind not in PROVIDER_TYPES:
            raise parse.ParseError("impact file: %s has an unknown Provider Type %s" % (ccn, row["type"]))
        value["type"] = kind
        hospitals[ccn] = value
    return at_least(hospitals, 3000, "FY 2027 impact file")


# ---------------------------------------------------------------- discharges (2024)

@cached
def _mup_rows():
    """The four columns read from the 2024 by-provider-and-service CSV, one tuple per row."""
    path = source_path(SOURCE_OF["load_drg_volume"])
    reader = csv.DictReader(io.StringIO(parse.decode(path.read_bytes()), newline=""))
    missing = [name for name in MUP_COLUMNS if name not in (reader.fieldnames or ())]
    if missing:
        raise parse.ParseError("%s: no column %s" % (path.name, ", ".join(missing)))
    rows = [tuple((row[name] or "").strip() for name in MUP_COLUMNS) for row in reader]
    return at_least(rows, 100000, path.name)


@cached
def load_drg_volume():
    """{CCN: {MS-DRG: traditional Medicare discharges in 2024}}, every DRG CMS publishes. CMS
    suppresses counts under 11, so a missing CCN or DRG means under 11 or none."""
    volume = {}
    for ccn, _, drg, count in _mup_rows():
        if not re.fullmatch(r"[0-9A-Z]{6}", ccn) or not re.fullmatch(r"\d{3}", drg) or not count.isdigit():
            raise parse.ParseError("2024 discharges: unexpected row %r" % ((ccn, drg, count),))
        drgs = volume.setdefault(ccn, {})
        if drg in drgs:
            raise parse.ParseError("2024 discharges: %s DRG %s listed twice" % (ccn, drg))
        if int(count) < MUP_SUPPRESSED_BELOW:
            raise parse.ParseError("2024 discharges: %s DRG %s has %s; CMS suppresses counts under %d"
                                   % (ccn, drg, count, MUP_SUPPRESSED_BELOW))
        drgs[drg] = int(count)
    return volume


@cached
def load_mup_states():
    """{CCN: the state CMS gives the hospital in the 2024 discharge file}."""
    states = {}
    for ccn, state, _, _ in _mup_rows():
        if states.setdefault(ccn, state) != state:
            raise parse.ParseError("2024 discharges: %s in two states" % ccn)
    return states


# ---------------------------------------------------------------- patient share (CY 2027)

@cached
def load_copays():
    """{HCPCS: {"national", "minimum"}} from CY2027 final Addendum B: the National Unadjusted
    Copayment and the Minimum Unadjusted Copayment (20% of the national rate), None where CMS
    prints "." or nothing."""
    columns = {"code": r"^HCPCS Code$", "national": r"^National Unadjusted Copayment$",
               "minimum": r"^Minimum Unadjusted Copayment$"}
    return addendum_rows(SOURCE_OF["load_copays"], history.ADDENDUM_B, columns,
                         lambda row: {"national": money(row["national"]), "minimum": money(row["minimum"])},
                         10000, "Addendum B copayments")


def copay(row):
    """The beneficiary copayment Addendum B gives for a code: the national unadjusted
    copayment, or where CMS prints none, the minimum unadjusted copayment; None for neither."""
    if not row:
        return None
    return row["national"] if row["national"] is not None else row["minimum"]


def _asc_aa(source_id):
    columns = {"code": r"^HCPCS Code$", "ci": r"Comment Indicator$", "pi": r"Payment Indicator$"}
    return addendum_rows(source_id, ASC_AA_MEMBER, columns,
                         lambda row: {"ci": row["ci"].upper(), "pi": row["pi"].upper()}, 4000, "Addendum AA")


@cached
def load_asc_2026():
    """{HCPCS: {"ci", "pi"}} every code on the CY2026 final ASC Addendum AA (CMS-1834-FC)."""
    return _asc_aa(SOURCE_OF["load_asc_2026"])


@cached
def load_asc_2027():
    """{HCPCS: {"ci", "pi"}} every code on the CY2027 final ASC Addendum AA, with its CY2027
    comment indicator (Addendum DD2: CH changed or newly payable in an ASC; NI, NP and NC new
    HCPCS codes; blank unchanged) and payment indicator. The rates are sources.load_asc."""
    return _asc_aa(SOURCE_OF["load_asc_2027"])


@cached
def load_asc_additions():
    """{HCPCS: payment indicator} CMS's Final Additions to the List of ASC Covered Procedures
    for CY 2027 (the 618 IPO removals and CPT 64629, 91 FR 70665)."""
    return addendum_rows(SOURCE_OF["load_asc_additions"], ADDITIONS_MEMBER, {"code": r"^HCPCS Code$", "pi": r"^PI$"},
                         lambda row: row["pi"].upper(), 100, "ASC additions")
