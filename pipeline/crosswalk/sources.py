"""Read the pinned CMS files the revenue-at-stake crosswalk is built from.

Each loader reads one source in data/raw/<id>/ (named in SOURCE_OF), is cached (treat what it
returns as read-only), and raises parse.ParseError when a file no longer has the layout it had
when this was written, so a changed CMS file fails the build instead of leaving quiet gaps.

ICD-10-PCS, ICD-10-CM and MS-DRG titles are CMS public domain and are returned. The HCPCS/CPT
short descriptors in the OPPS and ASC addenda are AMA-copyrighted and are never read out.
Standard library only.
"""
import functools
import re
import warnings
import zipfile

import fetch
import history
import parse

# The pinned source (sources.json id) each loader reads.
SOURCE_OF = {
    "load_pcs": "pcs-2027",
    "load_cm": "cm-2027",
    "load_drg_titles": "msdrg-v44",        # Appendix A
    "load_table5": "ipps-2027-table5",     # CMS-1849-CN Table 5
    "load_rates": "ipps-2027-table1",      # CMS-1849-CN Tables 1A, 1B, 1D
    "load_proc_index": "msdrg-v44",        # Appendix E, Part 1 (with Appendix D titles)
    "load_hierarchy": "msdrg-v44",         # Appendix D
    "load_unrelated": "msdrg-v44",         # Appendix F (and Appendix E for the OR designation)
    "load_dx_mdc": "msdrg-v44",            # "MDC nn Assignment of Diagnosis Codes" in mdcs_*.txt
    "load_dx_drgs": "msdrg-v44",           # Appendix B
    "load_opps": "addenda-2027",           # CY2027 final Addendum B
    "load_apc_titles": "addenda-2027",     # CY2027 final Addendum A
    "load_asc": "asc-2027-aa",             # CY2027 final ASC Addendum AA
    "load_opps_proposed": "addenda-2027-proposed",   # CY2027 proposed Addendum B
}

PCS = r"[0-9A-HJ-NP-Z]{7}"                 # ICD-10-PCS has no I or O
CM = r"[A-Z][0-9A-Z]{2,6}"                # ICD-10-CM without the dot (FY2027 adds QA codes)
DRGS = r"\d{3}(?:-\d{3})?"                 # one MS-DRG or a range of them
PCS_RE = re.compile(r"^%s$" % PCS)
CM_RE = re.compile(r"^%s$" % CM)
PRE_MDC = "00"                             # Appendix D's number for Pre-MDC; elsewhere CMS writes "Pre"
MDC_FILES = ("mdcs_00_07", "mdcs_08_11", "mdcs_12_21", "mdcs_22_25")
# MDC 24 (multiple significant trauma) is assigned from several diagnoses, so it has no list.
ASSIGNED_MDCS = {"%02d" % n for n in range(1, 24)} | {"25"}
ADDENDUM_A = r"addendum[ _-]*a(?![a-z])"
ASC_AA = r"asc[ _-]*aa(?![a-z])"
cached = functools.lru_cache(maxsize=None)


# ---------------------------------------------------------------- helpers

def _path(source_id):
    for source in fetch.load_sources():
        if source["id"] == source_id:
            return fetch.raw_path(source)
    raise KeyError("no source %r in sources.json" % source_id)


def _lines(source_id, pattern):
    """The lines of one text member of a source's zip."""
    path = _path(source_id)
    member = parse.pick_member(path, pattern, prefer_spreadsheet=False)
    with zipfile.ZipFile(path) as archive:
        text = parse._decode(parse._read(archive, member))
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _find(lines, regex, start=0, what=None):
    """Index of the first line at or after start matching regex."""
    compiled = re.compile(regex)
    for number in range(start, len(lines)):
        if compiled.search(lines[number]):
            return number
    raise parse.ParseError("no line matching %r (%s)" % (regex, what or "layout changed?"))


