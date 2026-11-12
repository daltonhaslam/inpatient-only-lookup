#!/usr/bin/env python3
"""Write the revenue-at-stake workbook (crosswalk.xlsx) from crosswalk.json.

    python3 pipeline/crosswalk/workbook.py [--in FILE] [--out FILE]

Tabs: Read me, Crosswalk (one row per code and DRG family, amounts as live formulas), PCS detail,
Inputs (yellow cells, named ranges), DRG weights, APC rates, Review log. Every dollar amount on
the Crosswalk tab is a formula over the Inputs, DRG weights and APC rates tabs, so a hospital can
enter its own wage index, IME and DSH. At the defaults the formulas reproduce crosswalk.json to
the cent (verify_workbook.py checks that with an independent evaluator). Needs openpyxl only.
"""
import argparse
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

import fetch      # noqa: E402
from crosswalk.reviews import REVIEWS      # noqa: E402
from openpyxl import Workbook      # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill      # noqa: E402
from openpyxl.utils import get_column_letter as col      # noqa: E402
from openpyxl.workbook.defined_name import DefinedName      # noqa: E402

JSON_PATH = fetch.DERIVED / "crosswalk.json"
XLSX_PATH = fetch.DERIVED / "crosswalk.xlsx"

BADGE = "Draft · built with Claude Code · under coder review"
HELP_URL = "https://inpatient-only-lookup.vercel.app/revenue-at-stake/help-review/"
# What selects an alternative family, from its "when" (the cards' whenLabel and the CSV say the same).
ALT_FLAG = {"dx": "Alternative family (depends on diagnosis)",
            "variant": "Alternative family (depends on operation variant)",
            "both": "Alternative family (depends on diagnosis and operation variant)"}
# Leading characters a spreadsheet may read as a formula. Text from data that starts with one is
# stored as an explicit string, never a formula (openpyxl treats any "=..." value as a formula).
FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")
CURRENCY = '$#,##0.00;[Red]-$#,##0.00'
HEADER_FILL = PatternFill("solid", fgColor="1F3A5F")
HEADER_FONT = Font(bold=True, color="FFFFFF")
INPUT_FILL = PatternFill("solid", fgColor="FFF2A8")
MAX_DRGS = 6
STATUS_TEXT = {"unreviewed": "Unreviewed", "one-agrees": "One reviewer agrees", "disputed": "Disputed",
               "agree-needs-tiebreak": "Two reviewers agree · needs a tiebreak", "confirmed": "Confirmed"}

CROSSWALK_COLUMNS = [
    ("Code", 10), ("Plain label", 44), ("Specialty group", 16), ("Year removed", 9), ("SI", 5), ("APC", 7),
    ("APC title", 34), ("Outpatient national rate", 16), ("ASC rate", 13), ("Family #", 9),
    ("Condition / principal dx", 40), ("ICD-10-CM", 36), ("MDC", 6), ("DRG family", 52), ("Basis", 14),
    ("Inpatient low", 14), ("Inpatient high", 14), ("Gap low", 14), ("Gap high", 14), ("Tier", 6),
    ("Review status", 22), ("Caveat", 60)]
HELPER_FIRST = len(CROSSWALK_COLUMNS) + 1       # DRG number helper columns follow the visible ones
COL = {name: n for n, (name, _) in enumerate(CROSSWALK_COLUMNS, 1)}

# name -> (default or crosswalk meta key, format, note)
INPUTS = [
    ("OpStd", "Operating standardized amount", "National operating standardized amount, FY 2027 IPPS Table 1A, full update. "
     "Table 1B gives the same amount."),
    ("CapRate", "Capital federal rate", "National capital federal rate, FY 2027 IPPS Table 1D."),
    ("LaborShare", "Operating labor share", "Share of the operating amount the wage index adjusts: {gt1:.1%} when the wage index is above 1 "
     "(Table 1A). If your wage index is 1.0 or below, set LaborShare to {le1:.0%} (Table 1B)."),
    ("WageIndex", "Hospital wage index (inpatient)", "Your hospital's FY 2027 IPPS wage index. 1.0 = national, unadjusted."),
    ("IME", "IME adjustment", "Indirect medical education add-on to operating payment, as a decimal (0.05 = 5%). 0 = none."),
    ("DSH", "DSH adjustment", "Disproportionate share add-on to operating payment, as a decimal (0.05 = 5%). 0 = none."),
    ("CapGAF", "Capital geographic adjustment factor", "Applied to the capital rate. 1.0 = national, unadjusted."),
    ("OppsLaborShare", "Outpatient labor share", "OPPS labor-related share of the payment rate: 60%."),
    ("OppsWageIndex", "Hospital wage index (outpatient)", "Your hospital's OPPS wage index. 1.0 = national, unadjusted. Outpatient gets no IME."),
]


