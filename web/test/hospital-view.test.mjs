// The hospital view: the build's hospital files, the facts line, the summary strip and the cards in
// hospital mode, run against the real derived tables the way the browser gets them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hospitals, volume, model, list, doc, data, recordOf, viewOf, read } from './hospital-fixture.mjs';
import { card, gapParts } from '../src/stake-card.mjs';
import { uncoveredDrgs, staleHospitalTables } from '../src/hospital-data.mjs';
import { hospitalIndex, findHospitals } from '../src/hospital-pick.mjs';
import { facts, summaryHtml, hospitalLede, LEDE_NATIONAL, LEDE_HOSPITAL } from '../src/hospital-view.mjs';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the files the build ships', () => {
  test('the list: every offered hospital, Maryland apart, and the constants the math needs', () => {
    assert.equal(list.h.length, hospitals.meta.counts.offered);
    assert.equal(list.md.length, hospitals.meta.counts.maryland);
    assert.deepEqual(list.h.find(([ccn]) => ccn === '380009'), ['380009', 'Ohsu Hospital And Clinics', 'OR', 2]);
    assert.deepEqual(list.meta.rates, hospitals.meta.rates);
    assert.deepEqual(list.meta.drg_weights, hospitals.meta.drg_weights);
    assert.equal(list.meta.opps_labor_share, hospitals.meta.opps_labor_share);
    assert.equal(list.meta.maryland, hospitals.meta.maryland);
    for (const [, , state] of list.h) assert.ok(list.states[state], `no name for state ${state}`);
    assert.ok(list.states.MD);
    const teaching = list.h.filter((row) => row[3] === 2).length;
    assert.equal(teaching, hospitals.meta.counts.teaching);
  });
  test('a hospital record: its factors and its 2024 counts for the crosswalk DRGs only', () => {
    const r = recordOf('380009');
    for (const key of ['wi', 'gaf', 'tchop', 'tchcp', 'dshopp', 'dshcpp', 'caseta44', 'ime_caseta44', 'name', 'state']) assert.equal(r[key], hospitals.hospitals['380009'][key], key);
    assert.deepEqual(r.v, volume.volume['380009']);
    assert.ok(Object.keys(r.v).every((drg) => volume.meta.drgs.includes(drg)));
    assert.deepEqual(recordOf('400001').v, {}, 'Puerto Rico: no published counts');
  });
  test('the build checks the hospital tables cover every DRG the crosswalk prices', () => {
    const none = { 'hospitals.json meta.drg_weights': [], 'drg-volume.json meta.drgs': [] };
    assert.deepEqual(uncoveredDrgs(model, hospitals.meta, volume.meta), none);
    const weights = { ...hospitals.meta.drg_weights };
    delete weights['165'];
    assert.deepEqual(uncoveredDrgs(model, { drg_weights: weights }, { drgs: volume.meta.drgs.filter((d) => d !== '163') }),
      { 'hospitals.json meta.drg_weights': ['165'], 'drg-volume.json meta.drgs': ['163'] });
  });
  test('hospitals.json must price as the crosswalk does: a changed weight or rate fails the build (staleHospitalTables)', () => {
    const rates = read('pipeline/derived/crosswalk.json').meta.rates;
    assert.deepEqual(staleHospitalTables(model, rates, hospitals.meta), []);
    // Mismatched fixture: last year's weight for DRG 165 and a different capital rate.
    const stale = { ...hospitals.meta, drg_weights: { ...hospitals.meta.drg_weights, 165: hospitals.meta.drg_weights['165'] + 0.0001 },
      rates: { ...hospitals.meta.rates, capital: hospitals.meta.rates.capital + 1 } };
    const problems = staleHospitalTables(model, rates, stale);
    assert.equal(problems.length, 2, problems.join('; '));
    assert.match(problems[0], /^MS-DRG 165 weight [\d.]+ in hospitals\.json, [\d.]+ in the crosswalk \(\w+\)$/);
    assert.match(problems[1], /^rate capital [\d.]+ in hospitals\.json, [\d.]+ in the crosswalk$/);
    // A rate the crosswalk does not carry, or no rates at all, fails too; a missing weight is uncoveredDrgs()'s.
    assert.equal(staleHospitalTables(model, { ...rates, labor_share: undefined }, hospitals.meta).length, 1);
    assert.deepEqual(staleHospitalTables(model, rates, { ...hospitals.meta, rates: {} }), ['hospitals.json has no meta.rates']);
    const weights = { ...hospitals.meta.drg_weights };
    delete weights['165'];
    assert.deepEqual(staleHospitalTables(model, rates, { ...hospitals.meta, drg_weights: weights }), []);
  });
  test('the list finds OHSU by name, state and CCN', () => {
    const index = hospitalIndex(list);
    for (const q of ['ohsu', '380009', 'ohsu or', 'ohsu oregon']) assert.equal(findHospitals(index, q).matches[0].ccn, '380009', q);
    assert.equal(findHospitals(index, 'meritus').maryland, true);
  });
  test('a query that is a state (its code or its name) lists that state’s hospitals first, not names that start with it', () => {
    const index = hospitalIndex(list);
    for (const [q, state] of [['ME', 'ME'], ['in', 'IN'], ['OR', 'OR'], ['oregon', 'OR'], ['indiana', 'IN']]) {
      const { matches } = findHospitals(index, q);
      assert.equal(matches.length, 8, q);
      assert.deepEqual([...new Set(matches.map((h) => h.state))], [state], `${q}: ${matches.map((h) => `${h.name} ${h.state}`).join('; ')}`);
    }
    // A name word still finds names: "medical" is no state.
    assert.ok(findHospitals(index, 'medical').matches.every((h) => h.words.some((w) => w.startsWith('medical'))));
  });
});

