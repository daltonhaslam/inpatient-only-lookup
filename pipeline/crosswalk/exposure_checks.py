"""Fail-closed checks on the hospital-view and patient-share tables (exposure.py).

Each check adds lines to the crosswalk checks report (checks.Report), recomputing what it checks
from the pinned files and crosswalk.json rather than trusting the tables. Any FAIL stops build.py
from writing crosswalk.json and every derived table. Never print descriptor text.
"""
import collections

from crosswalk import checks, exposure
from crosswalk import exposure_sources as xs
from crosswalk.exposure import ASC_NEW, COINSURANCE, HOSPITAL_RATES, HOSPITALS, MARYLAND, SHARES, VOLUME
from crosswalk.exposure import compared_codes, crosswalk_drgs, patient_share
from crosswalk.price import NATIONAL, hospital_drg_payment, hospital_outpatient, per_year

EXAMPLES = 8
# Addendum DD2 comment indicators that mark a code new to HCPCS for the next year: NI (interim
# indicator), NP (proposed) and NC (final, after comment). The spec named only NI, but all three
# mean "new code", and the rule's additions are existing codes. Safe: this only fails the check
# if a code on CMS's additions list carries one of them.
NEW_HCPCS = ("NI", "NP", "NC")


def run_all(report, doc, removed):
    """Read the pinned files, assemble the derived tables and check them into report. Returns
    {file name: table}, or {} when reading or checking raised (a FAIL line names the error)."""
    step = "read"
    try:
        t = exposure.load_tables()
        tables = exposure.assemble(doc, removed, t)
        step = "check"
        run(report, doc, tables, removed, t)
    except Exception as error:      # noqa: BLE001 - any error must still leave a report that says so
        report.check("hospital and patient-share tables %s" % step, ["%s: %s" % (type(error).__name__, error)],
                     "the pinned files exposure.py reads and the checks on its tables")
        return {}
    return tables


def run(report, doc, tables, removed, t):
    """Add every check to report. doc is crosswalk.json, tables exposure.assemble's output,
    removed {code: removal date}, t exposure.load_tables()."""
    hospitals = tables[HOSPITALS]
    _hospitals(report, hospitals, t)
    _states(report, hospitals, t)
    _fixture(report, doc, tables, t)
    _national(report, doc)
    _weights(report, doc, hospitals)
    _rates(report, doc, hospitals)
    _volume(report, doc, tables[VOLUME], hospitals, t)
    _asc_new(report, tables[ASC_NEW], removed, t)
    _shares(report, doc, tables[SHARES], t)
    _descriptors(report, tables, t)


def _hospitals(report, table, t):
    offered, maryland, counts = table["hospitals"], table["maryland"], table["meta"]["counts"]
    expected = t.facts["expected"]
    problems = []
    low, high = expected["hospitals_offered"]
    if not low <= len(offered) <= high:
        problems.append("%d hospitals offered, expected %d-%d" % (len(offered), low, high))
    in_file = teaching = 0
    for ccn, row in t.impact.items():
        if row["tchop"] > 0:
            in_file += 1
            teaching += not ccn.startswith(MARYLAND)
    if in_file != expected["teaching_in_file"]:
        problems.append("%d impact-file rows with TCHOP > 0, expected %d" % (in_file, expected["teaching_in_file"]))
    if (counts["teaching"], counts["teaching_in_file"]) != (teaching, in_file):
        problems.append("teaching counts %s, file gives %d offered and %d in all" % (counts, teaching, in_file))
    problems += ["%s: Maryland hospital offered" % ccn for ccn in offered if ccn.startswith(MARYLAND)]
    if sorted(maryland) != sorted(ccn for ccn in t.impact if ccn.startswith(MARYLAND)):
        problems.append("the Maryland list is not every CCN starting %s" % MARYLAND)
    if set(offered) | set(maryland) != set(t.impact):
        problems.append("hospitals plus Maryland is not the impact file")
    report.check("hospitals from the impact file", problems,
                 "%d offered (%d in the file less %d in Maryland); %d teaching (%d in the file with TCHOP > 0)" % (
                     len(offered), len(t.impact), len(maryland), counts["teaching"], in_file))


def _states(report, table, t):
    """The state from the CCN agrees with the state CMS gives in the 2024 discharge file."""
    problems = []
    for ccn, row in list(table["hospitals"].items()) + list(table["maryland"].items()):
        listed = t.mup_states.get(ccn)
        if listed and listed != row["state"]:
            problems.append("%s: CCN gives %s, 2024 discharge file says %s" % (ccn, row["state"], listed))
    both = sum(1 for ccn in table["hospitals"] if ccn in t.mup_states)
    report.check("hospital states", problems,
                 "from the CCN; agree with the 2024 discharge file for the %d hospitals in both" % both)


def _dollars(value):
    return "$" + format(value, ",.2f")