def _plain(cell):
    """A cell written from data: text that could read as a formula is stored as a plain string."""
    if isinstance(cell.value, str) and cell.value.startswith(FORMULA_LEAD):
        cell.data_type = "s"
    return cell


def _put(ws, row, column, value):
    return _plain(ws.cell(row=row, column=column, value=value))


def _append(ws, values):
    ws.append(values)
    for cell in ws[ws.max_row]:
        _plain(cell)


def alt_flag(fam):
    """The caveat for an alternative family: what selects it (diagnosis, operation variant or both)."""
    when = fam.get("when") or {}
    if when.get("variant"):
        return ALT_FLAG["both" if when.get("dx") else "variant"]
    return ALT_FLAG["dx"]


def _header(ws, row, names, widths=None):
    for n, name in enumerate(names, 1):
        cell = ws.cell(row=row, column=n, value=name)
        cell.font, cell.fill = HEADER_FONT, HEADER_FILL
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        if widths:
            ws.column_dimensions[col(n)].width = widths[n - 1]


def _inpatient_amount(drg_cell):
    """One DRG's national-formula payment, from its DRG number cell, over the Inputs names."""
    return ("ROUND(INDEX(DrgWeight,MATCH(%s,DrgNum,0))*(OpStd*(LaborShare*WageIndex+1-LaborShare)*(1+IME+DSH)"
            "+CapRate*CapGAF),2)" % drg_cell)


def _outpatient_amount(apc_cell):
    return ("IFERROR(ROUND(INDEX(ApcRate,MATCH(%s,ApcNum,0))*(OppsLaborShare*OppsWageIndex+1-OppsLaborShare),2),\"\")"
            % apc_cell)


def _drg_text(drgs):
    numbers = [d["drg"] for d in drgs]
    return "DRG " + ", ".join(numbers)


def _crosswalk_rows(doc):
    """[(cells by column name, DRG numbers)]: one row per code and DRG family. Packaged and
    unmappable codes get one row with no inpatient cells."""
    rows = []
    for code, item in sorted(doc["codes"].items()):
        out = item["outpatient"]
        base = {"Code": code, "Plain label": item["label"], "Specialty group": item["group"],
                "Year removed": int(item["removed"][:4]), "SI": out["si"],
                "APC": int(out["apc"]) if out["apc"] else None, "APC title": out["apc_title"],
                "ASC rate": out["asc"], "Tier": (item["tier"] or {}).get("tier"),
                "Review status": STATUS_TEXT.get(item["review"]["status"], item["review"]["status"])}
        inpatient = item["inpatient"]
        if not inpatient:
            reason = ("Packaged: no separate OPPS payment (status indicator %s)." % out["si"] if out["packaged"]
                      else (item["tier"] or {}).get("why") or "No inpatient mapping.")
            rows.append((dict(base, Caveat=reason, **{"Review status": "Not applicable"}), []))
            continue
        for n, fam in enumerate(inpatient["families"], 1):
            notes = []
            if n > 1:
                notes.append(alt_flag(fam))
            if item["tier"]["tier"] == 3:
                notes.append(item["tier"]["why"])
            if fam.get("caveat"):
                notes.append(fam["caveat"])
            dx = fam["dx"]
            rows.append((dict(base, **{
                "Family #": "%d of %d" % (n, len(inpatient["families"])),
                "Condition / principal dx": fam["condition"], "ICD-10-CM": "%s %s" % (dx["code"], dx["title"]),
                "MDC": fam["mdc"], "DRG family": "%s (%s)" % (fam["family"] or "", _drg_text(fam["drgs"])),
                "Basis": fam["basis"], "Caveat": " ".join(notes) or None}), [int(d["drg"]) for d in fam["drgs"]]))
    return rows