describe('facts line', () => {
  test('teaching, capital IME only and none, with operating IME and DSH and the wage index', () => {
    assert.equal(facts(hospitals.hospitals['380009']), 'Teaching · IME 31.1% · DSH 7.0% · wage index 1.19');
    assert.equal(facts(hospitals.hospitals['010005']), `Not a teaching hospital · DSH ${(hospitals.hospitals['010005'].dshopp * 100).toFixed(1)}% · wage index ${hospitals.hospitals['010005'].wi.toFixed(2)}`);
    assert.equal(facts(hospitals.hospitals['030107']), `Not a teaching hospital · No DSH · wage index ${hospitals.hospitals['030107'].wi.toFixed(2)}`);
    assert.match(facts(hospitals.hospitals['110165']), /^Capital IME only · /);
  });
});

describe('summary strip', () => {
  test('OHSU: the lead reads as a finding, with the three numbers', () => {
    const view = viewOf('380009');
    const t = text(view.summaryHtml);
    assert.match(t, /^At Ohsu Hospital And Clinics, about half of what a removed procedure loses when billed outpatient is teaching and DSH add-ons\./);
    assert.ok(t.includes('$10,478'), t);
    assert.ok(t.includes('$5,156'), t);
    assert.ok(t.includes('822 of 849'), t);
  });
  test('Review Focus 1: a hospital with no IME and no DSH says so, never $0–$0 or NaN', () => {
    const view = viewOf('030107');
    assert.equal(view.summary.state, 'no-addons');
    const t = text(view.summaryHtml);
    assert.match(t, /^Arizona Spine And Joint Hospital gets no teaching or DSH add-ons, so what a removed procedure loses when billed outpatient is base payment only\./);
    assert.ok(!/\$0\b|NaN|undefined|null|Infinity/.test(t), t);
  });
  test('every state renders without a missing number', () => {
    const base = { codes: 849, below: 800, medianGap: 1234.5, medianAddOn: 500, ratio: 0.405 };
    for (const s of [{ ...base, state: 'addons' }, { ...base, medianAddOn: 0, ratio: null, state: 'no-addons' }, { ...base, medianGap: -250, ratio: null, state: 'no-gap' }, { ...base, medianGap: 0, ratio: null, state: 'no-gap' }]) {
      const t = text(summaryHtml(s, 'A <b>Hospital</b>'));
      assert.ok(!/NaN|undefined|null|Infinity/.test(t), `${s.state}: ${t}`);
      assert.ok(!t.includes('<b>'), 'the name is escaped');
    }
    assert.equal(summaryHtml({ codes: 0, below: 0, medianGap: null, medianAddOn: null, ratio: null, state: 'empty' }, 'X'), '');
  });
  test('the name is escaped everywhere it appears', () => {
    const record = { ...recordOf('380009'), name: '<img src=x onerror=alert(1)>' };
    const view = viewOf('380009', record);
    for (const html of [view.summaryHtml, view.barHtml, view.card(view.data.byCode['32480'])]) {
      assert.ok(!html.includes('<img'), html.slice(0, 200));
      assert.ok(html.includes('&lt;img'));
    }
  });
});

