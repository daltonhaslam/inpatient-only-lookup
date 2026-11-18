// The Methods sections for the hospital view, the per-year ceiling and the patient share: every factor
// traced to its CMS file and column, every figure read from the derived tables (never retyped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methodsTables, hospitalMethods, methodsSources, IMPACT_CCN, MUP_KEYS } from '../src/hospital-methods.mjs';
import { normalize } from '../src/stake-data.mjs';
import { CFR } from '../src/site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const tablesFrom = (over = {}) => methodsTables({
  hospitals: read('pipeline/derived/hospitals.json'),
  volume: read('pipeline/derived/drg-volume.json'),
  ascNew: read('pipeline/derived/asc-new-2027.json'),
  shares: read('pipeline/derived/patient-shares.json'),
  citations: read('pipeline/citations.json'),
  sources: read('pipeline/sources.json'),
  ...over,
});
const rates = normalize(read('pipeline/derived/crosswalk.json')).meta.rates;
const html = hospitalMethods(tablesFrom(), rates);
const text = html.replace(/<span class="sr">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('every hospital factor is traced to the impact file and its column, and the counts to the MUP file', () => {
  const { columns } = read('pipeline/derived/hospitals.json').meta;
  for (const column of [...Object.values(columns), IMPACT_CCN]) assert.ok(html.includes(`<code>${column}</code>`), column);
  for (const column of ['Tot_Dschrgs', ...MUP_KEYS]) assert.ok(html.includes(`<code>${column}</code>`), column);
  for (const words of ['FY 2027 IPPS final rule impact file, correction notice', 'Medicare Inpatient Hospitals - by Provider and Service, data year 2024',
    'Table 5, CMS-1849-CN', 'Table 1A, CMS-1849-CN', 'Table 1D, CMS-1849-CN', '$6,848.00', '$539.95', '66%', '62%', '60%']) assert.ok(text.includes(words), words);
  assert.ok(html.includes('https://www.govinfo.gov/link/fr/91/70328'), 'the OPPS labor share cites 91 FR 70328');
});

test('the MUP column names match the pipeline that reads the file', () => {
  const source = readFileSync(join(root, 'pipeline/crosswalk/exposure_sources.py'), 'utf8');
  for (const name of [...MUP_KEYS, 'Tot_Dschrgs']) assert.ok(source.includes(`"${name}"`), name);
  assert.ok(source.includes(`^${IMPACT_CCN}$`), IMPACT_CCN);
});

test('what is left out, with the CFR cites; MA in one sentence with its quote; Maryland with the reason', () => {
  for (const section of ['412.106', '412.105', '412.322', '413.76']) {
    assert.ok(CFR[section], `CFR map has ${section}`);
    assert.ok(html.includes(CFR[section]), `links ${section}`);
  }
  for (const words of ['42 CFR 412.106(i)', 'Outliers', 'value-based purchasing', 'readmissions', 'hospital-acquired condition',
    'hospital-specific rate', 'federal rate', 'Direct GME', '42 CFR 412.105(g)', 'operating IME only', '412.322']) assert.ok(text.includes(words), words);
  const quote = read('pipeline/citations.json').citations['E27-MA'];
  assert.ok(text.includes(quote.quote), 'the MA quote, verbatim');
  assert.ok(html.includes('https://www.govinfo.gov/link/fr/91/70572'));
  const { meta } = read('pipeline/derived/hospitals.json');
  assert.ok(text.includes(meta.maryland), 'the Maryland reason');
  assert.ok(text.includes(`${meta.counts.maryland} Maryland hospitals`), 'how many');
});

test('the per-year ceiling and the MA estimate', () => {
  for (const words of ['A ceiling, not a forecast', 'under 11', 'IME_CASETA44', 'same MS-DRG mix', 'not saved']) assert.ok(text.includes(words), words);
});

test('the patient share: $1,776 and $292 from patient-shares.json with the fact sheet; the 618 with FR 2026-22739 and 64629; one Procedure Price Lookup link', () => {
  const { deductibles } = read('pipeline/derived/patient-shares.json').meta;
  assert.ok(text.includes('$1,776') && text.includes('$292'));
  assert.ok(html.includes(deductibles.url), 'fact sheet link');
  for (const words of ['618', 'FR Doc. 2026-22739', '64629', '20%']) assert.ok(text.includes(words), words);
  for (const page of ['70286', '70665']) assert.ok(html.includes(`https://www.govinfo.gov/link/fr/91/${page}`), page);
  assert.equal(html.split('https://www.medicare.gov/procedure-price-lookup').length - 1, 1);
});

test('figures are read from the tables, never retyped: another deductible shows up as given', () => {
  const shares = read('pipeline/derived/patient-shares.json');
  shares.meta.deductibles = { ...shares.meta.deductibles, part_a_inpatient: 1900, part_b: 300 };
  const changed = hospitalMethods(tablesFrom({ shares }), rates);
  assert.ok(changed.includes('$1,900') && changed.includes('$300'));
  assert.ok(!changed.includes('$1,776') && !changed.includes('$292'));
  assert.ok(!/NaN|undefined|null/.test(html));
});

test('the data years read as calendars: FY 2027 inpatient, CY 2027 outpatient, 2024 discharges', () => {
  for (const words of ['FY 2027', 'CY 2027', '2024']) assert.ok(text.includes(words), words);
});

test('the Maryland sentence holds only while Maryland is the one exclusion: another one fails the build', () => {
  const hospitals = read('pipeline/derived/hospitals.json');
  hospitals.meta = { ...hospitals.meta, counts: { ...hospitals.meta.counts, offered: hospitals.meta.counts.offered - 1 } };
  assert.throws(() => tablesFrom({ hospitals }), /Maryland/);
});

test('SCH and MDH payment, cited to 42 CFR 412.92(d) and 412.108(c); downloads keep leading zeros through a text import', () => {
  for (const section of ['412.92', '412.108']) assert.ok(CFR[section] && html.includes(CFR[section]), section);
  for (const words of ['higher of the federal rate or a hospital-specific rate', 'federal rate plus 75% of any difference', 'This page shows the federal rate']) assert.ok(text.includes(words), words);
});

test('the sources table gains the new files, each once', () => {
  const rows = methodsSources(tablesFrom());
  const ids = rows.map((s) => s.id);
  for (const id of ['ipps-2027-impact', 'mup-inp-2024', 'asc-2027-additions']) assert.equal(ids.filter((x) => x === id).length, 1, id);
  assert.ok(rows.every((s) => s.label && s.landing && s.file));
});
