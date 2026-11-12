"""The mapping record format for the revenue-at-stake crosswalk, and how records are checked.

A record says how a hospital inpatient coder would report the same operation as one CPT/HCPCS
code in ICD-10-PCS, and the typical principal diagnosis. See data/crosswalk/README.md.

Pass files are data/crosswalk/passes/{a,b}/<batch-id>.json (a JSON list of records);
adjudications.json maps a code to the record that settles a disagreement. Records hold codes and
the mapper's own words only, never CPT descriptor text. Standard library only.
"""
import hashlib
import json

import fetch
from crosswalk.group import group

CROSSWALK_DIR = fetch.ROOT / "data" / "crosswalk"
PASSES_DIR = CROSSWALK_DIR / "passes"
ADJUDICATIONS = CROSSWALK_DIR / "adjudications.json"
UNMAPPABLE = PASSES_DIR / "unmappable.json"
PASS_NAMES = ("a", "b")
CONFIDENCE = ("high", "medium", "low")
ROLES = ("typical", "alternative")
MAX_SETS = 6


def _is_text(value):
    return isinstance(value, str) and bool(value.strip())


def validate_record(rec, ref):
    """List of error strings for one mapping record (empty when it is valid).

    Checks the shape, that every PCS code is valid in FY2027 and every principal diagnosis is a
    billable FY2027 ICD-10-CM code (no dot), and that a mappable record has at least one
    alternative and exactly one typical diagnosis. It does not call the grouper.
    """
    if not isinstance(rec, dict):
        return ["record is not an object"]
    errors = []
    code = rec.get("code")
    if not _is_text(code):
        errors.append("missing code")
    if not isinstance(rec.get("mappable"), bool):
        errors.append("mappable must be true or false")
        return errors
    if not rec["mappable"]:
        if not _is_text(rec.get("unmapped_reason")):
            errors.append("unmapped record needs an unmapped_reason")
        if rec.get("pcs_sets") or rec.get("principal_dx"):
            errors.append("unmapped record must not have pcs_sets or principal_dx")
        return errors
    if rec.get("unmapped_reason"):
        errors.append("mappable record must not have an unmapped_reason")
    errors += _check_sets(rec.get("pcs_sets"), ref)
    errors += _check_dx(rec.get("principal_dx"), ref)
    if not _is_text(rec.get("rationale")):
        errors.append("missing rationale")
    if rec.get("confidence") not in CONFIDENCE:
        errors.append("confidence must be one of %s" % "/".join(CONFIDENCE))
    return errors


def _check_sets(sets, ref):
    if not isinstance(sets, list) or not sets:
        return ["mappable record needs at least one pcs_set"]
    errors = []
    if len(sets) > MAX_SETS:
        errors.append("%d pcs_sets (the limit is %d)" % (len(sets), MAX_SETS))
    for number, entry in enumerate(sets, 1):
        codes = entry.get("codes") if isinstance(entry, dict) else None
        if not isinstance(codes, list) or not codes:
            errors.append("pcs_set %d has no codes" % number)
            continue
        for pcs in codes:
            if pcs not in ref.pcs:
                errors.append("pcs_set %d: %r is not a valid FY2027 ICD-10-PCS code" % (number, pcs))
    return errors


def _check_dx(entries, ref):
    if not isinstance(entries, list) or not entries:
        return ["mappable record needs at least one principal_dx"]
    errors = []
    roles = []
    for entry in entries:
        dx = entry.get("code") if isinstance(entry, dict) else None
        role = entry.get("role") if isinstance(entry, dict) else None
        roles.append(role)
        if dx not in ref.cm:
            errors.append("principal_dx %r is not a billable FY2027 ICD-10-CM code (no dot)" % (dx,))
        if role not in ROLES:
            errors.append("principal_dx %r: role must be typical or alternative" % (dx,))
    if roles.count("typical") != 1:
        errors.append("principal_dx needs exactly one typical (found %d)" % roles.count("typical"))
    if roles.count("alternative") > 1:
        errors.append("principal_dx allows at most one alternative")
    return errors


def approach_warnings(rec):
    """Hints (not errors): the CPT fixes the approach, so the first code of every pcs_set should
    share its 5th character. Unlike body-part or device, a differing approach is rarely deliberate."""
    if not rec.get("mappable"):
        return []
    approaches = {}
    for number, entry in enumerate(rec.get("pcs_sets") or [], 1):
        codes = entry.get("codes") or []
        if codes and len(codes[0]) == 7:
            approaches.setdefault(codes[0][4], []).append(number)
    if len(approaches) > 1:
        detail = "; ".join("approach %s in set %s" % (a, ",".join(map(str, n))) for a, n in sorted(approaches.items()))
        return ["pcs_sets differ in approach (%s); the CPT fixes one" % detail]
    return []


def fingerprint(rec):
    """First 8 hex digits of the sha256 of the record's PCS sets and diagnosis codes, in a
    canonical order, so two mappers' records can be compared for the same substance."""
    sets = sorted(sorted(entry["codes"]) for entry in rec.get("pcs_sets") or [])
    dx = sorted(entry["code"] for entry in rec.get("principal_dx") or [])
    canonical = json.dumps({"pcs": sets, "dx": dx}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:8]


def load_passes(directory=None):
    """{"a": {code: record}, "b": {code: record}} from every <batch-id>.json in each pass folder.
    The auto-written unmappable.json records (codes no mapper sees) count in both passes."""
    root = directory or PASSES_DIR
    fixed = root / "unmappable.json"
    unmappable = {rec["code"]: rec for rec in json.loads(fixed.read_text())} if fixed.is_file() else {}
    passes = {}
    for name in PASS_NAMES:
        records = dict(unmappable)
        folder = root / name
        for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
            for rec in json.loads(path.read_text()):
                records[rec["code"]] = rec
        passes[name] = records
    return passes


def load_adjudications(path=None):
    """{code: record} of settled disagreements, or {} when there are none yet."""
    target = path or ADJUDICATIONS
    return json.loads(target.read_text()) if target.is_file() else {}


def families(rec, ref):
    """The set of DRG families (tuples of MS-DRGs) a record groups to over every pcs_set x
    principal_dx; None for an unmappable record. A combination the grouper rejects counts as its
    own distinct marker, so it can never agree with a real family."""
    if not rec.get("mappable"):
        return None
    found = set()
    for entry in rec["pcs_sets"]:
        for dx in rec["principal_dx"]:
            try:
                found.add(tuple(group(entry["codes"], dx["code"], ref)["drgs"]))
            except ValueError as error:
                found.add(("error", str(error)))
    return frozenset(found)


def final_mapping(code, passes, adjudications, ref):
    """The record to use for code: an adjudication wins; else pass A's, when both passes agree on
    the families (or both call it unmappable). Raises ValueError when the passes disagree or one
    is missing and nothing adjudicates it."""
    if code in adjudications:
        return adjudications[code]
    a, b = passes.get("a", {}).get(code), passes.get("b", {}).get(code)
    if a is None or b is None:
        raise ValueError("%s: missing from pass %s and not adjudicated" % (code, "a" if a is None else "b"))
    if families(a, ref) != families(b, ref):
        raise ValueError("%s: passes disagree on the DRG family and it is not adjudicated" % code)
    return a
