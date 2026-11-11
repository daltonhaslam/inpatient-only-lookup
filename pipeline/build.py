#!/usr/bin/env python3
"""Build the committed history tables from the raw CMS files and reconcile them against CMS's own counts.

Reads   data/raw/ (gitignored), pipeline/sources.json, pipeline/rules.json, pipeline/citations.json
Writes  pipeline/derived/periods.json      one row per Addendum B snapshot
        pipeline/derived/ipo-history.json  events and dated spans for every code ever on the list
        pipeline/derived/other-codes.json  first/last period for codes never on the list
        pipeline/derived/years.json        the year-by-year ledger shown on the History page
        pipeline/derived/reconciliation.json  CMS's stated counts and printed tables beside the computed ones
        pipeline/out/checks.txt            the reconciliation report
Exits non-zero if any check fails, and then leaves pipeline/derived/ untouched.
"""
import sys

import citations
import fetch
import history
import parse

DERIVED = fetch.PIPELINE / "derived"
OUT = fetch.PIPELINE / "out"
NO_CHANGE = {"removed": [], "retired": [], "new": [], "added": []}


class Report:
    def __init__(self):
        self.lines = []
        self.failures = 0
        self.checks = 0
        self.rows = []      # comparisons the site shows: {"year", "what", "cms", "computed", "cite", "note"}

    def section(self, title):
        self.lines += ["", title, "-" * len(title)]

    def check(self, ok, text):
        self.checks += 1
        if not ok:
            self.failures += 1
        self.lines.append("%s  %s" % ("ok  " if ok else "FAIL", text))

    def note(self, text):
        self.lines.append("      " + text)


def year_ledger(periods, snapshots):
    """One entry per calendar year: the list's size, what changed on January 1 and during the year.

    "january" is None for the first year, which has nothing before it to compare with.
    """
    years = {}
    for index, period in enumerate(periods):
        year = int(period["date"][:4])
        count = len(history.ipo_codes(snapshots[index]))
        entry = years.setdefault(year, {"year": year, "start": count, "end": count, "basis": period["basis"],
                                        "january": None, "midyear": []})
        entry["end"] = count
        if index == 0:
            continue
        change = history.transition(snapshots[index - 1], snapshots[index])
        if history.is_january(period):
            entry["january"] = change
        elif any(change.values()):
            entry["midyear"].append({"date": period["date"], **change})
    return [years[year] for year in sorted(years)]


# What a count stated in a final rule is compared with: (this year's ledger entry, last year's).
COMPARATORS = {
    "removed": lambda this, last: len(this["january"]["removed"]),
    "new": lambda this, last: len(this["january"]["new"]),
    "new+added": lambda this, last: len(this["january"]["new"]) + len(this["january"]["added"]),
    "before": lambda this, last: last["end"],
    "start_of_prior_year": lambda this, last: last["start"],
}


