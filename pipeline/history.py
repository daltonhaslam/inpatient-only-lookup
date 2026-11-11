"""Turn CMS's addenda into a dated, code-level history of the inpatient-only (IPO) list.

The test for "inpatient only" is CMS's own: OPPS status indicator "C" in Addendum B.
A period is one Addendum B snapshot: a calendar quarter from January 2020 on, a calendar
year before that, and the newest final rule's Addendum B until its January file is posted.
"""
import datetime
import json
from pathlib import Path

import fetch
import parse

ROOT = Path(__file__).resolve().parent.parent
PIPELINE = ROOT / "pipeline"

IPO = "C"            # "Inpatient Procedures": not paid under OPPS
DISCONTINUED = "D"   # "Discontinued Codes"

ADDENDUM_B = r"addendum[ _-]*b(?![a-z])"
ADDENDUM_E = r"addendum[ _-]*e(?![a-z])"
REMOVAL = r"remov"

# Indefinite exemption: services removed on or after this date (42 CFR 412.3(d)(2)(ii)).
INDEFINITE_FROM = datetime.date(2021, 1, 1)
# Two-year exemption: services removed during CY 2020 (84 FR 61365; 85 FR 86300).
TWO_YEAR_FROM = datetime.date(2020, 1, 1)
# From the CY 2022 rule until the CY 2026 rule took effect, the regulation carried a two-year
# limit for removals "on or after January 1, 2020" (86 FR 63992) alongside the indefinite
# paragraph. CMS later said the indefinite exemption had remained in effect (90 FR 53829).
TWO_YEAR_TEXT_UNTIL = datetime.date(2026, 1, 1)


def load_sources():
    return json.loads((PIPELINE / "sources.json").read_text())["sources"]


def _table(source, pattern):
    path = fetch.raw_path(source)
    return parse.code_table(path, parse.pick_member(path, pattern))


def build_periods(sources):
    """Ordered periods, each {"id", "date", "source", "basis"}; a correction replaces its original."""
    quarters = {}
    for source in sources:
        if source["kind"] != "addendum_b":
            continue
        slot = quarters.setdefault(source["effective"], {})
        slot["correction" if source.get("corrects") else "original"] = source
    periods = []
    for effective, slot in quarters.items():
        chosen = slot.get("correction") or slot["original"]
        periods.append({"id": effective[:7], "date": effective, "source": chosen["id"], "basis": "quarterly"})
    first_quarter = min(quarters)
    last_quarter = max(quarters)
    for source in sources:
        if source["kind"] != "rule_addenda":
            continue
        january = "%d-01-01" % source["cy"]
        if january < first_quarter:
            periods.append({"id": january[:7], "date": january, "source": source["id"], "basis": "annual"})
        elif january > last_quarter:
            periods.append({"id": january[:7], "date": january, "source": source["id"], "basis": "final-rule"})
    periods.sort(key=lambda period: period["date"])
    return periods


def load_snapshots(sources, periods):
    by_id = {source["id"]: source for source in sources}
    return [_table(by_id[period["source"]], ADDENDUM_B) for period in periods]


def runs_for(code, snapshots):
    """Run-length encode a code's status indicator across periods: [[first period index, SI], ...].

    "" means the code is not in that period's Addendum B.
    """
    runs = []
    for index, snapshot in enumerate(snapshots):
        si = snapshot.get(code, {}).get("si", "")
        if not runs or runs[-1][1] != si:
            runs.append([index, si])
    return runs


def state_of(si):
    if si == IPO:
        return "ipo"
    if si in ("", DISCONTINUED):
        return "gone"
    return "off"


def _add_years(date, years):
    return date.replace(year=date.year + years)


def exemption_for(removed_on, ended_on=None):
    """The medical-review exemption that attaches to a removal date.

    Returns {"kind", "from", "through", "two_year_text"}. "through" is None while the exemption
    has no end date. "two_year_text" is the window, if any, in which the regulation's two-year
    paragraph would have ended the exemption had CMS not kept the indefinite one.
    """
    if removed_on >= INDEFINITE_FROM:
        through = ended_on - datetime.timedelta(days=1) if ended_on else None
        window = None
        lapse = _add_years(removed_on, 2)
        if lapse < TWO_YEAR_TEXT_UNTIL:
            window = {"from": lapse.isoformat(), "through": (TWO_YEAR_TEXT_UNTIL - datetime.timedelta(days=1)).isoformat()}
        return {"kind": "indefinite", "from": removed_on.isoformat(), "through": through.isoformat() if through else None, "two_year_text": window}
    if removed_on >= TWO_YEAR_FROM:
        through = _add_years(removed_on, 2) - datetime.timedelta(days=1)
        return {"kind": "two-year", "from": removed_on.isoformat(), "through": through.isoformat(), "two_year_text": None}
    return {"kind": "before-2020", "from": removed_on.isoformat(), "through": None, "two_year_text": None}


def code_history(code, snapshots, periods, exemption_ends=None):
    """Events and date spans for one code.

    events: [{"date", "type", "si"}] where type is one of
      listed    on the list in the first period we have
      new       a code that first appears already on the list
      added     an existing code newly put on the list
      returned  a code put back on the list after an earlier removal
      removed   taken off the list and still payable (the event the exemption attaches to)
      retired   the code leaves Addendum B, or is marked discontinued, while on the list
    spans: [{"from", "state", "si", "removed", "exemption"}], contiguous, each running to the next.
    """
    exemption_ends = exemption_ends or {}
    runs = runs_for(code, snapshots)
    dates = [datetime.date.fromisoformat(period["date"]) for period in periods]
    events = []
    spans = []
    removed_on = None      # date of the removal that the current off-list stretch began with
    was_listed = False
    previous = None
    for start, si in runs:
        state = state_of(si)
        date = dates[start]
        if state == "ipo":
            if previous is None:
                kind = "listed"
            elif previous == "gone" and not was_listed:
                kind = "new"
            elif was_listed:
                kind = "returned"
            else:
                kind = "added"
            events.append({"date": date.isoformat(), "type": kind, "si": si})
            was_listed = True
            removed_on = None
        elif previous == "ipo":
            if state == "off":
                removed_on = date
                events.append({"date": date.isoformat(), "type": "removed", "si": si})
            else:
                removed_on = None
                events.append({"date": date.isoformat(), "type": "retired", "si": si})
        elif state == "gone":
            removed_on = None
        span = {"from": date.isoformat(), "state": state, "si": si, "removed": None, "exemption": None}
        if state == "off" and removed_on is not None:
            span["removed"] = removed_on.isoformat()
            ended = exemption_ends.get(code)
            span["exemption"] = exemption_for(removed_on, datetime.date.fromisoformat(ended) if ended else None)
        spans.append(span)
        previous = state
    return {"events": events, "spans": spans}


def transition(before, after):
    """Classify every code whose list membership changes between two snapshots."""
    out = {"removed": [], "retired": [], "new": [], "added": []}
    for code in sorted(set(before) | set(after)):
        old = before.get(code, {}).get("si", "")
        new = after.get(code, {}).get("si", "")
        if old == IPO and new != IPO:
            out["removed" if state_of(new) == "off" else "retired"].append(code)
        elif new == IPO and old != IPO:
            out["new" if state_of(old) == "gone" else "added"].append(code)
    return out


def ipo_codes(snapshot):
    return {code for code, row in snapshot.items() if row["si"] == IPO}


def addendum_e(source):
    return set(_table(source, ADDENDUM_E))


def removal_file(source):
    return _table(source, REMOVAL)
