"""Check that every quoted Federal Register passage really is on the page it cites."""
import re
from pathlib import Path

import fetch

_PAGE = re.compile(r"\[\[Page (\d+)\]\]")


def pages_of(path):
    """{page number: text} for a govinfo HTML rendering of a Federal Register document."""
    parts = _PAGE.split(fetch.text_of(Path(path).read_text(encoding="utf-8", errors="replace")))
    return {int(parts[i]): fetch.squash(parts[i + 1]) for i in range(1, len(parts), 2)}


def load():
    return fetch.read_json(fetch.PIPELINE / "citations.json")["citations"]


def split_cite(cite):
    """(volume, page) of a "VOL FR PAGE" citation."""
    match = re.fullmatch(r"(\d+) FR (\d+)", cite)
    if not match:
        raise ValueError("citation is not 'VOL FR PAGE': %r" % cite)
    return int(match.group(1)), int(match.group(2))


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
        volume, page = split_cite(item["cite"])
        quote = fetch.squash(item["quote"])
        if volume != split_cite(source["fr"])[0]:
            problems.append("%s: %s is not in volume %s of %s" % (key, item["cite"], source["fr"].split()[0], source["id"]))
        elif not quote or quote not in cache[source["id"]].get(page, ""):
            problems.append("%s: quote not found on %s" % (key, item["cite"]))
    return problems
