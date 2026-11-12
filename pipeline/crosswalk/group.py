"""Group a set of ICD-10-PCS codes and a principal diagnosis to an MS-DRG v44 family.

A family is the severity set of MS-DRGs (e.g. 163-165) a case lands in before CC/MCC split
it. group() picks it the way the CMS grouper does, from the v44 Definitions Manual tables:

1. MDC: the principal diagnosis's MDC (load_dx_mdc). Codes CMS assigns by sex have two MDCs.
2. Pre-MDC (MDC "00"): transplants, ECMO, tracheostomy, CAR-T and bone marrow transplants are
   checked first, in Appendix D order, with the conditions those DRGs state (see _pre_mdc).
3. In the MDC: the OR procedures (Appendix E codes without *) with a row in that MDC; of the
   rows whose condition the case shows, the one whose family comes first in the MDC's
   Appendix D hierarchy wins (see _in_mdc).
4. OR procedures, none with a row in the MDC: the MDC's "principal diagnosis with any O.R.
   procedure" family where v44 has one (_ANY_OR: 769, 817-819, 853-858, 876, 939-941,
   969-970), else 981-983, or 987-989 when every one is non-extensive.
5. No OR procedure: the principal diagnosis's medical DRGs in its MDC (Appendix B), less
   those that need a procedure or a discharge status the case does not show (_medical).

What this cannot see, and so does not model:
- CC/MCC: a family is returned as the whole severity set; pricing gives its range.
- Secondary diagnoses, except where noted. Pancreas transplant DRGs need diabetes (and 008/019
  renal failure); they are assumed present.
- Appendix E Part 4 (MDC 14 obstetric logic) is not parsed. Part 2 procedure clusters
  ("grouped differently than their constituent codes", e.g. uterus, cervix and supporting
  structures to radical hysterectomy 734-735) replace their codes' own rows in an MDC where a
  cluster row's condition holds, else the codes keep theirs (_clusters). So a bilateral hip or
  knee revision is 461-462 even with a periprosthetic infection diagnosis (each removal's
  403-404 row gives way to its cluster's 461-462); v44 does not say which wins, so this is an
  open ambiguity. Part 3 combinations (bile duct stent exchanges) are made non-OR.
- Conditions other than the principal diagnosis and the other codes present (number of
  spinal levels beyond the codes, device types); see _in_mdc.
- Non-OR procedures that CMS lets lead to a surgical or a procedure-driven medical DRG
  (debridement to 579-581, cardiac catheterization to 286-287, MV > 96 hours to 207): per the
  spec, a case with no OR procedure groups by diagnosis. Nor do they outrank an OR code: a
  percutaneous hip or knee spacer removal (0SPC38Z*, listed for 463-465) with a replacement
  groups to 469-470 here, 463-465 in v44.
- MDC 25 with only non-extensive OR procedures goes to 987-989 (v44 not checked for this).

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
        descriptor = type(self).__dict__.get(name)
        if descriptor is not None:
            # Python lands here when a property raised AttributeError; surface that cause
            # instead of reporting the property itself as missing.
            try:
                return descriptor.__get__(self, type(self))
            except AttributeError as error:
                raise RuntimeError("Ref.%s failed: %s" % (name, error)) from error
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
    non_or = {code for combo in ref.non_or_combos if set(combo) <= set(codes) for code in combo}
    or_codes = [code for code in codes if code in ref.unrelated and code not in non_or]
    mdc, ambiguous = _principal_mdc(principal_dx, codes, sex, ref)

    def result(family_mdc, drgs, family, basis):
        return {"mdc": family_mdc, "drgs": list(drgs), "family": family, "basis": basis,
                "or_codes": or_codes, "mdc_ambiguous": ambiguous}

    found = _pre_mdc(codes, or_codes, principal_dx, ref)
    if found:
        return result(PRE, found[0], found[1], "pre-mdc")
    found = _in_mdc(codes, or_codes, mdc, principal_dx, ref)
    if found:
        return result(mdc, found[0], found[1], "in-mdc")
    if or_codes:
        extensive = any(ref.unrelated[code] == "extensive" for code in or_codes)
        drgs = _any_or(mdc, principal_dx, extensive, ref)
        if drgs:
            return result(mdc, drgs, _title(drgs, ref), "in-mdc")
        drgs = EXTENSIVE if extensive else NONEXTENSIVE
        return result(mdc, drgs, _title(drgs, ref), "unrelated-extensive" if extensive else "unrelated-nonextensive")
    drgs = _medical(codes, mdc, principal_dx, ref)
    if not drgs:
        raise ValueError("%s has no medical MS-DRG in MDC %s (v44 groups it to 998)" % (principal_dx, mdc))
    return result(mdc, drgs, _title(drgs, ref), "medical")


# v44 families defined as a principal diagnosis plus ANY operating room procedure, so Appendix
# E has no rows for them: {mdc: [(drgs, who)]} in Appendix D order. who is "listed" (Appendix B
# lists the principal diagnosis for the family), "any" (any principal diagnosis of the MDC; for
# 853-855 "from MDC 18 except" the 856-858 list, checked first) or "extensive" (969-970: "all
# procedures not listed in Appendix F, DRGs 987, 988, or 989").
_ANY_OR = {
    "14": [(("817", "818", "819"), "listed"), (("769",), "listed")],
    "18": [(("856", "857", "858"), "listed"), (("853", "854", "855"), "any")],
    "19": [(("876",), "any")],
    "23": [(("939", "940", "941"), "any")],
    "25": [(("969", "970"), "extensive")],
}


def _any_or(mdc, dx, extensive, ref):
    """The MDC's any-OR-procedure family this principal diagnosis takes, or None."""
    listed = ref.dx_drgs.get(dx, ())
    for drgs, who in _ANY_OR.get(mdc, ()):
        if who == "any" or (who == "listed" and drgs[0] in listed) or (who == "extensive" and extensive):
            return list(drgs)
    return None


