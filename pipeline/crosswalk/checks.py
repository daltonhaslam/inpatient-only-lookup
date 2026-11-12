"""Fail-closed checks on an assembled crosswalk.json (see build.py).

Each check recomputes what it checks from the pinned CMS files and the mapping passes, not from
the code that assembled the document, and writes one line: "ok <name>: detail", "FAIL <name>:
detail" (followed by the first problems), "skip <name>: reason" or "info <name>: detail". Any
FAIL stops build.py from writing crosswalk.json.

Never print descriptor text: the checks file is committed. Standard library + openpyxl.
"""
import functools
import re

import fetch
import history
import parse
from crosswalk import group as grouper
from crosswalk import mappings, sources
from crosswalk.price import drg_payment

EXPECTED_REMOVALS = {"2026-01-01": 285, "2027-01-01": 637}
DRG165_BAND = (10000.0, 25000.0)
PUBLISHED_DRG165 = 20000.0      # a published hand-worked lobectomy example (report-only)
SHOWN = 12                      # problems listed under a FAIL line
RUN = 5                         # consecutive words that count as copying a descriptor
# Shortest text whose equality with a whole descriptor counts as a copy. Two-word descriptors
# are generic terms ("breast reconstruction"), which labels.json family names may share.
EQUAL_WORDS = 3
TEAM = "team-2027"


class Report:
    def __init__(self):
        self.lines = []
        self.failures = 0

    def check(self, name, problems, detail):
        if not problems:
            self.lines.append("ok %s: %s" % (name, detail))
            return
        self.failures += 1
        self.lines.append("FAIL %s: %s; %d problem(s)" % (name, detail, len(problems)))
        self.lines += ["    - %s" % problem for problem in problems[:SHOWN]]
        if len(problems) > SHOWN:
            self.lines.append("    ... and %d more" % (len(problems) - SHOWN))

    def skip(self, name, reason):
        self.lines.append("skip %s: %s" % (name, reason))

    def info(self, name, detail):
        self.lines.append("info %s: %s" % (name, detail))


def run(doc, inputs, allow_missing=False):
    """Run every check on doc (the assembled crosswalk) against inputs (build.load_inputs)."""
    report = Report()
    codes = doc["codes"]
    _codes_present(report, codes, inputs)
    finals = _final_mappings(report, codes, inputs, allow_missing)
    combos = _combinations(finals, inputs.ref)
    _mapped_codes(report, codes, finals, inputs.ref)
    _families(report, codes, finals, combos, inputs.ref)
    _index_rows(report, combos, inputs.ref)
    _drgs(report, codes, inputs.ref)
    _medical_exclusions(report, inputs.ref)
    _outpatient(report, codes, inputs)
    _differences(report, codes)
    _batches(report, doc, inputs)
    _known_cases(report, codes, allow_missing)
    _drg165(report, inputs.ref)
    _descriptors(report, doc, inputs)
    _team(report, combos)
    return report


def _families_of(entry):
    return (entry["inpatient"] or {}).get("families", [])


# ---------------------------------------------------------------- codes and mappings

def _codes_present(report, codes, inputs):
    problems = ["%s missing" % code for code in sorted(set(inputs.removed) - set(codes))]
    problems += ["%s is not a 2026/2027 removal" % code for code in sorted(set(codes) - set(inputs.removed))]
    problems += ["%s removed %s, file says %s" % (code, inputs.removed[code], entry["removed"])
                 for code, entry in sorted(codes.items()) if code in inputs.removed and entry["removed"] != inputs.removed[code]]
    by_date = {date: sum(1 for d in inputs.removed.values() if d == date) for date in EXPECTED_REMOVALS}
    problems += ["%d codes removed %s, expected %d" % (by_date[date], date, count)
                 for date, count in EXPECTED_REMOVALS.items() if by_date[date] != count]
    report.check("all removed codes present once", problems, "%d codes (%s)" % (
        len(codes), ", ".join("%d removed %s" % (by_date[date], date) for date in EXPECTED_REMOVALS)))


