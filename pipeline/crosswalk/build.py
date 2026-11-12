#!/usr/bin/env python3
"""Assemble the revenue-at-stake crosswalk and check it.

    python3 pipeline/crosswalk/build.py [--passes DIR] [--adjudications FILE] [--out DIR]
                                        [--checks FILE] [--allow-missing]

Reads   pipeline/derived/ipo-history.json, data/labels.json, the pinned CMS files (data/raw/),
        the mapping passes (data/crosswalk/passes/), adjudications.json, reviews.json and
        resolutions.json
Writes  <out>/crosswalk.json (default pipeline/derived/), only when every check passes, and with it
        <out>/crosswalk.xlsx (workbook.py), except under --allow-missing
        pipeline/out/crosswalk-checks.txt (or --checks), always

One entry per code with a removal dated 2026-01-01 or 2027-01-01: the CY 2027 outpatient
payment, the FY 2027 MS-DRG families its mapping groups to with national amounts, the
difference, tier, review status and review batch. --allow-missing turns "a mappable code has no
mapping in both passes yet" from a failure into a skip, for building before mapping is done; a
disagreement nobody adjudicated still fails. Exits 1 on any failed check.
"""
import argparse
import datetime
import sys
import types
from pathlib import Path

if __name__ == "__main__":
    # Run as a script, sys.path[0] is this folder; the pipeline modules live one level up.
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

import fetch      # noqa: E402
import history    # noqa: E402
import parse      # noqa: E402
from crosswalk import checks, mapper, mappings, reviews, sources, status, workbook   # noqa: E402
from crosswalk.group import _ANY_OR, Ref, _clusters, group     # noqa: E402
from crosswalk.price import family_range   # noqa: E402

DERIVED = fetch.PIPELINE / "derived"
CHECKS = fetch.PIPELINE / "out" / "crosswalk-checks.txt"
RESOLUTIONS = mappings.CROSSWALK_DIR / "resolutions.json"
REVIEW_BATCH_SIZE = 10

# A hip or knee revision coded as Removal (0SP, these joint body parts) plus Replacement lands in
# 463-465, because the 0SP rows rank above 469-470 in v44; the family carries this caveat.
REVISION_DRGS = ("463", "464", "465")
REVISION_JOINTS = frozenset("CD9BAERSTUVW")
REVISION_CAVEAT = ("In MS-DRG v44 a hip or knee revision coded as removal plus replacement groups to DRGs 463–465. "
                   "CMS's title for those DRGs still reads wound debridement or skin graft. DRG 449 (revision of hip or "
                   "knee prosthesis) covers only the PCS Revision root operation.")

# Every source sources.py reads: a label for the page and the members it reads, as
# [(member pattern, prefer the workbook)], the same patterns sources.py uses.
SOURCE_FILES = {
    "addenda-2027": ("CY 2027 OPPS final rule (CMS-1850-FC), Addenda A and B",
                     [(sources.ADDENDUM_A, True), (history.ADDENDUM_B, True)]),
    "addenda-2027-proposed": ("CY 2027 OPPS proposed rule (CMS-1850-P), Addendum B", [(history.ADDENDUM_B, True)]),
    "asc-2027-aa": ("CY 2027 ASC final rule (CMS-1850-FC), Addendum AA", [(sources.ASC_AA, True)]),
    "ipps-2027-table5": ("FY 2027 IPPS final rule, correction notice Table 5 (MS-DRG relative weights)",
                         [(r"-CN Table 5\.txt$", False)]),
    "ipps-2027-table1": ("FY 2027 IPPS final rule, correction notice Tables 1A-1E (standardized amounts, capital rate)",
                         [(r"-CN Tables 1A", False)]),
    "msdrg-v44": ("MS-DRG v44.0 Definitions Manual",
                  [(r"^appendix_A\.txt$", False), (r"^appendix_B\.txt$", False), (r"^appendix_D_E\.txt$", False),
                   (r"^appendix_F_I\.txt$", False)] + [(r"^%s\.txt$" % name, False) for name in sources.MDC_FILES]),
    "pcs-2027": ("ICD-10-PCS FY 2027 code titles (order file)", [(r"^icd10pcs_order_\d{4}\.txt$", False)]),
    "cm-2027": ("ICD-10-CM FY 2027 code titles (tabular order file)", [(r"^icd10cm_order_\d{4}\.txt$", False)]),
}


