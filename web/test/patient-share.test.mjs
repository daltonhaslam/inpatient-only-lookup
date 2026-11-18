// The ASC patient-share line (patient-share.mjs): code pages of the compared codes and the lookup
// answer for CMS's 2027 ASC additions. National, whole dollars at display, deductibles from the file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packShare, shareHtml, sharesFile, lookupShare } from '../src/patient-share.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const shares = read('pipeline/derived/patient-shares.json');
const ascNew = read('pipeline/derived/asc-new-2027.json');
const deductibles = shares.meta.deductibles;
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

describe('packShare', () => {
  test('the four figures the line needs, unrounded; null when a share is missing', () => {
    assert.deepEqual(packShare(shares.codes['32480']), [316.996, 716.99, 0, 0]);
    assert.deepEqual(packShare(shares.codes['0202T']), [4674.348, 1776, 1, 1]);
    assert.equal(packShare(shares.codes['64629']), null);
    assert.equal(packShare(undefined), null);
  });
});

describe('shareHtml', () => {
  test('32480: both shares in whole dollars and the Part B deductible from the file', () => {
    const t = text(shareHtml(packShare(shares.codes['32480']), deductibles));
    assert.equal(t, 'about $317 at a surgery center, $717 in the hospital outpatient department, plus the $292 Part B deductible in either. Most Medigap plans pay the coinsurance; Medicare Advantage plans set their own.');
  });
  test('ASC higher: the line leads with it, and names the hospital cap', () => {
    const html = shareHtml(packShare(shares.codes['0202T']), deductibles);
    const t = text(html);
    assert.equal(t, 'more at a surgery center, about $4,674, than the $1,776 in the hospital outpatient department (capped at the inpatient deductible), plus the $292 Part B deductible in either. Most Medigap plans pay the coinsurance; Medicare Advantage plans set their own.');
    assert.match(html, /^<strong>more at a surgery center<\/strong>/);
  });
  test('capped but the ASC is still lower: the cap is named, the order is normal', () => {
    const [code] = Object.entries(shares.codes).find(([, s]) => s.opps_capped && s.asc_more === false);
    const t = text(shareHtml(packShare(shares.codes[code]), deductibles));
    assert.match(t, /^about \$[\d,]+ at a surgery center, \$1,776 in the hospital outpatient department \(capped at the inpatient deductible\), plus/);
  });
  test('asc_more compares unrounded values: the flag comes from the file, never from rounded dollars', () => {
    const t = text(shareHtml([300.4, 300.6, 0, 0], deductibles));
    assert.ok(t.startsWith('about $300 at a surgery center, $301'), t);
    const more = text(shareHtml([300.6, 300.4, 1, 0], deductibles));
    assert.ok(more.startsWith('more at a surgery center, about $301, than the $300'), more);
  });
  test('the deductible is never retyped: a different file gives a different line', () => {
    assert.ok(text(shareHtml([100, 200, 0, 0], { part_b: 300 })).includes('$300 Part B deductible'));
  });
  test('every compared code has a line with no missing number', () => {
    let n = 0;
    for (const [code, s] of Object.entries(shares.codes)) {
      const packed = packShare(s);
      if (!packed) continue;
      n += 1;
      assert.ok(!/NaN|undefined|null/.test(shareHtml(packed, deductibles)), code);
    }
    assert.equal(n, shares.meta.counts.compared);
  });
});

describe('the lookup file', () => {
  const file = sharesFile(shares, ascNew);
  test('only the 2027 ASC additions that leave the list and have shares (64629 and the packaged codes have none)', () => {
    const expected = Object.keys(ascNew.codes).filter((code) => ascNew.codes[code].ipo_removed && packShare(shares.codes[code]));
    assert.deepEqual(Object.keys(file.c).sort(), expected.sort());
    assert.ok(!('64629' in file.c));
    assert.deepEqual(file.c['32480'], [316.996, 716.99, 0, 0]);
    assert.equal(file.d.part_b, deductibles.part_b);
    assert.ok(JSON.stringify(file).length < 20000, `${JSON.stringify(file).length} bytes`);
  });
  test('an addition that never left the inpatient-only list gets no line, even with an ASC rate', () => {
    // A future non-IPO addition with a rate (fixture: a compared code that has both shares, added with
    // ipo_removed false), and 64629 given a rate: neither is in the file, so the build's one-removal-date
    // check (build.mjs patientShares) never sees them.
    const extra = Object.keys(shares.codes).find((code) => !(code in ascNew.codes) && packShare(shares.codes[code]));
    assert.ok(extra, 'a compared code outside the 2027 additions');
    const fixture = { ...ascNew, codes: { ...ascNew.codes, [extra]: { pi: 'G2', ipo_removed: false } } };
    const rated = { ...shares, codes: { ...shares.codes, 64629: shares.codes['32480'] } };
    const out = sharesFile(rated, fixture);
    assert.ok(!(extra in out.c), extra);
    assert.ok(!('64629' in out.c), '64629');
    assert.deepEqual(Object.keys(out.c).sort(), Object.keys(file.c).sort());
    assert.ok(Object.keys(out.c).every((code) => fixture.codes[code].ipo_removed === true));
  });
  test('lookupShare: the line once the code is off the list, not before, and never for a code not added', () => {
    assert.equal(lookupShare(file, '32480', 'off', '2027-03-01', '2027-01-01').startsWith('About $317'), true);
    assert.equal(lookupShare(file, '32480', 'ipo', '2026-11-11', '2027-01-01'), '');
    assert.equal(lookupShare(file, '32480', 'off', '2026-12-31', '2027-01-01'), '');
    assert.equal(lookupShare(file, '27447', 'off', '2027-03-01', '2020-01-01'), '');
    assert.equal(lookupShare(null, '32480', 'off', '2027-03-01', '2027-01-01'), '');
    const more = Object.keys(file.c).find((code) => file.c[code][2] === 1);
    assert.match(lookupShare(file, more, 'off', '2027-03-01', '2027-01-01'), /^<strong>More at a surgery center<\/strong>/);
  });
});