def _fixture(report, doc, tables, t):
    """The plan's OHSU anchors (facts.json expected.ohsu) to the cent, from the table that ships (its
    hospital row and meta.rates, which _rates holds to crosswalk.json's) and Table 5."""
    rates, fixture, problems = tables[HOSPITALS]["meta"]["rates"], t.facts["expected"]["ohsu"], []
    ohsu = tables[HOSPITALS]["hospitals"].get(fixture["ccn"])
    if ohsu is None:
        report.check("OHSU fixture", ["%s not offered" % fixture["ccn"]], "")
        return
    details = []
    for drg, want in fixture["drgs"].items():
        paid = hospital_drg_payment(t.table5[drg]["weight"], ohsu, rates)
        found = {key: round(paid[key], 2) for key in want}
        if found != want:
            problems.append("DRG %s: %s, expected %s" % (drg, found, want))
        operating = ", operating IME %s" % _dollars(want["ime_operating"]) if "ime_operating" in want else ""
        details.append("DRG %s %s (IME + DSH %s%s)" % (drg, _dollars(want["total"]), _dollars(want["addons"]), operating))
    apc = fixture["apc"]
    labor = tables[HOSPITALS]["meta"]["opps_labor_share"]
    if round(hospital_outpatient(apc["rate"], ohsu["wi"], labor), 2) != apc["at_hospital"]:
        problems.append("APC %s at OHSU is not %s" % (apc["apc"], _dollars(apc["at_hospital"])))
    year = fixture["per_year"]
    addons = hospital_drg_payment(t.table5[year["drg"]]["weight"], ohsu, rates)["addons"]
    if per_year(year["count"], addons) != year["addons"]:
        problems.append("%d cases of DRG %s: add-ons per year are not %s" % (
            year["count"], year["drg"], _dollars(year["addons"])))
    volume = tables[VOLUME]["volume"].get(fixture["ccn"], {})
    found = {drg: volume.get(drg) for drg in fixture["volume_2024"]}
    if found != fixture["volume_2024"]:
        problems.append("2024 discharges: %s, expected %s" % (found, fixture["volume_2024"]))
    report.check("OHSU fixture", problems, "%s; APC %s %s; %d cases of DRG %s %s a year; 2024 counts %s" % (
        "; ".join(details), apc["apc"], _dollars(apc["at_hospital"]), year["count"], year["drg"],
        _dollars(year["addons"]), "/".join(str(n) for _, n in sorted(fixture["volume_2024"].items()))))


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


def _weights(report, doc, table):
    """meta.drg_weights has exactly the crosswalk's DRGs, each with the weight every crosswalk.json
    row uses, so a DRG priced with two weights fails."""
    weights, problems = table["meta"]["drg_weights"], []
    if sorted(weights) != crosswalk_drgs(doc):
        problems.append("the weights are not for exactly the crosswalk's DRGs")
    for code, entry in sorted(doc["codes"].items()):
        for family in (entry["inpatient"] or {}).get("families", []):
            for row in family["drgs"]:
                if weights.get(row["drg"]) != row["weight"]:
                    problems.append("%s DRG %s: weight %s, hospitals.json has %s" % (
                        code, row["drg"], row["weight"], weights.get(row["drg"])))
    report.check("DRG weights for the hospital view", problems,
                 "%d DRGs in hospitals.json meta.drg_weights, each the weight every crosswalk.json row uses" % len(weights))


def _rates(report, doc, table):
    """hospitals.json meta.rates is exactly the crosswalk.json meta.rates the hospital formula reads."""
    shipped, source = table["meta"]["rates"], doc["meta"]["rates"]
    problems = [] if sorted(shipped) == sorted(HOSPITAL_RATES) else ["keys %s, expected %s" % (sorted(shipped), sorted(HOSPITAL_RATES))]
    problems += ["%s: %s, crosswalk.json has %s" % (key, shipped.get(key), source.get(key))
                 for key in HOSPITAL_RATES if shipped.get(key) != source.get(key)]
    report.check("IPPS rates for the hospital view", problems,
                 "hospitals.json meta.rates equals crosswalk.json meta.rates for %s" % ", ".join(HOSPITAL_RATES))


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
    if extra != sorted(fact["also_added"]):
        problems.append("codes on the list beyond the IPO removals are %s; the rule adds exactly %s" % (
            ", ".join(extra[:EXAMPLES]) or "none", ", ".join(fact["also_added"])))
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
    """Each share recomputed from Addendum AA, Addendum B and the deductible in facts.json (by
    exposure.patient_share, the one implementation)."""
    cap = t.facts["deductibles"]["part_a_inpatient"]
    compared = compared_codes(doc)
    codes = sorted(set(compared) | set(t.additions))
    rows = table["codes"]
    problems = ["%s: missing from the table" % code for code in codes if code not in rows]
    problems += ["%s: neither compared nor a CY 2027 ASC addition" % code for code in sorted(set(rows) - set(codes))]
    problems += ["%s: shares do not recompute" % code for code in codes
                 if code in rows and rows[code] != patient_share(code, t)]
    report.check("patient shares recompute", problems, (
        "%d codes; ASC share 20%% of the CY 2027 ASC rate, hospital share Addendum B copayment capped at $%s; "
        "the ASC costs the patient more for %d") % (len(codes), format(cap, ","),
                                                   sum(1 for r in rows.values() if r["asc_more"])))
    # Hand-checked anchors (facts.json expected.shares), independent of patient_share's formula.
    anchors = t.facts["expected"]["shares"]
    report.check("patient-share anchors", [
        "%s: %s, expected %s" % (code, {key: (rows.get(code) or {}).get(key) for key in want}, want)
        for code, want in sorted(anchors.items())
        if {key: (rows.get(code) or {}).get(key) for key in want} != want], ", ".join(sorted(anchors)))
    report.info("compared codes without an ASC rate", "%d of %d" % (
        sum(1 for code in compared if code in rows and rows[code]["asc_rate"] is None), len(compared)))
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
    codes = tables[SHARES]["codes"]      # the compared codes and the CY 2027 ASC additions
    texts = [item for name, table in sorted(tables.items()) for item in checks.strings(table, name)]
    checks.no_descriptor_text(report, "no CPT descriptor text in the hospital and patient-share tables",
                              texts, codes, "the hospital and patient-share tables")
