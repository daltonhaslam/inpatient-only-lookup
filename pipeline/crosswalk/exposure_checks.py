"""Fail-closed checks on the hospital-view and patient-share tables (exposure.py).

Each check adds lines to the crosswalk checks report (checks.Report), recomputing what it checks
from the pinned files and crosswalk.json rather than trusting the tables. Any FAIL stops build.py
from writing crosswalk.json and every derived table. Never print descriptor text.
"""
import collections

from crosswalk import checks
from crosswalk import exposure_sources as xs
from crosswalk.exposure import COINSURANCE, MARYLAND, compared_codes, crosswalk_drgs
from crosswalk.price import NATIONAL, hospital_drg_payment, hospital_outpatient, per_year

HOSPITALS = (3000, 3200)          # hospitals the picker offers
TEACHING_IN_FILE = 1327           # impact-file rows with TCHOP > 0 (spec, checked 11-18)
OHSU = "380009"
# The plan's fixture, to the cent: {DRG: (total, IME + DSH, operating IME or None)}.
OHSU_DRGS = {"165": (22116.60, 6067.07, 4632.08), "163": (51459.44, 14116.45, None)}
OHSU_APC_5183 = (3584.95, 3995.14)
OHSU_PER_YEAR = ("165", 10, 60670.69)       # 10 traditional cases' IME + DSH
OHSU_VOLUME = {"163": 15, "164": 34, "165": 11}
EXAMPLES = 8
NEW_HCPCS = ("NI", "NP", "NC")     # Addendum DD2: new codes for the next calendar year


def run(report, doc, tables, removed, t):
    """Add every check to report. doc is crosswalk.json, tables exposure.assemble's output,
    removed {code: removal date}, t exposure.load_tables()."""
    hospitals = tables["hospitals.json"]
    _hospitals(report, hospitals, t)
    _states(report, hospitals, t)
    _fixture(report, doc, tables, t)
    _national(report, doc)
    _volume(report, doc, tables["drg-volume.json"], hospitals, t)
    _asc_new(report, tables["asc-new-2027.json"], removed, t)
    _shares(report, doc, tables["patient-shares.json"], t)
    _descriptors(report, tables, t)


def _hospitals(report, table, t):
    offered, maryland, counts = table["hospitals"], table["maryland"], table["meta"]["counts"]
    problems = []
    low, high = HOSPITALS
    if not low <= len(offered) <= high:
        problems.append("%d hospitals offered, expected %d-%d" % (len(offered), low, high))
    in_file = sum(1 for row in t.impact.values() if row["tchop"] > 0)
    if in_file != TEACHING_IN_FILE:
        problems.append("%d impact-file rows with TCHOP > 0, expected %d" % (in_file, TEACHING_IN_FILE))
    teaching = sum(1 for ccn, row in t.impact.items() if row["tchop"] > 0 and not ccn.startswith(MARYLAND))
    if (counts["teaching"], counts["teaching_in_file"]) != (teaching, in_file):
        problems.append("teaching counts %s, file gives %d offered and %d in all" % (counts, teaching, in_file))
    problems += ["%s: Maryland hospital offered" % ccn for ccn in offered if ccn.startswith(MARYLAND)]
    if sorted(maryland) != sorted(ccn for ccn in t.impact if ccn.startswith(MARYLAND)):
        problems.append("the Maryland list is not every CCN starting %s" % MARYLAND)
    problems += ["%s: factors differ from the impact file" % ccn
                 for ccn, row in offered.items() if t.impact.get(ccn) != row]
    if set(offered) | set(maryland) != set(t.impact):
        problems.append("hospitals plus Maryland is not the impact file")
    report.check("hospitals from the impact file", problems,
                 "%d offered (%d in the file less %d in Maryland); %d teaching (%d in the file with TCHOP > 0)" % (
                     len(offered), len(t.impact), len(maryland), counts["teaching"], in_file))


def _states(report, table, t):
    """The state from the CCN agrees with the state CMS gives in the 2024 discharge file."""
    problems = []
    for ccn, row in list(table["hospitals"].items()) + list(table["maryland"].items()):
        state = row["state"]
        if state != xs.state_of(ccn):
            problems.append("%s: state %s, CCN gives %s" % (ccn, state, xs.state_of(ccn)))
        listed = t.mup_states.get(ccn)
        if listed and listed != state:
            problems.append("%s: CCN gives %s, 2024 discharge file says %s" % (ccn, state, listed))
    both = sum(1 for ccn in table["hospitals"] if ccn in t.mup_states)
    report.check("hospital states", problems,
                 "from the CCN; agree with the 2024 discharge file for the %d hospitals in both" % both)


