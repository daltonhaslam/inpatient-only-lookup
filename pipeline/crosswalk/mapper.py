#!/usr/bin/env python3
"""Helper CLI for mapping CPT/HCPCS codes to ICD-10-PCS (see mapping-brief.md and data/crosswalk/README.md).

    python3 pipeline/crosswalk/mapper.py batches
    python3 pipeline/crosswalk/mapper.py batch m01
    python3 pipeline/crosswalk/mapper.py pcs-search '^0BT'
    python3 pipeline/crosswalk/mapper.py cm-search 'lung.*malignant'
    python3 pipeline/crosswalk/mapper.py check data/crosswalk/passes/a/m01.json
    python3 pipeline/crosswalk/mapper.py unmappable      # (re)writes passes/unmappable.json

Mapping batches: the codes with a removal dated 2026-01-01 or 2027-01-01 in
pipeline/derived/ipo-history.json that Medicare pays for outpatient (current status indicator
not N) and that are not anesthesia codes (00100-01999), sorted by labels.json group then code,
in chunks of 40, ids m01, m02, ...

batch prints CMS's short descriptor for the mapper's eyes only; nothing here writes it to a file.
"""
import argparse
import json
import re
import sys
from pathlib import Path

if __name__ == "__main__":
    # Run as a script, sys.path[0] is this folder; the pipeline modules live one level up.
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

import fetch      # noqa: E402
import history    # noqa: E402
import parse      # noqa: E402
from crosswalk import mappings, sources   # noqa: E402
from crosswalk.group import Ref, group     # noqa: E402
from crosswalk.price import family_range   # noqa: E402

REMOVAL_DATES = ("2026-01-01", "2027-01-01")
BATCH_SIZE = 40
SEARCH_LIMIT = 200
HISTORY = fetch.ROOT / "pipeline" / "derived" / "ipo-history.json"
LABELS = fetch.ROOT / "data" / "labels.json"

REMINDER = """\
Reminders: approach is fixed by the CPT (open 0, percutaneous 3, perc. endoscopic 4, natural
opening 8). Use the PCS root operation the work actually is (Excision vs Resection, Replacement
vs Supplement). One code per set unless PCS needs separate codes for distinct objectives.
Alternatives = variants that matter (cap 6). One typical dx; an alternative only if it changes
the family. Never copy descriptor text into your output."""


def _load_json(path):
    return json.loads(path.read_text())


def mapping_batches():
    """({batch id: [codes]}, {code: reason} for the removed codes that are not mapped)."""
    spans = _load_json(HISTORY)
    labels = _load_json(LABELS)
    candidates = sorted(code for code, info in spans.items()
                        if any(e["type"] == "removed" and e["date"] in REMOVAL_DATES for e in info["events"]))
    mappable, unmappable = [], {}
    for code in candidates:
        if "00100" <= code <= "01999":
            unmappable[code] = "anesthesia code"
        elif spans[code]["spans"][-1]["si"] == "N":
            unmappable[code] = "packaged: no separate outpatient payment"
        else:
            mappable.append(code)
    mappable.sort(key=lambda code: (labels[code]["group"], code))
    batches = {"m%02d" % (n + 1): mappable[start:start + BATCH_SIZE]
               for n, start in enumerate(range(0, len(mappable), BATCH_SIZE))}
    return batches, unmappable


def _removal_year(code):
    events = _load_json(HISTORY)[code]["events"]
    return max(e["date"] for e in events if e["type"] == "removed" and e["date"] in REMOVAL_DATES)[:4]


def cmd_batches(_args):
    batches, unmappable = mapping_batches()
    for batch_id, codes in batches.items():
        print("%s  %3d codes  %s .. %s" % (batch_id, len(codes), codes[0], codes[-1]))
    print("%d batches, %d mappable codes, %d unmappable (python3 pipeline/crosswalk/mapper.py unmappable)"
          % (len(batches), sum(len(c) for c in batches.values()), len(unmappable)))


def cmd_batch(args):
    batches, _ = mapping_batches()
    if args.batch_id not in batches:
        sys.exit("unknown batch %r (see: mapper.py batches)" % args.batch_id)
    labels = _load_json(LABELS)
    opps = sources.load_opps()
    apcs = sources.load_apc_titles()
    path = sources._path("addenda-2027")
    descriptors = parse.descriptor_table(path, parse.pick_member(path, history.ADDENDUM_B))
    print(REMINDER + "\n")
    for code in batches[args.batch_id]:
        info = labels[code]
        row = opps.get(code, {})
        apc = row.get("apc")
        print("%s  [%s] removed %s  SI %s  APC %s %s" % (
            code, info["group"], _removal_year(code), row.get("si", "-"), apc or "-", apcs.get(apc, "")))
        print("    label: %s" % info["label"])
        print("    CMS short descriptor (do not copy): %s" % "; ".join(descriptors.get(code, ["-"])))


