#!/usr/bin/env python3
"""Check crosswalk.xlsx with an independent formula evaluator (not run on Vercel).

    <venv with the `formulas` package>/bin/python pipeline/crosswalk/verify_workbook.py
        [--xlsx FILE] [--json FILE] [--hospitals FILE] [--facts FILE]

Evaluates the workbook as shipped and copies with inputs typed in (in parallel), and compares:
1. National (CCN blank): every amount on the Crosswalk tab against crosswalk.json to the cent
   (outpatient rate, inpatient low and high, gap low and high); IME + DSH is $0 on every row.
2. Your own wage index 1.2: the DRG 165 row against price.py's formula at that wage index.
3. CCN 380009 (OHSU) with 10 traditional DRG 165 cases: the OHSU anchors in facts.json
   "expected" (DRG 165 and 163 totals and add-ons, operating IME, APC 5183, the per-year
   add-ons) on the Per year and Crosswalk tabs, and every Crosswalk amount against price.py's
   hospital formula (the reference the site is held to).
4. A hospital with no IME or DSH and a wage index below 1, its CCN typed as a number (leading zero
   dropped): every Crosswalk amount against price.py, IME + DSH $0, no MA estimate.
5. A Maryland CCN: the status reads hospitals.json's Maryland reason, and the DRG 165 row stays
   national.
No scenario may leave an error value (#N/A, #VALUE!, ...) on the Crosswalk, Per year or Inputs tab.
Needs: python3 -m venv V && V/bin/pip install formulas openpyxl. Exits 1 on any mismatch.
"""
import argparse
import numbers
import os
import re
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import formulas      # noqa: E402
import openpyxl      # noqa: E402
import fetch      # noqa: E402
from crosswalk import workbook as wbk      # noqa: E402
from crosswalk.price import NATIONAL, hospital_drg_payment, hospital_outpatient      # noqa: E402

HEADERS = ("Outpatient rate", "Inpatient low", "Inpatient high", "IME + DSH low", "IME + DSH high", "Gap low", "Gap high")
CHECKED_SHEETS = ("CROSSWALK", "PER YEAR", "INPUTS")