def _fixture(report, doc, tables, t):
    """OHSU (380009) to the cent, from the table that ships, crosswalk.json meta.rates and Table 5."""
    rates, problems = doc["meta"]["rates"], []
    ohsu = tables["hospitals.json"]["hospitals"].get(OHSU)
    if ohsu is None:
        report.check("OHSU fixture", ["%s not offered" % OHSU], "")
        return
    for drg, (total, addons, ime_operating) in OHSU_DRGS.items():
        paid = hospital_drg_payment(t.table5[drg]["weight"], ohsu, rates)
        found = (round(paid["total"], 2), round(paid["addons"], 2),
                 round(paid["ime_operating"], 2) if ime_operating is not None else None)
        if found != (total, addons, ime_operating):
            problems.append("DRG %s: %s, expected %s" % (drg, found, (total, addons, ime_operating)))
    rate, expected = OHSU_APC_5183
    labor = tables["hospitals.json"]["meta"]["opps_labor_share"]
    if round(hospital_outpatient(rate, ohsu["wi"], labor), 2) != expected:
        problems.append("APC 5183 at OHSU is not $%s" % expected)
    drg, count, expected = OHSU_PER_YEAR
    if per_year(count, hospital_drg_payment(t.table5[drg]["weight"], ohsu, rates)["addons"]) != expected:
        problems.append("%d cases of DRG %s: add-ons per year are not $%s" % (count, drg, expected))
    volume = tables["drg-volume.json"]["volume"].get(OHSU, {})
    if {drg: volume.get(drg) for drg in OHSU_VOLUME} != OHSU_VOLUME:
        problems.append("2024 discharges for DRGs 163-165: %s" % {drg: volume.get(drg) for drg in OHSU_VOLUME})
    report.check("OHSU fixture", problems, "DRG 165 $22,116.60 (IME + DSH $6,067.07, operating IME $4,632.08); DRG 163 "
                 "$51,459.44 ($14,116.45); APC 5183 $3,995.14; 10 cases of DRG 165 $60,670.69 a year; 2024 counts 15/34/11")


def _national(report, doc):
    """With no hospital, the hospital formula gives every DRG amount in crosswalk.json to the cent."""
    rates, problems, rows = doc["meta"]["rates"], [], 0
    for code, entry in sorted(doc["codes"].items()):
        for family in (entry["inpatient"] or {}).get("families", []):
            for row in family["drgs"]:
                rows += 1
                found = round(hospital_drg_payment(row["weight"], NATIONAL, rates)["total"], 2)
                if found != row["amount"]:
                    problems.append("%s DRG %s: %s, crosswalk.json has %s" % (code, row["drg"], found, row["amount"]))
    report.check("national mode reproduces every DRG amount", problems,
                 "%d DRG rows: wage index 1, GAF 1, no IME or DSH" % rows)


def _volume(report, doc, table, hospitals, t):
    used, offered = set(crosswalk_drgs(doc)), hospitals["hospitals"]
    problems = []
    for ccn, counts in table["volume"].items():
        if ccn not in offered:
            problems.append("%s: not an offered hospital" % ccn)
        for drg, count in counts.items():
            if drg not in t.table5 or drg not in used:
                problems.append("%s DRG %s: not a crosswalk DRG with a Table 5 weight" % (ccn, drg))
            if t.volume.get(ccn, {}).get(drg) != count:
                problems.append("%s DRG %s: %s, file has %s" % (ccn, drg, count, t.volume.get(ccn, {}).get(drg)))
    for ccn, counts in t.volume.items():
        kept = {drg: n for drg, n in counts.items() if drg in used}
        if kept and table["volume"].get(ccn) != kept and ccn not in table["meta"]["dropped"]:
            problems.append("%s: in the 2024 file, neither in the table nor listed as dropped" % ccn)
    dropped = collections.Counter(table["meta"]["dropped"].values())
    report.check("2024 DRG volume", problems, "%d hospitals, %d hospital-DRG counts over %d crosswalk DRGs; dropped: %s" % (
        len(table["volume"]), table["meta"]["counts"]["rows"], len(used),
        ", ".join("%d %s" % (n, why) for why, n in sorted(dropped.items())) or "none"))


