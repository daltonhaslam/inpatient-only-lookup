// The hospital CSV ("Download for <Hospital> (CSV)"): built in the browser from the picked hospital's
// view, with the counts someone typed. Run against the real derived tables the way the browser gets them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { volume, list, data, recordOf, viewOf } from './hospital-fixture.mjs';
import { HOSPITAL_CSV_HEADER, hospitalCsvName } from '../src/hospital-csv.mjs';
import { csv } from '../src/engine.mjs';
import { ceiling } from '../src/hospital-words.mjs';


const col = (name) => HOSPITAL_CSV_HEADER.indexOf(name);
const pick = (rows, type, code, drg, payer = '') => rows.filter((r) => r[col('row_type')] === type && r[col('code')] === code && r[col('drg')] === drg && r[col('payer')] === payer);
const one = (rows, ...key) => {
  const found = pick(rows, ...key);
  assert.equal(found.length, 1, `rows for ${key.join(' ')}: ${found.length}`);
  return Object.fromEntries(HOSPITAL_CSV_HEADER.map((name, i) => [name, found[0][i]]));
};
const compared = data.items.filter((item) => item.kind === 'compare');

describe('hospital CSV', () => {
  test('the header is the first row, plain snake_case names, no comment line', () => {
    const rows = viewOf('380009').csvRows();
    assert.deepEqual(rows[0], HOSPITAL_CSV_HEADER);
    assert.ok(HOSPITAL_CSV_HEADER.every((name) => /^[a-z0-9_]+$/.test(name)));
    for (const name of ['code', 'drg', 'hospital_outpatient', 'inpatient_base', 'ime', 'dsh', 'inpatient_total', 'outpatient_minus_inpatient', 'cases', 'count_source', 'add_on_per_case', 'add_on_per_year']) {
      assert.ok(HOSPITAL_CSV_HEADER.includes(name), name);
    }
    assert.ok(rows.slice(1).every((r) => r.length === HOSPITAL_CSV_HEADER.length));
  });

  test('the filename carries the CCN', () => {
    assert.equal(hospitalCsvName('380009'), 'revenue-at-stake-380009.csv');
    assert.equal(viewOf('380009').csvName, 'revenue-at-stake-380009.csv');
  });

  test('OHSU 32480: a per-case row per DRG to the cent (the fixture), with the gap from unrounded parts', () => {
    const rows = viewOf('380009').csvRows();
    const r165 = one(rows, 'per_case', '32480', '165');
    assert.equal(r165.ccn, '380009');
    assert.equal(r165.hospital, 'Ohsu Hospital And Clinics');
    assert.equal(r165.hospital_outpatient, 3995.14);
    assert.equal(r165.inpatient_total, 22116.6);
    assert.equal(r165.inpatient_base, 16049.53);
    assert.equal(Math.round((r165.ime + r165.dsh) * 100), 606707);   // the spec's add-ons, $6,067.07 (parts rounded once each)
    assert.equal(r165.outpatient_minus_inpatient, -18121.46);
    assert.equal(r165.family_order, 'primary');
    const r163 = one(rows, 'per_case', '32480', '163');
    assert.equal(r163.inpatient_total, 51459.44);
    // Per-case rows carry no per-year cells.
    for (const key of ['payer', 'cases', 'count_source', 'add_on_per_case', 'add_on_per_year']) assert.equal(r165[key], '', key);
  });

  test('one per-case row per compared code and DRG, every per-case row before the per-year rows; codes without a comparison are left out', () => {
    const rows = viewOf('380009').csvRows().slice(1);
    const want = compared.reduce((n, item) => n + item.ip.families.reduce((m, f) => m + f.drgs.length, 0), 0);
    const types = rows.map((r) => r[col('row_type')]);
    assert.equal(types.filter((t) => t === 'per_case').length, want);
    assert.equal(types.lastIndexOf('per_case'), want - 1, 'per-case rows come first');
    const codes = new Set(rows.map((r) => r[col('code')]));
    for (const item of data.items.filter((i) => i.kind !== 'compare')) assert.ok(!codes.has(item.code), item.code);
  });

  test('per year at OHSU: prefilled counts (CMS 2024, MA estimate), the add-on per case, a total row per code', () => {
    const view = viewOf('380009');
    const rows = view.csvRows();
    const trad = one(rows, 'per_year', '32480', '165', 'traditional_medicare');
    assert.equal(trad.count_source, `cms_${volume.meta.data_year}`);
    assert.equal(trad.cases, volume.volume['380009']['165']);
    assert.equal(trad.add_on_per_case, 6067.07);
    const ma = one(rows, 'per_year', '32480', '165', 'medicare_advantage');
    assert.equal(ma.count_source, 'estimate');
    assert.match(ma.note, /^operating IME only; estimate: 1\.11 MA cases per traditional case/);
    const total = one(rows, 'per_year_total', '32480', '');
    assert.equal(total.add_on_per_year, 1015760.07);
    assert.equal(total.note, ceiling(2024));
    // No per-case cells on per-year rows.
    for (const key of ['hospital_outpatient', 'inpatient_base', 'inpatient_total', 'outpatient_minus_inpatient']) assert.equal(trad[key], '', key);
  });

  test('typed counts are in the file and say so: 10 cases of DRG 165 is $60,670.69 a year, the MA estimate follows', () => {
    const view = viewOf('380009');
    view.count('32480', '165:trad', '10');
    view.count('32480', '164:trad', '2.5');
    const rows = view.csvRows();
    const trad = one(rows, 'per_year', '32480', '165', 'traditional_medicare');
    assert.deepEqual([trad.cases, trad.count_source, trad.add_on_per_year, trad.note], [10, 'typed', 60670.69, 'your count']);
    const ma = one(rows, 'per_year', '32480', '165', 'medicare_advantage');
    assert.deepEqual([ma.cases, ma.count_source, ma.add_on_per_year], [11, 'estimate', 50952.86]);
    const bad = one(rows, 'per_year', '32480', '164', 'traditional_medicare');
    assert.deepEqual([bad.cases, bad.count_source, bad.add_on_per_year], ['', 'typed', '']);
    assert.match(bad.note, /not a whole number/);
    assert.ok(!rows.flat().includes('2.5'), 'a typed value is never echoed');
    // Another card's counts are untouched.
    const other = compared.find((item) => item.code !== '32480' && item.ip.families.some((f) => f.drgs.some((d) => d.drg === '165')));
    if (other) assert.equal(one(rows, 'per_year', other.code, '165', 'traditional_medicare').count_source, `cms_${volume.meta.data_year}`);
  });

  test('the data year comes from the data: another year shows in count_source and the ceiling note', () => {
    const later = { ...list, meta: { ...list.meta, volume_year: 2025 } };
    const rows = viewOf('380009', recordOf('380009'), later).csvRows();
    assert.equal(one(rows, 'per_year', '32480', '165', 'traditional_medicare').count_source, 'cms_2025');
    assert.equal(one(rows, 'per_year_total', '32480', '').note, ceiling(2025));
    assert.ok(!rows.flat().some((cell) => typeof cell === 'string' && cell.includes('2024')), 'no 2024 left in the words of a 2025 file');
    const none = { ...list, meta: { ...list.meta, volume_year: undefined } };
    assert.throws(() => viewOf('380009', recordOf('380009'), none), /volume_year/);
  });

  test('an MA estimate with no traditional count to scale because the count was cleared says so, not "CMS published nothing"', () => {
    const view = viewOf('380009');
    view.count('32480', '165:trad', '');
    const ma = one(view.csvRows(), 'per_year', '32480', '165', 'medicare_advantage');
    assert.deepEqual([ma.cases, ma.count_source], ['', 'estimate']);
    assert.match(ma.note, /no traditional count to scale/);
    view.count('32480', '165:trad', 'x');
    assert.match(one(view.csvRows(), 'per_year', '32480', '165', 'medicare_advantage').note, /no traditional count to scale/);
  });

  test('Review Focus 3: a suppressed DRG reads "under 11 or none", no count; the total still adds up', () => {
    const rows = viewOf('010001').csvRows();
    const at = pick(rows, 'per_year', '32480', '164', 'traditional_medicare');
    assert.equal(at.length, 1, '010001 has a per-year row for 164 (CMS publishes no 2024 count for it)');
    const row = Object.fromEntries(HOSPITAL_CSV_HEADER.map((name, i) => [name, at[0][i]]));
    assert.deepEqual([row.cases, row.count_source, row.note], ['', 'none', 'under 11 or none']);
    assert.ok(Number.isFinite(one(rows, 'per_year_total', '32480', '').add_on_per_year));
  });

  test('a non-teaching DSH hospital has traditional rows only; a hospital with no add-ons has no per-year rows and no NaN', () => {
    const dsh = viewOf('010005').csvRows();
    assert.ok(dsh.some((r) => r[col('payer')] === 'traditional_medicare'));
    assert.ok(!dsh.some((r) => r[col('payer')] === 'medicare_advantage'));
    const none = viewOf('030107').csvRows();
    assert.ok(none.slice(1).every((r) => r[col('row_type')] === 'per_case'));
    const r = one(none, 'per_case', '32480', '165');
    assert.deepEqual([r.ime, r.dsh], [0, 0]);
    for (const rows of [dsh, none]) assert.ok(!/NaN|undefined|Infinity|null/.test(csv(rows)));
  });

  test('a hostile hospital name goes through csv()\'s formula guard; no CPT descriptor or label is in the file', () => {
    const record = { ...recordOf('380009'), name: '=HYPERLINK("http://x.example","click")' };
    const view = viewOf('380009', record);
    const text = csv(view.csvRows());
    const line = text.split('\n')[1];
    assert.ok(line.includes('"\'=HYPERLINK(""http://x.example"",""click"")"'), line);
    assert.ok(!text.split('\n').some((row) => row.split(',').some((cell) => /^[=+\-@]/.test(cell) && !/^-\d/.test(cell))), 'a cell starts like a formula');
    const labels = new Set(compared.map((item) => item.label).filter(Boolean));
    assert.ok(![...labels].some((label) => text.includes(label)), 'a procedure label is in the hospital CSV');
  });
});
