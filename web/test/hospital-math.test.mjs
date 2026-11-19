// The hospital view's math: pure, against the real derived tables (crosswalk.json, hospitals.json,
// drg-volume.json), so these tests prove the pipeline + math chain, not hand-typed factors.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientModel } from '../src/stake-data.mjs';
import { read, hospitals, model } from './hospital-fixture.mjs';
import { prepare } from '../src/stake-engine.mjs';
import {
  NATIONAL, round2, teaching, count, drgPayment, outpatientRate, hospitalContext, hospitalItem,
  splitRows, perYearTable, summary,
} from '../src/hospital-math.mjs';
import { fractionWord } from '../src/hospital-words.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crosswalk = read('pipeline/derived/crosswalk.json');
const { volume } = read('pipeline/derived/drg-volume.json');
const { items, byCode } = prepare(clientModel(model, []));   // exactly what the browser draws cards from
// The hospital view's only constants: hospitals.json meta (rates, DRG weights, OPPS labor share).
const env = { meta: hospitals.meta };
const { rates: RATES, drg_weights: WEIGHTS, opps_labor_share: LABOR } = hospitals.meta;
const at = (ccn) => hospitalContext({ ...env, hospital: hospitals.hospitals[ccn], volume: volume[ccn] });

const OHSU = '380009';
const ohsu = at(OHSU);
const compared = items.filter((item) => item.kind === 'compare');
const noCompare = items.filter((item) => item.kind !== 'compare');
const factors = (h) => Object.values(h).filter((v) => typeof v === 'number');
const NO_ADDONS = Object.keys(hospitals.hospitals).find((ccn) => volume[ccn] && ['tchop', 'tchcp', 'dshopp', 'dshcpp'].every((k) => hospitals.hospitals[ccn][k] === 0));
const CAPITAL_ONLY = Object.keys(hospitals.hospitals).find((ccn) => hospitals.hospitals[ccn].tchop === 0 && hospitals.hospitals[ccn].tchcp > 0);
const NO_MA_RATIO = Object.keys(hospitals.hospitals).find((ccn) => hospitals.hospitals[ccn].tchop > 0 && hospitals.hospitals[ccn].ime_caseta44 === null);
const LOW_WAGE = Object.keys(hospitals.hospitals).find((ccn) => hospitals.hospitals[ccn].wi < 1 && hospitals.hospitals[ccn].tchop > 0 && hospitals.hospitals[ccn].dshopp > 0);

/** Every number reachable from value is finite (no NaN or Infinity hiding in a nested field). */
function assertFinite(value, path = 'value') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
}

describe('correctness anchors (OHSU 380009, from the derived tables)', () => {
  const item = hospitalItem(byCode['32480'], ohsu);
  const [family] = item.ip.families;
  const rows = splitRows(byCode['32480'], ohsu)[0].rows;
  const row = (drg) => rows.find((r) => r.drg === drg);

  test('DRG 165: total $22,116.60, IME + DSH $6,067.07, operating IME $4,632.08', () => {
    assert.equal(row('165').total, 22116.60);
    assert.equal(row('165').addons, 6067.07);
    assert.equal(row('165').imeOperating, 4632.08);
    assert.equal(family.low, 22116.60);
  });
  test('DRG 163: total $51,459.44, add-ons $14,116.45', () => {
    assert.equal(row('163').total, 51459.44);
    assert.equal(row('163').addons, 14116.45);
    assert.equal(family.high, 51459.44);
    assert.deepEqual(item.addOn, { low: 6067.07, high: 14116.45 });
    assert.deepEqual(family.addOn, { low: 6067.07, high: 14116.45 });
  });
  test('APC 5183 ($3,584.95) at OHSU is $3,995.14; the ASC amount stays national', () => {
    assert.equal(byCode['32480'].op.rate, 3584.95);
    assert.equal(item.op.rate, 3995.14);
    assert.equal(item.op.national, 3584.95);
    assert.equal(item.op.asc, byCode['32480'].op.asc);
  });
  test('the gap is from unrounded amounts: outpatient less each end of the family', () => {
    assert.equal(item.ip.low, 22116.60);
    assert.equal(item.ip.high, 51459.44);
    assert.deepEqual(item.diff, { low: round2(outpatientRate(3584.95, 1.1907, 0.6) - drgPayment(4.4892, hospitals.hospitals[OHSU], RATES).total), high: -18121.46 });
    assert.equal(item.diff.low, -47464.30);
  });
  test('per year: 10 traditional cases of DRG 165 is $60,670.69 (not 10 × $6,067.07)', () => {
    const table = perYearTable(byCode['32480'], ohsu, { 165: { trad: 10 } });
    const r = table.rows.find((x) => x.drg === '165');
    assert.equal(r.trad.perYear, 60670.69);
    assert.equal(r.trad.perCase, 6067.07);
  });
  test('the input item is not changed', () => {
    assert.equal(byCode['32480'].ip.families[0].low, 14254.31);
    assert.equal(byCode['32480'].op.rate, 3584.95);
  });
});

