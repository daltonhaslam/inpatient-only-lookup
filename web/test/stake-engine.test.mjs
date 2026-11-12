// Pure filter, sort, search, URL-state and format logic for the Revenue at stake page.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, filterCodes, sortCodes, gapSize, outsideCrosswalk, stateFromParams, paramsFromState, countText, DEFAULTS } from '../src/stake-engine.mjs';
import { moneyRange } from '../src/stake-card.mjs';

const fam = (name, condition) => ({ condition, name, drgs: [{ drg: '163' }], low: 1000, high: 2000 });
const item = (extra) => ({ kind: 'compare', year: 2026, group: 'airway', op: { si: 'J1', rate: 3000, asc: null }, review: { status: 'unreviewed' }, tier: { n: 1, why: 'x' }, diff: { low: -500, high: -100 }, ip: { low: 1000, high: 2000, families: [fam('Major chest procedures', 'lung cancer')] }, ...extra });
const model = {
  meta: { years: {}, groups: [['airway', 'Chest and airway'], ['spine', 'Spine']] },
  strings: ['Why one', 'Why three', 'Major chest procedures', 'Spinal fusion'],
  codes: {
    32480: item({ label: 'Partial lung removal', tier: { n: 1, why: 0 }, diff: { low: -29581, high: -10669 }, ip: { low: 1000, high: 2000, families: [{ ...fam(2, 'lung cancer') }] }, review: { status: 'confirmed' } }),
    22800: item({ label: 'Posterior spinal fusion', group: 'spine', year: 2027, tier: { n: 3, why: 1 }, diff: { low: -2000, high: 500 }, ip: { low: 1000, high: 2000, families: [fam(3, 'spinal disease')] } }),
    '0790T': item({ label: 'Revision of device', group: 'spine', year: 2027, tier: { n: 2, why: 0 }, diff: { low: -300, high: -100 }, review: { status: 'one-agrees' }, ip: { low: 1000, high: 2000, families: [fam(2, 'x')] } }),
    '00176': { label: 'Anesthesia for neck surgery', group: 'airway', year: 2026, kind: 'packaged', op: { si: 'N', rate: null, asc: null }, review: { status: 'unreviewed' }, tier: null, diff: null },
  },
  siteCodes: ['27447'],
};
const data = prepare(model);
const codes = (filters) => filterCodes(data, filters).map((i) => i.code);

describe('filterCodes', () => {
  test('no filters: everything, in code order', () => assert.deepEqual(codes({}), ['00176', '0790T', '22800', '32480']));
  test('searches by code and by code prefix', () => {
    assert.deepEqual(codes({ q: '32480' }), ['32480']);
    assert.deepEqual(codes({ q: '22' }), ['22800']);
  });
  test('searches the label, the body system and the DRG family', () => {
    assert.deepEqual(codes({ q: 'lung' }), ['32480']);
    assert.deepEqual(codes({ q: 'fusion' }), ['22800']);
    assert.deepEqual(codes({ q: 'spine' }).sort(), ['0790T', '22800']);
  });
  test('tier keeps only that tier and drops codes without a comparison', () => {
    assert.deepEqual(codes({ tier: '3' }), ['22800']);
    assert.deepEqual(codes({ tier: '1' }), ['32480']);
  });
  test('status, group and year filter; filters combine', () => {
    assert.deepEqual(codes({ status: 'confirmed' }), ['32480']);
    assert.deepEqual(codes({ group: 'spine' }), ['0790T', '22800']);
    assert.deepEqual(codes({ year: '2027', status: 'one-agrees' }), ['0790T']);
    assert.deepEqual(codes({ year: '2026', group: 'spine' }), []);
  });
  test('"has a comparison" drops packaged codes', () => assert.deepEqual(codes({ compared: true }), ['0790T', '22800', '32480']));
});

describe('sort', () => {
  test('biggest gap first, codes without a comparison last', () => {
    assert.deepEqual(codes({ sort: 'gap' }), ['32480', '22800', '0790T', '00176']);
  });
  test('gap size is the larger absolute end', () => {
    assert.equal(gapSize({ diff: { low: -2000, high: 500 } }), 2000);
    assert.equal(gapSize({ diff: null }), -1);
  });
  test('does not reorder its input', () => {
    const input = [{ code: 'B', diff: null }, { code: 'A', diff: null }];
    sortCodes(input, 'code');
    assert.equal(input[0].code, 'B');
  });
});

describe('outsideCrosswalk', () => {
  test('a code not in the crosswalk says whether the site has a page for it', () => {
    assert.deepEqual(outsideCrosswalk(data, '27447'), { code: '27447', page: true });
    assert.deepEqual(outsideCrosswalk(data, ' 99213 '), { code: '99213', page: false });
  });
  test('null for a code in the crosswalk or text that is not a code', () => {
    assert.equal(outsideCrosswalk(data, '32480'), null);
    assert.equal(outsideCrosswalk(data, 'lobectomy'), null);
    assert.equal(outsideCrosswalk(data, '9921'), null);
  });
});

describe('URL state', () => {
  test('round-trips and leaves defaults out', () => {
    const state = { ...DEFAULTS, q: 'lung', tier: '3', compared: true, sort: 'gap' };
    const text = paramsFromState(state);
    assert.equal(text, 'q=lung&tier=3&compared=1&sort=gap');
    assert.deepEqual(stateFromParams(`?${text}`, data), state);
    assert.equal(paramsFromState(DEFAULTS), '');
  });
  test('unknown values are dropped', () => {
    const state = stateFromParams('?tier=9&group=<script>&status=x&year=1999&sort=evil&q=' + 'a'.repeat(200), data);
    assert.deepEqual({ ...state, q: state.q.length }, { ...DEFAULTS, q: 80 });
  });
});

describe('format', () => {
  test('ranges', () => {
    assert.equal(moneyRange(14254.31, 33165.99), '$14,254–$33,166');
    assert.equal(moneyRange(1000.2, 1000.4), '$1,000');
  });
  test('count text', () => {
    assert.equal(countText(0, 0), 'No codes match.');
    assert.equal(countText(1, 1), '1 code.');
    assert.equal(countText(922, 922), '922 codes.');
    assert.equal(countText(922, 50), 'Showing 50 of 922 codes.');
  });
});
