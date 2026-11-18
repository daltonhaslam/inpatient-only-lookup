#!/usr/bin/env python3
"""Write the revenue-at-stake workbook (crosswalk.xlsx) from crosswalk.json.

    python3 pipeline/crosswalk/workbook.py [--in FILE] [--out FILE]

Tabs: Read me, Crosswalk (one row per code and DRG family, amounts as live formulas), Per year
(IME and DSH a year by DRG, from counts you enter), PCS detail, Inputs (yellow cells, named
ranges), Hospitals (every hospital the site offers, with its FY 2027 impact-file factors), DRG
weights (each DRG's payment and IME + DSH at the Inputs hospital), APC rates, Review log. Every
dollar amount on the Crosswalk and Per year tabs is a formula over the Inputs, Hospitals, DRG
weights and APC rates tabs. A hospital CCN typed on the Inputs tab drives every factor; a value of
your own overrides it; blank means national. At the national defaults the formulas reproduce
crosswalk.json to the cent (verify_workbook.py checks that, and the OHSU fixture, with an
independent evaluator). Reads hospitals.json and patient-shares.json beside crosswalk.json.
Needs openpyxl only.
"""
import argparse
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

import fetch      # noqa: E402
from crosswalk.exposure import HOSPITALS, SHARES      # noqa: E402
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
FACTOR = "0.0000######"
PERCENT = "0.000%"
HEADER_FILL = PatternFill("solid", fgColor="1F3A5F")
HEADER_FONT = Font(bold=True, color="FFFFFF")
INPUT_FILL = PatternFill("solid", fgColor="FFF2A8")
MAX_DRGS = 6
STATUS_TEXT = {"unreviewed": "Unreviewed", "one-agrees": "One reviewer agrees", "disputed": "Disputed",
               "agree-needs-tiebreak": "Two reviewers agree · needs a tiebreak", "confirmed": "Confirmed"}

# Prose said in more than one place (Inputs notes, Per year tab, Read me). {ime_caseta44} and
# {caseta44} are the impact-file column names (hospitals.json meta.columns).
UNCOMPENSATED = ("Uncompensated care is left out: paid per claim only as an interim amount and settled at the "
                 "cost report to a fixed yearly total (42 CFR 412.106(i)), so it is not lost per case.")
MA_ESTIMATE = ("At a teaching hospital the MA count defaults to traditional x the hospital's MA ratio "
               "({ime_caseta44} / {caseta44}), an estimate that assumes its MA cases have the same DRG mix as "
               "traditional Medicare; type over it to use your own.")
ADDON_CASES = ("Which cases carry add-ons: IME is paid on traditional Medicare and MA discharges (MA: operating IME "
               "only, 42 CFR 412.105(g)); DSH on traditional Medicare only. Direct GME follows the Medicare and MA share "
               "of inpatient days (42 CFR 413.76); Medicaid GME is separate and state-run; commercial payers pay no add-on.")
CEILING = "A ceiling, not a forecast: a count covers every case in the DRG, not only removed procedures."
# The CCN status line beside the Hospital CCN cell.
NATIONAL_STATUS = "National: no hospital. Type a CCN to apply its wage index, IME and DSH."
NATIONAL_FALLBACK = "Using national values."
NOT_FOUND = "CCN not found on the Hospitals tab. " + NATIONAL_FALLBACK


def maryland_status(meta):
    """The status line for a Maryland CCN: hospitals.json meta.maryland, then the fallback."""
    return "%s %s" % (meta["maryland"], NATIONAL_FALLBACK)


ASC_SHARE, OPPS_SHARE = "Patient share at ASC (national)", "Patient share at hospital outpatient (national)"
ASC_MORE = "ASC costs patient more"
CROSSWALK_COLUMNS = [
    ("Code", 10), ("Plain label", 44), ("Specialty group", 16), ("Year removed", 9), ("SI", 5), ("APC", 7),
    ("APC title", 34), ("Outpatient rate", 14), ("ASC rate", 13), ("Family #", 9),
    ("Condition / principal dx", 40), ("ICD-10-CM", 36), ("MDC", 6), ("DRG family", 52), ("Basis", 14),
    ("Inpatient low", 14), ("Inpatient high", 14), ("IME + DSH low", 14), ("IME + DSH high", 14),
    ("Gap low", 14), ("Gap high", 14), (ASC_SHARE, 14), (OPPS_SHARE, 16), (ASC_MORE, 11),
    ("Tier", 6), ("Review status", 22), ("Caveat", 60)]
