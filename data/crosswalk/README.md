# data/crosswalk: CPT/HCPCS to ICD-10-PCS mappings

Input to the "Revenue at stake" estimate: for each code Medicare removed from the inpatient-only
list (2026-01-01 and 2027-01-01), how a hospital would report the same operation as an inpatient
(ICD-10-PCS + typical principal diagnosis). A deterministic MS-DRG v44 grouper turns each record
into a DRG family, and national FY2027 payments come from the family. Records hold codes and the
mapper's own words only, never CPT descriptor text.

## Files
- `passes/unmappable.json`: records written by `python3 pipeline/crosswalk/mapper.py unmappable`
  for codes no mapper sees (packaged, no separate outpatient payment; anesthesia codes). Counted
  in both passes.
- `passes/a/<batch-id>.json`, `passes/b/<batch-id>.json`: two independent mapping passes, one
  JSON list of records per mapping batch (`m01` ... `m22`, 40 codes each, in batch order).
  List the batches with `mapper.py batches`; a mapper's brief is `mapper.py batch <id>`.
- `adjudications.json`: one merged file, an object keyed by code; each value is a full record that settles a
  code the passes disagree on. An adjudication always wins.
- `notes/<pass>-<batch-id>.md`: each mapper's working notes for a batch (`a-m01.md`, `b-m01.md`, ...).
- `reviews.json`: de-identified coder reviews (credential, verdict, date, optional display name and profile link), written by
  `python3 pipeline/crosswalk/reviews.py ingest`.
- `resolutions.json`: how each disputed code was resolved, keyed `"code:fp"` to `{decision, by, date}`.
  A tiebreaker may add `by_profile`, an optional https link their name points to on the help-review
  page. It must already be in the normalized form `reviews.clean_profile()` returns (https, at most
  200 characters, no spaces or control characters, no `@`, a real hostname; query and fragment dropped) and needs a `by`.
  `crosswalk/build.py` stops on a bad one; `reviews.resolution_problems(resolutions)` lists them.
- `claims.json`: counts of claimed review batches, written by `reviews.py ingest --claims`.

`mappings.final_mapping(code, passes, adjudications, ref)` picks the record to use: the
adjudication if there is one, else pass A when both passes group to the same DRG families,
otherwise it raises so the disagreement gets adjudicated.

## Record
```json
{"code": "32480", "mappable": true, "unmapped_reason": null,
 "pcs_sets": [{"codes": ["0BTC0ZZ"], "note": "right upper lobe"}],
 "principal_dx": [{"code": "C3411", "condition": "lung cancer", "role": "typical"},
                  {"code": "...", "condition": "...", "role": "alternative"}],
 "rationale": "one line", "confidence": "high"}
```
- `pcs_sets`: alternatives (at most 6). `codes` inside one set are reported together on one claim.
- `principal_dx`: billable ICD-10-CM codes without the dot. Exactly one `typical`; at most one
  `alternative`, only when it changes the DRG family.
- `confidence`: `high`, `medium` or `low`.
- Not mappable: `{"code", "mappable": false, "unmapped_reason"}` and nothing else.

## Checking
`python3 pipeline/crosswalk/mapper.py check <file>` validates every record, checks the file's
codes against its batch (from the file name), prints the DRG family and national payment range
each set x diagnosis groups to, and exits 1 on any error. `mappings.fingerprint(rec)` is a short
hash of the PCS and diagnosis codes, for comparing two passes.
