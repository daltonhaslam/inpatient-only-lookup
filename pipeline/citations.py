"""Check that every quoted Federal Register passage really is on the page it cites, and that the
deductible quotes in facts.json are on the pinned CMS fact sheet they come from."""
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


# Sources whose pin may move: a CMS newsroom page whose HTML drifts (menus, scripts) while the quoted
# sentences stay. A new hash is adopted when every quote still verifies on the new text (fetch.py,
# refresh.py); otherwise a person must look. Every other source (FR text included) stays strict.
QUOTED_PAGES = ("fact_sheet",)


def _facts(facts):
    return facts or fetch.read_json(fetch.PIPELINE / "facts.json")


def deductible_problems(text, facts=None):
    """Problems with facts.json's deductibles against a fact sheet's text (HTML or plain): each figure
    must be in a quote ("will be $1,776 in 2027"), and each quote on the page."""
    deductibles = _facts(facts)["deductibles"]
    page = fetch.squash(fetch.text_of(text))
    quotes = " ".join(deductibles["quotes"])
    problems = ["deductibles: %s $%s is in no quote" % (key, format(deductibles[key], ","))
                for key in ("part_a_inpatient", "part_b")
                if "will be ${:,} in {}".format(deductibles[key], deductibles["year"]) not in quotes]
    problems += ["deductibles: quote not on the fact sheet: %s" % quote[:60]
                 for quote in deductibles["quotes"] if not fetch.squash(quote) or fetch.squash(quote) not in page]
    return problems


def deductible_source(sources, facts=None):
    """The sources.json entry for facts.json's deductibles (the one with the same URL), or None."""
    url = _facts(facts)["deductibles"]["url"]
    return next((s for s in sources if s["url"] == url), None)


def verify_deductibles(sources, facts=None):
    """Problems with facts.json's deductibles; empty when each figure is quoted and each quote is on the
    downloaded copy of the fact sheet it names. A missing source or download is a problem, never an error."""
    facts = _facts(facts)
    source = deductible_source(sources, facts)
    if source is None:
        return ["deductibles: no source in sources.json for %s; pin the fact sheet" % facts["deductibles"]["url"]]
    path = fetch.raw_path(source)
    if not path.is_file():
        return ["deductibles: %s is not downloaded; run python3 pipeline/fetch.py --only %s" % (source["id"], source["id"])]
    return deductible_problems(path.read_text(encoding="utf-8", errors="replace"), facts)


def quoted_page_change(source, data):
    """For a QUOTED_PAGES source whose bytes no longer match its pin: (adopt, message). adopt is True
    when the deductible quotes still verify on data, so the new hash can be pinned. Only the sheet
    facts.json quotes can be checked; any other changed page needs a person."""
    facts = _facts(None)
    if source["url"] != facts["deductibles"]["url"]:
        return False, "page changed; facts.json quotes another page, so nothing to check it against -> FAIL, needs a person"
    problems = deductible_problems(data.decode("utf-8", errors="replace"), facts)
    if problems:
        return False, "page changed; deductible quotes no longer match -> FAIL, needs a person (%s)" % "; ".join(problems)
    return True, "page changed; deductible quotes still match -> adopted new hash %s" % fetch.sha256(data)[:12]