def _table(source_id, pattern, columns, prefer_spreadsheet=True):
    """Rows of a CMS table as [{key: cell}], under the first header row in which each regex of
    columns ({key: regex}) matches exactly one label."""
    path = _path(source_id)
    member = parse.pick_member(path, pattern, prefer_spreadsheet)
    for _, rows in parse.read_member(path, member):
        for number, row in enumerate(rows[:40]):
            labels = [re.sub(r"\s+", " ", cell or "").strip() for cell in row]
            found = {}
            for key, regex in columns.items():
                hits = [index for index, label in enumerate(labels) if re.search(regex, label, re.I)]
                if len(hits) == 1:
                    found[key] = hits[0]
            if len(found) == len(columns):
                return [{key: parse._cell(r, index) for key, index in found.items()} for r in rows[number + 1:]]
    raise parse.ParseError("no header with columns %s in %s" % (sorted(columns), member))


def _money(text):
    """'$3,584.95' or '3584.95' -> 3584.95; blank or '.' -> None."""
    value = (text or "").strip().replace("$", "").replace(",", "")
    return None if value in ("", ".") else float(value)


def _expand(drgs):
    """'163-165' -> ['163', '164', '165']; '928-929,934' -> ['928', '929', '934']."""
    out = []
    for part in drgs.split(","):
        low, _, high = part.strip().partition("-")
        high = high or low
        if not (re.fullmatch(r"\d{3}", low) and re.fullmatch(r"\d{3}", high)) or int(high) < int(low):
            raise parse.ParseError("bad MS-DRG range %r" % drgs)
        out.extend("%03d" % number for number in range(int(low), int(high) + 1))
    return out


def _at_least(table, minimum, what):
    if len(table) < minimum:
        raise parse.ParseError("only %d entries parsed for %s" % (len(table), what))
    return table


# ---------------------------------------------------------------- code sets

def _order_file(source_id, pattern, code_re, what):
    """{valid code: long title} from a CMS ICD-10 order file. Fixed width: order number (5),
    code (7), valid flag (1 = valid for submission, 0 = header), short title (60), long title."""
    titles = {}
    for line in _lines(source_id, pattern):
        if not line.strip():
            continue
        code, flag, title = line[6:13].strip(), line[14:15], line[77:].strip()
        if not re.match(r"^\d{5} ", line) or flag not in ("0", "1") or not title:
            raise parse.ParseError("%s: unexpected line %r" % (what, line[:40]))
        if flag == "1":
            if not code_re.match(code) or code in titles:
                raise parse.ParseError("%s: bad or repeated code %r" % (what, code))
            titles[code] = title
    return _at_least(titles, 50000, what)


@cached
def load_pcs():
    """{ICD-10-PCS code valid in FY2027: long title}."""
    return _order_file(SOURCE_OF["load_pcs"], r"^icd10pcs_order_\d{4}\.txt$", PCS_RE, "ICD-10-PCS")


@cached
def load_cm():
    """{billable FY2027 ICD-10-CM code, no dot: long title}."""
    return _order_file(SOURCE_OF["load_cm"], r"^icd10cm_order_\d{4}\.txt$", CM_RE, "ICD-10-CM")


# ---------------------------------------------------------------- MS-DRG weights and rates

_DRG_TYPE = {"P": "SURG", "M": "MED", " ": None}


@cached
def load_drg_titles():
    """{"165": {"title", "mdc", "type"}} from v44 Appendix A. mdc is None for DRGs outside any
    MDC (Pre-MDC, 981-989, 998-999); type is "SURG", "MED", or None for 998 and 999."""
    titles = {}
    for line in _lines(SOURCE_OF["load_drg_titles"], r"^appendix_A\.txt$"):
        if not re.match(r"^\d{3} ", line):
            continue
        match = re.match(r"^(\d{3}) (\d\d| {2}) {2}([PM ]) {2}(\S.*?)\s*$", line)
        if not match or match.group(1) in titles:
            raise parse.ParseError("Appendix A: unexpected line %r" % line[:60])
        drg, mdc, kind, title = match.groups()
        titles[drg] = {"title": title, "mdc": mdc.strip() or None, "type": _DRG_TYPE[kind]}
    return _at_least(titles, 700, "Appendix A")