describe('cards in hospital mode', () => {
  test('OHSU 32480: hospital amounts, the gap with the name, the add-on line, the darker bar and the fine print', () => {
    const view = viewOf('380009');
    const html = view.card(view.data.byCode['32480']);
    const t = text(html);
    assert.ok(t.includes('If billed outpatient, Ohsu Hospital And Clinics is paid $18,121–$47,464 less than the inpatient DRG family.'), t);
    assert.ok(t.includes('$3,995'), 'wage-adjusted outpatient');
    assert.ok(t.includes('national rate $3,585'), 'the national rate beside it');
    assert.ok(t.includes('Surgery center (ASC), national: $1,585'), 'ASC stays national');
    assert.ok(t.includes('No teaching or DSH add-on in either outpatient setting.'));
    assert.ok(t.includes('$22,117–$51,459'), 'inpatient range');
    assert.ok(t.includes('Includes $6,067–$14,116 in IME and DSH'), t);
    assert.ok(t.includes('Ohsu Hospital And Clinics rates: wage index, IME and DSH (operating and capital).'));
    assert.ok(!t.includes('National, unadjusted'));
    assert.match(html, /class="sbar__add"/);
    // The legend is a swatch of the segment's own color, never a word that dark mode or forced colors make false.
    assert.match(html, /<span class="sbar__keyed">\(<i class="sbar__key"><\/i>IME and DSH\)<\/span>/);
    assert.ok(!/darker|lighter/i.test(html), 'no light/dark word in the legend');
    assert.ok(t.includes('Show the national work for 32480'));
    assert.ok(!html.includes('scard__work'), 'no national DRG table beside hospital figures');
  });
  test('a hospital with no add-ons: no add-on line, no darker bar, says so in the fine print', () => {
    const view = viewOf('030107');
    const html = view.card(view.data.byCode['32480']);
    const t = text(html);
    assert.ok(!t.includes('Includes'), t);
    assert.ok(!html.includes('sbar__add'));
    assert.ok(!t.includes('No teaching or DSH add-on in either outpatient setting'));
    assert.ok(t.includes('Arizona Spine And Joint Hospital rates: wage index. This hospital gets no IME or DSH.'));
    assert.ok(!/\$0–\$0|NaN/.test(t));
  });
  test('an add-on that rounds to $0 draws no segment and no legend, like the Includes line', () => {
    const record = { ...recordOf('380009'), tchop: 1e-5, tchcp: 0, dshopp: 0, dshcpp: 0 };
    const view = viewOf('380009', record);
    const item = view.data.byCode['32480'];
    assert.ok(item.addOn && item.addOn.high > 0 && item.addOn.high < 0.5, 'a real but sub-$0.50 add-on');
    const html = view.card(item);
    assert.ok(!html.includes('Includes'));
    assert.ok(!html.includes('sbar__add'));
    assert.ok(!html.includes('sbar__key'));
  });
  test('Review Focus 4: a code with no comparison draws exactly as nationally', () => {
    const view = viewOf('380009');
    const none = data.items.filter((item) => item.kind !== 'compare');
    assert.ok(none.length > 50);
    for (const item of none) {
      assert.equal(view.card(view.data.byCode[item.code]), card(item, doc.meta, { detail: false }), item.code);
    }
  });
  test('two-family codes keep their families, each with its own add-on line', () => {
    const view = viewOf('380009');
    const two = view.data.items.find((item) => item.kind === 'compare' && item.ip.families.length > 1);
    const html = view.card(two);
    assert.equal((html.match(/class="scard__fam"/g) || []).length, two.ip.families.length);
    assert.equal((html.match(/class="scard__addon"/g) || []).length, two.ip.families.length);
    assert.match(text(html), /than the inpatient DRG families\./);
    // The legend sits right after "Inpatient", so at 400 px the long family name truncates, not the legend.
    assert.match(html, /<span class="sbar__name">Inpatient <span class="sbar__keyed">\(<i class="sbar__key"><\/i>IME and DSH\)<\/span>, /);
  });
  test('the view sorts by the hospital\'s gap and keeps every item', () => {
    const view = viewOf('380009');
    assert.equal(view.data.items.length, data.items.length);
    assert.equal(view.data.byCode['32480'].op.rate, 3995.14);
    assert.equal(view.data.index, data.index);
  });
});

describe('gap sentence parts', () => {
  const fam = (n) => ({ families: Array.from({ length: n }, () => ({})) });
  const item = (diff, n = 1) => ({ diff, op: { si: 'J1' }, ip: fam(n) });
  test('less, more, mixed and no rate; the range stands alone so the card keeps it on one line', () => {
    assert.deepEqual(gapParts(item({ low: -47464.3, high: -18121.46 }), 'If billed outpatient, X is paid'), ['If billed outpatient, X is paid ', '$18,121–$47,464', ' less than the inpatient DRG family.']);
    assert.deepEqual(gapParts(item({ low: 100, high: 200 }, 2)), ['Outpatient pays ', '$100–$200', ' more than the inpatient DRG families.']);
    assert.deepEqual(gapParts(item({ low: -50, high: 75 })), ['Outpatient pays from $50 less to $75 more than the inpatient DRG family.']);
    assert.equal(gapParts(item(null)).length, 1);
    assert.match(gapParts(item(null))[0], /^No national outpatient rate for status indicator J1/);
  });
});

describe('the lede after a pick', () => {
  const lede = 'For those 849: what outpatient pays next to the inpatient MS-DRG family the same operation would group to, national and unadjusted, from CMS’s CY 2027 and FY 2027 final rules.';
  test('says the rates are the hospital’s where the national lede says national and unadjusted', () => {
    assert.equal(hospitalLede(lede), lede.replace('national and unadjusted', 'at this hospital’s rates'));
  });
  test('the swap is about the same length, so the lede keeps its lines (no layout shift)', () => {
    assert.ok(Math.abs(LEDE_HOSPITAL.length - LEDE_NATIONAL.length) <= 2, `${LEDE_HOSPITAL} vs ${LEDE_NATIONAL}`);
    assert.equal(hospitalLede('Something else.'), 'Something else.');
  });
});