def _final_mappings(report, codes, inputs, allow_missing):
    """{code: final record} for the mappable codes that have a valid one."""
    finals, waiting, disagree, invalid = {}, [], [], []
    for code in inputs.mappable:
        in_passes = [inputs.passes.get(name, {}).get(code) for name in mappings.PASS_NAMES]
        try:
            rec = mappings.final_mapping(code, inputs.passes, inputs.adjudications, inputs.ref)
        except ValueError as error:
            if code not in inputs.adjudications and None in in_passes:
                waiting.append(code)
            else:
                disagree.append(str(error))
            continue
        errors = mappings.validate_record(rec, inputs.ref)
        if rec.get("code") != code:
            errors.append("record is for %r" % rec.get("code"))
        if errors:
            invalid.append("%s: %s" % (code, "; ".join(errors)))
            continue
        finals[code] = rec
    name = "final mapping for every mappable code"
    detail = "%d of %d mappable codes; %d disagree (not adjudicated), %d invalid, %d not yet in both passes" % (
        len(finals), len(inputs.mappable), len(disagree), len(invalid), len(waiting))
    blocking = disagree + invalid
    if allow_missing and waiting and not blocking:
        report.skip(name, "--allow-missing given; " + detail)
    elif allow_missing:
        report.check(name, blocking, detail)
    else:
        report.check(name, blocking + ["%s: not yet in both passes" % code for code in waiting], detail)
    return finals


def _mapped_codes(report, codes, finals, ref):
    """The document's mapping block matches the final record, and PCS and ICD-10-CM codes and titles are FY2027's."""
    problems, pcs_bad, dx_bad = [], [], []
    for code, entry in sorted(codes.items()):
        rec = finals.get(code)
        mapping = entry["mapping"]
        if rec is None or not rec["mappable"]:
            if mapping is not None or entry["inpatient"] is not None:
                problems.append("%s has a mapping block but no mappable final record" % code)
            continue
        if mapping is None:
            problems.append("%s: final record not in the file" % code)
            continue
        if mapping["fp"] != mappings.fingerprint(rec):
            problems.append("%s: fingerprint %s, record gives %s" % (code, mapping["fp"], mappings.fingerprint(rec)))
        if [[c["code"] for c in s["codes"]] for s in mapping["pcs_sets"]] != [s["codes"] for s in rec["pcs_sets"]]:
            problems.append("%s: PCS sets differ from the final record" % code)
        if [d["code"] for d in mapping["principal_dx"]] != [d["code"] for d in rec["principal_dx"]]:
            problems.append("%s: principal diagnoses differ from the final record" % code)
        for item in (c for s in mapping["pcs_sets"] for c in s["codes"]):
            if ref.pcs.get(item["code"]) != item["title"]:
                pcs_bad.append("%s: %s" % (code, item["code"]))
        for item in mapping["principal_dx"] + [f["dx"] for f in _families_of(entry)]:
            if item["code"] not in ref.dx_mdc or ref.cm.get(item["code"]) != item["title"]:
                dx_bad.append("%s: %s" % (code, item["code"]))
    report.check("mappings match the passes", problems, "%d codes mapped" % len(finals))
    report.check("PCS codes valid FY2027", pcs_bad, "every PCS code is in the FY2027 order file with its title")
    report.check("principal diagnoses valid FY2027", dx_bad,
                 "every diagnosis is a billable FY2027 ICD-10-CM code with a v44 MDC, with its title")


def _combinations(finals, ref):
    """[(code, dx, pcs_set, group result or error text)] for every mappable final record."""
    combos = []
    for code, rec in sorted(finals.items()):
        if not rec["mappable"]:
            continue
        for dx in sorted(rec["principal_dx"], key=lambda d: d["role"] != "typical"):
            for entry in rec["pcs_sets"]:
                try:
                    result = grouper.group(entry["codes"], dx["code"], ref)
                except ValueError as error:
                    result = str(error)
                combos.append((code, dx, entry, result))
    return combos


