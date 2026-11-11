"""Check that every quoted Federal Register passage really is on the page it cites."""
import html
import json
import re
from pathlib import Path

import fetch

ROOT = Path(__file__).resolve().parent.parent
_PAGE = re.compile(r"\[\[Page (\d+)\]\]")


def pages_of(path):
    """{page number: text} for a govinfo HTML rendering of a Federal Register document."""
    text = html.unescape(re.sub(r"<[^>]+>", "", Path(path).read_text(encoding="utf-8", errors="replace")))
    parts = _PAGE.split(text)
    return {int(parts[i]): re.sub(r"\s+", " ", parts[i + 1]) for i in range(1, len(parts), 2)}


def load():
    return json.loads((ROOT / "pipeline" / "citations.json").read_text())["citations"]


def page_number(cite):
    match = re.fullmatch(r"(\d+) FR (\d+)", cite)
    if not match:
        raise ValueError("citation is not 'VOL FR PAGE': %r" % cite)
    return int(match.group(2))


def verify(sources):
    """Return a list of problems; empty when every quote is on its cited page."""
    by_id = {source["id"]: source for source in sources}
    cache = {}
    problems = []
    for key, item in sorted(load().items()):
        source = by_id.get(item["source"])
        if source is None:
            problems.append("%s: unknown source %s" % (key, item["source"]))
            continue
        if source["id"] not in cache:
            cache[source["id"]] = pages_of(fetch.raw_path(source))
        quote = re.sub(r"\s+", " ", item["quote"]).strip()
        if quote not in cache[source["id"]].get(page_number(item["cite"]), ""):
            problems.append("%s: quote not found on %s" % (key, item["cite"]))
    return problems
