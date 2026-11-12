#!/usr/bin/env python3
"""Ingest coder reviews from the Google Forms response sheet into data/crosswalk/reviews.json.

    python3 pipeline/crosswalk/reviews.py ingest agree.csv wrong.csv [--claims claims.csv] [--yes]

The three forms write to separate tabs of one sheet (see Paid-And-Penalized-Planning/docs/review-forms.md);
export each tab as CSV. Columns are found by question title. Written rows:
{"code", "fp", "credential", "verdict": "agree"|"wrong", "date", "ts", "name"|null, "reason"|null}.
Never written: email addresses, the "where do you code" answer, free text from agree rows, claim
names. A row whose Code is not a CPT/HCPCS code in the crosswalk is dropped and reported. A
dispute's reasoning is cut to 280 characters and dropped when it looks like PHI (a date of
birth, a record number, "Mr./Mrs./Ms." plus a name); a display name gets the same scan. A drop is
reported on the screen with the code, never the text. Every new row (code, verdict, credential,
name, and a dispute's reason) and the abuse flags are printed (--drop-reasons nulls all reasons)
and the run waits for a yes before writing.
"""
import argparse
import csv
import ipaddress
import re
import sys
from urllib.parse import urlsplit, urlunsplit
from collections import defaultdict
from datetime import datetime
from pathlib import Path

if __name__ == "__main__":
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

import fetch      # noqa: E402
from crosswalk.mappings import CROSSWALK_DIR   # noqa: E402
from crosswalk.status import INPATIENT_CREDS   # noqa: E402

REVIEWS = CROSSWALK_DIR / "reviews.json"
CROSSWALK_JSON = fetch.DERIVED / "crosswalk.json"
CLAIMS = CROSSWALK_DIR / "claims.json"
CREDENTIALS = ("CCS", "CCS-P", "CIC", "CPC", "COC", "CDIP", "CCDS", "RHIA", "RHIT", "MD or DO", "RN", "Other")
_CRED_ALIASES = {"MD/DO": "MD or DO", "MD": "MD or DO", "DO": "MD or DO"}
REASON_LIMIT = 280
NAME_LIMIT = 80
BURST_COUNT, BURST_SECONDS = 3, 120
PROFILE_LIMIT = 200
KNOWN_PROFILE_HOSTS = ("linkedin.com", "www.linkedin.com", "doximity.com", "orcid.org", "github.com")

# Question titles (case-insensitive prefixes) -> field.
TITLES = {"timestamp": "Timestamp", "code": "Code", "mapping": "Mapping reviewed", "credential": "Your credential",
          "name": "Name to show in the credit list", "profile": "Link to your LinkedIn or other professional profile",
          "pcs_which": "If not, which PCS codes",
          "dx_what": "If not, what would you expect", "reasoning": "Your reasoning", "batch": "Batch"}
