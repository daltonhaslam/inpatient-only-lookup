#!/usr/bin/env python3
"""Build the committed history tables from the raw CMS files and reconcile them against CMS's own counts.

Reads   data/raw/ (gitignored), pipeline/sources.json, pipeline/rules.json
Writes  pipeline/derived/periods.json      one row per Addendum B snapshot
        pipeline/derived/ipo-history.json  events and dated spans for every code ever on the list
        pipeline/derived/other-codes.json  first/last period for codes never on the list
        pipeline/derived/years.json        the year-by-year ledger shown on the History page
        pipeline/out/checks.txt            the reconciliation report
Exits non-zero if any check fails.
"""
import json
import sys
from pathlib import Path

import citations
import fetch
import history
import parse

ROOT = Path(__file__).resolve().parent.parent
DERIVED = ROOT / "pipeline" / "derived"
OUT = ROOT / "pipeline" / "out"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n")


class Report:
    def __init__(self):
        self.lines = []
        self.failures = 0

    def section(self, title):
        self.lines += ["", title, "-" * len(title)]

    def check(self, ok, text):
        if not ok:
            self.failures += 1
        self.lines.append("%s  %s" % ("ok  " if ok else "FAIL", text))

    def note(self, text):
        self.lines.append("      " + text)


def year_ledger(periods, snapshots, rules):
    """One entry per calendar year: what changed on January 1 and during the year."""
    years = {}
    for index, period in enumerate(periods):
        year = int(period["date"][:4])
        entry = years.setdefault(year, {
            "year": year, "start": None, "end": None, "basis": period["basis"],
            "january": None, "midyear": [],
        })
        count = len(history.ipo_codes(snapshots[index]))
        entry["end"] = count
        if index == 0:
            entry["start"] = count
            continue
        change = history.transition(snapshots[index - 1], snapshots[index])
        if period["date"].endswith("-01-01"):
            entry["start"] = count
            entry["january"] = change
        elif any(change.values()):
            entry["midyear"].append({"date": period["date"], **change})
    stated = {rule["cy"]: rule.get("stated", {}) for rule in rules}
    ledger = []
    for year in sorted(years):
        entry = years[year]
        entry["stated"] = stated.get(year, {})
        ledger.append(entry)
    return ledger