def load_inputs(passes_dir=None, adjudications_path=None):
    """Everything the crosswalk is assembled and checked from, as one namespace."""
    spans = fetch.read_json(mapper.HISTORY)
    batches, packaged = mapper.mapping_batches()
    passes_dir = Path(passes_dir) if passes_dir else mappings.PASSES_DIR
    adjudications_path = Path(adjudications_path) if adjudications_path else mappings.ADJUDICATIONS
    return types.SimpleNamespace(
        ref=Ref.load(),
        removed={code: max(e["date"] for e in info["events"] if e["type"] == "removed" and e["date"] in mapper.REMOVAL_DATES)
                 for code, info in spans.items()
                 if any(e["type"] == "removed" and e["date"] in mapper.REMOVAL_DATES for e in info["events"])},
        labels=fetch.read_json(mapper.LABELS),
        mappable=[code for codes in batches.values() for code in codes],
        packaged=packaged,
        passes=mappings.load_passes(passes_dir),
        adjudications=mappings.load_adjudications(adjudications_path),
        reviews=fetch.read_json(reviews.REVIEWS) if reviews.REVIEWS.is_file() else [],
        resolutions=fetch.read_json(RESOLUTIONS) if RESOLUTIONS.is_file() else {},
        passes_dir=passes_dir,
        adjudications_path=adjudications_path,
    )


# ---------------------------------------------------------------- pieces of an entry

def difference(rate, inpatient):
    """Outpatient rate minus the inpatient range (negative = the hospital is paid less), or None."""
    if rate is None or inpatient is None:
        return None
    return {"low": round(rate - inpatient["high"], 2), "high": round(rate - inpatient["low"], 2)}


def review_batches(codes, labels):
    """[{"id", "group", "codes"}]: by labels.json group, then chunks of at most 10 in code order."""
    by_group = {}
    for code in sorted(codes):
        by_group.setdefault(labels[code]["group"], []).append(code)
    return [{"id": "%s-%d" % (name, n + 1), "group": name, "codes": members[start:start + REVIEW_BATCH_SIZE]}
            for name, members in sorted(by_group.items())
            for n, start in enumerate(range(0, len(members), REVIEW_BATCH_SIZE))]


def outpatient(code, packaged, ref):
    row = ref.opps.get(code) or {}
    apc = row.get("apc")
    proposed = ref.opps_proposed.get(code)
    return {"si": row.get("si"), "apc": apc, "apc_title": ref.apc_titles.get(apc) if apc else None,
            "rate": row.get("rate"), "asc": ref.asc.get(code), "proposed": dict(proposed) if proposed else None,
            "packaged": packaged}


def inpatient(rec, ref):
    """{"families", "low", "high"} over every pcs_set x principal_dx, typical diagnosis first.

    One family per diagnosis and DRG family. Where the sets give one diagnosis several families,
    each is labeled with its condition and the notes of the sets that lead to it. Raises
    ValueError when a combination does not group."""
    families = []
    for dx in sorted(rec["principal_dx"], key=lambda d: d["role"] != "typical"):
        found = {}
        for entry in rec["pcs_sets"]:
            result = group(entry["codes"], dx["code"], ref)
            found.setdefault(tuple(result["drgs"]), (result, entry["codes"], []))[2].append(entry.get("note") or "")
        condition = dx.get("condition") or ref.cm[dx["code"]]
        for drgs, (result, codes, notes) in found.items():
            notes = [note for note in notes if note]
            priced = family_range(drgs, ref)
            families.append({
                "condition": "%s: %s" % (condition, "; ".join(notes)) if len(found) > 1 and notes else condition,
                "dx": {"code": dx["code"], "title": ref.cm[dx["code"]]},
                "mdc": result["mdc"], "family": result["family"], "basis": result["basis"],
                "drgs": priced["drgs"], "low": priced["low"], "high": priced["high"],
                "index_rows": index_rows(codes, result, ref)})
            if drgs == REVISION_DRGS and any(pcs[:3] == "0SP" and pcs[3] in REVISION_JOINTS for pcs in codes):
                families[-1]["caveat"] = REVISION_CAVEAT
    return {"families": families, "low": min(f["low"] for f in families), "high": max(f["high"] for f in families)}