# Medical DRGs that need a procedure Appendix E names (thrombolytic, ventilation, cardiac
# catheterization, rehabilitation therapy), and ones that need a discharge status (expired,
# left against medical advice). Appendix B lists them for every diagnosis they can take, which
# would put their amounts into ranges for cases that show neither.
_NEEDS_PROCEDURE = frozenset(("061", "062", "063", "207", "208", "286", "287", "870", "895"))
_NEEDS_DISCHARGE_STATUS = frozenset(("283", "284", "285", "894"))


def _medical(codes, mdc, dx, ref):
    """The principal diagnosis's medical DRGs in its MDC (Appendix B)."""
    named = {drg for code in codes for row in ref.proc_index.get(code, ()) for drg in row["drgs"]}
    return [drg for drg in ref.dx_drgs[dx]
            if ref.drg_titles[drg]["type"] == "MED" and ref.drg_titles[drg]["mdc"] == mdc
            and drg not in _NEEDS_DISCHARGE_STATUS and (drg not in _NEEDS_PROCEDURE or drg in named)]


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


def _clusters(codes, ref):
    """{"A+B": rows} the Appendix E Part 2 clusters the codes complete, keyed by their codes.

    Appendix E: clusters "are grouped differently than their constituent codes". In an MDC (or
    Pre-MDC) where one of a cluster's rows has its condition met, the cluster is read as one
    code with the cluster's rows and its codes' own rows are set aside (_set_aside); otherwise
    the codes keep their rows. A one-joint knee removal plus replacement (0SPC0JZ+0SRC0J9) has
    only a 461-462 row, which needs two sites, so it groups by the removal's 463-465 row.
    """
    present, found = set(codes), {}
    for cluster in ref.clusters:
        if all(group & present for group in cluster["groups"]):
            key = "+".join(sorted(code for group in cluster["groups"] for code in group & present))
            found.setdefault(key, []).extend(cluster["rows"])
    return found


def _set_aside(clusters):
    """The codes of these clusters (keys of _clusters), whose own rows give way to them."""
    return {code for key in clusters for code in key.split("+")}


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