def plain(value):
    """An evaluator result as a plain, picklable value: float, bool, str, or None for empty."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, numbers.Number):      # numpy numbers included
        return float(value)
    text = str(value)
    return None if text == "empty" else text


def evaluate(path):
    """{sheet name (upper case): {cell: value}} for the tabs a reader uses, from the independent evaluator."""
    solution = formulas.ExcelModel().loads(str(path)).finish().calculate()
    out = {}
    for key, rng in solution.items():
        m = re.match(r"^'\[[^\]]+\](.+)'!([A-Z]+\d+)$", str(key))
        if m and m.group(1).upper() in CHECKED_SHEETS:
            out.setdefault(m.group(1).upper(), {})[m.group(2)] = plain(rng.value[0, 0])
    return out


def number(value):
    """A float, or None for an empty or text result."""
    return value if isinstance(value, float) else None


def cents(value):
    return None if value is None else round(value, 2)


def errors(values):
    """Cells holding an Excel error value."""
    return ["%s!%s %s" % (sheet, cell, value) for sheet, got in values.items() for cell, value in got.items()
            if str(value).startswith("#")]


def expected_rows(doc, hospital=None, rates=None, opps_labor_share=None):
    """[(code, [outpatient, low, high, IME + DSH low, IME + DSH high, gap low, gap high], family)]:
    crosswalk.json's own amounts (hospital None), or price.py's at a hospital."""
    rows = []
    for code, item in sorted(doc["codes"].items()):
        rate = item["outpatient"]["rate"]
        if hospital and rate is not None:
            rate = cents(hospital_outpatient(rate, hospital["wi"], opps_labor_share))
        for fam in (item["inpatient"] or {}).get("families") or [None]:
            if fam is None:
                rows.append((code, [rate] + [None] * 6, fam))
                continue
            if hospital:
                paid = [hospital_drg_payment(d["weight"], hospital, rates) for d in fam["drgs"]]
                totals, addons = [cents(p["total"]) for p in paid], [cents(p["addons"]) for p in paid]
                low, high, add_low, add_high = min(totals), max(totals), min(addons), max(addons)
            else:
                low, high, add_low, add_high = fam["low"], fam["high"], 0.0, 0.0
            gap = (None, None) if rate is None else (round(rate - high, 2), round(rate - low, 2))
            rows.append((code, [rate, low, high, add_low, add_high, gap[0], gap[1]], fam))
    return rows


def compare(values, header, expected):
    """(cells checked, mismatches) of the Crosswalk amounts against expected_rows."""
    bad, checked = [], 0
    cols = [header[h] for h in HEADERS]
    for r, (code, want, _) in enumerate(expected, 2):
        for letter, name, w in zip(cols, HEADERS, want):
            got = number(values.get("%s%d" % (letter, r)))
            checked += 1
            if (got is None) != (w is None) or (w is not None and abs(got - w) > 0.005):
                bad.append("%s row %d %s: workbook %r, expected %r" % (code, r, name, got, w))
    return checked, bad


def defined_cell(wb, name, column=None):
    """(sheet, cell) a single-cell name points at; column swaps its column (the "your value" cell is B)."""
    sheet, ref = wb.defined_names[name].attr_text.split("!")
    ref = ref.replace("$", "")
    if column:
        ref = column + re.sub(r"^[A-Z]+", "", ref)
    return sheet.strip("'"), ref


def typed_copy(source, changes, folder, label):
    """A copy of the workbook with {(sheet, cell): value} typed in."""
    wb = openpyxl.load_workbook(source)
    for (sheet, ref), value in changes.items():
        wb[sheet][ref].value = value
    path = Path(folder) / ("%s.xlsx" % label)
    wb.save(path)
    return path


class Report:
    def __init__(self):
        self.failed = 0

    def line(self, ok, text, details=()):
        print("%s  %s" % ("ok  " if ok else "FAIL", text))
        for detail in list(details)[:20]:
            print("        " + detail)
        self.failed += 0 if ok else 1

    def match(self, label, got, want):
        ok = got is not None and want is not None and abs(got - want) <= 0.005
        self.line(ok, "%s: workbook %s, expected %s" % (label, "%.2f" % got if got is not None else got, "%.2f" % want))

    def rows(self, label, values, header, expected, against):
        checked, bad = compare(values["CROSSWALK"], header, expected)
        self.line(not bad, "%s: %d Crosswalk amount cells against %s; %d mismatch(es)" % (label, checked, against, len(bad)), bad)

    def clean(self, label, values):
        self.line(not errors(values), "%s: no error values" % label, errors(values))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--xlsx", type=Path, default=fetch.DERIVED / "crosswalk.xlsx")
    parser.add_argument("--json", type=Path, default=fetch.DERIVED / "crosswalk.json")
    parser.add_argument("--hospitals", type=Path, default=fetch.DERIVED / "hospitals.json")
    parser.add_argument("--facts", type=Path, default=fetch.PIPELINE / "facts.json")
    args = parser.parse_args(argv)
    started = time.time()
    doc, table = fetch.read_json(args.json), fetch.read_json(args.hospitals)
    anchors = fetch.read_json(args.facts)["expected"]["ohsu"]
    rates, opps_share = table["meta"]["rates"], table["meta"]["opps_labor_share"]
    wb = openpyxl.load_workbook(args.xlsx)
    ws = wb["Crosswalk"]
    header = {cell.value: cell.column_letter for cell in ws[1]}
    codes = [ws["A%d" % r].value for r in range(2, ws.max_row + 1)]
    national = expected_rows(doc)
    if [e[0] for e in national] != codes:
        print("FAIL: Crosswalk rows do not match crosswalk.json code/family rows (%d vs %d)" % (len(codes), len(national)))
        return 1
    per_year_sheet = wb["Per year"]
    py_col = {c.value: c.column_letter for c in per_year_sheet[wbk.PER_YEAR_FIRST - 1] if c.value}
    drg_row = {per_year_sheet["A%d" % r].value: r for r in range(wbk.PER_YEAR_FIRST, per_year_sheet.max_row + 1)
               if isinstance(per_year_sheet["A%d" % r].value, int)}
    status, ccn = defined_cell(wb, "HospitalStatus")[1], defined_cell(wb, "HospitalCCN")
    count_drg, count = int(anchors["per_year"]["drg"]), anchors["per_year"]["count"]
    trad = ("Per year", "%s%d" % (py_col[wbk.PY_TRAD], drg_row[count_drg]))
    plain_ccn = next(c for c, h in sorted(table["hospitals"].items()) if c.startswith("0") and h["wi"] < 1
                     and not any(h[k] for k in ("tchop", "tchcp", "dshopp", "dshcpp")))
    maryland = sorted(table["maryland"])[0]
    # A row whose family's lowest DRG is 165 (the wage-index and Maryland samples).
    r165 = next(r for r, (_, _, fam) in enumerate(national, 2)
                if fam and min(fam["drgs"], key=lambda d: d["amount"])["drg"] == "165")
    w165 = next(d for d in national[r165 - 2][2]["drgs"] if d["drg"] == "165")

    folder = tempfile.mkdtemp()
    report = Report()
    try:
        scenarios = {"national": args.xlsx,
                     "wage12": typed_copy(args.xlsx, {defined_cell(wb, "WageIndex", "B"): 1.2}, folder, "wage12"),
                     "ohsu": typed_copy(args.xlsx, {ccn: anchors["ccn"], trad: count}, folder, "ohsu"),
                     "plain": typed_copy(args.xlsx, {ccn: int(plain_ccn), trad: count}, folder, "plain"),
                     "maryland": typed_copy(args.xlsx, {ccn: maryland}, folder, "maryland")}
        with ProcessPoolExecutor(max_workers=min(len(scenarios), os.cpu_count() or 1)) as pool:
            results = dict(zip(scenarios, pool.map(evaluate, scenarios.values())))

        # 1. National, as shipped.
        values = results["national"]
        report.rows("National", values, header, national, "crosswalk.json")
        report.clean("National", values)

        # 2. Your own wage index 1.2.
        moved = number(results["wage12"]["CROSSWALK"]["%s%d" % (header["Inpatient low"], r165)])
        want = cents(hospital_drg_payment(w165["weight"], dict(NATIONAL, wi=1.2), rates)["total"])
        report.match("Your wage index 1.2, DRG 165 (row %d, national %.2f), against price.py" % (r165, w165["amount"]), moved, want)

        # 3. OHSU by CCN, with a per-year count.
        values, label = results["ohsu"], "CCN %s" % anchors["ccn"]
        hospital = table["hospitals"][anchors["ccn"]]
        report.line(str(values["INPUTS"][status]).startswith("Hospital: "), "%s: status reads %r" % (label, values["INPUTS"][status]))
        per_year = values["PER YEAR"]
        cell = lambda name, drg: number(per_year["%s%d" % (py_col[name], drg_row[int(drg)])])      # noqa: E731
        for drg, want in sorted(anchors["drgs"].items()):
            report.match("%s DRG %s total per case (Per year)" % (label, drg), cents(cell(wbk.PY_TOTAL, drg)), want["total"])
            report.match("%s DRG %s IME + DSH per case (Per year)" % (label, drg), cents(cell(wbk.PY_ADDONS, drg)), want["addons"])
            if "ime_operating" in want:
                report.match("%s DRG %s operating IME per case (Per year, MA)" % (label, drg),
                             cents(cell(wbk.PY_MA, drg)), want["ime_operating"])
        for drg, side in (("165", "low"), ("163", "high")):
            r = next((r for r, (_, _, fam) in enumerate(national, 2) if fam and
                      (min if side == "low" else max)(fam["drgs"], key=lambda d: d["weight"])["drg"] == drg), None)
            if r is None:
                report.line(False, "%s: no Crosswalk row whose %s DRG is %s" % (label, side, drg))
                continue
            got = values["CROSSWALK"]
            report.match("%s Crosswalk row %d (%s) inpatient %s, DRG %s" % (label, r, codes[r - 2], side, drg),
                         number(got["%s%d" % (header["Inpatient " + side], r)]), anchors["drgs"][drg]["total"])
            report.match("%s Crosswalk row %d IME + DSH %s, DRG %s" % (label, r, side, drg),
                         number(got["%s%d" % (header["IME + DSH " + side], r)]), anchors["drgs"][drg]["addons"])
        apc = anchors["apc"]
        r = next(r for r in range(2, ws.max_row + 1) if str(ws["%s%d" % (header["APC"], r)].value) == apc["apc"])
        report.match("%s APC %s outpatient rate (row %d)" % (label, apc["apc"], r),
                     number(values["CROSSWALK"]["%s%d" % (header["Outpatient rate"], r)]), apc["at_hospital"])
        report.match("%s per year: %d traditional DRG %d cases' IME + DSH" % (label, count, count_drg),
                     cell(wbk.PY_YEAR_TRAD, count_drg), anchors["per_year"]["addons"])
        ratio = hospital["ime_caseta44"] / hospital["caseta44"]
        ma_cases = int(count * ratio + 0.5)
        ma_ime = hospital_drg_payment(table["meta"]["drg_weights"]["%03d" % count_drg], hospital, rates)["ime_operating"]
        report.line(cell(wbk.PY_MA_USED, count_drg) == ma_cases, "%s per year: MA estimate %r cases (expected round(%d x %.4f) = %d)"
                    % (label, cell(wbk.PY_MA_USED, count_drg), count, ratio, ma_cases))
        report.match("%s per year: MA operating IME a year" % label, cell(wbk.PY_YEAR_MA, count_drg), round(ma_cases * ma_ime, 2))
        total_row = max(drg_row.values()) + 1
        report.match("%s per year: total add-ons" % label, number(per_year["%s%d" % (py_col[wbk.PY_YEAR], total_row)]),
                     round(anchors["per_year"]["addons"] + round(ma_cases * ma_ime, 2), 2))
        report.rows(label, values, header, expected_rows(doc, hospital, rates, opps_share), "price.py")
        report.clean(label, values)

        # 4. No IME or DSH, wage index below 1, CCN typed as a number.
        values = results["plain"]
        label = "CCN %s typed as %d (no add-ons, wage index %s)" % (plain_ccn, int(plain_ccn), table["hospitals"][plain_ccn]["wi"])
        per_year = values["PER YEAR"]
        report.line(str(values["INPUTS"][status]).endswith("CCN %s" % plain_ccn), "%s: status reads %r" % (label, values["INPUTS"][status]))
        report.rows(label, values, header, expected_rows(doc, table["hospitals"][plain_ccn], rates, opps_share), "price.py")
        report.line(cell(wbk.PY_YEAR_TRAD, count_drg) == 0 and per_year["%s%d" % (py_col[wbk.PY_MA_USED], drg_row[count_drg])] in ("", None),
                    "%s: per year IME + DSH $0, no MA estimate" % label)
        report.clean(label, values)

        # 5. Maryland: not offered, so national values, and the status gives hospitals.json's reason.
        values, label = results["maryland"], "CCN %s (Maryland)" % maryland
        report.line(values["INPUTS"][status] == wbk.maryland_status(table["meta"]),
                    "%s: status reads %r" % (label, values["INPUTS"][status]))
        report.match("%s row %d inpatient low (national)" % (label, r165),
                     number(values["CROSSWALK"]["%s%d" % (header["Inpatient low"], r165)]), w165["amount"])
        report.match("%s row %d IME + DSH low" % (label, r165),
                     number(values["CROSSWALK"]["%s%d" % (header["IME + DSH low"], r165)]), 0.0)
        report.clean(label, values)
    finally:
        shutil.rmtree(folder)
    print("%s: %d check(s) failed (%.0f s)" % ("FAIL" if report.failed else "PASS", report.failed, time.time() - started))
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