def _crosswalk_sheet(wb, doc):
    ws = wb.create_sheet("Crosswalk")
    _header(ws, 1, [name for name, _ in CROSSWALK_COLUMNS] + ["DRG %d" % n for n in range(1, MAX_DRGS + 1)],
            [w for _, w in CROSSWALK_COLUMNS] + [8] * MAX_DRGS)
    letter = {name: col(n) for name, n in COL.items()}
    for r, (cells, drgs) in enumerate(_crosswalk_rows(doc), 2):
        for name, value in cells.items():
            _put(ws, r, COL[name], value)
        if cells.get("APC"):
            ws.cell(row=r, column=COL["Outpatient national rate"],
                    value="=" + _outpatient_amount("%s%d" % (letter["APC"], r)))
        if drgs:
            if len(drgs) > MAX_DRGS:
                raise ValueError("%s: %d DRGs in one family; the workbook has room for %d" % (cells["Code"], len(drgs), MAX_DRGS))
            helpers = ["%s%d" % (col(HELPER_FIRST + k), r) for k in range(len(drgs))]
            for k, drg in enumerate(drgs):
                ws.cell(row=r, column=HELPER_FIRST + k, value=drg)
            amounts = ",".join(_inpatient_amount(h) for h in helpers)
            ws.cell(row=r, column=COL["Inpatient low"], value="=MIN(%s)" % amounts)
            ws.cell(row=r, column=COL["Inpatient high"], value="=MAX(%s)" % amounts)
            rate, low, high = (("%s%d" % (letter[n], r)) for n in ("Outpatient national rate", "Inpatient low", "Inpatient high"))
            ws.cell(row=r, column=COL["Gap low"], value='=IF(%s="","",%s-%s)' % (rate, rate, high))
            ws.cell(row=r, column=COL["Gap high"], value='=IF(%s="","",%s-%s)' % (rate, rate, low))
        for name in ("Outpatient national rate", "ASC rate", "Inpatient low", "Inpatient high", "Gap low", "Gap high"):
            ws.cell(row=r, column=COL[name]).number_format = CURRENCY
    last = ws.max_row
    for n in range(HELPER_FIRST, HELPER_FIRST + MAX_DRGS):
        ws.column_dimensions[col(n)].hidden = True
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = "A1:%s%d" % (col(HELPER_FIRST + MAX_DRGS - 1), last)
    ws.row_dimensions[1].height = 32
    return ws


def _pcs_sheet(wb, doc):
    ws = wb.create_sheet("PCS detail")
    names = ["Code", "Plain label", "PCS set #", "Set note", "PCS code", "PCS title (CMS)", "Index MDC",
             "Index DRGs", "Index family", "Non-OR", "Index note"]
    _header(ws, 1, names, [10, 44, 9, 30, 11, 60, 9, 14, 52, 8, 60])
    for code, item in sorted(doc["codes"].items()):
        mapping = item["mapping"]
        if not mapping:
            continue
        index = {}
        for fam in item["inpatient"]["families"] if item["inpatient"] else []:
            for row in fam["index_rows"]:
                index.setdefault(row["pcs"], []).append(row)
        for s, entry in enumerate(mapping["pcs_sets"], 1):
            for pcs in entry["codes"]:
                rows = index.get(pcs["code"], [])
                seen = list(dict.fromkeys(
                    (r["mdc"] or "", ", ".join(r["drgs"]), r["family"] or "", r["non_or"], r.get("note") or "") for r in rows))
                join = lambda i: " | ".join(dict.fromkeys(str(x[i]) for x in seen if x[i] != ""))      # noqa: E731
                _append(ws, [code, item["label"], s, entry["note"], pcs["code"], pcs["title"], join(0), join(1), join(2),
                             ("yes" if any(x[3] for x in seen) else "no") if seen else None, join(4)])
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    return ws


def _lookup_sheet(wb, title, name, header, rows, source, widths, key_name, value_name, value_format):
    """A reference table: title row, source line, landing URL, blank row, header, data from row 6."""
    ws = wb.create_sheet(title)
    ws["A1"], ws["A2"], ws["A3"] = name, "Source: " + source["label"], "Landing page: " + source["landing"]
    ws["A1"].font = Font(bold=True, size=13)
    _header(ws, 5, header, widths)
    for row in rows:
        _append(ws, row)
    last = ws.max_row
    for r in range(6, last + 1):
        ws.cell(row=r, column=len(header)).number_format = value_format
    ws.freeze_panes = "A6"
    ws.auto_filter.ref = "A5:%s%d" % (col(len(header)), last)
    for defined, column in ((key_name, "A"), (value_name, col(len(header)))):
        wb.defined_names[defined] = DefinedName(defined, attr_text="'%s'!$%s$6:$%s$%d" % (title, column, column, last))
    return ws


