// The hospital view's two folds on each compared card: the split by DRG and the per year table with
// editable counts, run against the real derived tables the way the browser gets them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, clientModel } from '../src/stake-data.mjs';
import { prepare } from '../src/stake-engine.mjs';
import { hospitalList, hospitalRecord, drgSeverity } from '../src/hospital-data.mjs';
import { createView } from '../src/hospital-view.mjs';
import { drgLabel, yearUpdate, addOnName } from '../src/hospital-folds.mjs';
import { ceiling } from '../src/hospital-words.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const hospitals = read('pipeline/derived/hospitals.json');
const volume = read('pipeline/derived/drg-volume.json');
const model = normalize(read('pipeline/derived/crosswalk.json'));
const list = JSON.parse(JSON.stringify(hospitalList(hospitals, model, volume.meta)));
const doc = JSON.parse(JSON.stringify(clientModel(model, [], [])));
const data = prepare(doc);
const recordOf = (ccn) => JSON.parse(JSON.stringify(hospitalRecord(hospitals.hospitals[ccn], volume.volume[ccn], volume.meta.drgs)));
const viewOf = (ccn, record = recordOf(ccn)) => createView({ list, record, ccn, data, meta: doc.meta });
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const folds = (view, code) => {
  const html = view.card(view.data.byCode[code]);
  const at = html.indexOf('<details class="hfold');
  return at < 0 ? '' : html.slice(at, html.indexOf('<p class="scard__fine">'));
};
const fold = (html, kind) => {
  const at = html.indexOf(`data-fold="${kind}"`);
  return at < 0 ? '' : html.slice(html.lastIndexOf('<details', at), html.indexOf('</details>', at));
};
const inputValue = (html, key) => (new RegExp(`data-count="${key}"[^>]*value="([^"]*)"`).exec(html) || new RegExp(`value="([^"]*)"[^>]*data-count="${key}"`).exec(html) || [])[1];

describe('DRG severity labels', () => {
  test('the severity part of a CMS MS-DRG title', () => {
    assert.equal(drgSeverity('Major Chest Procedures without CC/MCC'), 'without CC/MCC');
    assert.equal(drgSeverity('Cervical Spinal Fusion with MCC'), 'with MCC');
    assert.equal(drgSeverity('Back and Neck Procedures Except Spinal Fusion with MCC or Disc Device or Neurostimulator'), 'with MCC or Disc Device or Neurostimulator');
    assert.equal(drgSeverity('Other Kidney and Urinary Tract Procedures with Major O.R. Procedures with CC'), 'with CC');
    assert.equal(drgSeverity('Hand Procedures for Injuries'), null);
  });
  test('the list ships one for each crosswalk DRG that has one, and drgLabel uses it', () => {
    assert.equal(list.meta.drg_sev['165'], 'without CC/MCC');
    assert.equal(list.meta.drg_sev['163'], 'with MCC');
    assert.ok(Object.keys(list.meta.drg_sev).every((drg) => drg in list.meta.drg_weights));
    assert.equal(drgLabel('165', list.meta.drg_sev), '165 without CC/MCC');
    assert.equal(drgLabel('999', list.meta.drg_sev), '999');
  });
});

describe('per year lead', () => {
  test('the ceiling caveat comes from hospital-words ceiling() with the shipped data year and the family\'s DRGs', () => {
    const later = { ...list, meta: { ...list.meta, volume_year: 2025 } };
    const view = createView({ list: later, record: recordOf('380009'), ccn: '380009', data, meta: doc.meta });
    const html = view.card(view.data.byCode['32480']);
    assert.ok(html.includes(ceiling(2025, '163–165')), 'lead');
    assert.ok(!html.includes('2024'), 'no 2024 left in a 2025 view');
  });
});

describe('split by DRG', () => {
  test('OHSU 32480: a row per DRG, to the cent, base + IME + DSH, and why uncompensated care is out', () => {
    const view = viewOf('380009');
    const html = fold(folds(view, '32480'), 'split');
    const t = text(html);
    assert.ok(t.startsWith('The split by DRG · base, IME, DSH'), t.slice(0, 80));
    // A column per DRG, adding down to the total.
    assert.ok(t.includes('MS-DRG 163 with MCC MS-DRG 164 with CC MS-DRG 165 without CC/MCC Base $37,342.99 $20,926.61 $16,049.53 IME '), t);
    assert.ok(t.includes('Total $51,459.44 $28,837.33 $22,116.60'), t);
    assert.ok(t.includes('Uncompensated care is left out'), t);
    assert.ok(t.includes('412.106(i)'));
    // Spec § Rounding: parts and total are each rounded from unrounded values, and the fold says so.
    assert.ok(t.includes('Parts are rounded separately, so they can differ from the total by a cent.'), t);
    assert.ok(!/NaN|undefined|null/.test(t));
  });
  test('a hospital with no add-ons: operating and capital only, no $0 columns', () => {
    const view = viewOf('030107');
    const t = text(fold(folds(view, '32480'), 'split'));
    assert.ok(t.startsWith('The split by DRG · operating and capital, no IME or DSH'), t.slice(0, 90));
    assert.ok(!/<th[^>]*>(IME|DSH)<\/th>/.test(fold(folds(view, '32480'), 'split')), 'no IME or DSH column');
    assert.ok(!/\$0\.00/.test(t), t);
  });
  test('two-family codes get one table per family', () => {
    const view = viewOf('380009');
    const two = view.data.items.find((item) => item.kind === 'compare' && item.ip.families.length > 1);
    assert.equal((fold(folds(view, two.code), 'split').match(/<table/g) || []).length, two.ip.families.length);
  });
});

