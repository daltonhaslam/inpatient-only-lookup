# Inpatient Only Lookup

**Was a procedure on Medicare's inpatient-only list on a given date of service?**

Enter a CPT or HCPCS code, or search by procedure, and pick a date. The site says whether the code was inpatient
only that day, when it left the list, whether it came back, and whether it is exempt from certain medical review,
with the Federal Register page or CMS file behind each fact.

Live site: **https://inpatient-only-lookup.vercel.app**

## Why it exists

CMS is eliminating the inpatient-only list in three phases (2026, 2027, 2028), with the list gone by January 1,
2029. It tried once before: 298 codes came off in 2021 and 293 went back on in 2022. So "is this code inpatient
only?" has no answer without a date. CMS publishes the full list once a year (Addendum E) and the status of every
code each quarter (Addendum B), but nothing joins them into a history. This does.

The site stays useful after the list ends. Audits and appeals turn on what was true on the date of service, and
the medical-review exemption for removed procedures runs on, code by code, until CMS ends it.

## What it covers

- **Dates of service from January 1, 2020** through the end of the newest final rule's year, by quarter. Annual
  history back to 2017.
- **1,861 codes** that have been on the list at some point since 2017, each with its own page, plus a plain answer
  ("never on the list since 2017") for every other code in CMS's files.
- **The medical-review exemption** under 42 CFR 412.3(d)(2), by removal date and date of service.
- **The phase-out schedule**, year-by-year history, and a reconciliation against the counts CMS states in each rule.

## How it works

The test is CMS's own: status indicator **C** in OPPS Addendum B means inpatient only.

```
pipeline/sources.json     every CMS and Federal Register file used, pinned by SHA-256
pipeline/fetch.py         downloads them to data/raw/ (not in the repo)
pipeline/build.py         parses them, builds each code's dated history, and reconciles it
pipeline/derived/         the result: small JSON tables, committed
pipeline/rules.json       facts about each final rule: citations, stated counts, printed code lists
pipeline/citations.json   157 passages quoted from the Federal Register, each checked against its page
data/labels.json          this project's own plain-language procedure labels
web/                      the static site, generated from the tables above
```

`build.py` fails, and leaves the published tables alone, unless every check passes
(`pipeline/out/checks.txt`):

- each file's spreadsheet and text copy agree;
- each year's Addendum E equals status C in the same rule's Addendum B and in January's quarterly file;
- CMS's removal files (298 codes for 2021, 637 for 2027) equal the computed removals;
- counts stated in the rules (298, 285, 637, 1,740, 1,731, 1,438) equal the computed counts;
- code lists printed in the Federal Register for 2020 through 2026 equal the computed changes, with each
  difference explained in `rules.json` and on the site's Methods page;
- every quoted passage appears on the page it cites.

## Refreshing

CMS posts a new Addendum B each quarter and a final rule each November.

```bash
python3 pipeline/refresh.py --dry-run   # what has CMS posted or replaced?
python3 pipeline/refresh.py             # fetch it, rebuild, reconcile, test
cd web && npm ci && npm run build && npm test
```

`refresh.py` finds new quarterly files, corrections, and the next final rule's files on cms.gov, checks that each
download is the table it claims to be, notices files CMS has replaced in place, and then rebuilds and re-runs
every check. It ends by listing what still needs a person: a new rule's Federal Register facts in `rules.json`,
the page copy for that year, labels for new codes, and, as each comes due, the Revenue at stake sources it does not
discover (the impact file each October, the MUP file each spring, the deductibles and the ASC additions each
November; see below). Pushing to `main` deploys.

## Building from a clone

The site builds from the committed tables alone:

```bash
cd web && npm ci && npm run build      # writes ../docs
npm run serve                          # http://127.0.0.1:4173
npm test                               # unit tests, output checks, browser tests
```

`BASE_URL=https://… node e2e/smoke.mjs` runs the browser checks against a deployed copy.

To rebuild the tables from CMS's files (about 100 MB, downloaded on first run):

```bash
python3 pipeline/fetch.py && python3 pipeline/build.py && python3 pipeline/run_tests.py
```