def _used(doc):
    drgs, apcs = {}, {}
    for item in doc["codes"].values():
        out = item["outpatient"]
        if out["apc"] and out["rate"] is not None:
            apcs[int(out["apc"])] = (out["apc_title"], out["rate"])
        for fam in (item["inpatient"] or {}).get("families", []):
            for d in fam["drgs"]:
                drgs[int(d["drg"])] = (d["title"], d["weight"])
    return drgs, apcs


def _inputs_sheet(wb, doc):
    ws = wb.create_sheet("Inputs")
    rates = doc["meta"]["rates"]
    ws["A1"], ws["A1"].font = "Inputs: change the yellow cells", Font(bold=True, size=13)
    ws["A2"] = ("Defaults are national and unadjusted, which is how the site headlines every figure. Enter your hospital's own "
                "values and the Crosswalk tab recalculates. " + BADGE + ".")
    _header(ws, 4, ["Input", "Value", "Note"], [38, 14, 110])
    defaults = {"OpStd": rates["operating"], "CapRate": rates["capital"], "LaborShare": rates["labor_share"],
                "WageIndex": 1.0, "IME": 0, "DSH": 0, "CapGAF": 1.0, "OppsLaborShare": 0.60, "OppsWageIndex": 1.0}
    for r, (name, label, note) in enumerate(INPUTS, 5):
        ws.cell(row=r, column=1, value="%s (%s)" % (label, name))
        cell = ws.cell(row=r, column=2, value=defaults[name])
        cell.fill = INPUT_FILL
        cell.number_format = (CURRENCY if name in ("OpStd", "CapRate") else "0.0%" if "Share" in name or name in ("IME", "DSH")
                              else "0.0000")
        ws.cell(row=r, column=3, value=note.format(gt1=rates["labor_share"], le1=rates["labor_share_le1"]))
        wb.defined_names[name] = DefinedName(name, attr_text="Inputs!$B$%d" % r)
    return ws


def _review_log_sheet(wb, reviews):
    ws = wb.create_sheet("Review log")
    _header(ws, 1, ["Code", "Mapping fingerprint", "Verdict", "Credential", "Date", "Name (if given)", "Profile", "Reason"],
            [10, 18, 10, 14, 12, 28, 40, 80])
    for r in reviews:
        _append(ws, [r.get("code"), r.get("fp"), r.get("verdict"), r.get("credential"), r.get("date"), r.get("name"), r.get("profile"), r.get("reason")])
    if not reviews:
        ws.append(["No reviews yet"])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:H%d" % ws.max_row
    return ws