def _families(report, codes, finals, combos, ref):
    """Regrouping every PCS set x diagnosis gives exactly the families in the file, typical diagnosis first."""
    expected, sets_of = {}, {}
    problems = []
    for code, dx, entry, result in combos:
        if isinstance(result, str):
            problems.append("%s: %s x %s does not group: %s" % (code, "+".join(entry["codes"]), dx["code"], result))
            continue
        key = (dx["code"], tuple(result["drgs"]), result["mdc"], result["basis"])
        expected.setdefault(code, set()).add(key)
        sets_of.setdefault((code,) + key, []).append(entry["codes"])
    for code, rec in sorted(finals.items()):
        if not rec["mappable"]:
            continue
        families = _families_of(codes[code])
        found = {(f["dx"]["code"], tuple(row["drg"] for row in f["drgs"]), f["mdc"], f["basis"]) for f in families}
        if found != expected.get(code, set()):
            problems.append("%s: families in the file differ from regrouping" % code)
        for family in families:
            rows = family.get("index_rows") or []
            key = (code, family["dx"]["code"], tuple(row["drg"] for row in family["drgs"]), family["mdc"], family["basis"])
            if [row["pcs"] for row in rows] not in sets_of.get(key, []) or not all(_is_index_row(row, ref) for row in rows):
                problems.append("%s: index rows of family %s are not v44 Appendix E rows of a set that groups to it"
                                % (code, "-".join(key[2])))
        typical = next(d["code"] for d in rec["principal_dx"] if d["role"] == "typical")
        if families and families[0]["dx"]["code"] != typical:
            problems.append("%s: first family is not for the typical diagnosis" % code)
    report.check("inpatient families regroup", problems, "%d PCS set x diagnosis combinations" % len(combos))


def _is_index_row(row, ref):
    """An index_rows entry is a real v44 row: the code's Appendix E Part 1 row, or the Part 2
    row of the cluster it names (which must contain the code); a note-only entry has no row."""
    if row["mdc"] is None:
        return not row["drgs"] and bool(row.get("note"))
    shown = (row["mdc"], tuple(row["drgs"]), row["family"])
    if "cluster" in row:
        members = row["cluster"].split("+")
        return row["pcs"] in members and any(
            shown == (r["mdc"], tuple(r["drgs"]), r["family"])
            for r in ref.clusters_for(members).get(row["cluster"], ()))
    return any(shown == (r["mdc"], tuple(r["drgs"]), r["family"]) for r in ref.proc_index.get(row["pcs"], ()))


def _index_rows(report, combos, ref):
    """Each family is backed by v44: an Appendix E Part 1 row of one of the set's codes, or a
    Part 2 row of a cluster the set completes, in the family's MDC naming its DRGs (Pre-MDC rows
    for Pre-MDC); an OR code for the any-OR and unrelated families; and no OR code for a medical
    family. OR codes are Appendix E codes without * that no completed Part 3 combination makes non-OR."""
    problems = []
    for code, dx, entry, result in combos:
        if isinstance(result, str):
            continue
        drgs, mdc, basis = set(result["drgs"]), result["mdc"], result["basis"]
        present = set(entry["codes"])
        made_non_or = {pcs for combo in ref.non_or_combos if set(combo) <= present for pcs in combo}
        or_codes = [pcs for pcs in entry["codes"] if pcs in ref.unrelated and pcs not in made_non_or]
        rows = [row for pcs in entry["codes"] for row in ref.proc_index.get(pcs, ())
                if row["mdc"] == mdc and drgs & set(row["drgs"])]
        rows += [row for found in ref.clusters_for(entry["codes"]).values() for row in found
                 if row["mdc"] == mdc and drgs & set(row["drgs"])]
        if basis == "medical":
            ok = not or_codes
        elif basis.startswith("unrelated") or (basis == "in-mdc" and tuple(result["drgs"]) in grouper.ANY_OR_FAMILIES):
            ok = bool(or_codes)
        else:
            ok = bool(rows)
        if not ok:
            problems.append("%s: %s x %s -> %s %s (%s) has no v44 support" % (
                code, "+".join(entry["codes"]), dx["code"], mdc, "-".join(result["drgs"]), basis))
    report.check("PCS codes in the v44 index for the family's MDC", problems,
                 "every family traced to Appendix E rows or the OR designation")


# ---------------------------------------------------------------- dollars