def _pre_mdc(codes, or_codes, dx, ref):
    """(drgs, family) of the first Appendix D Pre-MDC family the case qualifies for, or None.

    The conditions are the ones the v44 Pre-MDC tables state that the codes and principal
    diagnosis can show: tracheostomy goes to 003 with a major OR procedure (an OR procedure
    outside 987-989) or 004 without, when there is MV > 96 hours or the principal diagnosis is
    not a face, mouth and neck one (Appendix B Pre-MDC 011-013), else to 011-013. Kidney
    transplant needs a pancreas or islet cell transplant (008), plus hemodialysis for 019; a
    pancreas transplant without a kidney is 010 (Appendix D ranks 010 above 008 and 019, which
    would otherwise make them unreachable).
    """
    clusters = {key: [row for row in rows if row["mdc"] == PRE] for key, rows in _clusters(codes, ref).items()}
    clusters = {key: rows for key, rows in clusters.items() if rows}
    roles, candidates = {}, []
    for code in codes:
        rows = [row for row in ref.proc_index.get(code, ()) if row["mdc"] == PRE]
        if rows and code not in _set_aside(clusters):
            roles[code] = _pre_role(code, rows)
            candidates.extend((code, row) for row in rows)
    for key, rows in clusters.items():
        roles[key] = None
        candidates.extend((key, row) for row in rows)
    if not candidates:
        return None
    has = set(roles.values())
    face_mouth_neck = "011" in ref.dx_pre_drgs.get(dx, ())
    tracheostomy = "tracheostomy" in has and ("ventilation" in has or not face_mouth_neck)
    major_or = any(ref.unrelated[code] == "extensive" and roles.get(code) != "tracheostomy" for code in or_codes)
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
    there when a higher one's condition fails, so for each OR code, and each Appendix E Part 2
    cluster the codes complete with a row here whose condition holds (as one code with the
    cluster's rows, in place of its codes; see _clusters):
    - rows whose stated v44 condition the codes do not show are dropped (_condition_met);
    - a diagnosis-specific row (DRGs Appendix B lists for some diagnosis) keeps the DRGs listed
      for this diagnosis, else its other DRGs, else is dropped (unless it is the code's only
      row in the MDC: then the listing is for other logic and the row stands);
    - its lowest-ranked remaining row (its base) always qualifies;
    - a higher row qualifies when the diagnosis is listed for it, or (212, 461-462) its
      procedure condition was checked in full;
    - of the higher rows in a family where another of the codes is an acceptable partner
      (_partner_ok), the lowest-ranked qualifies. Lowest, because a partner code is often
      listed under several of them: a catheterization has rows in 212, 216-218 and 233-234, so
      valve plus catheterization is 216-218 and bypass plus catheterization 233-234.
    """
    listed = set(ref.dx_drgs.get(dx, ()))
    clusters = {key: rows for key, rows in _clusters(codes, ref).items()
                if any(row["mdc"] == mdc and _condition_met(mdc, row["drgs"], codes, ref) for row in rows)}
    entries = {code: ref.proc_index[code] for code in or_codes if code not in _set_aside(clusters)}
    entries.update(clusters)
    families = {code: frozenset(_row_rank(mdc, row["drgs"], ref) for row in ref.proc_index.get(code, ())
                                if row["mdc"] == mdc)
                for code in codes}
    families.update({code: frozenset(_row_rank(mdc, row["drgs"], ref) for row in rows if row["mdc"] == mdc)
                     for code, rows in entries.items() if code not in families})
    hierarchy = ref.hierarchy.get(mdc, ())
    best = None
    for code, all_rows in entries.items():
        rows = [row for row in all_rows if row["mdc"] == mdc and _condition_met(mdc, row["drgs"], codes, ref)]
        kept = []
        for row in rows:
            # A row qualifies outright when its whole condition is shown: the diagnosis is
            # listed for it, or (212, 461-462) _condition_met checked it in full.
            drgs, shown = row["drgs"], (mdc, row["drgs"][0]) in _CHECKED_IN_FULL
            specific = [drg for drg in drgs if drg in ref.dx_specific]
            if specific:
                matched = [drg for drg in specific if drg in listed]
                shown = bool(matched)
                drgs = matched or [drg for drg in drgs if drg not in ref.dx_specific]
                if not drgs and len(rows) == 1:
                    drgs = row["drgs"]
            if drgs:
                kept.append((_row_rank(mdc, row["drgs"], ref), drgs, row["family"], shown))
        if not kept:
            continue
        base = max(rank for rank, _, _, _ in kept)

        def paired(rank):
            return any(rank in families[other] and _partner_ok(mdc, hierarchy[rank][0], code, other, families)
                       for other in codes if other != code)

        partnered = [rank for rank, _, _, _ in kept if rank < base and paired(rank)]
        partner = max(partnered) if partnered else None
        for rank, drgs, family, shown in kept:
            if rank in (base, partner) or shown:
                key = (rank, int(drgs[0]), len(drgs))
                if best is None or key < best[0]:
                    best = (key, list(drgs), family)
    return (best[1], best[2]) if best else None


def _has_row(code, mdc, drgs, ref):
    """Whether one of the code's rows in the MDC names one of these DRGs."""
    return any(row["mdc"] == mdc and not drgs.isdisjoint(row["drgs"]) for row in ref.proc_index.get(code, ()))


_DELIVERY_FAMILIES = ("783", "786", "768", "796")   # cesarean, vaginal delivery with O.R./sterilization
_DELIVERY = frozenset(("786", "805"))               # rows of cesarean and vaginal delivery codes
_CHOLECYSTECTOMY = frozenset(("414", "417"))        # rows 411-416 (open) and 417-419 (laparoscopic)
_COMBINED_FUSION = ("402", "426", "429")            # combined anterior and posterior fusion families
_CHECKED_IN_FULL = frozenset((("05", "212"), ("08", "461")))   # rows _condition_met settles


def _condition_met(mdc, drgs, codes, ref):
    """False for a row whose family needs something v44 states and the codes do not show:
    - MDC 14 cesarean and vaginal-delivery families need a delivery code (a cesarean, or a
      code with a vaginal delivery 805-807 row); without one, a salpingectomy for an ectopic
      pregnancy is not "vaginal delivery with sterilization";
    - MDC 07 411-413 (cholecystectomy with C.D.E.) needs a cholecystectomy; a bile duct
      exploration alone is 408-410 ("biliary tract procedures except only cholecystectomy");
    - 212 needs an aortic valve (02xF) and a mitral valve (02xG) procedure plus at least one
      concomitant procedure (a third code listed for 212);
    - 461-462 needs codes from two different lower extremity sites of its list (right hip,
      left knee ...): two codes on one joint (acetabular and femoral surfaces) are not bilateral.
    """
    first = drgs[0]
    if mdc == "14" and first in _DELIVERY_FAMILIES:
        return any(_has_row(code, "14", _DELIVERY, ref) for code in codes)
    if mdc == "07" and tuple(drgs) == ("411", "412", "413"):
        return any(_has_row(code, "07", _CHOLECYSTECTOMY, ref) for code in codes)
    if mdc == "05" and first == "212":
        listed = [code for code in codes if _has_row(code, "05", {"212"}, ref)]
        valves = {code[3] for code in listed if code[1] == "2"}
        return {"F", "G"} <= valves and len(listed) >= 3
    if mdc == "08" and first == "461":
        present = set(codes)
        sites = [site for site, entries in ref.joint_sites.items()
                 if any(set(entry) <= present for entry in entries)]
        return len(sites) >= 2
    return True


def _fusion_column(code):
    """"anterior" or "posterior" for an ICD-10-PCS spinal fusion (0RG/0SG) by its qualifier,
    as v44 sorts them into the anterior (0, J) and posterior lists of DRGs 402, 426 and 429;
    None for anything else (new-technology XRG fusions are not sorted)."""
    if code[:3] in ("0RG", "0SG"):
        return "anterior" if code[6] in "0J" else "posterior"
    return None


def _partner_ok(mdc, family, code, other, families):
    """Whether other can be the second procedure that the family (its first DRG) needs:
    - MDC 05 families are "X with Y" (212, 216-218, 231-234, 317): two codes listed under the
      same set of families (two grafts, two valves) are the same kind and do not pair;
    - combined fusions (402, 426-428, 429-430) need an anterior and a posterior column code;
    - 447-448 by two single-level codes needs two from the same column list.
    Elsewhere (kidney with hemodialysis) any listed code pairs; 461-462 is settled by
    _condition_met.
    """
    if mdc == "05":
        return families[other] != families[code]
    if family in _COMBINED_FUSION:
        return None not in (_fusion_column(code), _fusion_column(other)) and \
            _fusion_column(code) != _fusion_column(other)
    if family == "447":
        return _fusion_column(code) is not None and _fusion_column(code) == _fusion_column(other)
    return True
