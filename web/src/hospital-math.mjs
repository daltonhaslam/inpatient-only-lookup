// The Revenue at stake hospital view's math: one hospital's FY 2027 IPPS payment for each MS-DRG
// (wage index, capital GAF, IME, DSH), its CY 2027 OPPS payment, the card's amounts rewritten for it,
// the split by DRG, the per-year table and the summary strip. Pure: no DOM, no fetch.
//
// The formula is pipeline/crosswalk/price.py's (hospital_drg_payment, hospital_outpatient, per_year),
// with the same order of operations so the doubles agree exactly (web/test/hospital-math.test.mjs
// runs price.py to prove it). Rates are crosswalk.json meta.rates, the OPPS labor share is
// hospitals.json meta.opps_labor_share, and a hospital is one hospitals.json record: none retyped here.
//
// Rounding: everything is computed unrounded; each figure returned for display is rounded to the cent
// once, and every sum, gap and per-year value is taken from unrounded parts.
import { num } from './engine.mjs';

const ADDON_FACTORS = ['tchop', 'tchcp', 'dshopp', 'dshcpp'];
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

/** {drg: Table 5 weight} from a normalize()d crosswalk model (the browser model drops weights). */
export function drgWeights(model) {
  const weights = {};
  for (const item of Object.values(model.codes)) {
    for (const family of item.ip ? item.ip.families : []) {
      for (const { drg, weight } of family.drgs) {
        if (drg in weights && weights[drg] !== weight) throw new Error(`MS-DRG ${drg} has two weights: ${weights[drg]} and ${weight}`);
        weights[drg] = weight;
      }
    }
  }
  return weights;
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

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Everything the functions below need for one hospital. hospital: a hospitals.json record (or
 * NATIONAL); volume: that hospital's drg-volume.json entry ({DRG: 2024 discharges}), or undefined when
 * it has none; rates: crosswalk.json meta.rates; weights: drgWeights(); oppsLaborShare:
 * hospitals.json meta.opps_labor_share. Throws on a missing rate rather than drawing NaN.
 */
export function hospitalContext({ hospital, volume, rates, weights, oppsLaborShare }) {
  for (const key of RATES) if (!Number.isFinite(rates[key])) throw new Error(`meta.rates.${key} is missing`);
  if (!Number.isFinite(oppsLaborShare)) throw new Error('the OPPS labor share is missing');
  const paid = new Map();
  const kind = teaching(hospital);
  return {
    hospital,
    teaching: kind,
    addOns: ADDON_FACTORS.some((key) => hospital[key] > 0),
    // MA discharges per traditional one (IME_CASETA44 ÷ CASETA44); only where MA cases carry an add-on.
    maRatio: kind === 'teaching' && count(hospital.ime_caseta44) !== null && hospital.caseta44 > 0 ? hospital.ime_caseta44 / hospital.caseta44 : null,
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

const compares = (item) => item.kind === 'compare' && Boolean(item.ip);
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
  const all = { totals: [], addons: [] };
  const families = item.ip.families.map((family) => {
    const paid = family.drgs.map((d) => ctx.payment(d.drg));
    const totals = range(paid.map((p) => p.total));
    const addons = range(paid.map((p) => p.addons));
    all.totals.push(totals.low, totals.high);
    all.addons.push(addons.low, addons.high);
    return { ...family, ...rounded(totals), addOn: ctx.addOns ? rounded(addons) : null };
  });
  const ip = range(all.totals);
  const out = { ...item, ip: { ...item.ip, ...rounded(ip), families }, addOn: ctx.addOns ? rounded(range(all.addons)) : null };
  if (item.op.rate !== null) {
    const op = ctx.outpatient(item.op.rate);
    out.op = { ...item.op, rate: round2(op), national: item.op.rate };
    out.diff = { low: round2(op - ip.high), high: round2(op - ip.low) };
  }
  return out;
}

/** "The split by DRG": per family, a row per DRG with base, IME, DSH and total (cents). [] with no comparison. */
export function splitRows(item, ctx) {
  if (!ctx || !compares(item)) return [];
  return item.ip.families.map((family) => ({
    name: family.name,
    condition: family.condition,
    rows: family.drgs.map(({ drg }) => {
      const p = ctx.payment(drg);
      const row = { drg, base: round2(p.operating + p.capital) };
      for (const key of ['operating', 'capital', 'imeOperating', 'imeCapital', 'ime', 'dshOperating', 'dshCapital', 'dsh', 'addons', 'total']) row[key] = round2(p[key]);
      return row;
    }),
  }));
}

/** Reasons a count cell is empty, for the view's labels. */
export const EMPTY = {
  suppressed: 'under 11 or none',
  'no-ma-ratio': 'no MA count in CMS’s file',
};

/**
 * The per-year table: one row per DRG in the code's families (each DRG once, in family order; family
 * is the index of the first family it is in), with
 *   trad: {count, suppressed, perCase, perYear}: count is the 2024 traditional Medicare discharges
 *     (null when CMS publishes none: under 11 or none; suppressed says so even after an edit);
 *     add-on per case = IME + DSH.
 *   ma: null unless the hospital is a teaching hospital (operating IME > 0); else {count, estimated,
 *     reason, perCase, perYear}: count = round(traditional × MA ratio) unless typed; add-on per case =
 *     operating IME only (42 CFR 412.105(g); no capital IME or DSH on MA claims). reason is
 *     'no-ma-ratio' when CMS's file has no IME_CASETA44, so there is no estimate.
 * edits: {DRG: {trad, ma}}, the counts someone typed: a number, or null for a cleared cell; anything
 * else reads as empty. An edited traditional count moves the MA estimate with it.
 * total: round(the unrounded sum of every count × per case), or null when no row has a count.
 */
export function perYearTable(item, ctx, edits = {}) {
  if (!ctx || !compares(item)) return { rows: [], total: null };
  const first = new Map();
  item.ip.families.forEach((family, i) => family.drgs.forEach(({ drg }) => { if (!first.has(drg)) first.set(drg, i); }));
  let sum = 0;
  let counted = false;
  const add = (n, perCase) => {
    if (n === null) return null;
    sum += n * perCase;
    counted = true;
    return round2(n * perCase);
  };
  const rows = [...first].map(([drg, family]) => {
    const p = ctx.payment(drg);
    const edit = edits[drg] || {};
    const cms = count(ctx.volume[drg]);
    const trad = edit.trad !== undefined ? count(edit.trad) : cms;
    const row = { drg, family, trad: { count: trad, suppressed: cms === null, perCase: round2(p.addons), perYear: add(trad, p.addons) }, ma: null };
    if (ctx.teaching === 'teaching') {
      const typed = edit.ma !== undefined;
      const ma = typed ? count(edit.ma) : trad !== null && ctx.maRatio !== null ? Math.round(trad * ctx.maRatio) : null;
      row.ma = { count: ma, estimated: !typed && ma !== null, reason: ctx.maRatio === null ? 'no-ma-ratio' : null, perCase: round2(p.imeOperating), perYear: add(ma, p.imeOperating) };
    }
    return row;
  });
  return { rows, total: counted ? round2(sum) : null };
}

/**
 * The fraction of the gap that is add-ons, as a word for the lead sentence ("At <hospital>, <word> of
 * what a removed procedure loses ... is teaching and DSH add-ons"): the nearest of a quarter, a third,
 * half, two thirds and three quarters, with the cutoffs at the midpoints between them (7/24, 5/12,
 * 7/12, 17/24, 7/8); under a fifth is "a small part", from 7/8 "nearly all", and from 1 "all".
 */
const LADDER = [[1, 'all'], [7 / 8, 'nearly all'], [17 / 24, 'about three quarters'], [7 / 12, 'about two thirds'],
  [5 / 12, 'about half'], [7 / 24, 'about a third'], [1 / 5, 'about a quarter'], [-Infinity, 'a small part']];
export function fractionWord(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return LADDER.find(([from]) => ratio >= from)[1];
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
 * (the median of that lowest DRG's IME + DSH), ratio, word, state}. Medians are of unrounded values,
 * rounded once. state: 'addons' (word set), 'no-addons' (the gap is base payment only), 'no-gap' (at the
 * median outpatient pays at least the lowest DRG) or 'empty' (no compared codes). null with no hospital.
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
  if (!gaps.length) return { codes: 0, below: 0, medianGap: null, medianAddOn: null, ratio: null, word: null, state: 'empty' };
  const gap = median(gaps);
  const addOn = median(addOns);
  const state = !ctx.addOns ? 'no-addons' : gap <= 0 ? 'no-gap' : 'addons';
  const ratio = state === 'addons' ? addOn / gap : null;
  return { codes: gaps.length, below, medianGap: round2(gap), medianAddOn: round2(addOn), ratio, word: ratio === null ? null : fractionWord(ratio), state };
}

/** A per-year ceiling in round figures: "$1.1 million", "$61,000", "$9,500", "$480". */
export function roughMoney(n) {
  const step = n >= 10_000 ? 1000 : n >= 1000 ? 100 : 1;
  const r = Math.round(n / step) * step;
  return r >= 1_000_000 ? `$${Number((n / 1_000_000).toFixed(1))} million` : `$${num(r)}`;
}