@cached
def load_table5():
    """{"165": {"weight", "gmlos", "amlos"}} from the FY2027 correction-notice Table 5. The
    weight is CMS's "Weights - 10% Cap Applied" column, the one used for payment."""
    columns = {"drg": r"^MS-DRG$", "weight": r"10% Cap Applied$",
               "gmlos": r"^Geometric mean LOS$", "amlos": r"^Arithmetic mean LOS$"}
    table = {}
    for row in _table(SOURCE_OF["load_table5"], r"-CN Table 5\.txt$", columns, prefer_spreadsheet=False):
        if not re.fullmatch(r"\d{3}", row["drg"]) or not row["weight"]:
            continue    # 998 and 999 (ungroupable) have no weight
        if row["drg"] in table:
            raise parse.ParseError("Table 5: MS-DRG %s repeated" % row["drg"])
        table[row["drg"]] = {key: float(row[key]) for key in ("weight", "gmlos", "amlos")}
    return _at_least(table, 700, "Table 5")


def _operating(rows, table):
    """(labor share, labor + nonlabor) for the full update (quality data submitted, meaningful
    EHR user) from Table 1A or 1B."""
    start = next((n for n, row in enumerate(rows) if row and row[0].startswith("TABLE %s." % table)), None)
    if start is None:
        raise parse.ParseError("Table %s not found" % table)
    share = re.search(r"\((\d+(?:\.\d+)?) PERCENT LABOR SHARE", rows[start][0])
    groups, labels, amounts = rows[start + 1], rows[start + 2], rows[start + 3]
    if (not share or not groups[0].startswith("Hospital Submitted Quality Data and is a Meaningful EHR User")
            or labels[:2] != ["Labor-related", "Nonlabor-related"]):
        raise parse.ParseError("Table %s layout changed" % table)
    labor, nonlabor = _money(amounts[0]), _money(amounts[1])
    total = round(labor + nonlabor, 2)
    stated = float(share.group(1)) / 100
    if abs(labor / total - stated) > 0.0005:
        raise parse.ParseError("Table %s: labor share %.4f is not the stated %.3f" % (table, labor / total, stated))
    return stated, total


@cached
def load_rates():
    """National FY2027 IPPS rates from the correction-notice Tables 1A-1D: operating standardized
    amount (labor + nonlabor, full update) for wage index > 1 (1A) and <= 1 (1B), the labor shares
    those tables state, and the capital federal rate (1D)."""
    source_id = SOURCE_OF["load_rates"]
    path = _path(source_id)
    member = parse.pick_member(path, r"-CN Tables 1A", prefer_spreadsheet=False)
    rows = [[cell.strip() for cell in row] for row in parse.read_member(path, member)[0][1]]
    share_gt1, operating_gt1 = _operating(rows, "1A")
    share_le1, operating_le1 = _operating(rows, "1B")
    start = next((n for n, row in enumerate(rows) if row and row[0].startswith("TABLE 1D")), None)
    national = next((row for row in rows[start or 0:] if row and row[0] == "National"), None)
    if start is None or national is None or "CAPITAL" not in rows[start][0]:
        raise parse.ParseError("Table 1D layout changed")
    return {
        "operating_wi_gt1": operating_gt1, "operating_wi_le1": operating_le1,
        "labor_share_gt1": share_gt1, "labor_share_le1": share_le1,
        "capital": _money(national[1]), "source": source_id,
    }


# ---------------------------------------------------------------- MS-DRG v44 definitions

@cached
def _appendix_d_e():
    return _lines(SOURCE_OF["load_hierarchy"], r"^appendix_D_E\.txt$")


@cached
def _surgical_classes():
    """Appendix D as [(mdc, MS-DRG range text, surgical class title)] in hierarchy order."""
    lines = _appendix_d_e()
    start = _find(lines, r"^MDC \d\d ", what="Appendix D")
    end = _find(lines, r"^Appendix E Operating Room Procedures", start, "Appendix E")
    classes, mdc = [], None
    for line in lines[start:end]:
        heading = re.match(r"^MDC (\d\d) \S", line)
        row = re.match(r"^  (%s)\s+(\S.*?)\s*$" % DRGS, line)
        if heading:
            mdc = heading.group(1)
        elif row:
            classes.append((mdc, row.group(1), row.group(2)))
        elif line.strip() and not line.startswith("="):
            raise parse.ParseError("Appendix D: unexpected line %r" % line[:60])
    return _at_least(classes, 100, "Appendix D")


