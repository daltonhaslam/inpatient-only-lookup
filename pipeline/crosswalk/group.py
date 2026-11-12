"""Group a set of ICD-10-PCS codes and a principal diagnosis to an MS-DRG v44 family.

A family is the severity set of MS-DRGs (e.g. 163-165) a case lands in before CC/MCC split
it. group() picks it the way the CMS grouper does, from the v44 Definitions Manual tables:

1. MDC: the principal diagnosis's MDC (load_dx_mdc). Codes CMS assigns by sex have two MDCs.
2. Pre-MDC (MDC "00"): transplants, ECMO, tracheostomy, CAR-T and bone marrow transplants are
   checked first, in Appendix D order, with the conditions those DRGs state (see _pre_mdc).
3. In the MDC: the OR procedures (Appendix E codes without *) with a row in that MDC; of the
   rows whose condition the case shows, the one whose family comes first in the MDC's
   Appendix D hierarchy wins (see _in_mdc).
4. OR procedures, none in the MDC: 981-983, or 987-989 when every one is non-extensive.
5. No OR procedure: the principal diagnosis's medical DRGs in its MDC (Appendix B).

What this cannot see, and so does not model:
- CC/MCC: a family is returned as the whole severity set; pricing gives its range.
- Secondary diagnoses, except where noted. Pancreas transplant DRGs need diabetes (and 008/019
  renal failure); they are assumed present.
- Appendix E Part 2-4: procedure clusters (codes CMS only accepts in pairs, e.g. heart assist
  revisions with removals), Part 3 non-OR combinations and Part 4 MDC 14 obstetric logic are
  not parsed. Cluster-only codes have no Appendix E row, so they group as non-OR.
- Conditions other than the principal diagnosis and the other codes present (number of
  spinal levels, device types, "except only cholecystectomy"); see _in_mdc.
- Non-OR procedures that CMS lets lead to a surgical or a procedure-driven medical DRG
  (debridement to 579-581, cardiac catheterization to 286-287, MV > 96 hours to 207): per the
  spec, a case with no OR procedure groups by diagnosis.

Shared tables come from Ref and are never mutated.
"""
import functools
import re

import parse
from crosswalk import sources

PRE = sources.PRE_MDC
EXTENSIVE = ("981", "982", "983")
NONEXTENSIVE = ("987", "988", "989")
_SEVERITY = re.compile(r" (?:with|without) (?:MCC|CC/MCC|CC)$")


class Ref:
    """The CMS tables the crosswalk reads, as one object to pass around.

    ref.<name> is sources.load_<name>() (ref.proc_index, ref.table5, ref.rates ...), read on
    first use. Ref(name=table, ...) supplies tables directly, for tests. Ref.load() is the one
    shared instance over the pinned files. The tables are shared: never mutate them.
    """

    def __init__(self, **tables):
        unknown = sorted(name for name in tables if "load_" + name not in sources.SOURCE_OF)
        if unknown:
            raise TypeError("no loader for %s" % ", ".join(unknown))
        self.__dict__.update(tables)

    def __getattr__(self, name):
        if name.startswith("_") or "load_" + name not in sources.SOURCE_OF:
            raise AttributeError(name)
        value = getattr(sources, "load_" + name)()
        setattr(self, name, value)
        return value

    @classmethod
    @functools.lru_cache(maxsize=None)
    def load(cls):
        return cls()

    @functools.cached_property
    def rank(self):
        """{mdc: {drg: position of its Appendix D family in the MDC's hierarchy}}."""
        return {mdc: {drg: position for position, family in enumerate(families) for drg in family}
                for mdc, families in self.hierarchy.items()}

    @functools.cached_property
    def dx_specific(self):
        """Surgical DRGs whose logic names principal diagnoses: those Appendix B lists for some
        diagnosis (e.g. 521-522 hip replacement for hip fracture, 731-733 for malignancy)."""
        return frozenset(drg for drgs in self.dx_drgs.values() for drg in drgs
                         if self.drg_titles[drg]["type"] == "SURG")


