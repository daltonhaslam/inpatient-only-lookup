#!/usr/bin/env python3
"""Pick up what CMS has posted since the last refresh, then rebuild and re-check everything.

    python3 pipeline/refresh.py              discover, download, rebuild, test
    python3 pipeline/refresh.py --dry-run    show what discovery finds; change nothing
    python3 pipeline/refresh.py --recheck    also re-download the newest files to see if CMS replaced them

It looks in two places on cms.gov:
  * the quarterly Addendum A and B page, for an Addendum B newer than the newest one in sources.json;
  * the OPPS regulations page, for the final rule of the next calendar year (its addenda zip and,
    if there is one, its "removed from the IPO list" file).
Whatever it finds is appended to sources.json, downloaded and pinned. Then build.py reconciles
the whole history and the tests run. A new final rule also needs its Federal Register facts
entered by hand in rules.json; the report at the end says exactly what is missing.

To add a file CMS posted somewhere discovery does not look:
    python3 pipeline/refresh.py --add-quarter 2027-04 https://www.cms.gov/files/zip/....zip
    python3 pipeline/refresh.py --add-rule 2028 https://www.cms.gov/files/zip/....zip [--removal-file URL]
"""
import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

import fetch
import history

ROOT = Path(__file__).resolve().parent.parent
QUARTERLY_PAGE = "https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient/addendum-a-b-updates"
RULES_PAGE = "https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient/regulations-notices"
MONTHS = {"january": "01", "april": "04", "july": "07", "october": "10"}
_LINK = re.compile(r"""<a\b[^>]*?href\s*=\s*["']\s*([^"']+?)\s*["'][^>]*>(.*?)</a>""", re.S | re.I)


def links(page_html):
    """[(absolute https://www.cms.gov url, visible text)] for every link on a CMS page."""
    found = []
    for href, inner in _LINK.findall(page_html):
        url = urllib.parse.urljoin("https://www.cms.gov/", html.unescape(href))
        text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", inner))).strip()
        found.append((url, text))
    return found


def file_url(url):
    """CMS wraps downloads in a license click-through (?file=/files/zip/x.zip); return the file itself."""
    parts = urllib.parse.urlsplit(url)
    target = urllib.parse.parse_qs(parts.query).get("file", [None])[0]
    if target:
        url = urllib.parse.urljoin("https://www.cms.gov/", target)
        parts = urllib.parse.urlsplit(url)
    if parts.hostname == "edit.cms.gov":
        # CMS sometimes links its own authoring host (the CY 2027 removal file); the public copy is on www.
        parts = parts._replace(netloc="www.cms.gov")
        url = urllib.parse.urlunsplit(parts)
    if parts.scheme != "https" or parts.hostname != "www.cms.gov":
        return None
    return url if parts.path.lower().endswith(".zip") else None


def quarter_of(text):
    match = re.match(r"\s*(?:(\d{4})\s+)?(january|april|july|october)\s*(\d{4})?", text, re.I)
    if not match or not (match.group(1) or match.group(3)):
        return None
    return "%s-%s" % (match.group(1) or match.group(3), MONTHS[match.group(2).lower()])


def discover_quarters(sources, get):
    """New Addendum B sources for quarters after the newest one already in sources.json."""
    newest = max(source["effective"] for source in sources if source["kind"] == "addendum_b")[:7]
    known = {source["url"].lower() for source in sources}
    pages = {}
    for url, text in links(get(QUARTERLY_PAGE)):
        quarter = quarter_of(text)
        if quarter and quarter > newest and urllib.parse.urlsplit(url).hostname == "www.cms.gov":
            pages.setdefault(quarter, []).append(url)
    found = []
    for quarter in sorted(pages):
        for page in pages[quarter]:
            for url, _ in links(get(page)):
                target = file_url(url)
                name = (target or "").rsplit("/", 1)[-1]
                if target and re.search(r"addendum[-_ ]?b", name, re.I) and target.lower() not in known:
                    known.add(target.lower())
                    found.append({"id": "b-" + quarter, "kind": "addendum_b", "effective": quarter + "-01",
                                  "url": target, "landing": QUARTERLY_PAGE, "sha256": None})
    return found


def discover_rule(sources, get):
    """Sources for the final rule of the calendar year after the newest rule in sources.json."""
    newest = max(source["cy"] for source in sources if source["kind"] == "rule_addenda")
    wanted = str(newest + 1)
    known = {source["url"].lower() for source in sources}
    found = []
    for page, text in links(get(RULES_PAGE)):
        if not re.search(r"/cms-\d+-fc?$", page.rstrip("/"), re.I) or urllib.parse.urlsplit(page).hostname != "www.cms.gov":
            continue
        rule = page.rstrip("/").rsplit("/", 1)[-1].upper()
        for url, label in links(get(page)):
            target = file_url(url)
            if not target or target.lower() in known or not label.startswith(wanted):
                continue
            if re.search(r"\bOPPS Addenda\b", label, re.I):
                found.append({"id": "addenda-" + wanted, "kind": "rule_addenda", "cy": newest + 1, "rule": rule,
                              "url": target, "landing": page, "sha256": None})
            elif re.search(r"remov\w* from (the )?(IPO|inpatient)", label, re.I):
                found.append({"id": "removed-" + wanted, "kind": "removal_file", "cy": newest + 1, "rule": rule,
                              "url": target, "landing": page, "sha256": None})
    return found