@cached
def load_hierarchy():
    """{mdc: [(drg, ...), ...]} the surgical classes of each MDC from v44 Appendix D, highest in
    the hierarchy first. Pre-MDC is "00"."""
    hierarchy = {}
    for mdc, drgs, _ in _surgical_classes():
        hierarchy.setdefault(mdc, []).append(tuple(_expand(drgs)))
    return hierarchy


_INDEX_ROW = re.compile(r"^  (%s)?([*+]{0,2})\s+(Pre|\d\d)\s+(%s)(?: +(\S.*?))?\s*$" % (PCS, DRGS))
_CLUSTER_ONLY = re.compile(r"^  %s[*+]{1,2}\s+Code only used in clusters\s*$" % PCS)


@cached
def load_proc_index():
    """{PCS code: [{"mdc", "drgs", "family", "non_or"}]} from v44 Appendix E, Part 1 (the
    Procedure Code/MS-DRG Index), one entry per row in CMS's order.

    A row with a blank code continues the code above it. A trailing * on the code marks a non-OR
    procedure (it still affects some DRGs, listed in its rows); + marks a member of a procedure
    cluster (Part 2), which this does not read. Pre-MDC rows have mdc "00". family is the
    Appendix D title of the row's MDC and DRG range (CMS leaves some category cells blank), or
    the row's own category where the range is not an Appendix D class: a sub-range of one (e.g.
    hernia 350-352 within 350-355) or a medical DRG a non-OR procedure leads to. The seven codes
    CMS lists only as cluster members ("Code only used in clusters") are left out.
    """
    lines = _appendix_d_e()
    start = _find(lines, r"^Procedure Code/MS-DRG Index\s*$", what="Appendix E Part 1")
    end = _find(lines, r"^Procedure Cluster/MS-DRG Index\s*$", start, "Appendix E Part 2")
    if not re.match(r"^\s+CODE\s+MDC\s+MS-DRG\s+SURGICAL CATEGORY", lines[start + 1]):
        raise parse.ParseError("Appendix E Part 1 header changed")
    titles = {(mdc, drgs): title for mdc, drgs, title in _surgical_classes()}
    index, current, non_or = {}, None, None
    for line in lines[start + 2:end]:
        if not line.strip():
            continue
        if _CLUSTER_ONLY.match(line):
            current = None
            continue
        match = _INDEX_ROW.match(line)
        if not match:
            raise parse.ParseError("Appendix E: unexpected line %r" % line[:60])
        code, marks, mdc, drgs, category = match.groups()
        if code:
            if code in index:
                raise parse.ParseError("Appendix E: %s listed twice" % code)
            current, non_or = code, "*" in marks
            index[code] = []
        elif current is None:
            raise parse.ParseError("Appendix E: continuation row with no code: %r" % line[:60])
        mdc = PRE_MDC if mdc == "Pre" else mdc
        family = titles.get((mdc, drgs)) or category
        if not family:
            raise parse.ParseError("Appendix E: %s MDC %s %s has no category" % (current, mdc, drgs))
        index[current].append({"mdc": mdc, "drgs": _expand(drgs), "family": family, "non_or": non_or})
    return _at_least(index, 10000, "Appendix E")