describe('JS agrees with the Python reference (price.py), exactly, for every DRG and APC rate the crosswalk uses', () => {
  const weights = Object.entries(WEIGHTS).sort();
  const rates = [...new Set(compared.map((item) => item.op.rate))].sort((a, b) => a - b);
  const ccns = [OHSU, LOW_WAGE, NO_ADDONS, CAPITAL_ONLY];
  const years = weights.map(([, w], i) => [i % 97 + 1, w]);
  let reference = null;
  try {
    reference = JSON.parse(execFileSync('python3', ['-I', join(here, 'hospital-reference.py')], {
      input: JSON.stringify({ rates: RATES, opps_labor_share: LABOR, hospitals: ccns.map((c) => hospitals.hospitals[c]), weights: weights.map(([, w]) => w), apc: rates, years }),
      maxBuffer: 64 * 1024 * 1024,
    }).toString());
  } catch (error) {
    reference = error;
  }
  const KEYS = { operating: 'operating', capital: 'capital', imeOperating: 'ime_operating', imeCapital: 'ime_capital', dshOperating: 'dsh_operating', dshCapital: 'dsh_capital', ime: 'ime', dsh: 'dsh', addons: 'addons', total: 'total' };

  test('the reference ran', { skip: reference instanceof Error && reference.code === 'ENOENT' ? 'python3 not found' : false }, () => {
    assert.ok(Array.isArray(reference), String(reference));
    assert.equal(weights.length, 282);
    assert.ok(rates.length > 30, `${rates.length} APC rates`);
  });
  ccns.forEach((ccn, h) => {
    test(`hospital ${ccn}: every component, outpatient rate and per-year value`, { skip: !Array.isArray(reference) }, () => {
      const hospital = hospitals.hospitals[ccn];
      const ref = reference[h];
      weights.forEach(([drg, w], i) => {
        const paid = drgPayment(w, hospital, RATES);
        for (const [js, py] of Object.entries(KEYS)) {
          assert.equal(paid[js], ref.drgs[i][py], `${ccn} DRG ${drg} ${js}`);
          assert.equal(round2(paid[js]), ref.drgs_cents[i][py], `${ccn} DRG ${drg} ${js} cents`);
        }
      });
      rates.forEach((rate, i) => {
        assert.equal(outpatientRate(rate, hospital.wi, LABOR), ref.outpatient[i], `${ccn} APC rate ${rate}`);
        assert.equal(round2(ref.outpatient[i]), ref.outpatient_cents[i]);
      });
      const ctx = at(ccn);
      years.forEach(([count], i) => {
        const [drg] = weights[i];
        const item = { kind: 'compare', ip: { families: [{ drgs: [{ drg }] }] } };
        const table = perYearTable(item, ctx, { [drg]: { trad: count } });
        assert.equal(table.rows[0].trad.perYear, ref.years[i], `${ccn} DRG ${drg} × ${count}`);
      });
    });
  });
});

