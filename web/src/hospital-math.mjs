// The Revenue at stake hospital view's math: one hospital's FY 2027 IPPS payment for each MS-DRG
// (wage index, capital GAF, IME, DSH), its CY 2027 OPPS payment, the card's amounts rewritten for it,
// the split by DRG, the per-year table and the summary strip. Pure: no DOM, no fetch, no wording
// (hospital-words.mjs has that).
//
// The formula is pipeline/crosswalk/price.py's (hospital_drg_payment, hospital_outpatient, per_year),
// with the same order of operations so the doubles agree exactly (web/test/hospital-math.test.mjs
// runs price.py to prove it). hospitals.json meta is the only source of every constant: meta.rates
// (the IPPS rates, which the pipeline copies from crosswalk.json and checks), meta.drg_weights and
// meta.opps_labor_share. A hospital is one hospitals.json record. Nothing is retyped here, and
// nothing here reads crosswalk.json keys (stake-data.mjs is the one place that does).
//
// Rounding: everything is computed unrounded; each figure returned for display is rounded to the cent
// once, and every sum, gap and per-year value is taken from unrounded parts.

// The hospitals.json meta.rates keys drgPayment reads (pipeline/crosswalk/exposure.py HOSPITAL_RATES).
const RATES = ['operating', 'operating_wi_le1', 'capital', 'labor_share', 'labor_share_le1'];

/** No adjustment: what the national figures assume (wage index and GAF 1, no add-ons). price.py NATIONAL. */
export const NATIONAL = Object.freeze({ wi: 1, gaf: 1, tchop: 0, tchcp: 0, dshopp: 0, dshcpp: 0 });

/**
 * x rounded to the cent the way Python's round(x, 2) does, so the browser and the pipeline agree:
 * by the double's exact value, with an exact half cent going to the even cent. toFixed rounds that
 * half up instead, and only a double whose fraction is an odd number of eighths sits exactly on one.
 */
export function round2(x) {
  const a = Math.abs(x);
  let r = Number(a.toFixed(2));
  if (Number.isInteger(a * 8) && !Number.isInteger(a * 4)) {
    const lower = Math.floor(a * 100);
    r = (lower % 2 === 0 ? lower : lower + 1) / 100;
  }
  return x < 0 && r !== 0 ? -r : r;
}

/** "teaching" (operating IME, so MA cases carry an add-on), "capital-only" (capital IME only), or "none". */
export function teaching(hospital) {
  if (hospital.tchop > 0) return 'teaching';
  return hospital.tchcp > 0 ? 'capital-only' : 'none';
}

/**
 * The FY 2027 IPPS payment for an MS-DRG of this weight at a hospital, unrounded:
 * {operating, capital, imeOperating, imeCapital, dshOperating, dshCapital, ime, dsh, addons, total}.
 * Operating base = weight × standardized amount × (labor share × wage index + 1 − labor share), the
 * Table 1A amount and 0.66 share above a wage index of 1, else 1B and 0.62; capital base = weight ×
 * capital rate × GAF; IME and DSH are each base × the hospital's operating and capital factor.
 */
export function drgPayment(weight, hospital, rates) {
  const { wi } = hospital;
  const [standardized, share] = wi > 1 ? [rates.operating, rates.labor_share] : [rates.operating_wi_le1, rates.labor_share_le1];
  const operating = weight * standardized * (share * wi + 1 - share);
  const capital = weight * rates.capital * hospital.gaf;
  const paid = {
    operating, capital,
    imeOperating: operating * hospital.tchop, imeCapital: capital * hospital.tchcp,
    dshOperating: operating * hospital.dshopp, dshCapital: capital * hospital.dshcpp,
  };
  paid.ime = paid.imeOperating + paid.imeCapital;
  paid.dsh = paid.dshOperating + paid.dshCapital;
  paid.addons = paid.ime + paid.dsh;
  paid.total = operating + capital + paid.addons;
  return paid;
}

/** An APC's national rate wage-adjusted for a hospital, unrounded. OPPS pays no IME or DSH. */
export const outpatientRate = (rate, wi, laborShare) => rate * (laborShare * wi + 1 - laborShare);

/**
 * A count of cases: a whole number of zero or more, given as a number or as the digits an input's
 * value holds ("10"). Anything else ("", "2.5", "-1", "1e3", NaN, null) is an empty cell: null.
 */