HELPER_FIRST = len(CROSSWALK_COLUMNS) + 1       # DRG number helper columns follow the visible ones
COL = {name: n for n, (name, _) in enumerate(CROSSWALK_COLUMNS, 1)}
DOLLAR_COLUMNS = ("Outpatient rate", "ASC rate", "Inpatient low", "Inpatient high", "IME + DSH low", "IME + DSH high",
                  "Gap low", "Gap high", ASC_SHARE, OPPS_SHARE)

# The IPPS payment for one unit of DRG weight, over the Inputs names (spec § Per-case math):
# operating base = OpStd x (LaborShare x WageIndex + 1 - LaborShare), capital base = CapRate x CapGAF;
# IME and DSH are each base times the hospital's operating and capital factor. Computed once on the
# Inputs tab; the DRG weights and Per year tabs multiply it by each DRG's weight.
OPERATING = "OpStd*(LaborShare*WageIndex+1-LaborShare)"
CAPITAL = "CapRate*CapGAF"
PER_WEIGHT = [  # (name, label, formula)
    ("PerWeightTotal", "Payment per unit of DRG weight", "%s*(1+IME+DSH)+%s*(1+CapIME+CapDSH)" % (OPERATING, CAPITAL)),
    ("PerWeightAddons", "IME + DSH per unit of DRG weight", "%s*(IME+DSH)+%s*(CapIME+CapDSH)" % (OPERATING, CAPITAL)),
    ("PerWeightMA", "Operating IME per unit of DRG weight (MA claims, 42 CFR 412.105(g))", "%s*IME" % OPERATING)]

# The Hospitals tab: (hospitals.json key or None, header, defined name over the column, number format,
# formula). Headers are formatted with the impact-file column names (hospitals.json meta.columns);
# a formula is formatted with the row ({r}) and each key's column letter.
HOSPITAL_COLUMNS = [
    ("ccn", "CCN", "HospCCN", "@", None), ("name", "Name", "HospName", None, None),
    ("state", "State", "HospState", None, None),
    ("wi", "Wage index ({wi})", "HospWI", FACTOR, None), ("gaf", "Capital GAF ({gaf})", "HospGAF", FACTOR, None),
    ("tchop", "Operating IME ({tchop})", "HospTCHOP", PERCENT, None),
    ("tchcp", "Capital IME ({tchcp})", "HospTCHCP", PERCENT, None),
    ("dshopp", "Operating DSH ({dshopp})", "HospDSHOPP", PERCENT, None),
    ("dshcpp", "Capital DSH ({dshcpp})", "HospDSHCPP", PERCENT, None),
    ("caseta44", "{caseta44}", None, "#,##0.00", None), ("ime_caseta44", "{ime_caseta44}", None, "#,##0.00", None),
    (None, "MA ratio ({ime_caseta44} / {caseta44})", "HospMARatio", "0.0000",
     '=IF(ISNUMBER({ime_caseta44}{r}),{ime_caseta44}{r}/{caseta44}{r},"")')]
HOSPITAL_LETTER = {key: col(n) for n, (key, *_) in enumerate(HOSPITAL_COLUMNS, 1) if key}