_PHI = (re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"), re.compile(r"\b\d{4}-\d{2}-\d{2}\b"),
        re.compile(r"\b\d{6,}\b"), re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
        re.compile(r"\b(?i:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b"),
        re.compile(r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?i:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b"),
        re.compile(r"\b(?i:dr|mr|mrs|ms|patient|pt)\.?\s+[A-Z][a-z]+"))
_FP = re.compile(r"\b[0-9a-f]{8}\b")
_CODE = re.compile(r"^[0-9A-Z]\d{3}[0-9A-Z]$")
_TS_FORMATS = ("%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%m/%d/%Y %H:%M")


def has_phi(text):
    return any(pattern.search(text) for pattern in _PHI)


def normalize_credential(value):
    value = fetch.squash(value or "")
    for known in CREDENTIALS:
        if value.lower() == known.lower():
            return known
    return _CRED_ALIASES.get(value.upper(), "Other")


def _parse_ts(value):
    for fmt in _TS_FORMATS:
        try:
            return datetime.strptime((value or "").strip(), fmt)
        except ValueError:
            pass
    return None


def _columns(header):
    """{field: column name} by case-insensitive title prefix; absent titles are left out."""
    found = {}
    for field, title in TITLES.items():
        for name in header:
            if name.strip().lower().startswith(title.lower()):
                found[field] = name
                break
    return found


def _read(path):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        return _columns(reader.fieldnames or []), list(reader)


def _clean_name(value, log, code):
    value = fetch.squash(value or "")
    if not value:
        return None
    if "@" in value or has_phi(value):    # scan the whole name before cutting it, as for a reason
        log.append("%s: a display name was dropped (email or PHI-like)" % code)
        return None
    return value[:NAME_LIMIT]


def clean_profile(value):
    """The normalized https profile URL, or None when it is not acceptable: https only, at most
    PROFILE_LIMIT characters, no whitespace or control characters, no "@" anywhere, a real hostname
    (not an IP literal, localhost or a dotless name). Surrounding whitespace is stripped and the
    query string and fragment are dropped for every host."""
    value = (value or "").strip()
    if (not value or len(value) > PROFILE_LIMIT or re.search(r"[\s\x00-\x1f\x7f@]", value)
            or not value.lower().startswith("https://")):
        return None
    try:
        parts = urlsplit(value)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != "https" or not host or port not in (None, 443) or not _public_host(host):
        return None
    return urlunsplit(parts._replace(query="", fragment=""))


def _public_host(host):
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    labels = host.split(".")
    return (len(labels) > 1 and host != "localhost" and labels[-1] != "localhost" and not labels[-1].isdigit()
            and all(labels))


def profile_host(url):
    return urlsplit(url).hostname or ""


def resolution_problems(resolutions):
    """Lines describing every resolutions.json `by_profile` that clean_profile would reject, or that has no `by`."""
    problems = []
    for key, entry in sorted(resolutions.items()):
        if not isinstance(entry, dict) or "by_profile" not in entry:
            continue
        value = entry["by_profile"]
        if not entry.get("by"):
            problems.append("%s: by_profile without by" % key)
        elif clean_profile(value) != value:
            problems.append("%s: by_profile is not an acceptable normalized https URL" % key)
    return problems


def _clean_reason(parts, log, code):
    text = "; ".join(fetch.squash(part) for part in parts if part and part.strip())
    if not text:
        return None
    if has_phi(text):    # scan everything before cutting, so a pattern past character 280 still counts
        log.append("%s: dispute text dropped (PHI-like pattern); %d characters" % (code, len(text)))
        return None
    return text[:REASON_LIMIT]


def crosswalk_codes(path=None):
    """The codes in crosswalk.json: the only codes a review can be about."""
    return set(fetch.read_json(path or CROSSWALK_JSON)["codes"])


def parse_rows(agree_path, wrong_path, log, codes):
    """Review rows from the two CSV exports, in timestamp order. codes: the crosswalk's codes; a row
    whose Code is not a CPT/HCPCS code among them is dropped (and logged)."""
    rows = []
    for path, verdict in ((agree_path, "agree"), (wrong_path, "wrong")):
        cols, records = _read(path)
        for number, rec in enumerate(records, 2):
            get = lambda field: (rec.get(cols[field]) or "").strip() if field in cols else ""   # noqa: E731
            code = get("code").upper()
            fp = _FP.search(get("mapping").lower())
            when = _parse_ts(get("timestamp"))
            if not code or not fp or not when:
                log.append("%s row %d skipped (missing code, fingerprint or timestamp)" % (Path(path).name, number))
                continue
            if not _CODE.match(code):     # the value is not echoed: a free-typed Code field could hold anything
                log.append("%s row %d skipped (Code is not a CPT/HCPCS code)" % (Path(path).name, number))
                continue
            if code not in codes:
                log.append("%s row %d skipped (%s is not in the crosswalk)" % (Path(path).name, number, code))
                continue
            reason = None
            if verdict == "wrong":
                reason = _clean_reason([get("reasoning"), get("pcs_which"), get("dx_what")], log, code)
            name = _clean_name(get("name"), log, code)
            profile = clean_profile(get("profile"))
            if get("profile") and not profile:
                log.append("%s: a profile link was dropped (not an acceptable https URL)" % code)
            if profile and not name:
                log.append("%s: a profile link was dropped (no name to link)" % code)
                profile = None
            rows.append({"code": code, "fp": fp.group(0), "credential": normalize_credential(get("credential")),
                         "verdict": verdict, "date": when.strftime("%Y-%m-%d"), "ts": when.strftime("%Y-%m-%d %H:%M:%S"),
                         "name": name, "profile": profile, "reason": reason})
    rows.sort(key=lambda row: row["ts"])
    return rows


def abuse_flags(rows):
    """Plain-English lines for a human to read before the rows are written."""
    flags = []
    by_code = defaultdict(list)
    for row in rows:
        by_code[row["code"]].append(row)
    for code, group in sorted(by_code.items()):
        stamps = [datetime.strptime(row["ts"], "%Y-%m-%d %H:%M:%S") for row in group]
        for i in range(len(stamps) - BURST_COUNT + 1):
            if (stamps[i + BURST_COUNT - 1] - stamps[i]).total_seconds() <= BURST_SECONDS:
                flags.append("%s: %d+ responses within %d seconds (burst)" % (code, BURST_COUNT, BURST_SECONDS))
                break
        names = defaultdict(int)
        for row in group:
            if row["name"]:
                names[row["name"].lower()] += 1
        flags += ["%s: display name %r appears %d times" % (code, name, n) for name, n in sorted(names.items()) if n > 1]
        for row in group:
            host = profile_host(row["profile"]) if row.get("profile") else ""
            if host and not host.isascii():
                flags.append("PROFILE (%s): %s — non-ASCII host, check before approving" % (code, host))
            elif host and host not in KNOWN_PROFILE_HOSTS:
                flags.append("PROFILE (%s): %s — check before approving" % (code, host))
        agrees = [row for row in group if row["verdict"] == "agree"]
        if agrees and not any(row["credential"] in INPATIENT_CREDS for row in agrees):
            flags.append("%s: %d agreement(s), none from an inpatient credential" % (code, len(agrees)))
    profiles = defaultdict(set)
    for row in rows:
        if row.get("name"):
            profiles[row["name"].lower()].add(row.get("profile"))
    flags += ["NAME: %r appears with different profile links (%s)" % (name, ", ".join(sorted(p or "none" for p in found)))
              for name, found in sorted(profiles.items()) if len(found) > 1]
    return flags


def count_claims(path):
    cols, records = _read(path)
    counts = defaultdict(int)
    for rec in records:
        batch = (rec.get(cols["batch"]) or "").strip() if "batch" in cols else ""
        if batch:
            counts[batch] += 1
    return dict(sorted(counts.items()))


def _key(row):
    return (row["ts"], row["code"], row["fp"], row["credential"], row["verdict"])


def ingest(agree_path, wrong_path, claims_path=None, reviews_path=None, claims_out=None, yes=False,
           confirm=input, out=sys.stdout, drop_reasons=False, codes=None):
    """Merge the exports into reviews.json (rows already there are kept; a repeated export adds
    nothing). codes: the crosswalk's codes (default: crosswalk.json's). Returns the number of new
    rows, or None when the human said no."""
    reviews_path = reviews_path or REVIEWS
    log = []
    rows = parse_rows(agree_path, wrong_path, log, crosswalk_codes() if codes is None else codes)
    if drop_reasons:
        for row in rows:
            row["reason"] = None
    existing = fetch.read_json_or(reviews_path, [])
    seen = {_key(row) for row in existing}
    new = [row for row in rows if _key(row) not in seen]
    claims = count_claims(claims_path) if claims_path else None
    for line in log:
        print("note: " + line, file=out)
    flags = abuse_flags(rows)
    for line in flags:
        print("FLAG: " + line, file=out)
    for row in new:     # everything that will be written and published, for a human to read first
        print("NEW (%s, %s): %s, credential %s, name %s, profile %s" % (
            row["code"], row["ts"], row["verdict"], row["credential"], row["name"] or "(none)", row["profile"] or "(none)"), file=out)
        if row["reason"]:
            print("REASON (%s, %s): %s" % (row["code"], row["ts"], row["reason"]), file=out)
    print("%d new review row(s), %d already present, %d flag(s)." % (len(new), len(rows) - len(new), len(flags)), file=out)
    if claims is not None:
        print("Claims per batch: %s" % (claims or "none"), file=out)
    if not yes and confirm("Write reviews.json? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Nothing written.", file=out)
        return None
    merged = sorted(existing + new, key=lambda row: row.get("ts", row["date"]))
    fetch.write_json(reviews_path, merged, indent=1)
    if claims is not None:
        fetch.write_json(claims_out or CLAIMS, claims, indent=1)
    return len(new)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("ingest", help="ingest the agree and wrong CSV exports")
    cmd.add_argument("agree")
    cmd.add_argument("wrong")
    cmd.add_argument("--claims")
    cmd.add_argument("--drop-reasons", action="store_true", help="write every dispute reason as null (safest)")
    cmd.add_argument("--yes", action="store_true", help="skip the confirmation (tests)")
    args = parser.parse_args(argv)
    result = ingest(args.agree, args.wrong, args.claims, yes=args.yes, drop_reasons=args.drop_reasons)
    sys.exit(1 if result is None else 0)


if __name__ == "__main__":
    main()