describe('national mode: no drift, by even a cent, on any item (Review Focus 5)', () => {
  const national = hospitalContext({ ...env, hospital: NATIONAL, volume: undefined });

  test('no hospital: every item comes back as the same object', () => {
    for (const item of items) assert.equal(hospitalItem(item, null), item, item.code);
  });
  test('national factors (wage index 1, GAF 1, no add-ons) reproduce every DRG amount, range, rate and difference', () => {
    let drgRows = 0;
    for (const item of compared) {
      const out = hospitalItem(item, national);
      assert.equal(out.op.rate, item.op.rate, `${item.code} outpatient`);
      assert.deepEqual(out.diff, item.diff, `${item.code} difference`);
      assert.equal(out.ip.low, item.ip.low, `${item.code} low`);
      assert.equal(out.ip.high, item.ip.high, `${item.code} high`);
      assert.equal(out.addOn, null);
      out.ip.families.forEach((f, i) => {
        assert.equal(f.low, item.ip.families[i].low, `${item.code} family ${i} low`);
        assert.equal(f.high, item.ip.families[i].high, `${item.code} family ${i} high`);
        assert.equal(f.addOn, null);
      });
      const full = model.codes[item.code].ip.families;
      splitRows(item, national).forEach((family, i) => family.rows.forEach((row, j) => {
        assert.equal(row.total, full[i].drgs[j].amount, `${item.code} DRG ${row.drg}`);
        drgRows += 1;
      }));
    }
    assert.equal(compared.length, 849);
    assert.ok(drgRows > 2800, `${drgRows} DRG rows`);
  });
  test('hospitals.json meta.drg_weights: every crosswalk DRG row has its weight, and weight × the combined rate is the national amount', () => {
    assert.equal(Object.keys(WEIGHTS).length, 282);
    for (const item of Object.values(model.codes)) for (const f of item.ip ? item.ip.families : []) for (const d of f.drgs) {
      assert.equal(WEIGHTS[d.drg], d.weight, `DRG ${d.drg} weight`);
      assert.equal(round2(d.weight * crosswalk.meta.rates.combined), d.amount, `DRG ${d.drg}`);
    }
  });
  test('a DRG with no weight throws rather than drawing NaN', () => {
    const ctx = hospitalContext({ meta: { ...hospitals.meta, drg_weights: {} }, hospital: hospitals.hospitals[OHSU], volume: undefined });
    assert.throws(() => hospitalItem(byCode['32480'], ctx), /MS-DRG 16\d has no weight/);
  });
  test('hospitals.json meta.rates is the five crosswalk.json rates the formula reads, and a missing one throws', () => {
    assert.deepEqual(RATES, Object.fromEntries(Object.keys(RATES).map((key) => [key, crosswalk.meta.rates[key]])));
    assert.deepEqual(Object.keys(RATES).sort(), ['capital', 'labor_share', 'labor_share_le1', 'operating', 'operating_wi_le1']);
    const { labor_share: _drop, ...short } = RATES;
    assert.throws(() => hospitalContext({ meta: { ...hospitals.meta, rates: short }, hospital: NATIONAL }), /meta\.rates\.labor_share is missing/);
    assert.throws(() => hospitalContext({ meta: { ...hospitals.meta, opps_labor_share: undefined }, hospital: NATIONAL }), /opps_labor_share/);
    // The formula reads every rate the shipped meta carries: dropping any one of them throws.
    for (const key of Object.keys(RATES)) {
      const { [key]: _gone, ...rest } = RATES;
      assert.throws(() => hospitalContext({ meta: { ...hospitals.meta, rates: rest }, hospital: NATIONAL }), new RegExp(`meta\\.rates\\.${key} is missing`), key);
    }
  });
  test('NATIONAL has exactly price.py\'s payment factors, and the shipped meta names a column for each', () => {
    const factors = JSON.parse(execFileSync('python3', ['-I', '-c', 'import json, sys; sys.path.insert(0, sys.argv[1]); from crosswalk.price import PAYMENT_FACTORS; print(json.dumps(PAYMENT_FACTORS))',
      join(here, '../../pipeline')], { encoding: 'utf8' }));
    assert.deepEqual(Object.keys(NATIONAL).sort(), [...factors].sort());
    for (const key of factors) assert.ok(hospitals.meta.columns[key], `hospitals.json meta.columns.${key}`);
  });
});