def index_rows(codes, result, ref):
    """The v44 Appendix E row behind a family, one entry per PCS code of the (first) set that
    groups to it: {"pcs", "mdc", "drgs", "family", "non_or"}, the code's Part 1 row in the
    family's MDC that names the family's DRGs, or else the Part 2 row of a procedure cluster the
    set completes with that code (then "cluster" holds the cluster's codes, e.g. "A+B", and a
    "note" says so). A code with neither gets mdc None, empty drgs, family None and a "note" on
    how it counts instead (non-OR, unrelated OR procedure, any-OR family, or another code sets the
    family). non_or is True for a code the grouper treats as non-OR (an Appendix E * code, one
    not in Appendix E, or one of a Part 3 non-OR combination)."""
    drgs, mdc, basis = set(result["drgs"]), result["mdc"], result["basis"]
    any_or = basis == "in-mdc" and tuple(result["drgs"]) in {f for entries in _ANY_OR.values() for f, _ in entries}
    clusters = [(key, row) for key, found in _clusters(codes, ref).items() for row in found
                if row["mdc"] == mdc and drgs & set(row["drgs"])]
    rows = []
    for pcs in codes:
        non_or = pcs not in result["or_codes"]
        row = next((r for r in ref.proc_index.get(pcs, ()) if r["mdc"] == mdc and drgs & set(r["drgs"])), None)
        if row:
            rows.append({"pcs": pcs, "mdc": row["mdc"], "drgs": list(row["drgs"]), "family": row["family"], "non_or": non_or})
            continue
        key, row = next(((key, row) for key, row in clusters if pcs in key.split("+")), (None, None))
        if row:
            rows.append({"pcs": pcs, "mdc": row["mdc"], "drgs": list(row["drgs"]), "family": row["family"], "non_or": non_or,
                         "cluster": key, "note": "Appendix E Part 2: the cluster %s is listed for this family" % key})
            continue
        if pcs not in ref.proc_index:
            note = "not in Appendix E: a non-OR procedure in MS-DRG terms"
        elif non_or and pcs in ref.unrelated:
            note = "made non-OR by an Appendix E Part 3 combination: does not set a surgical family"
        elif non_or:
            note = "non-OR procedure (Appendix E *): does not set a surgical family"
        elif basis.startswith("unrelated"):
            note = "OR procedure with no row in MDC %s: unrelated to the principal diagnosis (Appendix F, %s)" % (
                mdc, ref.unrelated[pcs].replace("nonextensive", "non-extensive"))
        elif any_or:
            note = "OR procedure: MDC %s groups a principal diagnosis with any OR procedure (no Appendix E rows)" % mdc
        else:
            note = "no row for this family in MDC %s; another code in the set sets the family" % mdc
        rows.append({"pcs": pcs, "mdc": None, "drgs": [], "family": None, "non_or": non_or, "note": note})
    return rows


def mapping_block(code, rec, inputs):
    a, b = (inputs.passes.get(name, {}).get(code) for name in mappings.PASS_NAMES)
    ref = inputs.ref
    adjudicated = inputs.adjudications.get(code)
    return {
        "pcs_sets": [{"codes": [{"code": pcs, "title": ref.pcs[pcs]} for pcs in entry["codes"]], "note": entry.get("note")}
                     for entry in rec["pcs_sets"]],
        "principal_dx": [{"code": dx["code"], "title": ref.cm[dx["code"]], "condition": dx.get("condition"), "role": dx["role"]}
                         for dx in rec["principal_dx"]],
        "fp": mappings.fingerprint(rec),
        # An adjudicated code shows pass A's reasoning here and the adjudicator's under "adjudication".
        "rationale": (a or {}).get("rationale") if adjudicated else rec["rationale"],
        "passes_agree": bool(a and b) and mappings.families(a, ref) == mappings.families(b, ref),
        "adjudication": adjudicated["rationale"] if adjudicated else None,
    }


def final_record(code, inputs):
    """The valid final record for a code, or None (the checks say why)."""
    try:
        rec = mappings.final_mapping(code, inputs.passes, inputs.adjudications, inputs.ref)
    except ValueError:
        return None
    if rec.get("code") != code or mappings.validate_record(rec, inputs.ref):
        return None
    return rec


# ---------------------------------------------------------------- the document

def entry(code, inputs, batch_of):
    ref = inputs.ref
    label = inputs.labels[code]
    packaged = code in inputs.packaged
    item = {"removed": inputs.removed[code], "label": label["label"], "group": label["group"], "family": label["family"],
            "outpatient": outpatient(code, packaged, ref), "inpatient": None, "mapping": None, "tier": None,
            "review": None, "difference": None, "batch": batch_of.get(code)}
    rec = None if packaged else final_record(code, inputs)
    fp = None
    if rec is not None:
        item["tier"] = status.tier(code, inputs.passes, rec, ref)
        if rec["mappable"]:
            fp = mappings.fingerprint(rec)
            item["mapping"] = mapping_block(code, rec, inputs)
            try:
                item["inpatient"] = inpatient(rec, ref)
            except ValueError:
                pass        # the checks fail the build on any combination that does not group
    item["review"] = status.review_status(code, fp, inputs.reviews, inputs.resolutions, item["tier"])
    item["difference"] = None if packaged else difference(item["outpatient"]["rate"], item["inpatient"])
    return item