export function count(value) {
  const n = typeof value === 'string' ? (/^\s*\d+\s*$/.test(value) ? Number(value) : null) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Everything the functions below need for one hospital. hospital: a hospitals.json record (or
 * NATIONAL); volume: that hospital's drg-volume.json entry ({DRG: 2024 discharges}), or undefined when
 * it has none; meta: hospitals.json meta (rates, drg_weights, opps_labor_share). Throws on a missing
 * constant rather than drawing NaN.
 */
export function hospitalContext({ hospital, volume, meta }) {
  const { rates = {}, drg_weights: weights = {}, opps_labor_share: oppsLaborShare } = meta;
  for (const key of RATES) if (!Number.isFinite(rates[key])) throw new Error(`hospitals.json meta.rates.${key} is missing`);
  if (!Number.isFinite(oppsLaborShare)) throw new Error('hospitals.json meta.opps_labor_share is missing');
  const paid = new Map();
  return {
    hospital,
    teaching: teaching(hospital),
    addOns: ['tchop', 'tchcp', 'dshopp', 'dshcpp'].some((key) => hospital[key] > 0),
    // MA discharges per traditional one (IME_CASETA44 ÷ CASETA44); only where MA cases carry an add-on
    // (operating IME, TCHOP > 0: a "teaching" hospital).
    maRatio: hospital.tchop > 0 && Number.isFinite(hospital.ime_caseta44) && hospital.caseta44 > 0 ? hospital.ime_caseta44 / hospital.caseta44 : null,
    volume: volume || {},
    payment(drg) {
      if (!paid.has(drg)) {
        if (!Number.isFinite(weights[drg])) throw new Error(`MS-DRG ${drg} has no weight`);
        paid.set(drg, drgPayment(weights[drg], hospital, rates));
      }
      return paid.get(drg);
    },
    outpatient: (rate) => outpatientRate(rate, hospital.wi, oppsLaborShare),
  };
}

const compares = (item) => item.kind === 'compare';
const range = (values) => ({ low: Math.min(...values), high: Math.max(...values) });
const rounded = ({ low, high }) => ({ low: round2(low), high: round2(high) });

/**
 * The item card() draws, with this hospital's amounts: each family's range, the overall range, the
 * outpatient rate (wage-adjusted; op.national keeps the national rate) and the difference. Added:
 * addOn {low, high} on the item and on each family, the IME + DSH inside the inpatient amounts, or
 * null when the hospital has no add-ons. The ASC amount stays national (ASC wage rules differ). With
 * no hospital, or for a code with no comparison (packaged, anesthesia, unmapped, pending), the item
 * comes back unchanged: the same object.
 */
export function hospitalItem(item, ctx) {
  if (!ctx || !compares(item)) return item;
  const paidBy = item.ip.families.map((family) => family.drgs.map((d) => ctx.payment(d.drg)));
  const addOn = (paid) => (ctx.addOns ? rounded(range(paid.map((p) => p.addons))) : null);
  const families = item.ip.families.map((family, i) => ({ ...family, ...rounded(range(paidBy[i].map((p) => p.total))), addOn: addOn(paidBy[i]) }));
  const all = paidBy.flat();
  const ip = range(all.map((p) => p.total));
  const out = { ...item, ip: { ...item.ip, ...rounded(ip), families }, addOn: addOn(all) };
  if (item.op.rate !== null) {
    const op = ctx.outpatient(item.op.rate);
    out.op = { ...item.op, rate: round2(op), national: item.op.rate };
    out.diff = { low: round2(op - ip.high), high: round2(op - ip.low) };
  }
  return out;
}

/**
 * "The split by DRG": per family, a row per DRG with every drgPayment() figure and base (operating +
 * capital), each rounded to the cent. [] with no comparison.
 */
export function splitRows(item, ctx) {
  if (!ctx || !compares(item)) return [];
  return item.ip.families.map((family) => ({
    name: family.name,
    condition: family.condition,
    rows: family.drgs.map(({ drg }) => {
      const p = ctx.payment(drg);
      const row = { drg, base: round2(p.operating + p.capital) };
      for (const [key, value] of Object.entries(p)) row[key] = round2(value);
      return row;
    }),
  }));
}

/** A typed count's kind (see perYearTable's source): 'typed', 'cleared' or 'invalid'; null when not typed. */
const typedSource = (raw) => {
  if (raw === undefined) return null;
  if (count(raw) !== null) return 'typed';
  return String(raw).trim() === '' ? 'cleared' : 'invalid';
};

/**
 * The per-year table: one row per DRG in the code's families (each DRG once, in family order; family
 * is the index of the first family it is in), with
 *   trad: {count, suppressed, source, perCase, perYear}: count is the 2024 traditional Medicare
 *     discharges (null when CMS publishes none: under 11 or none; suppressed says so even after an
 *     edit); add-on per case = IME + DSH.
 *   ma: null unless the hospital is a teaching hospital (operating IME > 0); else {count, estimated,
 *     reason, source, perCase, perYear}: count = round(traditional × MA ratio) unless typed; add-on per
 *     case = operating IME only (42 CFR 412.105(g); no capital IME or DSH on MA claims). reason is set
 *     only when the count is null and was not typed: 'no-ma-ratio' when CMS's file has no IME_CASETA44
 *     (no estimate), else 'suppressed' when CMS published no traditional count to scale; else null.
 *   source: where the cell's count came from, the one classification the folds and the hospital CSV
 *     each word their own way: a typed box is 'typed' (a whole number), 'cleared' (empty) or 'invalid'
 *     (anything else: no count); else 'cms' (traditional, as published), 'estimate' (MA, with a count),
 *     'unscaled' (MA: the reader's traditional count it scales is cleared or invalid), or 'none' (CMS
 *     published nothing to count or scale: suppressed, or the MA reason).
 * edits: {DRG: {trad, ma}}, the counts someone typed (see count(): a whole number or its digits; ""
 * or anything else is a cleared cell). An edited traditional count moves the MA estimate with it.
 * total: round(the unrounded sum of every count × per case), or null when no row has a count.
 */
export function perYearTable(item, ctx, edits = {}) {
  if (!ctx || !compares(item)) return { rows: [], total: null };
  const first = new Map();
  item.ip.families.forEach((family, i) => family.drgs.forEach(({ drg }) => { if (!first.has(drg)) first.set(drg, i); }));
  let sum = null;
  const add = (n, perCase) => {
    if (n === null) return null;
    sum = (sum ?? 0) + n * perCase;
    return round2(n * perCase);
  };
  const rows = [...first].map(([drg, family]) => {
    const p = ctx.payment(drg);
    const edit = edits[drg] || {};
    const cms = count(ctx.volume[drg]);
    const trad = edit.trad !== undefined ? count(edit.trad) : cms;
    const tradSource = typedSource(edit.trad) ?? (cms === null ? 'none' : 'cms');
    const row = { drg, family, trad: { count: trad, suppressed: cms === null, source: tradSource, perCase: round2(p.addons), perYear: add(trad, p.addons) }, ma: null };
    if (ctx.teaching === 'teaching') {
      const typed = edit.ma !== undefined;
      const ma = typed ? count(edit.ma) : trad !== null && ctx.maRatio !== null ? Math.round(trad * ctx.maRatio) : null;
      // Why an untyped MA cell is empty: no ratio to estimate with, or no traditional count to scale.
      const reason = ma !== null || typed ? null : ctx.maRatio === null ? 'no-ma-ratio' : cms === null ? 'suppressed' : null;
      const source = typedSource(edit.ma) ?? (ma !== null ? 'estimate' : reason ? 'none' : 'unscaled');
      row.ma = { count: ma, estimated: source === 'estimate', reason, source, perCase: round2(p.imeOperating), perYear: add(ma, p.imeOperating) };
    }
    return row;
  });
  return { rows, total: sum === null ? null : round2(sum) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The summary strip over the compared codes in items (others are skipped). For each code, the gap is
 * the lowest DRG's payment less the outpatient payment (positive = outpatient pays less); for a code
 * with several families, the lowest DRG across all of them, so the gap is never overstated.
 * {codes, below (codes where outpatient pays less than even the lowest DRG), medianGap, medianAddOn
 * (the median of that lowest DRG's IME + DSH), ratio (median add-on ÷ median gap, unrounded), state}.
 * Medians are of unrounded values, rounded once. state: 'no-gap' (at the median outpatient pays at
 * least the lowest DRG; checked first), 'no-addons' (the gap is base payment only), 'addons' (ratio
 * set) or 'empty' (no compared codes). null with no hospital.
 */
export function summary(items, ctx) {
  if (!ctx) return null;
  const gaps = [];
  const addOns = [];
  let below = 0;
  for (const item of items) {
    if (!compares(item) || item.op.rate === null) continue;
    const lowest = item.ip.families.flatMap((f) => f.drgs.map((d) => ctx.payment(d.drg))).reduce((a, b) => (b.total < a.total ? b : a));
    const op = ctx.outpatient(item.op.rate);
    gaps.push(lowest.total - op);
    addOns.push(lowest.addons);
    if (op < lowest.total) below += 1;
  }
  if (!gaps.length) return { codes: 0, below: 0, medianGap: null, medianAddOn: null, ratio: null, state: 'empty' };
  const gap = median(gaps);
  const addOn = median(addOns);
  // No gap first: a hospital with no add-ons and no loss at the median has no gap to explain.
  const state = gap <= 0 ? 'no-gap' : !ctx.addOns ? 'no-addons' : 'addons';
  return { codes: gaps.length, below, medianGap: round2(gap), medianAddOn: round2(addOn), ratio: state === 'addons' ? addOn / gap : null, state };
}
