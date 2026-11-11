#!/usr/bin/env python3
"""Pick up what CMS has posted since the last refresh, then rebuild and re-check everything.

    python3 pipeline/refresh.py              discover, download, rebuild, test
    python3 pipeline/refresh.py --dry-run    show what would change; change nothing

One run does four things:
  1. Looks on cms.gov for files this repo does not have: a newer quarterly Addendum B, a correction
     to a recent one, the next calendar year's final rule (its addenda and, if there is one, its
     "removed from the IPO list" file), or a re-posted copy of the newest rule's files.
  2. Re-downloads the recent files it already has, because CMS also replaces files in place under
     the same address. A changed file is adopted and re-pinned, and the report says so.
  3. Runs build.py, which reconciles the whole history and leaves the published tables alone if
     any check fails.
  4. Runs the tests, then lists what still needs a person: a new rule's Federal Register facts in
     rules.json, and plain-language labels for new codes.
Every new download is checked to be the table it claims to be before sources.json is touched.

To add a file CMS posted somewhere discovery does not look:
    python3 pipeline/refresh.py --add-quarter 2027-04 https://www.cms.gov/files/zip/....zip
    python3 pipeline/refresh.py --add-rule 2028 https://www.cms.gov/files/zip/....zip [--removal-file URL]
"""
import argparse
import re
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

import fetch
import history
import parse

QUARTERLY_PAGE = "https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient/addendum-a-b-updates"
RULES_PAGE = "https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient/regulations-notices"
MONTHS = {"january": "01", "april": "04", "july": "07", "october": "10"}
RECENT_QUARTERS = 8     # how far back to look for corrected or replaced Addendum B files
_LINK = re.compile(r"""<a\b[^>]*?href\s*=\s*["']\s*([^"']+?)\s*["'][^>]*>(.*?)</a>""", re.S | re.I)
# The table each kind of source must contain, to be accepted as that kind.
_PROOF = {"addendum_b": "b", "rule_addenda": "e", "removal_file": "removal"}


def links(page_html):
    """[(absolute https://www.cms.gov url, visible text)] for every link on a CMS page."""
    found = []
    for href, inner in _LINK.findall(page_html):
        url = urllib.parse.urljoin("https://www.cms.gov/", fetch.text_of(href))
        found.append((url, fetch.squash(fetch.text_of(inner))))
    return found


def on_cms(url):
    parts = urllib.parse.urlsplit(url)
    return parts.scheme == "https" and parts.hostname == "www.cms.gov"


def file_url(url):
    """CMS wraps downloads in a license click-through (?file=/files/zip/x.zip); return the zip itself, or None."""
    parts = urllib.parse.urlsplit(url)
    target = urllib.parse.parse_qs(parts.query).get("file", [None])[0]
    if target:
        url = urllib.parse.urljoin("https://www.cms.gov/", target)
        parts = urllib.parse.urlsplit(url)
    if parts.hostname == "edit.cms.gov":
        # CMS sometimes links its own authoring host (the CY 2027 removal file); the public copy is on www.
        url = urllib.parse.urlunsplit(parts._replace(netloc="www.cms.gov"))
    return url if on_cms(url) and urllib.parse.urlsplit(url).path.lower().endswith(".zip") else None


def quarter_of(text):
    """'January 2027 - updated' or '2025 October' -> '2027-01'; None for anything else."""
    match = re.match(r"\s*(?:(\d{4})\s+)?(january|april|july|october)\s*(\d{4})?", text, re.I)
    if not match or not (match.group(1) or match.group(3)):
        return None
    return "%s-%s" % (match.group(1) or match.group(3), MONTHS[match.group(2).lower()])


