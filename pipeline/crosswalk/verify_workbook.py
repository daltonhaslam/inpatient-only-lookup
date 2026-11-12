#!/usr/bin/env python3
"""Check crosswalk.xlsx with an independent formula evaluator (not run on Vercel).

    <venv with the `formulas` package>/bin/python pipeline/crosswalk/verify_workbook.py [--xlsx FILE] [--json FILE]

1. Evaluates every amount on the Crosswalk tab at the Inputs defaults and compares it with
   crosswalk.json to the cent (outpatient rate, inpatient low and high, gap low and high).
2. Sets WageIndex to 1.2 in a copy and checks the DRG 165 row moves by exactly the operating
   labor portion: weight x OpStd x LaborShare x 0.2.
Needs: python3 -m venv V && V/bin/pip install formulas openpyxl. Exits 1 on any mismatch.
"""
import argparse
import re
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import formulas      # noqa: E402
import openpyxl      # noqa: E402
import fetch      # noqa: E402

HEADERS = ("Outpatient national rate", "Inpatient low", "Inpatient high", "Gap low", "Gap high")


def evaluate(path):
    """{(sheet, cell): value} for every Crosswalk cell, from the independent evaluator."""
    solution = formulas.ExcelModel().loads(str(path)).finish().calculate()
    out = {}
    for key, rng in solution.items():
        m = re.match(r"^'\[[^\]]+\](.+)'!([A-Z]+\d+)$", str(key))
        if m and m.group(1).upper() == "CROSSWALK":
            out[m.group(2)] = rng.value[0, 0]
    return out


def number(value):
    """A float, or None for an empty or blank result."""
    if value is None or isinstance(value, str) or type(value).__name__ in ("XlError", "Empty"):
        return None if (value is None or isinstance(value, str) and value == "" or type(value).__name__ == "Empty") else value
    return float(value)


def expected_rows(doc):
    rows = []
    for code, item in sorted(doc["codes"].items()):
        rate = item["outpatient"]["rate"]
        fams = (item["inpatient"] or {}).get("families") or [None]
        for fam in fams:
            low, high = (fam["low"], fam["high"]) if fam else (None, None)
            gap = (None, None) if rate is None or fam is None else (round(rate - high, 2), round(rate - low, 2))
            rows.append((code, [rate, low, high, gap[0], gap[1]], fam))
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--xlsx", type=Path, default=fetch.PIPELINE / "derived" / "crosswalk.xlsx")
    parser.add_argument("--json", type=Path, default=fetch.PIPELINE / "derived" / "crosswalk.json")
    args = parser.parse_args(argv)
    doc = fetch.read_json(args.json)
    wb = openpyxl.load_workbook(args.xlsx)
    ws = wb["Crosswalk"]
    header = {cell.value: cell.column_letter for cell in ws[1]}
    cols = [header[h] for h in HEADERS]
    codes = [ws["A%d" % r].value for r in range(2, ws.max_row + 1)]
    expected = expected_rows(doc)
    if [e[0] for e in expected] != codes:
        print("FAIL: Crosswalk rows do not match crosswalk.json code/family rows (%d vs %d)" % (len(codes), len(expected)))
        return 1

    values = evaluate(args.xlsx)
    bad, checked = [], 0
    for r, (code, want, _) in enumerate(expected, 2):
        for letter, name, w in zip(cols, HEADERS, want):
            got = number(values.get("%s%d" % (letter, r)))
            checked += 1
            if (got is None) != (w is None) or (w is not None and abs(got - w) > 0.005):
                bad.append("%s row %d %s: workbook %r, json %r" % (code, r, name, got, w))
    print("Defaults: %d amount cells over %d rows checked against crosswalk.json; %d mismatch(es)" % (checked, len(expected), len(bad)))
    for line in bad[:20]:
        print("  " + line)

    # WageIndex 1.2: pick a row whose family's lowest DRG is 165.
    r165 = next(r for r, (_, _, fam) in enumerate(expected, 2)
                if fam and min(fam["drgs"], key=lambda d: d["amount"])["drg"] == "165")
    drg = next(d for d in expected[r165 - 2][2]["drgs"] if d["drg"] == "165")
    names = {n: wb.defined_names[n].attr_text.split("!")[1].replace("$", "") for n in ("WageIndex", "OpStd", "LaborShare")}
    inputs = wb["Inputs"]
    op, share = inputs[names["OpStd"]].value, inputs[names["LaborShare"]].value
    inputs[names["WageIndex"]].value = 1.2
    tmp = Path(tempfile.mkdtemp()) / "wage12.xlsx"
    wb.save(tmp)
    moved = number(evaluate(tmp)["%s%d" % (header["Inpatient low"], r165)])
    want = round(drg["weight"] * (op * (share * 1.2 + 1 - share) + doc["meta"]["rates"]["capital"]), 2)
    delta = round(drg["weight"] * op * share * 0.2, 2)
    ok = moved is not None and abs(moved - want) <= 0.005 and abs((moved - drg["amount"]) - delta) <= 0.011
    print("WageIndex 1.2, DRG 165 (row %d): %.2f -> %.2f; expected %.2f (labor portion adds %.2f)  %s"
          % (r165, drg["amount"], moved, want, delta, "ok" if ok else "MISMATCH"))
    shutil.rmtree(tmp.parent)
    return 1 if bad or not ok else 0


if __name__ == "__main__":
    sys.exit(main())