def cmd_unmappable(_args):
    _, unmappable = mapping_batches()
    records = [{"code": code, "mappable": False, "unmapped_reason": reason}
               for code, reason in sorted(unmappable.items())]
    mappings.UNMAPPABLE.parent.mkdir(parents=True, exist_ok=True)
    mappings.UNMAPPABLE.write_text(json.dumps(records, indent=1) + "\n")
    print("wrote %d records to %s" % (len(records), mappings.UNMAPPABLE))


def _search(table, pattern):
    try:
        regex = re.compile(pattern, re.I)
    except re.error as error:
        sys.exit("bad regex: %s" % error)
    hits = [(code, title) for code, title in sorted(table.items()) if regex.search(code) or regex.search(title)]
    for code, title in hits[:SEARCH_LIMIT]:
        print("%s  %s" % (code, title))
    if len(hits) > SEARCH_LIMIT:
        print("... %d more; narrow the pattern" % (len(hits) - SEARCH_LIMIT))
    elif not hits:
        print("no matches")


def cmd_pcs_search(args):
    _search(sources.load_pcs(), args.pattern)


def cmd_cm_search(args):
    _search(sources.load_cm(), args.pattern)


def cmd_check(args):
    path = Path(args.file)
    try:
        records = _load_json(path)
    except (OSError, ValueError) as error:
        sys.exit("cannot read %s: %s" % (path, error))
    if not isinstance(records, list):
        sys.exit("%s must hold a JSON list of records" % path)
    ref = Ref.load()
    errors = 0

    def problem(text):
        nonlocal errors
        errors += 1
        print("ERROR  %s" % text)

    batches, _ = mapping_batches()
    expected = batches.get(path.stem)
    codes = [rec.get("code") if isinstance(rec, dict) else None for rec in records]
    if expected is None:
        print("note: %s is not a mapping batch id, so batch membership is not checked" % path.stem)
    else:
        for code in sorted(set(expected) - set(codes)):
            problem("%s: in batch %s but missing from the file" % (code, path.stem))
        for code in sorted(set(codes) - set(expected), key=str):
            problem("%s: not in batch %s" % (code, path.stem))
        if codes != expected and sorted(map(str, codes)) == sorted(expected):
            print("warning: records are not in batch order")
    for code in sorted({c for c in codes if codes.count(c) > 1}, key=str):
        problem("%s: appears more than once" % code)

    for rec in records:
        name = rec.get("code") if isinstance(rec, dict) else "?"
        found = mappings.validate_record(rec, ref)
        for text in found:
            problem("%s: %s" % (name, text))
        if found:
            continue
        if not rec["mappable"]:
            print("%s  unmapped: %s" % (name, rec["unmapped_reason"]))
            continue
        print("%s  confidence %s  fingerprint %s" % (name, rec["confidence"], mappings.fingerprint(rec)))
        for text in mappings.approach_warnings(rec):
            print("  warning: %s" % text)
        for number, entry in enumerate(rec["pcs_sets"], 1):
            for dx in rec["principal_dx"]:
                label = "  set %d %s x %s (%s):" % (number, "+".join(entry["codes"]), dx["code"], dx["role"])
                try:
                    grouped = group(entry["codes"], dx["code"], ref)
                    prices = family_range(grouped["drgs"], ref)
                except ValueError as error:
                    problem("%s: set %d x %s: %s" % (name, number, dx["code"], error))
                    continue
                flag = "" if grouped["basis"] == "in-mdc" else "  <-- check: %s" % grouped["basis"]
                print("%s %s [%s] %s  $%s-$%s%s" % (
                    label, grouped["family"], "/".join(grouped["drgs"]), grouped["basis"],
                    format(prices["low"], ",.0f"), format(prices["high"], ",.0f"), flag))
    print("%d records, %d errors" % (len(records), errors))
    sys.exit(1 if errors else 0)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("batches", help="list the mapping batches").set_defaults(run=cmd_batches)
    batch = commands.add_parser("batch", help="show the codes of a mapping batch")
    batch.add_argument("batch_id")
    batch.set_defaults(run=cmd_batch)
    commands.add_parser("unmappable", help="write passes/unmappable.json").set_defaults(run=cmd_unmappable)
    for name, run, what in (("pcs-search", cmd_pcs_search, "valid FY2027 ICD-10-PCS codes"),
                            ("cm-search", cmd_cm_search, "billable FY2027 ICD-10-CM codes")):
        search = commands.add_parser(name, help="search " + what)
        search.add_argument("pattern", help="regex, matched against the code and the title")
        search.set_defaults(run=run)
    check = commands.add_parser("check", help="validate a pass file and show the DRG family each choice groups to")
    check.add_argument("file")
    check.set_defaults(run=cmd_check)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