def is_table(data, kind):
    """True if these bytes are a zip holding the table a source of this kind must have."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "candidate.zip"
        path.write_bytes(data)
        if not zipfile.is_zipfile(path):
            return False
        try:
            # __wrapped__: the uncached parser, so a temporary path never enters the cache.
            parse.code_table.__wrapped__(path, parse.pick_member(path, history.MEMBERS[kind][_PROOF[kind]]))
        except (parse.ParseError, zipfile.BadZipFile, KeyError, ValueError):
            return False
    return True


def discover_quarters(manifest, get, grab):
    """Addendum B files CMS has posted that sources.json does not have: [(source, bytes)].

    Covers quarters after the newest on file and the last RECENT_QUARTERS on file, where an
    address we have not seen is a correction. CMS names these files inconsistently, so a zip is
    judged by what is in it; addresses that turn out to be something else (Addendum A, Addendum Q)
    are remembered in manifest["ignored"] and not downloaded again.
    """
    sources = manifest["sources"]
    on_file = sorted({source["effective"][:7] for source in sources if source["kind"] == "addendum_b"})
    oldest = on_file[-RECENT_QUARTERS:][0]
    seen = {source["url"].lower() for source in sources} | {url.lower() for url in manifest.get("ignored", [])}
    pages = {}
    for url, text in links(get(QUARTERLY_PAGE)):
        quarter = quarter_of(text)
        if quarter and quarter >= oldest and on_cms(url):
            pages.setdefault(quarter, []).append(url)
    found = []
    for quarter in sorted(pages):
        for page in dict.fromkeys(pages[quarter]):
            for url, _ in links(get(page)):
                target = file_url(url)
                if not target or target.lower() in seen:
                    continue
                seen.add(target.lower())
                data = grab(target)
                if data is None:
                    continue
                if is_table(data, "addendum_b"):
                    found.append(({"id": "b-" + quarter, "kind": "addendum_b", "effective": quarter + "-01",
                                   "url": target, "landing": QUARTERLY_PAGE, "sha256": None}, data))
                else:
                    manifest.setdefault("ignored", []).append(target)
    return found


def discover_rules(manifest, get, grab):
    """Final-rule files for the newest calendar year on file (re-posted) and the next.

    Returns ([(source, bytes)], [notes for the person running it]).
    """
    sources = manifest["sources"]
    newest = max(source["cy"] for source in sources if source["kind"] == "rule_addenda")
    seen = {source["url"].lower() for source in sources}
    older_pages = {source["landing"] for source in sources if source.get("cy", newest) < newest}
    candidates = {}
    for page, _ in links(get(RULES_PAGE)):
        if not on_cms(page) or not re.search(r"/cms-\d+-fc?$", page.rstrip("/"), re.I) or page in older_pages:
            continue
        rule = page.rstrip("/").rsplit("/", 1)[-1].upper()
        for url, label in links(get(page)):
            target = file_url(url)
            year = label[:4]
            if not target or target.lower() in seen or year not in (str(newest), str(newest + 1)):
                continue
            if re.search(r"\bOPPS Addenda\b", label, re.I):
                kind = "rule_addenda"
            elif re.search(r"remov\w* from (the )?(IPO|inpatient)", label, re.I):
                kind = "removal_file"
            else:
                continue
            identifier = ("addenda-" if kind == "rule_addenda" else "removed-") + year
            candidates.setdefault(identifier, []).append({"id": identifier, "kind": kind, "cy": int(year), "rule": rule,
                                                          "url": target, "landing": page, "sha256": None})
    found, notes = [], []
    for identifier, group in sorted(candidates.items()):
        if len(group) > 1:
            notes.append("%s: CMS lists %d candidate files; add the right one by hand with --add-rule:\n      %s" % (
                identifier, len(group), "\n      ".join(source["url"] for source in group)))
            continue
        data = grab(group[0]["url"])
        if data is None:
            continue
        if is_table(data, group[0]["kind"]):
            found.append((group[0], data))
        else:
            notes.append("%s: %s is not the table expected; skipped" % (identifier, group[0]["url"]))
    return found, notes


def adopt(manifest, source, data):
    """Add a validated download to the manifest and save its bytes; return a line describing it.

    A further Addendum B for a quarter on file corrects the file currently in force. A rule file
    whose id is already on file replaces it: CMS re-posted it at a new address.
    """
    sources = manifest["sources"]
    source["sha256"] = fetch.sha256(data)
    existing = next((s for s in sources if s["id"] == source["id"]), None)
    if existing is None:
        sources.append(source)
        what = "new"
    elif source["kind"] == "addendum_b":
        quarter = [s for s in sources if s["kind"] == "addendum_b" and s["effective"] == source["effective"]]
        corrected = {s.get("corrects") for s in quarter}
        current = next(s for s in quarter if s["id"] not in corrected)
        source["corrects"] = current["id"]
        taken = {s["id"] for s in sources}
        base, n = source["id"] + "-corr", 1
        while source["id"] in taken:
            source["id"] = base if n == 1 else "%s%d" % (base, n)
            n += 1
        sources.append(source)
        what = "CORRECTION: replaces %s" % current["id"]
    else:
        fetch.raw_path(existing).unlink(missing_ok=True)
        existing.update(source)
        what = "RE-POSTED by CMS at a new address; replaces the copy on file"
    path = fetch.raw_path(source)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return "%-18s %s\n      %s" % (source["id"], what, source["url"])


def recent_sources(sources):
    """The files worth re-downloading: the last RECENT_QUARTERS quarters and the newest rule's files."""
    quarters = sorted({s["effective"] for s in sources if s["kind"] == "addendum_b"})[-RECENT_QUARTERS:]
    newest = max(s["cy"] for s in sources if s["kind"] == "rule_addenda")
    return [s for s in sources
            if s.get("effective") in quarters or (s["kind"] in ("rule_addenda", "removal_file") and s["cy"] == newest)]


def replaced_in_place(sources, grab):
    """[(source, new bytes)] for recent files whose bytes at the same address no longer match the pin."""
    changed = []
    for source in recent_sources(sources):
        data = grab(source["url"])
        if data is not None and fetch.sha256(data) != source["sha256"]:
            changed.append((source, data))
    return changed


def run(script):
    return subprocess.run([sys.executable, str(fetch.PIPELINE / script)], cwd=str(fetch.ROOT)).returncode