def _drgs(report, codes, ref):
    rates = ref.rates
    base = rates["operating_wi_gt1"] + rates["capital"]
    missing, titles, amounts = [], [], []
    for code, entry in sorted(codes.items()):
        families = _families_of(entry)
        for family in families:
            for row in family["drgs"]:
                drg = row["drg"]
                if drg not in ref.table5:
                    missing.append("%s: DRG %s" % (code, drg))
                    continue
                info = ref.drg_titles.get(drg)
                if not info or info["title"] != row["title"] or info["mdc"] not in (None, family["mdc"]):
                    titles.append("%s: DRG %s" % (code, drg))
                if row["weight"] != ref.table5[drg]["weight"] or row["amount"] != round(ref.table5[drg]["weight"] * base, 2):
                    amounts.append("%s: DRG %s amount %s" % (code, drg, row["amount"]))
            values = [row["amount"] for row in family["drgs"]]
            if not values or (family["low"], family["high"]) != (min(values), max(values)):
                amounts.append("%s: family %s low/high" % (code, family["family"]))
        if families and (entry["inpatient"]["low"], entry["inpatient"]["high"]) != (
                min(f["low"] for f in families), max(f["high"] for f in families)):
            amounts.append("%s: code low/high" % code)
        elif entry["inpatient"] is not None and not families:
            amounts.append("%s: inpatient block with no family" % code)
    report.check("DRGs in Table 5", missing, "every family DRG has an FY2027 CN Table 5 weight")
    report.check("DRG titles and MDCs match v44", titles, "titles from Appendix A; each DRG in its family's MDC")
    report.check("DRG amounts recompute", amounts, "weight x ($%s operating + $%s capital), to the cent" % (
        format(rates["operating_wi_gt1"], ",.2f"), format(rates["capital"], ",.2f")))


def _medical_exclusions(report, ref):
    """Every DRG the grouper holds back as needing a procedure or a discharge status is a medical
    DRG in Appendix A, so a typo there cannot silently stop the exclusion from applying."""
    named = (("procedure-defined", grouper.NEEDS_PROCEDURE), ("discharge-status", grouper.NEEDS_DISCHARGE_STATUS))
    problems = ["%s DRG %s is not a medical DRG in Appendix A" % (what, drg)
                for what, drgs in named for drg in sorted(drgs) if ref.drg_titles.get(drg, {}).get("type") != "MED"]
    report.check("grouper's medical exclusions are medical DRGs", problems,
                 "%d procedure-defined and %d discharge-status DRGs" % tuple(len(drgs) for _, drgs in named))


def _outpatient(report, codes, inputs):
    ref = inputs.ref
    apc, asc, proposed, packaged = [], [], [], []
    for code, entry in sorted(codes.items()):
        out = entry["outpatient"]
        row = ref.opps.get(code) or {}
        if (out["si"], out["apc"], out["rate"]) != (row.get("si"), row.get("apc"), row.get("rate")) or \
                out["apc_title"] != (ref.apc_titles.get(row["apc"]) if row.get("apc") else None):
            apc.append(code)
        if out["asc"] != ref.asc.get(code):
            asc.append(code)
        if out["proposed"] != (dict(ref.opps_proposed[code]) if code in ref.opps_proposed else None):
            proposed.append(code)
        is_packaged = code in inputs.packaged
        if out["packaged"] != is_packaged or (is_packaged and any(entry[k] is not None for k in ("mapping", "inpatient", "difference"))):
            packaged.append(code)
    report.check("APC rates equal Addendum B", apc, "SI, APC, title and national rate from CY 2027 final Addenda A and B")
    report.check("ASC rates equal Addendum AA", asc, "%d codes with an ASC rate" % sum(1 for e in codes.values() if e["outpatient"]["asc"] is not None))
    if ref.opps_proposed:
        report.check("proposed rates equal proposed Addendum B", proposed, "CY 2027 proposed rule")
    else:
        report.skip("proposed rates equal proposed Addendum B", "proposed Addendum B not downloaded")
    report.check("packaged codes have no comparison", packaged, "%d packaged (SI N or anesthesia)" % len(inputs.packaged))


def _differences(report, codes):
    problems = []
    for code, entry in sorted(codes.items()):
        rate, inpatient = entry["outpatient"]["rate"], entry["inpatient"]
        if entry["outpatient"]["packaged"] or rate is None or inpatient is None:
            expected = None
        else:
            expected = {"low": round(rate - inpatient["high"], 2), "high": round(rate - inpatient["low"], 2)}
        if entry["difference"] != expected:
            problems.append(code)
    report.check("differences recompute", problems, "outpatient rate minus inpatient high and low")


def _batches(report, doc, inputs):
    problems, seen = [], {}
    for batch in doc["meta"]["batches"]:
        if len(batch["codes"]) > 10 or not re.fullmatch(r"%s-\d+" % re.escape(batch["group"]), batch["id"]):
            problems.append("batch %s" % batch["id"])
        for code in batch["codes"]:
            if code in seen or doc["codes"][code]["batch"] != batch["id"] or doc["codes"][code]["group"] != batch["group"]:
                problems.append("%s in batch %s" % (code, batch["id"]))
            seen[code] = batch["id"]
    if set(seen) != set(inputs.mappable):
        problems.append("batches hold %d codes, %d are mappable" % (len(seen), len(inputs.mappable)))
    problems += ["%s has batch %s" % (code, entry["batch"]) for code, entry in sorted(doc["codes"].items())
                 if code not in seen and entry["batch"] is not None]
    report.check("review batches", problems, "%d batches of at most 10 codes" % len(doc["meta"]["batches"]))