# Inputs rows. Each has a yellow "your value" cell and a "used" cell its name points at:
# used = your value, else the kind's fallback:
#   factor: the CCN's (a Hospitals tab range), else national (None: blank)
#   rule:   the formula
#   rate:   the CMS rate, from (table, key): "rates" = crosswalk.json meta.rates, "hospitals" = hospitals.json meta
# (name, label, kind, source, format, note); notes are formatted with c (meta.columns), r (meta.rates)
# and h (hospitals.json meta).
INPUTS = [
    ("WageIndex", "Wage index", "factor", ("HospWI", 1), FACTOR,
     "FY 2027 IPPS wage index (impact file, {c[wi]}). National: 1, unadjusted."),
    ("CapGAF", "Capital geographic adjustment factor", "factor", ("HospGAF", 1), FACTOR,
     "Applied to the capital rate (impact file, {c[gaf]}). National: 1."),
    ("IME", "Operating IME", "factor", ("HospTCHOP", 0), PERCENT,
     "Operating indirect medical education adjustment, a share of the operating base (impact file, {c[tchop]}). "
     "National: 0. A teaching hospital is one with operating IME above 0."),
    ("CapIME", "Capital IME", "factor", ("HospTCHCP", 0), PERCENT,
     "Capital IME adjustment, a share of the capital base (impact file, {c[tchcp]}). National: 0."),
    ("DSH", "Operating DSH", "factor", ("HospDSHOPP", 0), PERCENT,
     "Operating disproportionate share adjustment (impact file, {c[dshopp]}; it already carries the 75% reduction). "
     "National: 0. " + UNCOMPENSATED),
    ("CapDSH", "Capital DSH", "factor", ("HospDSHCPP", 0), PERCENT,
     "Capital DSH adjustment (impact file, {c[dshcpp]}). National: 0."),
    ("MARatio", "MA-to-traditional case ratio", "factor", ("HospMARatio", None), "0.0000",
     "Medicare Advantage cases per traditional Medicare case ({c[ime_caseta44]} / {c[caseta44]}). Used only to "
     "estimate MA counts on the Per year tab at a teaching hospital. Blank when CMS gives none, and nationally."),
    ("LaborShare", "Operating labor share", "rule", "IF(WageIndex>1,LaborShareHigh,LaborShareLow)", "0.0%",
     "Share of the operating amount the wage index adjusts: {r[labor_share]:.0%} when the wage index used is above 1, "
     "else {r[labor_share_le1]:.0%}."),
    ("OpStd", "Operating standardized amount", "rule", "IF(WageIndex>1,OpStdHigh,OpStdLow)", CURRENCY,
     "The Table 1A amount when the wage index used is above 1, else the Table 1B amount."),
    ("OppsWageIndex", "Outpatient wage index", "rule", "WageIndex", FACTOR,
     "Wage index for the outpatient rate: the wage index used above unless you enter your own. Outpatient rate = APC "
     "rate x (outpatient labor share x wage index + 1 - outpatient labor share). Outpatient pays no IME or DSH."),
    ("OpStdHigh", "Operating standardized amount, wage index above 1", "rate", ("rates", "operating"), CURRENCY,
     "National operating standardized amount, full update, FY 2027 IPPS Table 1A (correction notice)."),
    ("OpStdLow", "Operating standardized amount, wage index 1 or below", "rate", ("rates", "operating_wi_le1"), CURRENCY,
     "The same, FY 2027 IPPS Table 1B (correction notice)."),
    ("LaborShareHigh", "Operating labor share, wage index above 1", "rate", ("rates", "labor_share"), "0.0%",
     "Labor-related share, FY 2027 IPPS Table 1A."),
    ("LaborShareLow", "Operating labor share, wage index 1 or below", "rate", ("rates", "labor_share_le1"), "0.0%",
     "Labor-related share, FY 2027 IPPS Table 1B."),
    ("CapRate", "Capital federal rate", "rate", ("rates", "capital"), CURRENCY,
     "National capital federal rate, FY 2027 IPPS Table 1D."),
    ("OppsLaborShare", "Outpatient labor share", "rate", ("hospitals", "opps_labor_share"), "0.0%",
     "OPPS labor-related share of the APC rate ({h[opps_labor_share_cite]})."),
]
INPUT_HEADER_ROW = 8

# The Per year tab's columns, by name.
PY_WEIGHT, PY_TOTAL = "Relative weight", "Payment per case"
PY_ADDONS, PY_MA = "IME + DSH per case (traditional)", "Operating IME per case (MA)"
PY_TRAD, PY_MA_COUNT, PY_MA_USED = "Traditional Medicare cases a year", "MA cases a year (blank = estimate)", "MA cases used"
PY_YEAR_TRAD, PY_YEAR_MA, PY_YEAR = "IME + DSH a year, traditional", "Operating IME a year, MA", "Add-ons a year"
PER_YEAR_COLUMNS = [
    ("DRG", 8), ("Title", 56), (PY_WEIGHT, 10), (PY_TOTAL, 14), (PY_ADDONS, 15), (PY_MA, 15),
    (PY_TRAD, 14), (PY_MA_COUNT, 14), (PY_MA_USED, 10), (PY_YEAR_TRAD, 16), (PY_YEAR_MA, 16), (PY_YEAR, 16)]
PER_YEAR_FIRST = 6      # data rows start here, under the header on row 5


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


def _name(wb, name, sheet, ref):
    wb.defined_names[name] = DefinedName(name, attr_text="'%s'!%s" % (sheet, ref))


def _text(value):
    """A string as an Excel formula literal."""
    return '"%s"' % value.replace('"', '""')


def alt_flag(fam):
    """The caveat for an alternative family: what selects it (diagnosis, operation variant or both)."""
    when = fam.get("when") or {}
    if when.get("variant"):
        return ALT_FLAG["both" if when.get("dx") else "variant"]
    return ALT_FLAG["dx"]


def yes_no(flag):
    """True/False as Yes/No; None (no comparison) as an empty cell."""
    return {True: "Yes", False: "No"}.get(flag)


def _header(ws, row, names, widths=None):
    for n, name in enumerate(names, 1):
        cell = ws.cell(row=row, column=n, value=name)
        cell.font, cell.fill = HEADER_FONT, HEADER_FILL
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        if widths:
            ws.column_dimensions[col(n)].width = widths[n - 1]


def _per_drg(name, drg_cell):
    """A DRG's figure from a DRG weights tab column (DrgTotal, DrgAddons), by its DRG number cell."""
    return "INDEX(%s,MATCH(%s,DrgNum,0))" % (name, drg_cell)


