"""The Python reference (pipeline/crosswalk/price.py) for web/test/hospital-math.test.mjs.

Reads {"rates", "opps_labor_share", "hospitals": [factors], "weights": [w], "apc": [rate],
"years": [[count, weight]]} as JSON on stdin and writes, per hospital, price.py's unrounded results
as JSON on stdout: Python floats round-trip through JSON exactly, so the JS test compares doubles,
not just cents. Run by the test; nothing here is committed output.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pipeline", "crosswalk"))
import price  # noqa: E402


def main():
    ask = json.load(sys.stdin)
    rates, share = ask["rates"], ask["opps_labor_share"]
    out = []
    for hospital in ask["hospitals"]:
        drgs = [price.hospital_drg_payment(w, hospital, rates) for w in ask["weights"]]
        outpatient = [price.hospital_outpatient(rate, hospital["wi"], share) for rate in ask["apc"]]
        years = [price.per_year(count, price.hospital_drg_payment(w, hospital, rates)["addons"]) for count, w in ask["years"]]
        out.append({"drgs": drgs, "drgs_cents": [{k: round(v, 2) for k, v in d.items()} for d in drgs],
                    "outpatient": outpatient, "outpatient_cents": [round(v, 2) for v in outpatient], "years": years})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