@cached
def load_unrelated():
    """{OR procedure code: "extensive" | "nonextensive"}: which unrelated-procedure DRGs a code
    leads to when no OR procedure on the claim is in the principal diagnosis's MDC.

    How v44 designates it (Appendix F, "Unrelated Operating Room Procedures"): DRGs 987-989
    (Non-Extensive O.R. Procedures Unrelated to Principal Diagnosis) list their codes under
    "ONLY OPERATING ROOM PROCEDURES"; DRGs 981-983 (Extensive) take "All other operating room
    procedures not listed for DRGs 987 through 989". An OR procedure is an Appendix E code
    without the * (non-OR) mark. So: listed in Appendix F's 987-989 list -> "nonextensive";
    any other OR code -> "extensive"; non-OR codes and codes absent from Appendix E are left out.
    """
    lines = _lines(SOURCE_OF["load_unrelated"], r"^appendix_F_I\.txt$")
    extensive = _find(lines, r"^DRG 981 Extensive O\.R\. Procedures Unrelated", what="Appendix F DRG 981")
    rule = _find(lines, r"\S", _find(lines, r"^OPERATING ROOM PROCEDURES\s*$", extensive) + 1)
    if not lines[rule].startswith("All other operating room procedures not listed for DRGs 987 through 989"):
        raise parse.ParseError("Appendix F: the extensive-procedure rule changed")
    heading = _find(lines, r"^DRG 987 Non-Extensive O\.R\. Procedures Unrelated", rule)
    start = _find(lines, r"^ONLY OPERATING ROOM PROCEDURES\s*$", heading) + 1
    end = _find(lines, r"^:?=+", start, "end of Appendix F")
    nonextensive = set()
    for line in lines[start:end]:
        match = re.match(r"^  (%s) \S" % PCS, line)
        if match:
            nonextensive.add(match.group(1))
        elif line.strip():
            raise parse.ParseError("Appendix F: unexpected line %r" % line[:60])
    operating_room = {code for code, rows in load_proc_index().items() if not rows[0]["non_or"]}
    if not nonextensive or nonextensive - operating_room:
        raise parse.ParseError("Appendix F lists codes that are not OR procedures in Appendix E")
    return {code: "nonextensive" if code in nonextensive else "extensive" for code in operating_room}


@cached
def load_dx_mdc():
    """{ICD-10-CM code: [mdc, ...]} the MDC(s) a code is assigned to as principal diagnosis.

    Read from the "MDC nn Assignment of Diagnosis Codes" list at the head of each MDC in the
    Definitions Manual (mdcs_*.txt), not from Appendix B: Appendix B also lists the MDCs where a
    code only acts as a secondary diagnosis (MDC 24 trauma, MDC 25 HIV, e.g. Z9282 under MDC 01
    for tPA), which a principal-diagnosis lookup must not return. Every code here also appears
    in Appendix B. A code has two MDCs only where CMS assigns by sex (12 male, 13 female; also
    N393 under 11 and 13). MDC 24 has no list (it needs two significant trauma diagnoses).
    """
    assigned = {}
    for name in MDC_FILES:
        lines = _lines(SOURCE_OF["load_dx_mdc"], r"^%s\.txt$" % name)
        for number, line in enumerate(lines):
            heading = re.match(r"^MDC (\d\d) Assignment of Diagnosis Codes\s*$", line)
            if not heading:
                continue
            mdc, count = heading.group(1), 0
            for row in lines[number + 1:]:
                match = re.match(r"^  (%s) +\S" % CM, row)
                if match:
                    codes = assigned.setdefault(match.group(1), [])
                    if mdc not in codes:
                        codes.append(mdc)
                    count += 1
                elif row.strip():
                    break
            if not count:
                raise parse.ParseError("MDC %s assigns no diagnosis codes" % mdc)
    found = {mdc for mdcs in assigned.values() for mdc in mdcs}
    if found != ASSIGNED_MDCS:
        raise parse.ParseError("diagnosis assignment lists for MDCs %s, expected %s"
                               % (sorted(found), sorted(ASSIGNED_MDCS)))
    return _at_least(assigned, 50000, "MDC diagnosis assignment")


_APPENDIX_B_ROW = re.compile(r"^ (%s)? +(Pre|\d\d) +(%s(?:,%s)*)(?: +\S.*)?\s*$" % (CM, DRGS, DRGS))