def unique_ids(sources, additions):
    """A second file for a quarter that already has one is a correction of it."""
    taken = {source["id"] for source in sources}
    for source in additions:
        if source["id"] in taken and source["kind"] == "addendum_b":
            source["corrects"] = source["id"]
            source["id"] += "-corr"
        suffix = 2
        base = source["id"]
        while source["id"] in taken:
            source["id"] = "%s%d" % (base, suffix)
            suffix += 1
        taken.add(source["id"])
    return additions


def recheck(sources, count=3):
    """Re-download the newest quarterly and rule files; report any whose bytes changed."""
    quarterly = sorted((s for s in sources if s["kind"] == "addendum_b"), key=lambda s: s["effective"])[-count:]
    newest_cy = max(s["cy"] for s in sources if s["kind"] == "rule_addenda")
    rule_files = [s for s in sources if s.get("cy") == newest_cy]
    changed = []
    for source in quarterly + rule_files:
        digest = hashlib.sha256(fetch.download(source["url"])).hexdigest()
        if digest != source["sha256"]:
            changed.append(source["id"])
    return changed


def run(script):
    return subprocess.run([sys.executable, str(ROOT / "pipeline" / script)], cwd=str(ROOT)).returncode


def follow_ups(manifest):
    """What a person still has to do by hand after an automatic refresh."""
    notes = []
    rulebook = json.loads((ROOT / "pipeline" / "rules.json").read_text())
    have_rules = {rule["cy"] for rule in rulebook["rules"]}
    for source in manifest["sources"]:
        if source["kind"] == "rule_addenda" and source["cy"] >= 2020 and source["cy"] not in have_rules:
            notes.append("rules.json has no entry for CY %d (%s): add its Federal Register citation, the counts "
                         "CMS states, and the printed code table if there is one." % (source["cy"], source["rule"]))
    derived = ROOT / "pipeline" / "derived" / "ipo-history.json"
    if derived.exists():
        listed = set(json.loads(derived.read_text()))
        labels = set(json.loads((ROOT / "data" / "labels.json").read_text()))
        if listed - labels:
            notes.append("%d code(s) need a plain-language label in data/labels.json: %s" % (
                len(listed - labels), ", ".join(sorted(listed - labels))))
        if labels - listed:
            notes.append("data/labels.json has labels for codes with no list history: %s" % ", ".join(sorted(labels - listed)))
    return notes


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pick up new CMS files, then rebuild and re-check the history.")
    parser.add_argument("--dry-run", action="store_true", help="show what discovery finds and stop")
    parser.add_argument("--recheck", action="store_true", help="re-download the newest files and report any CMS replaced")
    parser.add_argument("--add-quarter", nargs=2, metavar=("YYYY-MM", "URL"))
    parser.add_argument("--add-rule", nargs=2, metavar=("YEAR", "URL"))
    parser.add_argument("--removal-file", metavar="URL", help="with --add-rule: that rule's IPO removal file")
    args = parser.parse_args(argv)

    manifest = fetch.load_manifest()
    sources = manifest["sources"]
    additions = []
    if args.add_quarter:
        quarter, url = args.add_quarter
        if not re.fullmatch(r"\d{4}-(01|04|07|10)", quarter):
            parser.error("--add-quarter takes YYYY-MM for January, April, July or October")
        additions.append({"id": "b-" + quarter, "kind": "addendum_b", "effective": quarter + "-01",
                          "url": url, "landing": QUARTERLY_PAGE, "sha256": None})
    if args.add_rule:
        year, url = args.add_rule
        if not re.fullmatch(r"20\d\d", year):
            parser.error("--add-rule takes a four-digit calendar year")
        additions.append({"id": "addenda-" + year, "kind": "rule_addenda", "cy": int(year), "rule": "",
                          "url": url, "landing": RULES_PAGE, "sha256": None})
        if args.removal_file:
            additions.append({"id": "removed-" + year, "kind": "removal_file", "cy": int(year), "rule": "",
                              "url": args.removal_file, "landing": RULES_PAGE, "sha256": None})
    if not additions:
        def get(url):
            return fetch.download(url).decode("utf-8", errors="replace")
        additions = discover_quarters(sources, get) + discover_rule(sources, get)
    additions = unique_ids(sources, additions)

    print("New files found: %d" % len(additions))
    for source in additions:
        print("  %-16s %s" % (source["id"], source["url"]))
    if args.recheck:
        changed = recheck(sources)
        print("Files CMS has replaced since they were pinned: %s" % (", ".join(changed) or "none"))
        if changed:
            print("  Look at what changed, then: python3 pipeline/fetch.py --repin %s (after deleting the old download)" % " ".join(changed))
    if args.dry_run:
        return 0

    if additions:
        sources.extend(additions)
        fetch.save_manifest(manifest)
    status = run("fetch.py") or run("build.py") or run("run_tests.py")
    notes = follow_ups(fetch.load_manifest())
    print("\nStill to do by hand:" if notes else "\nNothing left to do by hand.")
    for note in notes:
        print("  - " + note)
    print("\nThen rebuild the site: cd web && npm run build && npm test")
    return status


if __name__ == "__main__":
    sys.exit(main())