describe('a hospital with no IME and no DSH (Review Focus 1)', () => {
  const ctx = at(NO_ADDONS);
  test('the context and the item say "no add-ons" as a state, never $0–$0', () => {
    assert.ok(NO_ADDONS);
    assert.equal(ctx.addOns, false);
    assert.equal(ctx.teaching, 'none');
    for (const item of compared.slice(0, 100)) {
      const out = hospitalItem(item, ctx);
      assert.equal(out.addOn, null);
      for (const f of out.ip.families) assert.equal(f.addOn, null);
      assertFinite(out);
    }
  });
  test('the summary says no add-ons, with the gap as base payment only, and no NaN', () => {
    const s = summary(compared, ctx);
    assert.equal(s.state, 'no-addons');
    assert.equal(s.ratio, null);
    assert.equal(s.medianAddOn, 0);
    assert.ok(s.medianGap > 0);
    assertFinite(s);
  });
  test('no add-ons and no gap at the median: "no-gap", not "the gap is base payment only"', () => {
    const paidMore = compared.slice(0, 9).map((item) => ({ ...item, op: { ...item.op, rate: 1e6 } }));   // outpatient above every DRG
    const s = summary(paidMore, ctx);
    assert.ok(s.medianGap <= 0, `${s.medianGap}`);
    assert.deepEqual([s.state, s.ratio], ['no-gap', null]);
  });
  test('per year: no MA row, $0 add-ons, totals still numbers', () => {
    const table = perYearTable(byCode['32480'], ctx);
    for (const row of table.rows) {
      assert.equal(row.ma, null);
      assert.equal(row.trad.perCase, 0);
    }
    assertFinite(table);
  });
});