def follow_ups(sources):
    """What a person still has to do by hand after an automatic refresh."""
    notes = []
    have_rules = {rule["cy"] for rule in fetch.load_rules()["rules"]}
    first_quarterly = min(int(source["effective"][:4]) for source in sources if source["kind"] == "addendum_b")
    for source in sources:
        if source["kind"] == "rule_addenda" and source["cy"] >= first_quarterly and source["cy"] not in have_rules:
            notes.append("rules.json has no entry for CY %d%s: add its Federal Register citation, the counts CMS "
                         "states, and the printed code table if there is one. Then update the page copy in "
                         "web/src/pages.mjs." % (source["cy"], " (%s)" % source["rule"] if source["rule"] else ""))
    derived = fetch.PIPELINE / "derived" / "ipo-history.json"
    if derived.exists():
        listed = set(fetch.read_json(derived))
        labels = set(fetch.read_json(fetch.ROOT / "data" / "labels.json"))
        if listed - labels:
            notes.append("%d code(s) need a plain-language label in data/labels.json: %s" % (
                len(listed - labels), ", ".join(sorted(listed - labels))))
        if labels - listed:
            notes.append("data/labels.json has labels for codes with no list history: %s" % ", ".join(sorted(labels - listed)))
    return notes


def manual_sources(args, parser):
    out = []
    if args.add_quarter:
        quarter, url = args.add_quarter
        if not re.fullmatch(r"\d{4}-(01|04|07|10)", quarter):
            parser.error("--add-quarter takes YYYY-MM for January, April, July or October")
        out.append({"id": "b-" + quarter, "kind": "addendum_b", "effective": quarter + "-01",
                    "url": url, "landing": QUARTERLY_PAGE, "sha256": None})
    if args.add_rule:
        year, url = args.add_rule
        if not re.fullmatch(r"20\d\d", year):
            parser.error("--add-rule takes a four-digit calendar year")
        out.append({"id": "addenda-" + year, "kind": "rule_addenda", "cy": int(year), "rule": "",
                    "url": url, "landing": RULES_PAGE, "sha256": None})
        if args.removal_file:
            out.append({"id": "removed-" + year, "kind": "removal_file", "cy": int(year), "rule": "",
                        "url": args.removal_file, "landing": RULES_PAGE, "sha256": None})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pick up new CMS files, then rebuild and re-check the history.")
    parser.add_argument("--dry-run", action="store_true", help="show what would change and stop")
    parser.add_argument("--add-quarter", nargs=2, metavar=("YYYY-MM", "URL"))
    parser.add_argument("--add-rule", nargs=2, metavar=("YEAR", "URL"))
    parser.add_argument("--removal-file", metavar="URL", help="with --add-rule: that rule's IPO removal file")
    args = parser.parse_args(argv)

    manifest = fetch.load_manifest()
    problems = []

    def get(url):
        return fetch.download(url).decode("utf-8", errors="replace")

    def grab(url):
        try:
            return fetch.download(url)
        except Exception as error:    # one dead link must not stop the refresh
            problems.append("could not download %s: %s" % (url, error))
            return None

    found = []
    manual = manual_sources(args, parser)
    if manual:
        for source in manual:
            data = grab(source["url"])
            if data is not None and is_table(data, source["kind"]):
                found.append((source, data))
            elif data is not None:
                problems.append("%s is not the table expected for %s" % (source["url"], source["id"]))
    else:
        found += discover_quarters(manifest, get, grab)
        rule_files, notes = discover_rules(manifest, get, grab)
        found += rule_files
        problems += notes
    replaced = replaced_in_place(manifest["sources"], grab)

    print("New files: %d" % len(found))
    for source, _ in found:
        print("  %-18s %s" % (source["id"], source["url"]))
    print("Files CMS replaced in place: %d" % len(replaced))
    for source, _ in replaced:
        print("  %-18s %s" % (source["id"], source["url"]))
    for problem in problems:
        print("  PROBLEM: " + problem)
    if args.dry_run:
        return 1 if problems else 0

    for source, data in found:
        print("  " + adopt(manifest, source, data))
    for source, data in replaced:
        fetch.raw_path(source).write_bytes(data)
        print("  %-18s re-pinned: %s -> %s" % (source["id"], source["sha256"][:12], fetch.sha256(data)[:12]))
        source["sha256"] = fetch.sha256(data)
    fetch.save_manifest(manifest)

    status = run("fetch.py") or run("build.py") or run("run_tests.py")
    if status or problems:
        print("\nREFRESH FAILED. The site's tables were not updated. Fix what is reported above and run it again.")
        print("To undo the changes to the file list: git checkout pipeline/sources.json")
        return 1
    notes = follow_ups(fetch.load_sources())
    print("\nStill to do by hand:" if notes else "\nNothing left to do by hand.")
    for note in notes:
        print("  - " + note)
    print("\nThen rebuild the site: cd web && npm run build && npm test")
    return 0


if __name__ == "__main__":
    sys.exit(main())