Python 3.9+ with the standard library only; Node 20+.

## Revenue at stake

For the 922 codes removed from the inpatient-only list in 2026 and 2027, the site sets CY 2027 outpatient payment
(APC, and ASC where CMS lists one) next to the FY 2027 inpatient MS-DRG family range. By default figures are national
and unadjusted: no wage index, IME, DSH or outlier. It is an estimate of revenue at stake, not a forecast. It is not a
reason to keep a case inpatient. Status decisions stay clinical, under the two-midnight rule.

**At your hospital.** A picker on `/revenue-at-stake/` applies one IPPS hospital's FY 2027 wage index, capital GAF,
IME and DSH (operating and capital) to every card, in the browser. A summary says how much of the typical loss is
teaching and DSH add-ons. Each card gains the split by DRG and a per-year ceiling built from the hospital's 2024
traditional Medicare discharges, plus estimated Medicare Advantage cases (operating IME only). Counts can be edited
on the page and are never saved. Uncompensated care, outliers, quality programs, SCH/MDH hospital-specific rates and
direct GME are left out, each with its reason on the Methods page. Maryland hospitals are not offered: they are paid
under the state's all-payer model. The national page loads nothing extra; the hospital list and each hospital's
small file load on first use. The URL carries the hospital (`?h=<CCN>`) only after a pick.

**Patient's share.** The code page of each compared code, and the lookup answer for the codes CMS adds to the ASC
list for 2027 (618 IPO removals plus 64629), show the national patient's share where the code has a separate ASC
payment: 20% of the ASC rate, and the hospital outpatient copayment capped at the Part A inpatient deductible, plus
the Part B deductible. The deductibles
live in `pipeline/facts.json`, with CMS's fact sheet.

How it is built:

- **Mapping.** Two independent AI passes each map every code to ICD-10-PCS codes plus a typical principal
  diagnosis. A third pass adjudicates where they disagree.
- **Grouping.** A partial MS-DRG v44 grouper turns each mapping into a DRG family. It covers surgical families,
  procedure clusters, and the unrelated, any-OR and medical fallbacks, and is built from CMS's definitions text.
- **Pricing.** FY 2027 Table 5 weight x ($6,848.00 operating + $539.95 capital). The result is a low to high range
  across the family, because CC/MCC severity is not known. At a hospital, the same weight with its factors from the
  FY 2027 IPPS impact file (`web/src/hospital-math.mjs`, the same formula as `pipeline/crosswalk/price.py`).
- **Checks.** The build fails closed unless every check passes. Results are written to
  `pipeline/out/crosswalk-checks.txt`.

The mappings were made with Claude Code and are under review by credentialed coders. Treat each as an estimate
until its review status says otherwise.

Files:

```
pipeline/crosswalk/               mapper, grouper, pricing, checks, workbook, review ingest
data/crosswalk/                   the mappings, adjudications and review log (see its README)
pipeline/derived/crosswalk.json   the result, one entry per code
pipeline/derived/crosswalk.xlsx   the same, with amounts as live formulas over an Inputs tab (a CCN cell picks a
                                  hospital) plus Hospitals and Per year tabs
pipeline/derived/hospitals.json   each IPPS hospital's factors from the FY 2027 impact file, and the DRG weights
pipeline/derived/drg-volume.json  2024 traditional Medicare discharges by hospital and MS-DRG (MUP, the DRGs used)
pipeline/derived/patient-shares.json  the national patient's share at an ASC and a hospital outpatient department
pipeline/derived/asc-new-2027.json    CMS's 2027 additions to the ASC covered procedures list
pipeline/facts.json               hand-kept figures no data file carries (deductibles, the 618), with sources
```