def _readme_sheet(wb, doc):
    meta = doc["meta"]
    counts, rates = meta["counts"], meta["rates"]
    lines = [
        ("Revenue at stake: Medicare inpatient-only removals", "title"),
        (BADGE, None),
        ("Built %s from crosswalk.json. Every figure is an estimate of revenue at stake, not a forecast, and not billing or legal advice." % meta["built"], None),
        ("", None),
        ("What this is", "h"),
        ("For each of the %d codes CMS removed from the inpatient-only list effective January 1, 2026 or January 1, 2027, "
         "the Crosswalk tab sets the national outpatient payment beside the range of national inpatient payments for the "
         "MS-DRG family the same operation would group to. Outpatient-eligible does not mean outpatient-only: status "
         "decisions stay clinical (two-midnight rule), and removal from the list changes what Medicare will pay for, not "
         "what is right for the patient." % counts["codes"], None),
        ("", None),
        ("Method in 5 steps", "h"),
        ("1. List: the codes removed from the inpatient-only list on 2026-01-01 (%d) or 2027-01-01 (%d)." % (counts["removed_2026"], counts["removed_2027"]), None),
        ("2. Outpatient: the CY 2027 OPPS Addendum B rate for the code's APC, with the CY 2027 ASC rate shown for reference. Packaged codes have no separate payment.", None),
        ("3. Map: two separate AI passes each chose the ICD-10-PCS code or codes a hospital would report for the same operation, and a typical principal diagnosis. A third pass adjudicated where they disagreed.", None),
        ("4. Group: a deterministic MS-DRG v44 grouper turns each mapping into a DRG family (the with MCC, with CC and without CC/MCC levels).", None),
        ("5. Price: DRG relative weight x (operating standardized amount + capital federal rate), from the FY 2027 IPPS correction-notice tables. The wage index applies to the labor share of the operating amount, IME and DSH apply to the operating amount only, and the capital rate uses the capital factor (CapGAF). Inpatient low and high are the lowest and highest DRG in the family. Gap = outpatient minus inpatient; negative means the hospital is paid less outpatient.", None),
        ("", None),
        ("Years", "h"),
        ("Outpatient: CY 2027 OPPS (from Jan 1, 2027).", None),
        ("Inpatient: FY 2027 IPPS (Oct 1, 2026 – Sep 30, 2027).", None),
        ("", None),
        ("National, unadjusted", "h"),
        ("By default every amount is national and unadjusted: no wage index, IME, DSH, outlier or other hospital-specific adjustment. "
         "A hospital's own wage index, IME and DSH raise inpatient figures, so published examples that include them run higher; "
         "outpatient gets no IME. Defaults: operating amount $%s, capital rate $%s." % (format(rates["operating"], ",.2f"), format(rates["capital"], ",.2f")), None),
        ("", None),
        ("How to use the Inputs tab", "h"),
        ("Change the yellow cells on the Inputs tab (wage index, IME, DSH, capital factor, outpatient wage index). The outpatient rate, "
         "inpatient low and high, and the gaps on the Crosswalk tab are formulas and recalculate. Do not type over them. "
         "The DRG weights and APC rates tabs hold the CMS figures the formulas look up.", None),
        ("", None),
        ("Estimate, not forecast", "h"),
        ("The figures show what Medicare's rates would pay for the same operation in each setting. They do not predict your volume, "
         "case mix, denials or contract terms, and they leave out outliers, add-on payments and copayments.", None),
        ("", None),
        ("How it was built", "h"),
        ("Built with Claude Code; mappings by two AI passes plus adjudication; under review by credentialed coders.", None),
        ("", None),
        ("How to review", "h"),
        ("Coders: confirm or dispute a mapping with the forms linked from %s. The Review log tab lists ingested reviews." % HELP_URL, None),
        ("", None),
        ("License", "h"),
        ("MIT. Free to use and share with the license notice.", None),
        ("", None),
        ("Sources", "h"),
    ] + [("%s. %s" % (s["label"], s["landing"]), None) for s in meta["sources"].values()]
    ws = wb.create_sheet("Read me", 0)
    ws.column_dimensions["A"].width = 130
    for r, (text, style) in enumerate(lines, 1):
        cell = ws.cell(row=r, column=1, value=text)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        if style == "title":
            cell.font = Font(bold=True, size=15)
        elif style == "h":
            cell.font = Font(bold=True, size=12)
    return ws


def write(doc, out_path, reviews=None):
    """Build the workbook for a crosswalk document and save it to out_path. Returns the path."""
    if reviews is None:
        reviews = fetch.read_json_or(REVIEWS, [])
    wb = Workbook()
    wb.remove(wb.active)
    _crosswalk_sheet(wb, doc)
    _pcs_sheet(wb, doc)
    _inputs_sheet(wb, doc)
    drgs, apcs = _used(doc)
    meta = doc["meta"]["sources"]
    _lookup_sheet(wb, "DRG weights", "FY 2027 MS-DRG relative weights (DRGs used on the Crosswalk tab)", ["DRG", "Title", "Relative weight"],
                  [[d, drgs[d][0], drgs[d][1]] for d in sorted(drgs)], meta["ipps-2027-table5"], [8, 100, 16],
                  "DrgNum", "DrgWeight", "0.0000")
    _lookup_sheet(wb, "APC rates", "CY 2027 OPPS payment rates (APCs used on the Crosswalk tab)", ["APC", "Title", "National unadjusted rate"],
                  [[a, apcs[a][0], apcs[a][1]] for a in sorted(apcs)], meta["addenda-2027"], [8, 60, 24],
                  "ApcNum", "ApcRate", CURRENCY)
    _review_log_sheet(wb, reviews)
    _readme_sheet(wb, doc)
    wb.properties.title = "Revenue at stake: inpatient-only removals"
    wb.properties.creator = "Built with Claude Code"
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out_path)
    return out_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--in", dest="source", type=Path, default=JSON_PATH, help="crosswalk.json to read")
    parser.add_argument("--out", type=Path, default=XLSX_PATH, help="workbook to write")
    args = parser.parse_args(argv)
    print("Wrote %s" % write(fetch.read_json(args.source), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