def source_meta(source_id):
    source = next(s for s in fetch.load_sources() if s["id"] == source_id)
    label, members = SOURCE_FILES[source_id]
    path = fetch.raw_path(source)
    files = [parse.pick_member(path, pattern, prefer_spreadsheet=book).rsplit("/", 1)[-1] for pattern, book in members]
    return {"label": label, "landing": source["landing"], "file": "; ".join(files)}


def assemble(inputs):
    """The crosswalk document (see the module docstring); never raises on a bad mapping."""
    ref = inputs.ref
    used = set(sources.SOURCE_OF.values())
    if used != set(SOURCE_FILES):
        raise RuntimeError("SOURCE_FILES does not list exactly the sources sources.py reads: %s"
                           % sorted(used ^ set(SOURCE_FILES)))
    if not ref.opps_proposed:
        used.discard(sources.SOURCE_OF["load_opps_proposed"])
    batches = review_batches(inputs.mappable, inputs.labels)
    batch_of = {code: batch["id"] for batch in batches for code in batch["codes"]}
    codes = {code: entry(code, inputs, batch_of) for code in sorted(inputs.removed)}
    rates = ref.rates
    tiers, statuses = {}, {}
    for item in codes.values():
        if item["tier"] and item["tier"]["tier"]:
            tiers[str(item["tier"]["tier"])] = tiers.get(str(item["tier"]["tier"]), 0) + 1
        if item["mapping"]:
            statuses[item["review"]["status"]] = statuses.get(item["review"]["status"], 0) + 1
    meta = {
        "built": datetime.date.today().isoformat(),
        "counts": {"codes": len(codes),
                   "removed_2026": sum(1 for d in inputs.removed.values() if d == "2026-01-01"),
                   "removed_2027": sum(1 for d in inputs.removed.values() if d == "2027-01-01"),
                   "mappable": len(inputs.mappable), "packaged": len(inputs.packaged),
                   "mapped": sum(1 for item in codes.values() if item["mapping"]),
                   "tiers": tiers, "statuses": statuses, "batches": len(batches)},
        "rates": {"operating": rates["operating_wi_gt1"], "capital": rates["capital"],
                  "combined": round(rates["operating_wi_gt1"] + rates["capital"], 2),
                  "labor_share": rates["labor_share_gt1"], "operating_wi_le1": rates["operating_wi_le1"],
                  "labor_share_le1": rates["labor_share_le1"],
                  "operating_table": "Table 1A, CMS-1849-CN: national operating standardized amount, full update "
                                     "(quality data submitted, meaningful EHR user), wage index above 1",
                  "capital_table": "Table 1D, CMS-1849-CN: national capital federal rate",
                  "weights_table": "Table 5, CMS-1849-CN: relative weights with the 10% cap applied",
                  "version": "FY 2027 IPPS final rule correction notice (CN) tables, which supersede the final-rule tables",
                  "adjusters": "none: no wage index, IME, DSH, outlier or other hospital-specific adjustment"},
        "sources": {source_id: source_meta(source_id) for source_id in sorted(used)},
        "years": {"outpatient": "CY 2027", "inpatient": "FY 2027"},
        "batches": batches,
    }
    return {"meta": meta, "codes": codes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--passes", type=Path, default=mappings.PASSES_DIR, help="mapping passes folder")
    parser.add_argument("--adjudications", type=Path, default=mappings.ADJUDICATIONS, help="adjudications file")
    parser.add_argument("--out", type=Path, default=DERIVED, help="folder for crosswalk.json")
    parser.add_argument("--checks", type=Path, default=CHECKS, help="where to write the checks report")
    parser.add_argument("--allow-missing", action="store_true",
                        help="skip, not fail, mappable codes with no mapping in both passes yet")
    args = parser.parse_args(argv)
    inputs = load_inputs(args.passes, args.adjudications)
    doc = assemble(inputs)
    report = checks.run(doc, inputs, allow_missing=args.allow_missing)
    target = args.out / "crosswalk.json"
    lines = ["Revenue at stake: crosswalk checks", ""] + report.lines + [""]
    if report.failures:
        # Never replace the published crosswalk with one that failed a check.
        lines.append("%d check(s) failed. %s was left as it was." % (report.failures, target.name))
    else:
        fetch.write_json(target, doc)
        lines.append("All checks passed. Wrote %s (%d codes)." % (target.name, len(doc["codes"])))
        if not args.allow_missing:
            sheet = workbook.write(doc, args.out / "crosswalk.xlsx")
            lines.append("Wrote %s." % sheet.name)
    args.checks.parent.mkdir(parents=True, exist_ok=True)
    args.checks.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