def _outpatient_amount(apc_cell):
    return ("IFERROR(ROUND(INDEX(ApcRate,MATCH(%s,ApcNum,0))*(OppsLaborShare*OppsWageIndex+1-OppsLaborShare),2),\"\")"
            % apc_cell)


def _drg_text(drgs):
    numbers = [d["drg"] for d in drgs]
    return "DRG " + ", ".join(numbers)


def _crosswalk_rows(doc, shares):
    """[(cells by column name, DRG numbers)]: one row per code and DRG family. Packaged and
    unmappable codes get one row with no inpatient cells."""
    rows = []
    for code, item in sorted(doc["codes"].items()):
        out = item["outpatient"]
        share = shares["codes"].get(code) or {}
        base = {"Code": code, "Plain label": item["label"], "Specialty group": item["group"],
                "Year removed": int(item["removed"][:4]), "SI": out["si"],
                "APC": int(out["apc"]) if out["apc"] else None, "APC title": out["apc_title"],
                "ASC rate": out["asc"], "Tier": (item["tier"] or {}).get("tier"),
                ASC_SHARE: share.get("asc_share"), OPPS_SHARE: share.get("opps_share"), ASC_MORE: yes_no(share.get("asc_more")),
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


def _crosswalk_sheet(wb, doc, shares):
    ws = wb.create_sheet("Crosswalk")
    _header(ws, 1, [name for name, _ in CROSSWALK_COLUMNS] + ["DRG %d" % n for n in range(1, MAX_DRGS + 1)],
            [w for _, w in CROSSWALK_COLUMNS] + [8] * MAX_DRGS)
    letter = {name: col(n) for name, n in COL.items()}
    for r, (cells, drgs) in enumerate(_crosswalk_rows(doc, shares), 2):
        for name, value in cells.items():
            _put(ws, r, COL[name], value)
        if cells.get("APC"):
            ws.cell(row=r, column=COL["Outpatient rate"], value="=" + _outpatient_amount("%s%d" % (letter["APC"], r)))
        if drgs:
            if len(drgs) > MAX_DRGS:
                raise ValueError("%s: %d DRGs in one family; the workbook has room for %d" % (cells["Code"], len(drgs), MAX_DRGS))
            helpers = ["%s%d" % (col(HELPER_FIRST + k), r) for k in range(len(drgs))]
            for k, drg in enumerate(drgs):
                ws.cell(row=r, column=HELPER_FIRST + k, value=drg)
            for table, low, high in (("DrgTotal", "Inpatient low", "Inpatient high"), ("DrgAddons", "IME + DSH low", "IME + DSH high")):
                amounts = ",".join(_per_drg(table, h) for h in helpers)
                ws.cell(row=r, column=COL[low], value="=MIN(%s)" % amounts)
                ws.cell(row=r, column=COL[high], value="=MAX(%s)" % amounts)
            rate, low, high = (("%s%d" % (letter[n], r)) for n in ("Outpatient rate", "Inpatient low", "Inpatient high"))
            ws.cell(row=r, column=COL["Gap low"], value='=IF(%s="","",%s-%s)' % (rate, rate, high))
            ws.cell(row=r, column=COL["Gap high"], value='=IF(%s="","",%s-%s)' % (rate, rate, low))
        for name in DOLLAR_COLUMNS:
            ws.cell(row=r, column=COL[name]).number_format = CURRENCY
    last = ws.max_row
    for n in range(HELPER_FIRST, HELPER_FIRST + MAX_DRGS):
        ws.column_dimensions[col(n)].hidden = True
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = "A1:%s%d" % (col(HELPER_FIRST + MAX_DRGS - 1), last)
    ws.row_dimensions[1].height = 45
    return ws


def _per_year_sheet(wb, drgs, columns):
    """One row per DRG the Crosswalk uses: per-case amounts at the Inputs hospital (unrounded), yellow
    counts, and per-year add-ons = ROUND(count x unrounded per-case amount, 2)."""
    ws = wb.create_sheet("Per year")
    ws["A1"], ws["A1"].font = "Per year: IME and DSH a year at the hospital on the Inputs tab, a ceiling", Font(bold=True, size=13)
    ws["A2"] = "=HospitalStatus"
    ws["A3"] = ("Enter traditional Medicare cases a year in the yellow cells (CMS publishes 2024 counts, Medicare Inpatient "
                "Hospitals by Provider and Service, but none under 11). " + MA_ESTIMATE.format(**columns) + " " + CEILING)
    ws["A4"] = ADDON_CASES
    header = [name for name, _ in PER_YEAR_COLUMNS]
    _header(ws, PER_YEAR_FIRST - 1, header, [w for _, w in PER_YEAR_COLUMNS])
    c = {name: col(n) for n, name in enumerate(header, 1)}
    last = PER_YEAR_FIRST + len(drgs) - 1
    for r, drg in enumerate(sorted(drgs), PER_YEAR_FIRST):
        at = {name: "%s%d" % (letter, r) for name, letter in c.items()}
        trad, ma, used = at[PY_TRAD], at[PY_MA_COUNT], at[PY_MA_USED]
        values = {
            "DRG": drg, "Title": drgs[drg][0], PY_WEIGHT: "=INDEX(DrgWeight,MATCH(%s,DrgNum,0))" % at["DRG"],
            PY_TOTAL: "=%s*PerWeightTotal" % at[PY_WEIGHT], PY_ADDONS: "=%s*PerWeightAddons" % at[PY_WEIGHT],
            PY_MA: "=%s*PerWeightMA" % at[PY_WEIGHT],
            PY_MA_USED: '=IF(ISNUMBER({m}),{m},IF(AND(IME>0,ISNUMBER(MARatio),ISNUMBER({t})),ROUND({t}*MARatio,0),""))'
                        .format(m=ma, t=trad),
            PY_YEAR_TRAD: '=IF(ISNUMBER({0}),ROUND({0}*{1},2),"")'.format(trad, at[PY_ADDONS]),
            PY_YEAR_MA: '=IF(ISNUMBER({0}),ROUND({0}*{1},2),"")'.format(used, at[PY_MA]),
            PY_YEAR: '=IF(COUNT({0}:{1})=0,"",SUM({0}:{1}))'.format(at[PY_YEAR_TRAD], at[PY_YEAR_MA])}
        for n, name in enumerate(header, 1):
            cell = _put(ws, r, n, values.get(name)) if name == "Title" else ws.cell(row=r, column=n, value=values.get(name))
            if name in (PY_TRAD, PY_MA_COUNT):
                cell.fill = INPUT_FILL
            cell.number_format = ("0.0000" if name == PY_WEIGHT else "0" if name in (PY_TRAD, PY_MA_COUNT, PY_MA_USED)
                                  else CURRENCY if n > 3 else "General")
    total = last + 1
    ws.cell(row=total, column=1, value="Total").font = Font(bold=True)
    for name in (PY_YEAR_TRAD, PY_YEAR_MA, PY_YEAR):
        cell = ws.cell(row=total, column=header.index(name) + 1, value="=SUM(%s%d:%s%d)" % (c[name], PER_YEAR_FIRST, c[name], last))
        cell.number_format, cell.font = CURRENCY, Font(bold=True)
    ws.freeze_panes = "C%d" % PER_YEAR_FIRST
    ws.auto_filter.ref = "A%d:%s%d" % (PER_YEAR_FIRST - 1, col(len(header)), last)
    ws.row_dimensions[PER_YEAR_FIRST - 1].height = 45
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


def _lookup_sheet(wb, title, name, header, rows, source, widths, names, formats, note=None, formulas=None):
    """A reference table: title row, source line, landing URL, a note, header, data from row 6.
    names, formats, formulas: {column number: defined name over its data / number format /
    formula, formatted with the row as {r}}."""
    ws = wb.create_sheet(title)
    ws["A1"], ws["A2"], ws["A3"] = name, "Source: " + source["label"], "Landing page: " + source["landing"]
    ws["A4"] = note
    ws["A1"].font = Font(bold=True, size=13)
    _header(ws, 5, header, widths)
    for row in rows:
        _append(ws, row)
    last = ws.max_row
    for r in range(6, last + 1):
        for column, formula in (formulas or {}).items():
            ws.cell(row=r, column=column, value=formula.format(r=r))
        for column, number_format in formats.items():
            ws.cell(row=r, column=column).number_format = number_format
    ws.freeze_panes = "A6"
    ws.auto_filter.ref = "A5:%s%d" % (col(len(header)), last)
    for column, defined in names.items():
        _name(wb, defined, title, "$%s$6:$%s$%d" % (col(column), col(column), last))
    return ws


def _hospitals_sheet(wb, hospitals):
    meta, offered = hospitals["meta"], hospitals["hospitals"]
    header = [label.format(**meta["columns"]) for _, label, *_ in HOSPITAL_COLUMNS]
    rows = [[dict(offered[ccn], ccn=ccn).get(key) if key else None for key, *_ in HOSPITAL_COLUMNS] for ccn in sorted(offered)]
    note = ("%d hospitals: every hospital the site's picker offers, factors as CMS wrote them (fractions: 0.31139 = "
            "31.139%%). Not listed: Maryland. %s" % (len(rows), meta["maryland"]))
    columns = list(enumerate(HOSPITAL_COLUMNS, 1))
    return _lookup_sheet(wb, "Hospitals", "FY 2027 IPPS hospitals and their payment factors", header, rows, meta["source"],
                         [9, 44, 6, 12, 12, 11, 11, 11, 11, 11, 11, 11],
                         {n: c[2] for n, c in columns if c[2]}, {n: c[3] for n, c in columns if c[3]}, note,
                         {n: c[4].replace("{r}", "{{r}}").format(**HOSPITAL_LETTER) for n, c in columns if c[4]})


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


def _inputs_sheet(wb, doc, hospitals):
    ws = wb.create_sheet("Inputs")
    meta = hospitals["meta"]
    tables = {"rates": doc["meta"]["rates"], "hospitals": meta}
    ws["A1"], ws["A1"].font = "Inputs: change the yellow cells", Font(bold=True, size=13)
    ws["A2"] = ("Blank is national and unadjusted, which is how the site headlines every figure. Type a hospital's CCN to "
                "use its FY 2027 wage index, GAF, IME and DSH from the Hospitals tab; a value in 'Your value' overrides "
                "that one factor. The Crosswalk and Per year tabs recalculate. " + BADGE + ".")
    ws["A4"] = "Hospital CCN (blank = national)"
    ws["B4"].fill, ws["B4"].number_format = INPUT_FILL, "@"
    # The CCN as the Hospitals tab writes it (six characters, so one typed as a number still matches).
    ws["A5"], ws["B5"] = "CCN as looked up", '=IF(ISNUMBER(HospitalCCN),RIGHT("00000"&HospitalCCN,6),TRIM(HospitalCCN))'
    ws["A6"], ws["B6"] = "Row on the Hospitals tab", '=IF(HospitalKey="","",IFERROR(MATCH(HospitalKey,HospCCN,0),"not found"))'
    found = "INDEX(%s,HospitalRow)"
    prefix = meta["maryland_prefix"]
    ws["C4"] = ('=IF(HospitalKey="",{national},IF(ISNUMBER(HospitalRow),"Hospital: "&IF({name}="","(no name in CMS\'s file)",'
                '{name})&", "&{state}&", CCN "&{ccn},IF(LEFT(HospitalKey,{n})={prefix},{maryland},{not_found})))').format(
        national=_text(NATIONAL_STATUS), name=found % "HospName", state=found % "HospState", ccn=found % "HospCCN",
        n=len(prefix), prefix=_text(prefix), maryland=_text(maryland_status(meta)), not_found=_text(NOT_FOUND))
    ws["C4"].font = Font(bold=True)
    for name, ref in (("HospitalCCN", "$B$4"), ("HospitalKey", "$B$5"), ("HospitalRow", "$B$6"), ("HospitalStatus", "$C$4")):
        _name(wb, name, "Inputs", ref)
    _header(ws, INPUT_HEADER_ROW, ["Input", "Your value", "From CCN or rule", "National", "Used", "Note"], [56, 12, 14, 12, 12, 110])
    for r, (name, label, kind, source, number_format, note) in enumerate(INPUTS, INPUT_HEADER_ROW + 1):
        ws.cell(row=r, column=1, value="%s (%s)" % (label, name))
        ws.cell(row=r, column=2).fill = INPUT_FILL
        if kind == "factor":
            lookup, national = source
            ws.cell(row=r, column=3, value='=IF(ISNUMBER(HospitalRow),IF(ISNUMBER({0}),{0},""),"")'.format(found % lookup))
            ws.cell(row=r, column=4, value=national)
            fallback = "IF(ISNUMBER(C{0}),C{0},{1})".format(r, '""' if national is None else "D%d" % r)
        elif kind == "rule":
            ws.cell(row=r, column=3, value="=" + source)
            fallback = "C%d" % r
        else:
            table, key = source
            ws.cell(row=r, column=4, value=tables[table][key])
            fallback = "D%d" % r
        ws.cell(row=r, column=5, value="=IF(ISNUMBER(B{0}),B{0},{1})".format(r, fallback)).font = Font(bold=True)
        for c in range(2, 6):
            ws.cell(row=r, column=c).number_format = number_format
        ws.cell(row=r, column=6, value=note.format(c=meta["columns"], r=tables["rates"], h=meta))
        _name(wb, name, "Inputs", "$E$%d" % r)
    r = INPUT_HEADER_ROW + len(INPUTS) + 2
    ws.cell(row=r, column=1, value="Per unit of DRG weight, from the values used (the DRG weights and Per year tabs "
                                    "multiply these by each DRG's weight)").font = Font(bold=True)
    for r, (name, label, formula) in enumerate(PER_WEIGHT, r + 1):
        ws.cell(row=r, column=1, value="%s (%s)" % (label, name))
        cell = ws.cell(row=r, column=5, value="=" + formula)
        cell.font, cell.number_format = Font(bold=True), CURRENCY
        ws.cell(row=r, column=6, value=formula)
        _name(wb, name, "Inputs", "$E$%d" % r)
    ws.freeze_panes = "A%d" % (INPUT_HEADER_ROW + 1)
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


def _readme_sheet(wb, doc, hospitals, shares):
    meta = doc["meta"]
    counts, rates = meta["counts"], meta["rates"]
    impact, deductibles = hospitals["meta"]["source"], shares["meta"]["deductibles"]
    sources = dict.fromkeys("%s. %s" % (s["label"], s["landing"])
                            for s in list(meta["sources"].values()) + [impact] + shares["meta"]["sources"])
    lines = [
        ("Revenue at stake: Medicare inpatient-only removals", "title"),
        (BADGE, None),
        ("Built %s from crosswalk.json. Every figure is an estimate of revenue at stake, not a forecast, and not billing or legal advice." % meta["built"], None),
        ("", None),
        ("What this is", "h"),
        ("For each of the %d codes CMS removed from the inpatient-only list effective January 1, 2026 or January 1, 2027, "
         "the Crosswalk tab sets the outpatient payment beside the range of inpatient payments for the "
         "MS-DRG family the same operation would group to: national by default, or at the hospital whose CCN you enter. "
         "Outpatient-eligible does not mean outpatient-only: status "
         "decisions stay clinical (two-midnight rule), and removal from the list changes what Medicare will pay for, not "
         "what is right for the patient." % counts["codes"], None),
        ("", None),
        ("Method in 5 steps", "h"),
        ("1. List: the codes removed from the inpatient-only list on 2026-01-01 (%d) or 2027-01-01 (%d)." % (counts["removed_2026"], counts["removed_2027"]), None),
        ("2. Outpatient: the CY 2027 OPPS Addendum B rate for the code's APC, with the CY 2027 ASC rate shown for reference. Packaged codes have no separate payment.", None),
        ("3. Map: two separate AI passes each chose the ICD-10-PCS code or codes a hospital would report for the same operation, and a typical principal diagnosis. A third pass adjudicated where they disagreed.", None),
        ("4. Group: a deterministic MS-DRG v44 grouper turns each mapping into a DRG family (the with MCC, with CC and without CC/MCC levels).", None),
        ("5. Price: DRG relative weight x (operating base + capital base), from the FY 2027 IPPS correction-notice tables. "
         "Operating base = standardized amount x (labor share x wage index + 1 - labor share); capital base = capital "
         "federal rate x GAF. IME = operating base x operating IME + capital base x capital IME; DSH the same with the DSH "
         "factors. Outpatient = APC rate x (outpatient labor share x wage index + 1 - outpatient labor share). Inpatient low "
         "and high are the lowest and highest DRG in the family. Gap = outpatient minus inpatient; negative means the "
         "hospital is paid less outpatient.", None),
        ("", None),
        ("Years", "h"),
        ("Outpatient: CY 2027 OPPS (from Jan 1, 2027).", None),
        ("Inpatient: FY 2027 IPPS (Oct 1, 2026 – Sep 30, 2027).", None),
        ("", None),
        ("National, unadjusted", "h"),
        ("With the Hospital CCN blank, every amount is national and unadjusted: wage index 1, GAF 1, no IME, DSH, outlier "
         "or other hospital-specific adjustment, and IME + DSH is $0. Defaults: operating amount $%s, capital rate $%s." % (
             format(rates["operating"], ",.2f"), format(rates["capital"], ",.2f")), None),
        ("", None),
        ("How to use the Inputs tab (Hospital CCN)", "h"),
        ("Type a hospital's six-digit CCN in the yellow Hospital CCN cell. Its FY 2027 wage index, capital GAF, operating "
         "and capital IME and DSH come from the Hospitals tab (%s) and the outpatient rate, inpatient low and high, "
         "IME + DSH, the gaps and the Per year tab recalculate. A value in a yellow 'Your value' cell overrides that one "
         "factor; the 'Used' column shows what the formulas use. A CCN not on the Hospitals tab, or a Maryland hospital's "
         "CCN, leaves national values and says so beside the cell. %s "
         "The labor share and standardized amount follow the wage index used (Table 1A above 1, Table 1B at 1 or below). "
         "Amounts are computed unrounded and rounded for display, so parts may differ from a total by a cent. "
         "Do not type over the formulas on the Crosswalk tab. The DRG weights and APC rates tabs hold the CMS figures "
         "the formulas look up, and the DRG weights tab each DRG's payment and IME + DSH at the hospital."
         % (impact["label"], hospitals["meta"]["maryland"]), None),
        ("", None),
        ("Per year", "h"),
        ("The Per year tab has one row per DRG on the Crosswalk tab: the payment and add-ons per case at the hospital, "
         "yellow cells for traditional Medicare and MA cases a year (blank until you enter them), and add-ons a year = "
         "count x the unrounded per-case add-on, rounded to the cent. Traditional Medicare carries IME and DSH; MA carries "
         "operating IME only (no capital IME or DSH on MA claims). " + MA_ESTIMATE.format(**hospitals["meta"]["columns"])
         + " " + CEILING + " " + ADDON_CASES, None),
        ("", None),
        ("Patient share (national)", "h"),
        ("The patient-share columns are national and do not follow the CCN. At an ambulatory surgery center: 20%% of the "
         "CY 2027 national ASC rate (Addendum AA). In the hospital outpatient department: Addendum B's national unadjusted "
         "copayment (where CMS prints none, its minimum, 20%% of the national rate), capped at the %d Part A inpatient "
         "deductible, $%s. The Part B deductible ($%s in %d) applies in either setting and is not included. 'ASC costs "
         "patient more' compares the unrounded shares. Deductibles: %s, %s." % (
             deductibles["year"], format(deductibles["part_a_inpatient"], ",d"), format(deductibles["part_b"], ",d"),
             deductibles["year"], deductibles["source"], deductibles["url"]), None),
        ("", None),
        ("Left out", "h"),
        (UNCOMPENSATED + " Also left out: outliers; value-based purchasing, readmissions and hospital-acquired condition "
         "adjustments; sole community and Medicare-dependent hospitals' hospital-specific rates (the federal rate is "
         "shown); direct GME (42 CFR 413.76: it follows the Medicare and MA share of inpatient days, so it falls slightly "
         "and later). Outpatient carries no IME or DSH.", None),
        ("", None),
        ("Estimate, not forecast", "h"),
        ("The figures show what Medicare's rates would pay for the same operation in each setting. They do not predict your volume, "
         "case mix, denials or contract terms.", None),
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
    ] + [(line, None) for line in sources]
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


def write(doc, out_path, reviews=None, hospitals=None, shares=None, beside=None):
    """Build the workbook for a crosswalk document and save it to out_path. Returns the path.
    hospitals and shares are hospitals.json and patient-shares.json; when not given they are read from
    the directory beside (the one holding the crosswalk.json being written; pipeline/derived/ by default)."""
    beside = Path(beside) if beside is not None else fetch.DERIVED
    if reviews is None:
        reviews = fetch.read_json_or(REVIEWS, [])
    if hospitals is None:
        hospitals = fetch.read_json(beside / HOSPITALS)
    if shares is None:
        shares = fetch.read_json(beside / SHARES)
    wb = Workbook()
    wb.remove(wb.active)
    drgs, apcs = _used(doc)
    _crosswalk_sheet(wb, doc, shares)
    _per_year_sheet(wb, drgs, hospitals["meta"]["columns"])
    _pcs_sheet(wb, doc)
    _inputs_sheet(wb, doc, hospitals)
    _hospitals_sheet(wb, hospitals)
    meta = doc["meta"]["sources"]
    _lookup_sheet(wb, "DRG weights", "FY 2027 MS-DRG relative weights (DRGs used on the Crosswalk tab), and each DRG's "
                  "payment at the hospital on the Inputs tab", ["DRG", "Title", "Relative weight", "Payment per case",
                                                                "IME + DSH per case"],
                  [[d, drgs[d][0], drgs[d][1]] for d in sorted(drgs)], meta["ipps-2027-table5"], [8, 100, 16, 16, 16],
                  {1: "DrgNum", 3: "DrgWeight", 4: "DrgTotal", 5: "DrgAddons"}, {3: "0.0000", 4: CURRENCY, 5: CURRENCY},
                  "Payment and IME + DSH per case = ROUND(relative weight x the Inputs tab's per-unit amount, 2).",
                  {4: "=ROUND(C{r}*PerWeightTotal,2)", 5: "=ROUND(C{r}*PerWeightAddons,2)"})
    _lookup_sheet(wb, "APC rates", "CY 2027 OPPS payment rates (APCs used on the Crosswalk tab)", ["APC", "Title", "National unadjusted rate"],
                  [[a, apcs[a][0], apcs[a][1]] for a in sorted(apcs)], meta["addenda-2027"], [8, 60, 24],
                  {1: "ApcNum", 3: "ApcRate"}, {3: CURRENCY})
    _review_log_sheet(wb, reviews)
    _readme_sheet(wb, doc, hospitals, shares)
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
    print("Wrote %s" % write(fetch.read_json(args.source), args.out, beside=args.source.parent))
    return 0


if __name__ == "__main__":
    sys.exit(main())