def _asc_new(report, table, removed, t):
    """CMS's list of CY 2027 ASC additions reconciles to 91 FR 70665: the 618 IPO removals the
    CY 2027 Addendum AA lists, plus CPT 64629 named on top of them."""
    fact = t.facts["asc_additions_2027"]
    additions = set(t.additions)
    ipo = {code for code in additions if removed.get(code) == "2027-01-01"}
    extra = sorted(additions - ipo)
    problems = []
    if len(ipo) != fact["count"]:
        problems.append("%d IPO removals on the list, the rule states %d" % (len(ipo), fact["count"]))
    if not set(extra) <= set(fact["also_added"]):
        problems.append("%d codes on the list beyond the IPO removals (only %s accepted): %s" % (
            len(extra), ", ".join(fact["also_added"]), ", ".join(extra[:EXAMPLES])))
    on_aa = {code for code in t.asc_2027 if removed.get(code) == "2027-01-01"}
    if on_aa != ipo:
        problems.append("2027 IPO removals on Addendum AA but not on the list: %s; on the list but not on AA: %s" % (
            sorted(on_aa - ipo)[:EXAMPLES], sorted(ipo - on_aa)[:EXAMPLES]))
    problems += ["%s: not on the CY 2027 Addendum AA" % code for code in sorted(additions - set(t.asc_2027))]
    problems += ["%s: already on the CY 2026 Addendum AA" % code for code in sorted(additions & set(t.asc_2026))]
    problems += ["%s: a new HCPCS code (comment indicator %s)" % (code, t.asc_2027[code]["ci"])
                 for code in sorted(additions & set(t.asc_2027)) if t.asc_2027[code]["ci"] in NEW_HCPCS]
    if sorted(table["codes"]) != sorted(additions) or table["meta"]["ipo_removed_2027"] != len(ipo):
        problems.append("asc-new-2027.json is not CMS's list")
    report.check("CY 2027 ASC additions reconcile to the rule", problems, "%d codes: %d removed from the IPO list for 2027 "
                 "(91 FR 70665 states %d) + %s; none on the CY 2026 AA, none new to HCPCS" % (
                     len(additions), len(ipo), fact["count"], ", ".join(extra) or "nothing else"))
    # The file-difference rule the spec first proposed, for the reviewer.
    diff = set(t.asc_2027) - set(t.asc_2026)
    rule = {code for code in diff if t.asc_2027[code]["ci"] != "NI"}
    others = rule - additions
    by_ci = collections.Counter(t.asc_2027[code]["ci"] or "blank" for code in others)
    report.info("CY 2027 AA less CY 2026 AA, less comment indicator NI", (
        "%d codes, not %d: the additions plus %d others (%s). NC and NP mark new HCPCS codes too (Addendum DD2); "
        "a blank indicator marks no change from the current year") % (
        len(rule), len(additions), len(others), ", ".join("%d %s" % (n, ci) for ci, n in sorted(by_ci.items()))))
    blank = sorted(code for code in ipo if t.asc_2027[code]["ci"] == "")
    if blank:
        report.info("IPO removals added with a blank comment indicator",
                    "%d (expected CH): %s" % (len(blank), ", ".join(blank)))


def _shares(report, doc, table, t):
    """Each share recomputed from Addendum AA, Addendum B and the deductible in facts.json."""
    cap = t.facts["deductibles"]["part_a_inpatient"]
    compared = compared_codes(doc)
    codes = sorted(set(compared) | set(t.additions))
    rows, problems = table["codes"], []
    if sorted(rows) != codes:
        problems.append("codes are not the compared codes plus the CY 2027 ASC additions")
    for code in codes:
        rate, listed = t.asc_rates.get(code), t.copays.get(code) or {}
        copay = listed["national"] if listed.get("national") is not None else listed.get("minimum")
        asc = None if rate is None else round(rate * COINSURANCE, 3)
        opps = None if copay is None else min(copay, cap)
        expected = {"asc_rate": rate, "asc_share": asc, "opps_copay": copay, "opps_share": opps,
                    "opps_capped": None if copay is None else copay > cap,
                    "asc_more": None if asc is None or opps is None else asc > opps}
        if rows.get(code) != expected:
            problems.append("%s: shares do not recompute" % code)
    report.check("patient shares recompute", problems, (
        "%d codes; ASC share 20%% of the CY 2027 ASC rate, hospital share Addendum B copayment capped at $%s; "
        "the ASC costs the patient more for %d") % (len(codes), format(cap, ","),
                                                   sum(1 for r in rows.values() if r["asc_more"])))
    report.info("compared codes without an ASC rate", "%d of %d" % (
        sum(1 for code in compared if rows[code]["asc_rate"] is None), len(compared)))
    report.info("hospital outpatient shares capped", "%d codes' copayment is above $%s" % (
        sum(1 for r in rows.values() if r["opps_capped"]), format(cap, ",")))
    _copay_vs_rate(report, codes, t)


def _copay_vs_rate(report, codes, t):
    """For the reviewer: Addendum B copayments that are not 20% of the national rate."""
    cents, more, national = [], [], []
    for code in codes:
        row, rate = t.copays.get(code), (t.opps.get(code) or {}).get("rate")
        if not row or rate is None or xs.copay(row) is None:
            continue
        if row["national"] is not None:
            national.append(code)
        gap = round(xs.copay(row) - round(rate * COINSURANCE, 2), 2)
        if gap:
            (cents if abs(gap) <= 0.01 else more).append(code)
    report.info("Addendum B copayment vs 20% of the rate", (
        "of the %d codes: %d use the national unadjusted copayment (the rest CMS's minimum); %d differ by one cent "
        "(e.g. %s); %d by more (%s)") % (len(codes), len(national), len(cents), ", ".join(cents[:EXAMPLES]) or "none",
                                         len(more), ", ".join(more[:EXAMPLES]) or "none"))


def _descriptors(report, tables, t):
    known = checks._all_descriptors()
    codes = set(tables["patient-shares.json"]["codes"]) | set(t.additions)
    grams = checks.descriptor_grams(text for code in codes for text in known.get(code, ()))
    texts = [item for name, table in sorted(tables.items()) for item in checks._strings(table, name)]
    hits = [where for where, text in texts if checks.copies_descriptor(text, grams)]
    report.check("no CPT descriptor text in the hospital and patient-share tables", hits,
                 "%d strings against the descriptors of %d codes" % (len(texts), len(codes)))
