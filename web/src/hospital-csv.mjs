// The hospital CSV: "Download for <Hospital> (CSV)", built in the browser after a pick from the same
// math the cards and folds draw (hospital-math.mjs), with the counts someone typed. Pure: rows of plain
// values; the page turns them into text with engine.mjs csv(), whose formula-injection guard covers every
// cell (the hospital's name comes from CMS's file but is treated as untrusted).
// One table under one header row, so a spreadsheet or a script reads it as is: first a per_case row per
// compared code and MS-DRG (the split by DRG, with the hospital's outpatient payment and the gap), then,
// for a hospital with add-ons, the per-year rows of each code (a row per DRG and payer, then the code's
// per_year_total). Codes and DRG numbers only: no procedure labels, so no CPT descriptor can ride along.
import { alternativeLabel } from './stake-card.mjs';
import { splitRows, perYearTable, count, round2 } from './hospital-math.mjs';
import { EMPTY, ceiling } from './hospital-words.mjs';
import { blank } from './engine.mjs';

export const HOSPITAL_CSV_HEADER = ['row_type', 'ccn', 'hospital', 'code', 'family_order', 'drg', 'payer',
  'hospital_outpatient', 'inpatient_base', 'ime', 'dsh', 'inpatient_total', 'outpatient_minus_inpatient',
  'cases', 'count_source', 'add_on_per_case', 'add_on_per_year', 'note'];

export const hospitalCsvName = (ccn) => `revenue-at-stake-${ccn}.csv`;

const PAYER = { trad: 'traditional_medicare', ma: 'medicare_advantage' };
const CEILING = ceiling(2024);   // the counts' data year, as the folds and count_source cms_2024 name it
const familyOrder = (item, i) => (i === 0 ? 'primary' : alternativeLabel(item.ip.families[i]));

/** A row from named cells; every other column is empty. */
const row = (cells) => HOSPITAL_CSV_HEADER.map((name) => blank(cells[name]));

/**
 * Where a per-year count came from, and what the note says: 'typed' (a number, or a cleared or invalid
 * box: then no count), 'cms_2024' (traditional, as published), 'estimate' (MA, traditional × the
 * hospital's MA ratio), or 'none' (CMS published nothing to count or scale).
 */
function source(payer, cell, typed, ratio) {
  if (typed !== undefined) {
    if (count(typed) !== null) return ['typed', 'your count'];
    if (String(typed).trim() === '') return ['typed', 'cleared'];
    return ['typed', 'not a whole number; not counted'];
  }
  if (cell.count === null) return ['none', payer === 'trad' ? EMPTY.suppressed : EMPTY[cell.reason] || ''];
  if (payer === 'trad') return ['cms_2024', ''];
  return ['estimate', `estimate: ${ratio.toFixed(2)} MA cases per traditional case (CMS impact file), same MS-DRG mix assumed`];
}

/**
 * Every row of the file, header first. items: prepare()'s national items (the hospital's amounts are
 * computed here from ctx, unrounded, and rounded once); ctx: hospitalContext(); edits: Map code ->
 * {DRG: {trad, ma}}, the text typed into each card's per-year table.
 */
export function hospitalCsvRows({ items, ctx, ccn, name, edits = new Map() }) {
  const compared = items.filter((item) => item.kind === 'compare');
  const who = { ccn, hospital: name };
  const perCase = compared.flatMap((item) => {
    const op = item.op.rate === null ? null : ctx.outpatient(item.op.rate);
    return splitRows(item, ctx).flatMap((family, i) => family.rows.map((r) => row({
      ...who, row_type: 'per_case', code: item.code, family_order: familyOrder(item, i), drg: r.drg,
      hospital_outpatient: op === null ? null : round2(op), inpatient_base: r.base, ime: r.ime, dsh: r.dsh, inpatient_total: r.total,
      outpatient_minus_inpatient: op === null ? null : round2(op - ctx.payment(r.drg).total),
    })));
  });
  // A hospital with no add-ons has no per-year table (nothing to add up a year), here as on the card.
  const perYear = !ctx.addOns ? [] : compared.flatMap((item) => {
    const typed = edits.get(item.code) || {};
    const table = perYearTable(item, ctx, typed);
    const lines = table.rows.flatMap((r) => ['trad', 'ma'].filter((payer) => r[payer]).map((payer) => {
      const cell = r[payer];
      const [from, why] = source(payer, cell, typed[r.drg]?.[payer], ctx.maRatio);
      return row({
        ...who, row_type: 'per_year', code: item.code, family_order: familyOrder(item, r.family), drg: r.drg, payer: PAYER[payer],
        cases: cell.count, count_source: from, add_on_per_case: cell.perCase, add_on_per_year: cell.perYear,
        note: [payer === 'ma' ? 'operating IME only' : '', why].filter(Boolean).join('; '),
      });
    }));
    return [...lines, row({ ...who, row_type: 'per_year_total', code: item.code, add_on_per_year: table.total, note: table.total === null ? `No counts. ${CEILING}` : CEILING })];
  });
  return [HOSPITAL_CSV_HEADER, ...perCase, ...perYear];
}