The four derived tables are written by the same `build.py` run, only when their checks pass (hospital count,
teaching count, the OHSU anchors to the cent, every volume DRG in Table 5, the 618, every patient share recomputed).
They have their own gate: `crosswalk.json` is written when the crosswalk checks pass, even if a table check fails
(a stale impact-file pin each October, a missing raw file). When the crosswalk fails, the tables are not built.
`crosswalk.xlsx` needs both: when a table check fails it is not built and a previous one is removed, so the site
ships no Excel download rather than one that disagrees with `crosswalk.json`. The checks report says which gate failed.
Downloads: `revenue-at-stake.xlsx`, `revenue-at-stake.csv` (national, with the patient's share columns), and after a
pick, a hospital CSV built in the browser (`revenue-at-stake-<CCN>.csv`).

Site pages: `/revenue-at-stake/` (search and filter), `/help-review/` (how to review a mapping), `/methods/`.

### Refreshing the estimate

- **Each October** (new FY weights and grouper): update the pinned sources, including the new FY's IPPS impact file
  (correction-notice version), rebuild, re-run the checks, and look at every family that changed.
- **Each November** (the OPPS/ASC final rule and CMS's deductibles notice): update the deductibles in
  `pipeline/facts.json` and pin the next year's ASC additions list.
- **Each January** (new APC rates, next year's removals): map the new codes with `mapper.py`, two passes, then
  adjudicate.
- **Each spring:** pin CMS's next Medicare Inpatient Hospitals by Provider and Service file for the per-year counts.
- **Each quarter:** `refresh.py` picks up Addendum B; check the quarterly OPPS and ASC updates against the rule's
  rates. `refresh.py` lists every one of these when it comes due.

```bash
python3 pipeline/crosswalk/build.py                  # assemble, check, write crosswalk.json and .xlsx
python3 pipeline/crosswalk/mapper.py batches         # list mapping batches
python3 pipeline/crosswalk/mapper.py batch m01       # a mapper's brief for one batch
python3 pipeline/crosswalk/mapper.py check data/crosswalk/passes/a/m01.json
```

`pipeline/crosswalk/verify_workbook.py` recomputes the workbook with an independent evaluator: the national
amounts against `crosswalk.json` to the cent, your own wage index, OHSU (CCN 380009) against the anchors in
`facts.json` including a per-year row, a hospital with no add-ons, and a Maryland CCN. The five evaluations run in parallel, about
a minute in all. Make the virtual environment outside the repository (nothing ignores it here):

```bash
python3 -m venv ~/.venvs/iol-verify && ~/.venvs/iol-verify/bin/pip install formulas openpyxl
~/.venvs/iol-verify/bin/python pipeline/crosswalk/verify_workbook.py
```

### Review loop

Responses to the review forms are private (Google Forms). Export the tabs as CSV, then:

```bash
python3 pipeline/crosswalk/reviews.py ingest agree.csv wrong.csv [--claims claims.csv] [--drop-reasons]
python3 pipeline/crosswalk/build.py
```

`ingest` writes de-identified rows (credential, verdict, date, optional display name) to
`data/crosswalk/reviews.json`, shows what it will write, and waits for a yes. Emails and free text from
agreements are never kept. Dispute reasons are cut and dropped if they look like PHI.

### Known limits

- The grouper is partial. Not modelled: the CC/MCC severity choice (shown as a range), MDC 14 Appendix E
  obstetric logic, and non-OR procedures that qualify a surgical DRG.
- Hip and knee revisions group to 463-465 in v44.
- No long CPT descriptors were available to the mappers, so the two passes are not fully independent.

## CPT content

CPT descriptors belong to the American Medical Association and are not in this repository or on the site. CMS's
downloads carry them, so `data/raw/` is never committed. Procedure labels are original plain-language wording,
reviewed code by code, and a test fails if any label repeats a CMS or AMA descriptor. They help you find a code;
they are not a substitute for the descriptor. CPT is a registered trademark of the American Medical Association.

## Not advice

This is not billing or legal advice, and it is not affiliated with or endorsed by CMS or the AMA. Off the list
does not mean an inpatient admission is payable: the two-midnight rule still applies. Check CMS's own files before
relying on an answer.

## Feedback

Corrections are welcome through the form linked in the site's footer.

Built by [Dalton Haslam, MD, MBA](https://www.linkedin.com/in/dalton-haslam), using Claude Code. MIT license. Part
of [Paid & Penalized](https://paidandpenalized.org).
