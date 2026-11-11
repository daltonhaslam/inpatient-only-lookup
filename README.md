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
the page copy for that year, and labels for new codes. Pushing to `main` deploys.

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