# ---------------------------------------------------------------- reference cases

def _known_cases(report, codes, allow_missing):
    """The three worked examples the crosswalk was specified with."""
    name = "known cases 32480, 44150, 48150"
    lobectomy, colectomy, whipple = (codes.get(code) or {} for code in ("32480", "44150", "48150"))
    unmapped = [code for code, entry in (("32480", lobectomy), ("44150", colectomy), ("48150", whipple))
                if not entry.get("inpatient")]
    if unmapped and allow_missing:
        report.skip(name, "--allow-missing given; no mapping yet for %s" % ", ".join(unmapped))
        return
    problems = ["%s has no inpatient family" % code for code in unmapped]

    def drgs(entry):
        return [(f["dx"]["code"], [row["drg"] for row in f["drgs"]]) for f in _families_of(entry)]

    out = lobectomy.get("outpatient") or {}
    if (out.get("apc"), out.get("rate")) != ("5183", 3584.95):
        problems.append("32480 outpatient is not APC 5183 at $3,584.95")
    if lobectomy.get("inpatient") and any(d != ["163", "164", "165"] for _, d in drgs(lobectomy)):
        problems.append("32480 groups outside 163-165")
    if colectomy.get("inpatient") and ["329", "330", "331"] not in [d for _, d in drgs(colectomy)]:
        problems.append("44150 has no 329-331 family")
    if whipple.get("inpatient") and not any(dx.startswith("C25") and d == ["405", "406", "407"] for dx, d in drgs(whipple)):
        problems.append("48150 has no 405-407 family for a pancreatic cancer diagnosis")
    report.check(name, problems, "lobectomy 163-165 vs APC 5183 $3,584.95; colectomy 329-331; Whipple 405-407 for pancreatic cancer")


def _drg165(report, ref):
    amount = drg_payment("165", ref)
    low, high = DRG165_BAND
    report.check("DRG 165 sanity band", [] if low <= amount <= high else ["$%s" % format(amount, ",.2f")],
                 "national $%s within $%s-$%s (catches unit errors only)" % (
                     format(amount, ",.2f"), format(low, ",.0f"), format(high, ",.0f")))
    gap = PUBLISHED_DRG165 - amount
    report.info("DRG 165 vs the published example", (
        "national unadjusted $%s; a published hand-worked lobectomy example is about $%s; gap $%s (%.1f%% lower). "
        "Published examples usually include a hospital's wage index, IME and DSH.") % (
        format(amount, ",.2f"), format(PUBLISHED_DRG165, ",.0f"), format(gap, ",.2f"), 100 * gap / PUBLISHED_DRG165))


# ---------------------------------------------------------------- CPT descriptors