describe('suppressed or missing DRG volume (Review Focus 3)', () => {
  test('OHSU 2024 counts prefill: 163/164/165 are 15/34/11', () => {
    const table = perYearTable(byCode['32480'], ohsu);
    assert.deepEqual(table.rows.map((r) => [r.drg, r.trad.count, r.trad.suppressed]), [['163', 15, false], ['164', 34, false], ['165', 11, false]]);
  });
  test('one DRG with no count reads as suppressed, is null, stays editable, and the total still works', () => {
    const ctx = hospitalContext({ ...env, hospital: hospitals.hospitals[OHSU], volume: { 163: 15, 164: 34 } });
    const table = perYearTable(byCode['32480'], ctx);
    const r165 = table.rows.find((r) => r.drg === '165');
    assert.deepEqual([r165.trad.count, r165.trad.suppressed, r165.trad.perYear, r165.ma.count, r165.ma.perYear], [null, true, null, null, null]);
    assert.equal(r165.ma.reason, 'suppressed');   // the MA cell says why it is empty too
    assert.equal(table.rows[0].ma.reason, null);   // an estimated MA count carries no reason
    assert.ok(table.total > 0);
    const edited = perYearTable(byCode['32480'], ctx, { 165: { trad: 10 } });
    const e165 = edited.rows.find((r) => r.drg === '165');
    assert.equal(e165.trad.perYear, 60670.69);
    assert.equal(e165.trad.suppressed, true);     // still labeled as CMS had no count
    assert.ok(edited.total > table.total);
  });
  test('the whole family missing (a hospital with no 2024 entry): every count null, total null, edits still total', () => {
    const ctx = hospitalContext({ ...env, hospital: hospitals.hospitals[OHSU], volume: undefined });
    const table = perYearTable(byCode['32480'], ctx);
    assert.ok(table.rows.every((r) => r.trad.count === null && r.trad.suppressed && r.ma.count === null));
    assert.equal(table.total, null);
    assertFinite(table);
    const edited = perYearTable(byCode['32480'], ctx, { 165: { trad: 10 } });
    assert.equal(edited.total, round2(10 * drgPayment(WEIGHTS['165'], hospitals.hospitals[OHSU], RATES).addons
      + Math.round(10 * hospitals.hospitals[OHSU].ime_caseta44 / hospitals.hospitals[OHSU].caseta44) * drgPayment(WEIGHTS['165'], hospitals.hospitals[OHSU], RATES).imeOperating));
  });
  test('bad edits (negative, NaN, fractions, text, blank) read as an empty cell, never NaN', () => {
    const table = perYearTable(byCode['32480'], ohsu, { 163: { trad: -1, ma: NaN }, 164: { trad: 2.5 }, 165: { trad: null } });
    assert.deepEqual(table.rows.map((r) => r.trad.count), [null, null, null]);
    assertFinite(table);
  });
  test('typed counts arrive as input strings: "10" is 10; "2.5", "", "-1", "1e3", "0x10", "ten" are empty', () => {
    assert.equal(count('10'), 10);
    assert.equal(count(' 7 '), 7);
    assert.equal(count('0'), 0);
    for (const bad of ['2.5', '', '  ', '-1', '1e3', '0x10', 'ten', 2.5, -1, NaN, Infinity, null, undefined, {}]) assert.equal(count(bad), null, String(bad));
    const table = perYearTable(byCode['32480'], ohsu, { 163: { trad: '10', ma: '' }, 164: { trad: '2.5' } });
    assert.deepEqual(table.rows.slice(0, 2).map((r) => [r.trad.count, r.ma.count]), [[10, null], [null, null]]);
    assert.equal(table.rows[0].trad.perYear, round2(10 * drgPayment(WEIGHTS['163'], hospitals.hospitals[OHSU], RATES).addons));
  });
});

describe('MA cases: teaching hospitals only, operating IME only', () => {
  const h = hospitals.hospitals[OHSU];
  test('OHSU: MA count = round(traditional × IME_CASETA44 ÷ CASETA44), add-on per case = operating IME', () => {
    const table = perYearTable(byCode['32480'], ohsu);
    const r = table.rows.find((x) => x.drg === '163');
    const paid = drgPayment(WEIGHTS['163'], h, RATES);
    assert.equal(r.ma.count, Math.round(15 * h.ime_caseta44 / h.caseta44));
    assert.equal(r.ma.count, 17);
    assert.equal(r.ma.estimated, true);
    assert.equal(r.ma.perCase, round2(paid.imeOperating));
    assert.equal(r.ma.perYear, round2(17 * paid.imeOperating));
    const sum = table.rows.reduce((s, x) => {
      const p = drgPayment(WEIGHTS[x.drg], h, RATES);
      return s + x.trad.count * p.addons + x.ma.count * p.imeOperating;
    }, 0);
    assert.equal(table.total, round2(sum));
  });
  test('an edited MA count is used as typed; the MA estimate follows an edited traditional count', () => {
    const table = perYearTable(byCode['32480'], ohsu, { 163: { ma: 3 }, 164: { trad: 100 } });
    assert.deepEqual([table.rows[0].ma.count, table.rows[0].ma.estimated], [3, false]);
    assert.equal(table.rows[1].ma.count, Math.round(100 * h.ime_caseta44 / h.caseta44));
  });
  test('teaching descriptor: teaching, capital-only (capital IME, no MA row), none', () => {
    assert.equal(ohsu.teaching, 'teaching');
    assert.equal(teaching(hospitals.hospitals[CAPITAL_ONLY]), 'capital-only');
    const ctx = at(CAPITAL_ONLY);
    assert.equal(ctx.addOns, true);
    assert.ok(perYearTable(byCode['32480'], ctx).rows.every((r) => r.ma === null));
    assert.ok(drgPayment(1, hospitals.hospitals[CAPITAL_ONLY], RATES).imeCapital > 0);
    assert.equal(teaching(NATIONAL), 'none');
  });
  test('a teaching hospital with no IME_CASETA44: MA count empty with the reason, totals still work', () => {
    const ctx = at(NO_MA_RATIO);
    assert.equal(ctx.maRatio, null);
    const table = perYearTable(byCode['32480'], ctx, { 163: { trad: 20 } });
    for (const row of table.rows) assert.deepEqual([row.ma.count, row.ma.reason], [null, 'no-ma-ratio']);
    assert.ok(table.total > 0);
    const typed = perYearTable(byCode['32480'], ctx, { 163: { trad: 20, ma: 5 } });
    assert.deepEqual([typed.rows[0].ma.count, typed.rows[0].ma.reason], [5, null]);   // a typed count needs no reason
    assert.ok(typed.total > table.total);
    const cleared = perYearTable(byCode['32480'], ctx, { 163: { ma: '' } });
    assert.deepEqual([cleared.rows[0].ma.count, cleared.rows[0].ma.reason], [null, null]);   // the reader's own empty cell
  });
});