def reconcile(report, sources, periods, snapshots, ledger, rules):
    january = {int(p["date"][:4]): i for i, p in enumerate(periods) if history.is_january(p)}
    by_year = {entry["year"]: entry for entry in ledger}

    report.section("1. Each table's workbook and its text copy agree")
    for source in sources:
        for which, pattern in history.MEMBERS.get(source["kind"], {}).items():
            path = fetch.raw_path(source)
            book = parse.pick_member(path, pattern, prefer_spreadsheet=True)
            text = parse.pick_member(path, pattern, prefer_spreadsheet=False)
            if book == text:
                continue
            a, b = parse.code_table(path, book), parse.code_table(path, text)
            # Addendum B: same inpatient-only codes. The short tables: same codes.
            same = history.ipo_codes(a) == history.ipo_codes(b) if which == "b" else set(a) == set(b)
            report.check(same, "%s (%s)" % (source["id"], which))
            extra = sorted(set(a) ^ set(b))
            if same and extra:
                report.note("codes in only one copy (none inpatient-only): %s" % ", ".join(extra))

    report.section("2. Addendum E equals status indicator C in the same rule's Addendum B and in January's quarterly file")
    for source in sources:
        if source["kind"] != "rule_addenda":
            continue
        listed = set(history.table(source, "e"))
        rule_b = history.ipo_codes(history.table(source, "b"))
        report.check(listed == rule_b, "CY %d  Addendum E %d codes = final-rule Addendum B status C %d" % (source["cy"], len(listed), len(rule_b)))
        index = january.get(source["cy"])
        if index is not None and periods[index]["basis"] == "quarterly":
            quarter = history.ipo_codes(snapshots[index])
            report.check(listed == quarter, "CY %d  Addendum E %d codes = January %d Addendum B status C %d" % (source["cy"], len(listed), source["cy"], len(quarter)))
            if listed != quarter:
                report.note("only in Addendum E: %s; only in January file: %s" % (sorted(listed - quarter), sorted(quarter - listed)))

    report.section("3. CMS's removal files equal the codes that leave status C and stay payable")
    for source in sources:
        if source["kind"] != "removal_file":
            continue
        listed = set(history.table(source, "removal"))
        computed = set((by_year[source["cy"]]["january"] or NO_CHANGE)["removed"])
        report.check(listed == computed, "CY %d  removal file %d codes = %d computed removals" % (source["cy"], len(listed), len(computed)))
        if listed != computed:
            report.note("file only: %s; computed only: %s" % (sorted(listed - computed), sorted(computed - listed)))

    report.section("4. Counts CMS states in each final rule equal the counts computed from Addendum B")
    for rule in rules:
        this, last = by_year.get(rule["cy"]), by_year.get(rule["cy"] - 1)
        for claim in rule.get("stated", []):
            label = "CY %d  %s: CMS says %d (%s)" % (rule["cy"], claim["what"], claim["count"], claim["cite"])
            if claim["compare"] not in COMPARATORS or not this or not last or this["january"] is None:
                report.check(False, label + "; nothing to compare it with (compare=%r)" % claim["compare"])
                continue
            computed = COMPARATORS[claim["compare"]](this, last)
            adjust = claim.get("adjust", 0)
            text = label + "; computed %d" % computed
            if adjust:
                text += " (%+d: %s)" % (adjust, claim["why"])
            report.check(computed == claim["count"] + adjust, text)
            report.rows.append({"year": rule["cy"], "what": claim["what"], "cms": claim["count"], "computed": computed,
                                "cite": claim["cite"], "note": claim.get("why", "")})

    report.section("5. Code lists printed in the Federal Register equal the changes computed from Addendum B")
    for rule in rules:
        printed_table = rule.get("table")
        if not printed_table:
            continue
        change = by_year[rule["cy"]]["january"]
        explained = {"removed": set(), "added": set()}
        for item in printed_table.get("explained", []):
            explained[item["side"]].update(item["codes"])
        for side, computed in (("removed", set(change["removed"])), ("added", set(change["new"]) | set(change["added"]))):
            printed = set(printed_table[side])
            unexplained = (printed ^ computed) - explained[side]
            stale = explained[side] - (printed ^ computed)
            report.check(not unexplained and not stale, "CY %d  %s (%s): %s %d printed, %d computed, %d difference(s) explained" % (
                rule["cy"], printed_table["name"], printed_table["pages"], side, len(printed), len(computed), len(printed ^ computed)))
            if printed or side == "removed":
                differences = len(printed ^ computed)
                report.rows.append({"year": rule["cy"], "what": "codes %s, as printed in %s" % (side, printed_table["name"]),
                                    "cms": len(printed), "computed": len(computed), "cite": printed_table["pages"].split("-")[0],
                                    "note": "%d difference%s, explained on the Methods page" % (differences, "" if differences == 1 else "s") if differences else ""})
            if unexplained:
                report.note("unexplained: %s" % sorted(unexplained))
            if stale:
                report.note("explanation no longer needed for: %s" % sorted(stale))
        if "remained_off" in printed_table:
            still_off = set(printed_table["remained_off"])
            snapshot = snapshots[january[rule["cy"]]]
            report.check(still_off <= set(snapshot) and not (still_off & history.ipo_codes(snapshot)),
                         "CY %d  %s: the %d codes it keeps off the list are not status C" % (rule["cy"], printed_table["name"], len(still_off)))

    report.section("6. Year by year (computed from Addendum B status C)")
    report.lines.append("      year  Jan 1  removed  retired  new  added  mid-year new  Dec 31")
    for entry in ledger:
        change = entry["january"] or NO_CHANGE
        mid = sum(len(m["new"]) + len(m["added"]) for m in entry["midyear"])
        report.lines.append("      %d  %5d  %7d  %7d  %3d  %5d  %12d  %6d" % (
            entry["year"], entry["start"], len(change["removed"]), len(change["retired"]),
            len(change["new"]), len(change["added"]), mid, entry["end"]))


def main():
    sources = fetch.load_sources()
    rulebook = fetch.load_rules()
    periods = history.build_periods(sources)
    snapshots = history.load_snapshots(sources, periods)

    listed = sorted(set().union(*[history.ipo_codes(s) for s in snapshots]))
    ipo_history = {code: history.code_history(code, snapshots, periods, rulebook["exemption_regimes"], rulebook["exemption_ends"])
                   for code in listed}
    other = history.other_codes(snapshots, listed)
    ledger = year_ledger(periods, snapshots)

    report = Report()
    report.lines.append("Inpatient-only list: reconciliation against CMS's files")
    report.lines.append("%d snapshots, %s to %s; %d codes ever on the list; %d other codes" % (
        len(periods), periods[0]["id"], periods[-1]["id"], len(listed), len(other)))
    reconcile(report, sources, periods, snapshots, ledger, rulebook["rules"])

    report.section("7. Every quoted Federal Register passage is on the page it cites")
    problems = citations.verify(sources)
    report.check(not problems, "%d quotes checked against the govinfo text of each rule" % len(citations.load()))
    for problem in problems:
        report.note(problem)
    for code in rulebook["exemption_ends"]:
        report.check(code in ipo_history, "exemption end date is for a code with list history: %s" % code)

    OUT.mkdir(parents=True, exist_ok=True)
    if report.failures:
        # The site is built from the derived tables: never replace them with unreconciled data.
        report.lines += ["", "%d check(s) failed. pipeline/derived/ was left as it was." % report.failures]
    else:
        fetch.write_json(DERIVED / "periods.json", periods)
        fetch.write_json(DERIVED / "ipo-history.json", ipo_history)
        fetch.write_json(DERIVED / "other-codes.json", other)
        fetch.write_json(DERIVED / "years.json", ledger)
        fetch.write_json(DERIVED / "reconciliation.json", {
            "rows": sorted(report.rows, key=lambda row: row["year"]), "checks": report.checks, "quotes": len(citations.load())})
        report.lines += ["", "All checks passed."]
    (OUT / "checks.txt").write_text("\n".join(report.lines) + "\n")
    print("\n".join(report.lines))
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
