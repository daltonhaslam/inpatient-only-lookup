import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hospitalParam, queryString, DEFAULTS } from '../src/stake-engine.mjs';
import { hospitalIndex, findHospitals, optionName, shortName, pickerMessage, LIMIT } from '../src/hospital-pick.mjs';

describe('URL state: the hospital', () => {
  test('a six-digit CCN is kept', () => {
    assert.equal(hospitalParam('?h=380009'), '380009');
    assert.equal(hospitalParam('?q=32480&h=400001&tier=3'), '400001');
  });
  test('anything else is dropped before any fetch could use it', () => {
    for (const bad of ['', '?h=', '?h=38000', '?h=3800090', '?h=38000a', '?h=../x', '?h=%2e%2e%2f', '?h=380009/', '?h= 380009', '?h=<script>', '?h=１２３４５６', '?h=380009&h=x']) {
      assert.equal(hospitalParam(bad), '', bad);
    }
  });
  test('the query string puts the hospital first and leaves it out when national', () => {
    assert.equal(queryString(DEFAULTS, ''), '');
    assert.equal(queryString(DEFAULTS, '380009'), 'h=380009');
    assert.equal(queryString({ ...DEFAULTS, q: 'lung', tier: '3' }, '380009'), 'h=380009&q=lung&tier=3');
    assert.equal(queryString({ ...DEFAULTS, q: 'lung' }, ''), 'q=lung');
  });
  test('a junk hospital never reaches the query string', () => {
    assert.equal(queryString(DEFAULTS, '../etc'), '');
    assert.equal(queryString(DEFAULTS, '38000'), '');
  });
});

const list = {
  states: { OR: 'Oregon', AL: 'Alabama', PR: 'Puerto Rico', MD: 'Maryland', DC: 'District of Columbia', WA: 'Washington' },
  h: [
    ['380009', 'Ohsu Hospital And Clinics', 'OR', 2],
    ['380004', 'Providence Portland Medical Center', 'OR', 2],
    ['380061', 'Providence St Vincent Medical Center', 'OR', 0],
    ['010005', 'Marshall Medical Centers South Campus', 'AL', 0],
    ['010130', 'St Vincent\'s St Clair', 'AL', 0],
    ['400001', 'Presbyterian Community Hospital', 'PR', 0],
    ['090012', null, 'DC', 0],
    ['500001', 'Orcas Island Hospital', 'WA', 1],
  ],
  md: [['210001', 'Meritus Medical Center'], ['210009', 'Johns Hopkins Hospital, The']],
};
const index = hospitalIndex(list);
const ccns = (result) => result.matches.map((h) => h.ccn);

describe('picker search', () => {
  test('by CCN, whole or a prefix', () => {
    assert.deepEqual(ccns(findHospitals(index, '380009')), ['380009']);
    assert.deepEqual(ccns(findHospitals(index, '3800')).sort(), ['380004', '380009', '380061']);
  });
  test('by name: every word is the start of a word in the name, any case, punctuation ignored', () => {
    assert.deepEqual(ccns(findHospitals(index, 'ohsu')), ['380009']);
    assert.deepEqual(ccns(findHospitals(index, 'OHSU hosp')), ['380009']);
    assert.deepEqual(ccns(findHospitals(index, 'st vincents')), ['010130']);
    assert.deepEqual(ccns(findHospitals(index, 'providence vincent')), ['380061']);
    assert.deepEqual(findHospitals(index, 'hsu').matches, []);
  });
  test('by state code or state name, alone or with a name', () => {
    assert.deepEqual(ccns(findHospitals(index, 'AL')).sort(), ['010005', '010130']);
    assert.deepEqual(ccns(findHospitals(index, 'puerto rico')), ['400001']);
    assert.deepEqual(ccns(findHospitals(index, 'providence or')).sort(), ['380004', '380061']);
    assert.deepEqual(ccns(findHospitals(index, 'oregon providence')).sort(), ['380004', '380061']);
  });
  test('names that start with the query rank first, then by name', () => {
    // "or": Orcas Island's name starts with it; the Oregon hospitals match by state.
    assert.deepEqual(ccns(findHospitals(index, 'or')), ['500001', '380009', '380004', '380061']);
  });
  test('a hospital with no name in CMS\'s file is found by CCN and labeled by it', () => {
    const [h] = findHospitals(index, '090012').matches;
    assert.equal(optionName(h), 'CCN 090012 (no name in CMS’s file)');
    assert.equal(shortName(h), 'CCN 090012');
    assert.equal(shortName(findHospitals(index, '380009').matches[0]), 'Ohsu Hospital And Clinics');
  });
  test('Maryland: never a match, but the search says why', () => {
    for (const q of ['meritus', '210001', 'md', 'maryland', 'johns hopkins']) {
      const result = findHospitals(index, q);
      assert.deepEqual(result.matches, [], q);
      assert.equal(result.maryland, true, q);
    }
    assert.equal(findHospitals(index, 'ohsu').maryland, false);
  });
  test('at most LIMIT matches, with the total', () => {
    const many = hospitalIndex({ states: { TX: 'Texas' }, h: Array.from({ length: 30 }, (_, i) => [`67${String(i).padStart(4, '0')}`, `Texas Hospital ${i}`, 'TX', 0]), md: [] });
    const result = findHospitals(many, 'texas');
    assert.equal(result.matches.length, LIMIT);
    assert.equal(result.total, 30);
  });
  test('an empty or blank query finds nothing', () => {
    assert.deepEqual(findHospitals(index, '').matches, []);
    assert.deepEqual(findHospitals(index, '  ,. ').matches, []);
    assert.equal(findHospitals(index, '').maryland, false);
  });
  test('the index looks a hospital up by CCN; Maryland and unknown CCNs are not in it', () => {
    assert.equal(index.byCcn.get('380009').name, 'Ohsu Hospital And Clinics');
    assert.equal(index.byCcn.has('210001'), false);
    assert.equal(index.maryland.has('210001'), true);
    assert.equal(index.byCcn.has('999999'), false);
  });
});

describe('picker messages', () => {
  const MD = 'Maryland hospitals are paid under the state’s all-payer model, not the IPPS.';
  test('nothing typed: nothing said', () => {
    assert.deepEqual(pickerMessage(findHospitals(index, ''), '', MD), { note: '', spoken: '' });
  });
  test('a Maryland search gives the reason, under the box and to a screen reader', () => {
    const m = pickerMessage(findHospitals(index, 'meritus'), 'meritus', MD);
    assert.equal(m.note, `${MD} So they are not in this list.`);
    assert.equal(m.spoken, m.note);
  });
  test('matches: the count is spoken; more than LIMIT says to keep typing', () => {
    assert.deepEqual(pickerMessage(findHospitals(index, 'ohsu'), 'ohsu', MD), { note: '', spoken: '1 hospital. Use the arrow keys to choose.' });
    const many = hospitalIndex({ states: { TX: 'Texas' }, h: Array.from({ length: 30 }, (_, i) => [`67${String(i).padStart(4, '0')}`, `Texas Hospital ${i}`, 'TX', 0]), md: [] });
    const m = pickerMessage(findHospitals(many, 'texas'), 'texas', MD);
    assert.equal(m.note, '30 hospitals match; keep typing to narrow the list.');
    assert.equal(m.spoken, `${LIMIT} of 30 hospitals. Use the arrow keys to choose.`);
  });
  test('no match says how to search', () => {
    assert.match(pickerMessage(findHospitals(index, 'zzz'), 'zzz', MD).note, /^No IPPS hospital matches/);
  });
});
