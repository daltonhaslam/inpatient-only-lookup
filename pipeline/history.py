"""Turn CMS's addenda into a dated, code-level history of the inpatient-only (IPO) list.

The test for "inpatient only" is CMS's own: OPPS status indicator "C" in Addendum B.
A period is one Addendum B snapshot: a calendar quarter from January 2020 on, a calendar
year before that, and the newest final rule's Addendum B until its January file is posted.
A snapshot is {code: status indicator}.
"""
import datetime

import fetch
import parse

IPO = "C"            # CMS: "Inpatient Procedures. Not paid under OPPS."
DISCONTINUED = "D"   # CMS: "Discontinued Codes"

ADDENDUM_B = r"addendum[ _-]*b(?![a-z])"
ADDENDUM_E = r"addendum[ _-]*e(?![a-z])"
REMOVAL = r"remov"

# The tables each kind of zip carries, as filename patterns. Federal Register texts have none.
MEMBERS = {
    "addendum_b": {"b": ADDENDUM_B},
    "rule_addenda": {"e": ADDENDUM_E, "b": ADDENDUM_B},
    "removal_file": {"removal": REMOVAL},
}


def table(source, which):
    """One of a source's tables as {code: status indicator}; `which` is a key of MEMBERS[kind]."""
    path = fetch.raw_path(source)
    return parse.code_table(path, parse.pick_member(path, MEMBERS[source["kind"]][which]))


def build_periods(sources):
    """Ordered periods, each {"id", "date", "source", "basis"}.

    basis is "quarterly" (an Addendum B update; a file is replaced by the one whose "corrects"
    names it), "annual" (a final rule's Addendum B for a year before the quarterly files start)
    or "final-rule" (the newest rule's Addendum B, standing in until its January file is posted).
    """
    by_quarter = {}
    for source in sources:
        if source["kind"] == "addendum_b":
            by_quarter.setdefault(source["effective"], []).append(source)
    quarters = {}
    for effective, files in by_quarter.items():
        # The file in force is the one no other file corrects, whatever order they are listed in.
        corrected = {source.get("corrects") for source in files}
        current = [source for source in files if source["id"] not in corrected]
        if len(current) != 1:
            raise ValueError("%s: expected one current Addendum B, found %s" % (effective, [s["id"] for s in current]))
        quarters[effective] = current[0]
    periods = [{"id": effective[:7], "date": effective, "source": source["id"], "basis": "quarterly"}
               for effective, source in quarters.items()]
    first_quarter, last_quarter = min(quarters), max(quarters)
    for source in sources:
        if source["kind"] != "rule_addenda":
            continue
        january = "%d-01-01" % source["cy"]
        if january < first_quarter:
            basis = "annual"
        elif january > last_quarter:
            basis = "final-rule"
        elif january in quarters:
            continue    # the January quarterly file is the period; the rule is used for reconciliation
        else:
            raise ValueError("no January Addendum B for CY %d inside the quarterly range" % source["cy"])
        periods.append({"id": january[:7], "date": january, "source": source["id"], "basis": basis})
    periods.sort(key=lambda period: period["date"])
    return periods


def is_january(period):
    return period["date"].endswith("-01-01")


def load_snapshots(sources, periods):
    by_id = {source["id"]: source for source in sources}
    return [table(by_id[period["source"]], "b") for period in periods]


def ipo_codes(snapshot):
    return {code for code, si in snapshot.items() if si == IPO}


def state_of(si):
    """"ipo" (on the list), "gone" (not in the file, or discontinued) or "off" (any other status)."""
    if si == IPO:
        return "ipo"
    if si in ("", DISCONTINUED):
        return "gone"
    return "off"


def classify(old_si, new_si, was_listed=False):
    """Name the change in list membership between two consecutive snapshots, or None.

    removed   taken off the list and still in the file (the event the exemption attaches to)
    retired   leaves the file, or is marked discontinued, while on the list
    new       a code that first appears already on the list
    added     an existing code newly put on the list
    returned  put back on the list after an earlier removal (only told apart when was_listed is known)
    """
    old, new = state_of(old_si), state_of(new_si)
    if old == "ipo" and new != "ipo":
        return "removed" if new == "off" else "retired"
    if new == "ipo" and old != "ipo":
        if was_listed:
            return "returned"
        return "new" if old == "gone" else "added"
    return None