describe('each per-year cell says where its count came from (source), once for the folds and the CSV', () => {
  const ctx = hospitalContext({ ...env, hospital: hospitals.hospitals[OHSU], volume: { 163: 15, 164: 34 } });
  const cell = (table, drg, payer) => table.rows.find((r) => r.drg === drg)[payer].source;
  test('untyped: CMS count, MA estimate, nothing published', () => {
    const table = perYearTable(byCode['32480'], ctx);
    assert.deepEqual([cell(table, '163', 'trad'), cell(table, '163', 'ma'), cell(table, '165', 'trad'), cell(table, '165', 'ma')], ['cms', 'estimate', 'none', 'none']);
  });
  test('typed: a whole number, a cleared box, anything else; an MA estimate with nothing to scale', () => {
    const table = perYearTable(byCode['32480'], ctx, { 163: { trad: '10', ma: '' }, 164: { trad: '2.5' }, 165: { trad: 7, ma: 'x' } });
    assert.deepEqual([cell(table, '163', 'trad'), cell(table, '163', 'ma'), cell(table, '164', 'trad'), cell(table, '164', 'ma'), cell(table, '165', 'trad'), cell(table, '165', 'ma')],
      ['typed', 'cleared', 'invalid', 'unscaled', 'typed', 'invalid']);
  });
  test('no MA ratio: the untyped MA cell is "none" with its reason', () => {
    const table = perYearTable(byCode['32480'], at(NO_MA_RATIO), { 163: { trad: 20 } });
    for (const row of table.rows) assert.deepEqual([row.ma.source, row.ma.reason], ['none', 'no-ma-ratio']);
  });
});

