#!/usr/bin/env python3
"""Download every file in sources.json into data/raw/<id>/ and pin or verify its SHA-256.

The raw files carry AMA CPT descriptors, so data/raw/ is gitignored and never published.
Usage: python3 pipeline/fetch.py [--only ID ...] [--repin ID ...]
"""
import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "pipeline" / "sources.json"
RAW = ROOT / "data" / "raw"
# www.cms.gov answers 403 to urllib's default agent.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ALLOWED_HOSTS = {"www.cms.gov", "www.govinfo.gov", "www.ecfr.gov"}
MAX_BYTES = 60 * 1024 * 1024


def load_manifest():
    return json.loads(MANIFEST.read_text())


def save_manifest(manifest):
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n")


def raw_path(source):
    name = urllib.parse.unquote(source["url"].rsplit("/", 1)[-1]) or "download"
    return RAW / source["id"] / name


def download(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
        raise ValueError("refusing to fetch %s: not an allowed https host" % url)
    quoted = urllib.parse.urlunsplit(parts._replace(path=urllib.parse.quote(parts.path)))
    request = urllib.request.Request(quoted, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("%s is larger than %d bytes" % (url, MAX_BYTES))
    return data


def fetch(source, repin=False):
    """Return (status, changed). Downloads only when the file is missing."""
    path = raw_path(source)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(download(source["url"]))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if source.get("sha256") in (None, "") or repin:
        changed = source.get("sha256") != digest
        source["sha256"] = digest
        return ("pinned", changed)
    if source["sha256"] != digest:
        return ("MISMATCH (CMS replaced the file, or the download is bad; rerun with --repin %s after checking)" % source["id"], False)
    return ("ok", False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", default=None, help="source ids to fetch (default: all)")
    parser.add_argument("--repin", nargs="*", default=[], help="source ids whose pin should be replaced")
    args = parser.parse_args(argv)
    manifest = load_manifest()
    failed = False
    dirty = False
    for source in manifest["sources"]:
        if args.only is not None and source["id"] not in args.only:
            continue
        try:
            status, changed = fetch(source, repin=source["id"] in args.repin)
        except Exception as error:  # one bad URL must not hide the rest
            status, changed = "FAILED: %s" % error, False
        dirty = dirty or changed
        if not status.startswith(("ok", "pinned")):
            failed = True
        print("%-16s %s" % (source["id"], status))
    if dirty:
        save_manifest(manifest)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