def transition(before, after):
    """Every code whose list membership changes between two snapshots, by kind of change."""
    out = {"removed": [], "retired": [], "new": [], "added": []}
    for code in sorted(set(before) | set(after)):
        kind = classify(before.get(code, ""), after.get(code, ""))
        if kind:
            out[kind].append(code)
    return out


def runs_for(code, snapshots):
    """Run-length encode a code's status indicator across periods: [[first period index, SI], ...].

    "" means the code is not in that period's Addendum B.
    """
    runs = []
    for index, snapshot in enumerate(snapshots):
        si = snapshot.get(code, "")
        if not runs or runs[-1][1] != si:
            runs.append([index, si])
    return runs


def exemption_for(removed_on, regimes, ended_on=None):
    """The medical-review exemption that attaches to a removal date.

    regimes is rules.json's "exemption_regimes": the last one whose removed_from is on or before
    the removal applies. Returns {"kind", "from", "through", "two_year_text"}:
      through        last day of the exemption, or None while it has no end date
      two_year_text  the window, if any, in which the regulation's two-year paragraph would have
                     ended the exemption had CMS not kept the indefinite one
    """
    regime = None
    for candidate in regimes:
        if datetime.date.fromisoformat(candidate["removed_from"]) <= removed_on:
            regime = candidate
    kind = regime["kind"] if regime else "before-2020"
    through = window = None
    if regime and regime.get("years"):
        through = removed_on.replace(year=removed_on.year + regime["years"]) - datetime.timedelta(days=1)
    elif regime and ended_on:
        through = ended_on - datetime.timedelta(days=1)
    if regime and regime.get("two_year_text_until"):
        lapse = removed_on.replace(year=removed_on.year + 2)
        until = datetime.date.fromisoformat(regime["two_year_text_until"])
        if lapse < until:
            window = {"from": lapse.isoformat(), "through": (until - datetime.timedelta(days=1)).isoformat()}
    return {"kind": kind, "from": removed_on.isoformat(),
            "through": through.isoformat() if through else None, "two_year_text": window}


def code_history(code, snapshots, periods, regimes, exemption_ends=None):
    """Events and date spans for one code.

    events: [{"date", "type", "si"}]; type is "listed" (on the list in the first period we have)
            or one of classify()'s names.
    spans:  [{"from", "state", "si", "removed", "exemption"}], contiguous, each running to the next.
            "removed" and "exemption" are set on off-list spans that follow a removal.
    exemption_ends: {code: first day the exemption no longer applies}; it ends the exemption of
            the code's removals before that day.
    """
    ended = (exemption_ends or {}).get(code)
    ended = datetime.date.fromisoformat(ended) if ended else None
    events, spans = [], []
    removed_on = None      # date of the removal that the current off-list stretch began with
    was_listed = False
    previous_si = None
    for start, si in runs_for(code, snapshots):
        date = datetime.date.fromisoformat(periods[start]["date"])
        state = state_of(si)
        if previous_si is None:
            kind = "listed" if state == "ipo" else None
        else:
            kind = classify(previous_si, si, was_listed)
        if kind:
            events.append({"date": date.isoformat(), "type": kind, "si": si})
        if kind == "removed":
            removed_on = date
        elif state == "ipo" or kind == "retired":
            removed_on = None
        was_listed = was_listed or state == "ipo"
        span = {"from": date.isoformat(), "state": state, "si": si, "removed": None, "exemption": None}
        if state == "off" and removed_on is not None:
            span["removed"] = removed_on.isoformat()
            span["exemption"] = exemption_for(removed_on, regimes, ended if ended and removed_on < ended else None)
        spans.append(span)
        previous_si = si
    return {"events": events, "spans": spans}


def other_codes(snapshots, listed):
    """{code: [first period index, last period index]} for codes that were never on the list."""
    out = {}
    for code in sorted(set().union(*snapshots) - set(listed)):
        present = [i for i, snapshot in enumerate(snapshots) if snapshot.get(code, DISCONTINUED) != DISCONTINUED]
        if present:
            out[code] = [present[0], present[-1]]
    return out