def group(pcs_codes, principal_dx, ref, sex=None):
    """{"mdc", "drgs", "family", "basis", "or_codes", "mdc_ambiguous"} for a case with these
    ICD-10-PCS codes (principal procedure first) and this principal diagnosis (no dot).

    basis is "pre-mdc", "in-mdc", "unrelated-extensive", "unrelated-nonextensive" or "medical".
    or_codes are the OR procedures among pcs_codes. sex ("F", "M" or None) settles diagnoses CMS
    assigns by sex; without it the MDC one of the codes belongs to is used, else the first, and
    mdc_ambiguous is True. Raises ValueError for an invalid code or a diagnosis with no MS-DRG.
    """
    codes = list(dict.fromkeys(pcs_codes))
    bad = [code for code in codes if code not in ref.pcs]
    if bad:
        raise ValueError("not valid FY2027 ICD-10-PCS codes: %s" % ", ".join(bad))
    if principal_dx not in ref.dx_mdc:
        raise ValueError("%r is not a billable FY2027 ICD-10-CM principal diagnosis" % principal_dx)
    if sex not in (None, "F", "M"):
        raise ValueError("sex must be 'F', 'M' or None, not %r" % sex)
    or_codes = [code for code in codes if code in ref.unrelated]
    mdc, ambiguous = _principal_mdc(principal_dx, codes, sex, ref)

    def result(family_mdc, drgs, family, basis):
        return {"mdc": family_mdc, "drgs": list(drgs), "family": family, "basis": basis,
                "or_codes": or_codes, "mdc_ambiguous": ambiguous}

    found = _pre_mdc(codes, principal_dx, ref)
    if found:
        return result(PRE, found[0], found[1], "pre-mdc")
    found = _in_mdc(codes, or_codes, mdc, principal_dx, ref)
    if found:
        return result(mdc, found[0], found[1], "in-mdc")
    if or_codes:
        extensive = any(ref.unrelated[code] == "extensive" for code in or_codes)
        drgs = EXTENSIVE if extensive else NONEXTENSIVE
        return result(mdc, drgs, _title(drgs, ref), "unrelated-extensive" if extensive else "unrelated-nonextensive")
    drgs = [drg for drg in ref.dx_drgs[principal_dx]
            if ref.drg_titles[drg]["type"] == "MED" and ref.drg_titles[drg]["mdc"] == mdc]
    if not drgs:
        raise ValueError("%s has no medical MS-DRG in MDC %s (v44 groups it to 998)" % (principal_dx, mdc))
    return result(mdc, drgs, _title(drgs, ref), "medical")


def _title(drgs, ref):
    """The family name: the DRG titles without their severity suffix, distinct, joined."""
    titles = []
    for drg in drgs:
        title = _SEVERITY.sub("", ref.drg_titles[drg]["title"])
        if title not in titles:
            titles.append(title)
    return "; ".join(titles)


def _principal_mdc(dx, codes, sex, ref):
    """(mdc, ambiguous). CMS assigns some diagnoses by sex: MDC 13 for a female, the other
    (12, or 11 for N393) for a male."""
    mdcs = ref.dx_mdc[dx]
    if len(mdcs) == 1:
        return mdcs[0], False
    if sex:
        chosen = [mdc for mdc in mdcs if (mdc == "13") == (sex == "F")]
        if len(chosen) == 1:
            return chosen[0], False
    used = [mdc for mdc in mdcs if any(row["mdc"] == mdc for code in codes for row in ref.proc_index.get(code, ()))]
    if len(used) == 1:
        return used[0], False
    return mdcs[0], True


# ---------------------------------------------------------------- Pre-MDC

# Pre-MDC codes that qualify only with something else, by the set of Pre-MDC rows Appendix E
# gives them. Any other code with Pre-MDC rows names a single family it reaches on its own
# (transplants, heart assist, ECMO, laryngectomy, CAR-T, bone marrow).
_PRE_ROLES = {
    (("003",), ("004",), ("011", "012", "013")): "tracheostomy",
    (("003",), ("004",)): "ventilation",       # 5A1955Z, MV > 96 hours
    (("008",), ("010",), ("019",)): "pancreas",  # pancreas or islet cell transplant
    (("008",), ("019",)): "kidney",            # kidney transplant
    (("019",),): "hemodialysis",
}


def _pre_role(code, rows):
    """A Pre-MDC code's role, or None for a code that reaches its one family on its own."""
    families = tuple(sorted({tuple(row["drgs"]) for row in rows}))
    if families in _PRE_ROLES:
        return _PRE_ROLES[families]
    if len(families) != 1:
        raise parse.ParseError("%s: Pre-MDC rows %s match no known Pre-MDC logic" % (code, families))
    return None


def _pre_mdc(codes, dx, ref):
    """(drgs, family) of the first Appendix D Pre-MDC family the case qualifies for, or None.

    The conditions are the ones the v44 Pre-MDC tables state that the codes and principal
    diagnosis can show: tracheostomy goes to 003 with a major OR procedure (an OR procedure
    outside 987-989) or 004 without, when there is MV > 96 hours or the principal diagnosis is
    not a face, mouth and neck one (Appendix B Pre-MDC 011-013), else to 011-013. Kidney
    transplant needs a pancreas or islet cell transplant (008), plus hemodialysis for 019; a
    pancreas transplant without a kidney is 010 (Appendix D ranks 010 above 008 and 019, which
    would otherwise make them unreachable).
    """
    roles, candidates = {}, []
    for code in codes:
        rows = [row for row in ref.proc_index.get(code, ()) if row["mdc"] == PRE]
        if rows:
            roles[code] = _pre_role(code, rows)
            candidates.extend((code, row) for row in rows)
    if not candidates:
        return None
    has = set(roles.values())
    face_mouth_neck = "011" in ref.dx_pre_drgs.get(dx, ())
    tracheostomy = "tracheostomy" in has and ("ventilation" in has or not face_mouth_neck)
    major_or = any(ref.unrelated.get(code) == "extensive" and roles.get(code) != "tracheostomy" for code in codes)
    allowed = {
        ("003",): tracheostomy and major_or,
        ("004",): tracheostomy and not major_or,
        ("011", "012", "013"): "tracheostomy" in has and face_mouth_neck,
        ("010",): "pancreas" in has and "kidney" not in has,
        ("008",): {"pancreas", "kidney"} <= has,
        ("019",): {"pancreas", "kidney", "hemodialysis"} <= has,
    }
    qualifying = [(_row_rank(PRE, row["drgs"], ref), int(row["drgs"][0]), list(row["drgs"]), row["family"])
                  for code, row in candidates if roles[code] is None or allowed[tuple(row["drgs"])]]
    if not qualifying:
        return None
    _, _, drgs, family = min(qualifying)
    return drgs, family