describe('per year', () => {
  test('OHSU 32480: traditional and MA rows, prefilled, the ceiling in the headline', () => {
    const view = viewOf('380009');
    const html = fold(folds(view, '32480'), 'year');
    const t = text(html);
    assert.ok(t.startsWith('Per year at Ohsu Hospital And Clinics · up to about $1 million, a ceiling'), t.slice(0, 120));
    assert.equal(inputValue(html, '163:trad'), '15');
    assert.equal(inputValue(html, '163:ma'), '17');
    assert.ok(t.includes('$14,116.45') && t.includes('$211,746.79'), '163 traditional');
    assert.ok(t.includes('$10,777.61') && t.includes('$183,219.40'), '163 MA: operating IME only');
    assert.ok(t.includes('$1,015,760.07'), 'total');
    assert.ok(t.includes('A ceiling, not a forecast'));
    assert.ok(t.includes('not saved'));
    assert.ok(t.includes('412.105(g)'));
    assert.match(html, /may not treat a removal from the inpatient-only list as requiring outpatient care \(<a href="https:\/\/www\.govinfo\.gov\/link\/fr\/91\/70572"/);
    assert.match(html, /inputmode="numeric"/);
    assert.match(html, /aria-label="MS-DRG 163, traditional Medicare cases"/);
    assert.match(html, /aria-label="MS-DRG 163, Medicare Advantage cases \(estimate\)"/);
  });
  test('editing a count: the row, the MA estimate, the total and the headline follow; 10 cases of 165 = $60,670.69', () => {
    const view = viewOf('380009');
    const up = view.count('32480', '165:trad', '10');
    assert.equal(up.cells['165:trad'].text, '$60,670.69');
    assert.equal(up.cells['165:ma'].value, String(Math.round(10 * (hospitals.hospitals['380009'].ime_caseta44 / hospitals.hospitals['380009'].caseta44))));
    const exact = 211746.79 + 183219.40 + 268964.15 + 229507.04 + 60670.69 + 11 * 4632.08;
    assert.ok(Math.abs(Number(up.total.replace(/[$,]/g, '')) - exact) < 0.05, up.total);
    assert.match(up.headline, /^up to about \$\d/);
    assert.equal(up.cells['165:trad'].invalid, false);
    // The card redrawn later (a filter change) keeps the typed count.
    assert.equal(inputValue(fold(folds(view, '32480'), 'year'), '165:trad'), '10');
  });
  test('typed values go through count(): only whole numbers of zero or more', () => {
    const view = viewOf('380009');
    for (const bad of ['2.5', '-1', '1e3', 'abc']) {
      const up = view.count('32480', '163:trad', bad);
      assert.equal(up.cells['163:trad'].invalid, true, bad);
      assert.equal(up.cells['163:trad'].note, 'not a whole number', bad);
      assert.equal(up.cells['163:trad'].text, 'no count', bad);
    }
    const cleared = view.count('32480', '163:trad', '');
    assert.equal(cleared.cells['163:trad'].invalid, false);
    assert.equal(cleared.cells['163:trad'].text, 'no count');
    assert.equal(view.count('32480', '163:trad', ' 7 ').cells['163:trad'].invalid, false);
  });
  test('Review Focus 3: a suppressed DRG reads "under 11 or none", stays editable, and the total still works', () => {
    const view = viewOf('010001');
    const html = fold(folds(view, '32480'), 'year');
    const t = text(html);
    assert.equal(inputValue(html, '164:trad'), '');
    assert.ok(t.includes('under 11 or none'), t);
    assert.ok(/up to about \$/.test(t), 'the published DRG still gives a total');
    const up = view.count('32480', '164:trad', '5');
    assert.notEqual(up.cells['164:trad'].text, 'no count');
    assert.equal(up.cells['164:trad'].note, 'under 11 or none', 'still says CMS published none');
  });
  test('Review Focus 3: no counts for the whole family says so, never $0', () => {
    const view = viewOf('010006');
    const t = text(fold(folds(view, '32480'), 'year'));
    assert.ok(t.startsWith(`Per year at ${view.name} · no 2024 counts published`), t.slice(0, 120));
    assert.ok(!/\$0\b|NaN/.test(t.slice(0, 120)));
    const up = view.count('32480', '163:trad', '3');
    assert.match(up.headline, /^up to about \$/);
    const back = view.count('32480', '163:trad', '');
    assert.equal(back.headline, 'no 2024 counts published');
  });
  test('a cleared published count: the headline says no counts entered', () => {
    const view = viewOf('010001');
    const up = view.count('32480', '163:trad', '');
    assert.equal(up.headline, 'no counts entered');
    assert.equal(up.total, 'no counts');
  });
  test('a non-teaching DSH hospital: no MA column (MA cases carry no add-on there)', () => {
    const view = viewOf('010005');
    const html = fold(folds(view, '32480'), 'year');
    assert.ok(html.length > 0);
    assert.ok(!html.includes(':ma"'), 'no MA inputs');
    assert.ok(text(html).includes('Medicare Advantage cases carry no add-on'), text(html));
    assert.match(text(html), /a case: DSH /, 'names only the add-on it gets');
    assert.ok(!text(html).includes('IME + DSH'), text(html));
    assert.equal(view.count('32480', '163:ma', '3'), null, 'no MA count to type');
  });
  test('the per-case label names the add-ons the hospital actually gets', () => {
    assert.equal(addOnName(hospitals.hospitals['380009']), 'IME + DSH');
    assert.equal(addOnName(hospitals.hospitals['010005']), 'DSH');
    assert.equal(addOnName(hospitals.hospitals['110165']), 'capital IME + DSH');
    assert.equal(addOnName({ tchop: 0, tchcp: 0, dshopp: 0, dshcpp: 0.1 }), 'capital DSH');
    assert.equal(addOnName({ tchop: 0.2, tchcp: 0, dshopp: 0, dshcpp: 0 }), 'IME');
    assert.match(text(fold(folds(viewOf('110165'), '32480'), 'year')), /a case: capital IME \+ DSH/);
  });
  test('Review Focus 1: a hospital with no add-ons has no per year fold', () => {
    const view = viewOf('030107');
    assert.equal(fold(folds(view, '32480'), 'year'), '');
  });
  test('a teaching hospital with no MA count in CMS’s file: the MA cell says so', () => {
    const view = viewOf('050242');
    const item = view.data.items.find((i) => i.kind === 'compare' && i.ip.families[0].drgs.some((d) => recordOf('050242').v[d.drg]));
    assert.ok(text(fold(folds(view, item.code), 'year')).includes('no MA count in CMS’s file'));
  });
  test('Puerto Rico (no published counts at all): no NaN, no $0 headline', () => {
    const view = viewOf('400013');
    const t = text(folds(view, '32480'));
    assert.ok(!/NaN|undefined|null|Infinity/.test(t), t);
    assert.ok(t.includes('no 2024 counts published'));
  });
  test('the fold remembers it was open', () => {
    const view = viewOf('380009');
    assert.equal(view.toggle('32480', 'year', true), true);
    assert.match(folds(view, '32480'), /<details class="hfold" data-fold="year"[^>]* open>/);
    // A redrawn card's open fold fires toggle again: nothing changes, the drawn card is kept.
    assert.equal(view.toggle('32480', 'year', true), false);
    view.toggle('32480', 'year', false);
    assert.doesNotMatch(folds(view, '32480'), / open>/);
  });
  test('yearUpdate is the same shaping the fold draws from', () => {
    const view = viewOf('380009');
    const item = view.data.byCode['32480'];
    const up = yearUpdate(item, view.ctx, {});
    assert.equal(up.cells['163:trad'].text, '$211,746.79');
    assert.equal(up.cells['163:ma'].value, '17');
    assert.equal(up.cells['163:ma'].note, 'estimate');
    assert.equal(up.total, '$1,015,760.07');
  });
});

describe('Review Focus 4 and safety', () => {
  test('no comparison: no folds', () => {
    const view = viewOf('380009');
    for (const item of view.data.items.filter((i) => i.kind !== 'compare')) assert.equal(folds(view, item.code), '', item.code);
  });
  test('a typed value is never put into HTML unescaped', () => {
    const view = viewOf('380009');
    view.count('32480', '163:trad', '"><img src=x onerror=alert(1)>');
    const html = folds(view, '32480');
    assert.ok(!html.includes('<img'), 'escaped');
    assert.ok(html.includes('&quot;&gt;&lt;img'));
  });
  test('a count for a DRG not in the card is ignored', () => {
    const view = viewOf('380009');
    assert.equal(view.count('32480', '999:trad', '5'), null);
    assert.equal(view.count('32480', '163:xx', '5'), null);
    assert.equal(view.count('nope', '163:trad', '5'), null);
  });
});