def words(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def descriptor_grams(texts):
    """(whole descriptors, every run of RUN consecutive words) as word tuples, for copies_descriptor."""
    whole, runs = set(), set()
    for text in texts:
        found = words(text)
        if found:
            whole.add(tuple(found))
        runs.update(tuple(found[i:i + RUN]) for i in range(len(found) - RUN + 1))
    return whole, runs


def copies_descriptor(text, grams):
    """True when text equals a descriptor (of EQUAL_WORDS words or more) or shares RUN consecutive
    words with one: the rule of pipeline/tests/test_raw.py::test_no_label_copies_a_cms_descriptor."""
    whole, runs = grams
    found = words(text)
    return (len(found) >= EQUAL_WORDS and tuple(found) in whole) or any(
        tuple(found[i:i + RUN]) in runs for i in range(len(found) - RUN + 1))


@functools.lru_cache(maxsize=None)
def _all_descriptors():
    """{code: {descriptor, ...}} from every Addendum B the project has (quarterly, final and
    proposed rule), via parse.descriptor_table. Local use only: never written anywhere."""
    found = {}
    tables = [(source, pattern) for source in fetch.load_sources()
              for which, pattern in history.MEMBERS.get(source["kind"], {}).items() if which != "e"]
    tables += [(source, history.ADDENDUM_B) for source in fetch.load_sources() if source["id"] == sources.SOURCE_OF["load_opps_proposed"]]
    for source, pattern in tables:
        path = fetch.raw_path(source)
        if not path.is_file():
            continue
        for code, texts in parse.descriptor_table(path, parse.pick_member(path, pattern)).items():
            found.setdefault(code, set()).update(texts)
    return found


def _strings(value, where):
    if isinstance(value, str):
        yield where, value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(item, "%s.%s" % (where, key))
    elif isinstance(value, list):
        for number, item in enumerate(value):
            yield from _strings(item, "%s[%d]" % (where, number))


def free_text(passes_dir, adjudications_path):
    """(where, text) for the free text of the mapping files: every string in the pass files and
    adjudications, and every line of the mappers' notes (passes_dir/../notes/*.md)."""
    paths = sorted(passes_dir.glob("*.json")) + sorted(passes_dir.glob("*/*.json"))
    if adjudications_path.is_file():
        paths.append(adjudications_path)
    for path in paths:
        yield from _strings(fetch.read_json(path), path.name if path.parent == passes_dir else "%s/%s" % (path.parent.name, path.name))
    notes = passes_dir.parent / "notes"
    for path in sorted(notes.glob("*.md")) if notes.is_dir() else []:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            yield "notes/%s:%d" % (path.name, number), line


def _descriptors(report, doc, inputs):
    known = _all_descriptors()
    grams = descriptor_grams(text for code in doc["codes"] for text in known.get(code, ()))
    texts = list(_strings(doc, "crosswalk.json")) + list(free_text(inputs.passes_dir, inputs.adjudications_path))
    hits = [where for where, text in texts if copies_descriptor(text, grams)]
    report.check("no CPT descriptor text", hits, "%d strings in crosswalk.json and the mapping files, against the CMS "
                 "descriptors of %d codes (equal, or %d consecutive words)" % (len(texts), len(doc["codes"]), RUN))


# ---------------------------------------------------------------- TEAM

_TEAM_TABLE = re.compile(r"^Table \d+[a-z]?\. List of (procedure|diagnosis) codes .* for MS-DRGs? ([\d ,-]+)$", re.I)


def team_procedures():
    """{PCS code: {MS-DRG, ...}} from the procedure-code tables of the TEAM MS-DRG mapping
    workbook, or None when it is not downloaded."""
    source = next((s for s in fetch.load_sources() if s["id"] == TEAM), None)
    path = fetch.raw_path(source) if source else None
    if path is None or not path.is_file():
        return None
    import openpyxl
    book = openpyxl.load_workbook(path, read_only=True)
    found = {}
    try:
        for sheet in book.worksheets:
            drgs = None
            for row in sheet.iter_rows(values_only=True):
                first = str(row[0] or "").strip() if row else ""
                title = _TEAM_TABLE.match(first)
                if title:
                    drgs = sources._expand(title.group(2).replace(" ", "")) if title.group(1).lower() == "procedure" else None
                elif drgs and sources.PCS_RE.match(first):
                    found.setdefault(first, set()).update(drgs)
    finally:
        book.close()
    return found


def _team(report, combos):
    """Compare families with TEAM's procedure tables where a mapped PCS code is in one. TEAM's
    tables state conditional reassignments (often needing a second code or a diagnosis), so a
    difference is listed for a reviewer, not failed."""
    name = "TEAM pairing"
    table = team_procedures()
    if table is None:
        report.skip(name, "data/raw/%s not downloaded" % TEAM)
        return
    overlap, differ = 0, []
    for code, dx, entry, result in combos:
        listed = set().union(*[table[pcs] for pcs in entry["codes"] if pcs in table])
        if not listed or isinstance(result, str):
            continue
        overlap += 1
        if not listed & set(result["drgs"]):
            differ.append("%s: %s x %s -> %s; TEAM lists %s" % (code, "+".join(entry["codes"]), dx["code"],
                                                                 "-".join(result["drgs"]), ",".join(sorted(listed))))
    if not overlap:
        report.skip(name, "no mapped PCS code is in a TEAM procedure table (%d codes in the tables)" % len(table))
    elif not differ:
        report.check(name, [], "%d PCS set x diagnosis combinations overlap TEAM's tables; all agree" % overlap)
    else:
        report.info(name, "%d combinations overlap TEAM's tables, %d differ (conditional reassignments; for a reviewer)"
                    % (overlap, len(differ)))
        report.lines += ["    - %s" % line for line in differ]