# ---------------------------------------------------------------- within the MDC

def _row_rank(mdc, drgs, ref):
    """Position in the MDC's Appendix D hierarchy of the family containing a row's DRGs.

    An Appendix E row may carry only part of a family (06 350-352 inside Hernia 350-355, 07
    411-413 inside 411-419, 08 518 inside 518-520): it ranks as that family, but the row's own
    DRGs are what the code leads to, because the grouper narrows within the family by the same
    logic the row records. A row in no family (MDC 14 delivery rows) ranks after all of them.
    """
    ranks = ref.rank.get(mdc, {})
    positions = {ranks.get(drg) for drg in drgs}
    if len(positions) == 1 and None not in positions:
        return positions.pop()
    if mdc == PRE:
        raise parse.ParseError("Pre-MDC row %s is in no Appendix D family" % "-".join(drgs))
    return len(ref.hierarchy.get(mdc, ()))


def _in_mdc(codes, or_codes, mdc, dx, ref):
    """(drgs, family) of the highest-ranked qualifying MDC row of an OR procedure, or None.

    Appendix D ranks families, but Appendix E lists a code under every family whose logic
    mentions it, including ones that need more than the code: a second procedure (212
    concomitant aortic and mitral valves, 216-218 valve with catheterization, 650-651 kidney
    transplant with hemodialysis, combined spinal fusions) or a principal diagnosis (521-522
    hip fracture, 731-733 malignancy). A code listed under a lower family as well can only land
    there when a higher one's condition fails, so for each OR code:
    - a diagnosis-specific row (DRGs Appendix B lists for some diagnosis) keeps the DRGs listed
      for this diagnosis, else its other DRGs, else is dropped (unless it is the code's only
      row in the MDC: then the listing is for other logic and the row stands);
    - its lowest-ranked remaining row (its base) always qualifies;
    - a higher row qualifies when the diagnosis is listed for it;
    - of the higher rows in a family where another of the codes also has a row, the
      lowest-ranked qualifies. Lowest, because a partner code is often listed under several
      of them: a catheterization has rows in 212 and 216-218 (and 233-234), so valve plus
      catheterization is 216-218 and bypass plus catheterization 233-234; anterior plus
      posterior single-level lumbar fusion is 402, not multi-level 426-428.
    Known misses, where the tables cannot show the condition: aortic plus mitral valve gets
    216-218, not 212 (three conditions); a bile duct exploration alone gets its base 411-413,
    not 408-410 ("except only cholecystectomy").
    """
    listed = set(ref.dx_drgs.get(dx, ()))
    families = {code: {_row_rank(mdc, row["drgs"], ref) for row in ref.proc_index.get(code, ()) if row["mdc"] == mdc}
                for code in codes}
    best = None
    for code in or_codes:
        rows = [row for row in ref.proc_index[code] if row["mdc"] == mdc]
        kept = []
        for row in rows:
            drgs, dx_listed = row["drgs"], False
            specific = [drg for drg in drgs if drg in ref.dx_specific]
            if specific:
                matched = [drg for drg in specific if drg in listed]
                dx_listed = bool(matched)
                drgs = matched or [drg for drg in drgs if drg not in ref.dx_specific]
                if not drgs and len(rows) == 1:
                    drgs = row["drgs"]
            if drgs:
                kept.append((_row_rank(mdc, row["drgs"], ref), drgs, row["family"], dx_listed))
        if not kept:
            continue
        base = max(rank for rank, _, _, _ in kept)
        partnered = [rank for rank, _, _, _ in kept
                     if rank < base and any(rank in families[other] for other in codes if other != code)]
        partner = max(partnered) if partnered else None
        for rank, drgs, family, dx_listed in kept:
            if rank in (base, partner) or dx_listed:
                key = (rank, int(drgs[0]), len(drgs))
                if best is None or key < best[0]:
                    best = (key, list(drgs), family)
    return (best[1], best[2]) if best else None