@cached
def load_dx_drgs():
    """{ICD-10-CM code: [drg, ...]} the MS-DRGs v44 Appendix B lists for a code within its
    principal-diagnosis MDC(s) (load_dx_mdc), in CMS's order. Rows under other MDCs (Pre-MDC,
    MDC 24/25 and other secondary-diagnosis logic) are dropped. Both surgical and medical DRGs
    are kept: filter on load_drg_titles()[drg]["type"] for the medical ones."""
    lines = _lines(SOURCE_OF["load_dx_drgs"], r"^appendix_B\.txt$")
    start = _find(lines, r"^\s*I10 Dx\s+MDC\s+DRG\(s\)", what="Appendix B header") + 1
    dx_mdc = load_dx_mdc()
    drgs, current = {}, None
    for line in lines[start:]:
        if not line.strip():
            continue
        match = _APPENDIX_B_ROW.match(line)
        if not match:
            raise parse.ParseError("Appendix B: unexpected line %r" % line[:60])
        code, mdc, listed = match.groups()
        if code:
            current = code
        elif current is None:
            raise parse.ParseError("Appendix B: continuation row with no code")
        if mdc in dx_mdc.get(current, ()):
            row = drgs.setdefault(current, [])
            row.extend(drg for drg in _expand(listed) if drg not in row)
    missing = set(dx_mdc) - set(drgs)
    if missing:
        raise parse.ParseError("Appendix B has no row in the assigned MDC for %d codes, e.g. %s"
                               % (len(missing), sorted(missing)[:5]))
    return drgs


# ---------------------------------------------------------------- outpatient (CY2027)

def _opps(source_id):
    """{HCPCS: {"si", "apc", "rate"}} from an Addendum B; apc and rate are None where blank."""
    columns = {"code": r"^HCPCS Code$", "si": r"^SI$", "apc": r"^APC$", "rate": r"^Payment Rate$"}
    table = {}
    for row in _table(source_id, history.ADDENDUM_B, columns):
        code = parse.normalize_code(row["code"])
        if not parse.CODE_RE.match(code):
            continue
        apc = row["apc"].strip()
        value = {"si": row["si"].upper(), "apc": apc.zfill(4) if apc.isdigit() else (apc or None),
                 "rate": _money(row["rate"])}
        if table.setdefault(code, value) != value:
            raise parse.ParseError("%s: %s listed twice with different values" % (source_id, code))
    return _at_least(table, 10000, source_id + " Addendum B")


@cached
def load_opps():
    """{HCPCS: {"si", "apc", "rate"}} from the CY2027 final OPPS Addendum B (national rate)."""
    return _opps(SOURCE_OF["load_opps"])


@cached
def load_apc_titles():
    """{APC: group title} from the CY2027 final OPPS Addendum A."""
    titles = {}
    for row in _table(SOURCE_OF["load_apc_titles"], ADDENDUM_A, {"apc": r"^APC$", "title": r"^Group Title$"}):
        apc = row["apc"].strip()
        if apc.isdigit():
            titles[apc.zfill(4)] = row["title"].strip()
    return _at_least(titles, 500, "Addendum A")


@cached
def load_asc():
    """{HCPCS: national ASC payment rate} from CY2027 final ASC Addendum AA, where CMS lists a
    rate (codes packaged in the ASC, with no rate, are left out)."""
    columns = {"code": r"^HCPCS Code$", "indicator": r"Payment Indicator$", "rate": r"Payment Rate$"}
    rates = {}
    for row in _table(SOURCE_OF["load_asc"], ASC_AA, columns):
        code, rate = parse.normalize_code(row["code"]), _money(row["rate"])
        if parse.CODE_RE.match(code) and rate is not None:
            if rates.setdefault(code, rate) != rate:
                raise parse.ParseError("Addendum AA: %s listed twice with different rates" % code)
    return _at_least(rates, 1000, "Addendum AA")


@cached
def load_opps_proposed():
    """{HCPCS: {"si", "apc", "rate"}} from the CY2027 proposed Addendum B, or {} with a warning
    when that file is not downloaded (the comparison is optional)."""
    source_id = SOURCE_OF["load_opps_proposed"]
    try:
        present = _path(source_id).is_file()
    except KeyError:
        present = False
    if not present:
        warnings.warn("%s is not downloaded; no proposed rates to compare" % source_id)
        return {}
    return _opps(source_id)