describe('two-family and no-comparison codes (Review Focus 4)', () => {
  const twoFamily = compared.filter((item) => item.ip.families.length > 1);
  test('two-family codes keep their structure, with hospital amounts in each family', () => {
    assert.ok(twoFamily.length > 100);
    for (const item of twoFamily) {
      const out = hospitalItem(item, ohsu);
      assert.equal(out.ip.families.length, item.ip.families.length);
      out.ip.families.forEach((f, i) => {
        const { low, high, addOn, ...rest } = f;
        const { low: l0, high: h0, ...rest0 } = item.ip.families[i];
        assert.deepEqual(rest, rest0, `${item.code} family ${i}`);
        assert.ok(low > l0 && high > h0 && addOn.low > 0, `${item.code} family ${i} amounts`);
      });
      assert.equal(out.ip.low, Math.min(...out.ip.families.map((f) => f.low)));
      assert.equal(out.ip.high, Math.max(...out.ip.families.map((f) => f.high)));
    }
  });
  test('two-family per-year rows: each DRG once, in family order, labeled with its first family', () => {
    const shared = twoFamily.find((item) => {
      const drgs = item.ip.families.flatMap((f) => f.drgs.map((d) => d.drg));
      return new Set(drgs).size < drgs.length;
    });
    assert.ok(shared);
    const table = perYearTable(shared, ohsu);
    const drgs = table.rows.map((r) => r.drg);
    assert.equal(new Set(drgs).size, drgs.length);
    assert.deepEqual(drgs, [...new Set(shared.ip.families.flatMap((f) => f.drgs.map((d) => d.drg)))]);
  });
  test('packaged, anesthesia, unmapped and pending items come back deep-equal to the input', () => {
    const kinds = new Set(noCompare.map((item) => item.kind));
    assert.ok(kinds.has('packaged') && kinds.has('anesthesia'));
    for (const item of noCompare) {
      assert.deepEqual(hospitalItem(item, ohsu), item, item.code);
      assert.deepEqual(splitRows(item, ohsu), []);
      assert.deepEqual(perYearTable(item, ohsu), { rows: [], total: null });
    }
    const unmapped = { ...noCompare[0], kind: 'unmapped', op: { si: 'J1', apc: '5183', rate: 3584.95, asc: null } };
    assert.deepEqual(hospitalItem(unmapped, ohsu), unmapped);
  });
});

describe('the summary strip', () => {
  test('OHSU: 822 of 849 below the lowest DRG; median gap and add-on; "about half"', () => {
    const s = summary(compared, ohsu);
    assert.equal(s.codes, 849);
    assert.equal(s.below, 822);
    assert.equal(s.medianGap, 10477.94);
    assert.equal(s.medianAddOn, 5156.10);
    assert.equal(s.state, 'addons');
    assert.ok(Math.abs(s.ratio - 5156.10 / 10477.94) < 1e-3);
    assert.equal(fractionWord(s.ratio), 'about half');
  });
  test('two-family codes use the lowest DRG across every family', () => {
    const item = compared.find((i) => i.ip.families.length > 1 && i.ip.families[0].low !== i.ip.low);
    const out = hospitalItem(item, ohsu);
    const s = summary([item], ohsu);
    assert.ok(out.ip.low < out.ip.families[0].low);
    assert.ok(Math.abs(s.medianGap - (out.ip.low - out.op.rate)) <= 0.01);
  });
  test('items without a comparison are skipped; nothing to compare gives an empty state, not NaN', () => {
    assert.equal(summary(noCompare, ohsu).codes, 0);
    const empty = summary([], ohsu);
    assert.deepEqual([empty.state, empty.ratio, empty.medianGap], ['empty', null, null]);
    assertFinite(empty);
  });
  test('national (no hospital): null', () => assert.equal(summary(compared, null), null));
});

describe('round2 matches Python round(x, 2)', () => {
  test('exact ties go to even; near-ties follow the double, as Python does', () => {
    assert.equal(round2(0.125), 0.12);
    assert.equal(round2(0.375), 0.38);
    assert.equal(round2(-0.125), -0.12);
    assert.equal(round2(2.675), 2.67);   // 2.67499999... as a double
    assert.equal(round2(1.005), 1);      // 1.00499999...
    assert.equal(round2(60670.6949), 60670.69);
    assert.equal(round2(-47464.304), -47464.3);
    assert.ok(Object.is(round2(-0.001), 0), "a rounded-away negative is 0, never −0");
  });
});

test('the hospital record carries only finite factors (sanity on the derived table)', () => {
  for (const ccn of [OHSU, NO_ADDONS, CAPITAL_ONLY, NO_MA_RATIO, LOW_WAGE]) assertFinite(factors(hospitals.hospitals[ccn]));
});