def reconcile(report, sources, periods, snapshots, ledger, rules):
    by_id = {source["id"]: source for source in sources}
    january = {int(p["date"][:4]): i for i, p in enumerate(periods) if p["date"].endswith("-01-01")}

    report.section("1. Each file's workbook and its text copy list the same inpatient-only codes")
    patterns = {"addendum_b": history.ADDENDUM_B, "rule_addenda": history.ADDENDUM_E, "removal_file": history.REMOVAL}
    for source in sources:
        pattern = patterns.get(source["kind"])
        if pattern is None:
            continue
        path = fetch.raw_path(source)
        book = parse.pick_member(path, pattern, prefer_spreadsheet=True)
        text = parse.pick_member(path, pattern, prefer_spreadsheet=False)
        if book == text:
            continue
        a, b = parse.code_table(path, book), parse.code_table(path, text)
        if source["kind"] == "addendum_b":
            same = history.ipo_codes(a) == history.ipo_codes(b)
        else:
            same = set(a) == set(b)
        report.check(same, "%s" % source["id"])
        extra = sorted(set(a) ^ set(b))
        if same and extra:
            report.note("codes in only one copy (none inpatient-only): %s" % ", ".join(extra))

    report.section("2. Addendum E equals status indicator C in the same rule's Addendum B and in January's quarterly file")
    for source in sources:
        if source["kind"] != "rule_addenda":
            continue
        listed = history.addendum_e(source)
        path = fetch.raw_path(source)
        rule_b = history.ipo_codes(parse.code_table(path, parse.pick_member(path, history.ADDENDUM_B)))
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
        listed = set(history.removal_file(source))
        index = january[source["cy"]]
        computed = set(history.transition(snapshots[index - 1], snapshots[index])["removed"])
        report.check(listed == computed, "CY %d  removal file %d codes = %d computed removals" % (source["cy"], len(listed), len(computed)))
        if listed != computed:
            report.note("file only: %s; computed only: %s" % (sorted(listed - computed), sorted(computed - listed)))

    report.section("4. Counts CMS states in each final rule equal the counts computed from Addendum B")
    by_year = {entry["year"]: entry for entry in ledger}
    for rule in rules:
        entry = by_year.get(rule["cy"])
        for claim in rule.get("stated", []):
            change = entry["january"]
            computed = {
                "removed": lambda: len(change["removed"]),
                "new": lambda: len(change["new"]),
                "new+added": lambda: len(change["new"]) + len(change["added"]),
                "before": lambda: by_year[rule["cy"] - 1]["end"],
                "start_of_prior_year": lambda: by_year[rule["cy"] - 1]["start"],
            }[claim["compare"]]()
            adjust = claim.get("adjust", 0)
            text = "CY %d  %s: CMS says %d (%s); computed %d" % (rule["cy"], claim["what"], claim["count"], claim["cite"], computed)
            if adjust:
                text += " (%+d: %s)" % (adjust, claim["why"])
            report.check(computed == claim["count"] + adjust, text)

    report.section("5. Code lists printed in the Federal Register equal the changes computed from Addendum B")
    for rule in rules:
        table = rule.get("table")
        if not table:
            continue
        change = by_year[rule["cy"]]["january"]
        explained = {"removed": set(), "added": set()}
        for item in table.get("explained", []):
            explained[item["side"]].update(item["codes"])
        for side, computed in (("removed", set(change["removed"])), ("added", set(change["new"]) | set(change["added"]))):
            printed = set(table[side])
            unexplained = (printed ^ computed) - explained[side]
            stale = explained[side] - (printed ^ computed)
            report.check(not unexplained and not stale, "CY %d  %s (%s): %s %d printed, %d computed, %d difference(s) explained" % (
                rule["cy"], table["name"], table["pages"], side, len(printed), len(computed), len(printed ^ computed)))
            if unexplained:
                report.note("unexplained: %s" % sorted(unexplained))
            if stale:
                report.note("explanation no longer needed for: %s" % sorted(stale))
        if "remained_off" in table:
            still_off = set(table["remained_off"])
            report.check(not (still_off & set(change["added"])) and still_off <= set(snapshots[january[rule["cy"]]]),
                         "CY %d  %s: the %d codes it keeps off the list are not status C" % (rule["cy"], table["name"], len(still_off)))

    report.section("6. Year by year (computed from Addendum B status C)")
    report.lines.append("      year  Jan 1  removed  retired  new  added  mid-year new  Dec 31")
    for entry in ledger:
        change = entry["january"] or {"removed": [], "retired": [], "new": [], "added": []}
        mid = sum(len(m["new"]) + len(m["added"]) for m in entry["midyear"])
        report.lines.append("      %d  %5d  %7d  %7d  %3d  %5d  %12d  %6d" % (
            entry["year"], entry["start"], len(change["removed"]), len(change["retired"]),
            len(change["new"]), len(change["added"]), mid, entry["end"]))
        start = entry["start"]
        if entry["january"] is not None:
            index = january[entry["year"]]
            before = len(history.ipo_codes(snapshots[index - 1]))
            balanced = before - len(change["removed"]) - len(change["retired"]) + len(change["new"]) + len(change["added"]) == start
            report.check(balanced, "CY %d balances: %d - %d - %d + %d + %d = %d" % (
                entry["year"], before, len(change["removed"]), len(change["retired"]), len(change["new"]), len(change["added"]), start))


def main():
    sources = history.load_sources()
    rulebook = json.loads((ROOT / "pipeline" / "rules.json").read_text())
    rules = rulebook["rules"]
    exemption_ends = rulebook.get("exemption_ends", {})
    periods = history.build_periods(sources)
    snapshots = history.load_snapshots(sources, periods)

    ever = sorted(set().union(*[history.ipo_codes(s) for s in snapshots]))
    everything = set().union(*[set(s) for s in snapshots])
    ipo_history = {code: history.code_history(code, snapshots, periods, exemption_ends) for code in ever}
    other = {}
    for code in sorted(everything - set(ever)):
        present = [i for i, snapshot in enumerate(snapshots) if code in snapshot and snapshot[code]["si"] != history.DISCONTINUED]
        if present:
            other[code] = [present[0], present[-1]]

    ledger = year_ledger(periods, snapshots, rules)
    report = Report()
    report.lines.append("Inpatient-only list: reconciliation against CMS's files")
    report.lines.append("%d snapshots, %s to %s; %d codes ever on the list; %d other codes" % (
        len(periods), periods[0]["id"], periods[-1]["id"], len(ever), len(other)))
    reconcile(report, sources, periods, snapshots, ledger, rules)
    for code in exemption_ends:
        report.check(code in ipo_history, "exemption end date is for a code with list history: %s" % code)
    report.section("7. Every quoted Federal Register passage is on the page it cites")
    problems = citations.verify(sources)
    report.check(not problems, "%d quotes checked against the govinfo text of each rule" % len(citations.load()))
    for problem in problems:
        report.note(problem)

    write_json(DERIVED / "periods.json", periods)
    write_json(DERIVED / "ipo-history.json", ipo_history)
    write_json(DERIVED / "other-codes.json", other)
    write_json(DERIVED / "years.json", ledger)
    OUT.mkdir(parents=True, exist_ok=True)
    report.lines += ["", "%d check(s) failed" % report.failures if report.failures else "All checks passed."]
    (OUT / "checks.txt").write_text("\n".join(report.lines) + "\n")
    print("\n".join(report.lines))
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
