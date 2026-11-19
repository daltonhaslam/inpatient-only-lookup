// The two folded sections a compared card gains after a hospital is picked: "The split by DRG" (base,
// the add-ons the hospital gets and total per DRG, to the cent) and "Per year at <hospital>" (the add-ons
// on its cases in those DRGs, with counts anyone can change). Pure: strings in, HTML strings out; the
// hospital bundle's DOM code (hospital-picker.mjs) applies yearUpdate() to the card when a count changes.
// Every string from data or from a typed count goes through esc(); figures come from cents().
import { esc, fr, cfr, scroller } from './views.mjs';
import { cents, drgList, whenLabel } from './stake-card.mjs';
import { splitRows, perYearTable, count } from './hospital-math.mjs';
import { EMPTY, roughMoney, ceiling, MA_MIX, MA_ADD_ON, addOnName, partsWords, series } from './hospital-words.mjs';

const PAYERS = { trad: 'traditional Medicare', ma: 'Medicare Advantage' };

// The folds' fixed prose (HTML). The functions below fill in names and ratios (a hospital's name through
// esc(); the add-on words are fixed, from hospital-words.mjs addOnsOf()). Spec § Rounding: each figure is rounded
// once from unrounded parts, so the parts need not add to the total.
const ROUNDING = 'Parts are rounded separately, so they can differ from the total by a cent.';
const SPLIT_NOTE = {
  addOns: (addOns) => `Base is operating plus capital payment with this hospital’s wage index and capital GAF; ${partsWords(addOns)}. Uncompensated care is left out: it is a fixed yearly amount, settled at cost report, not lost per case (${cfr('412.106', '42 CFR 412.106(i)')}). Outliers are left out too. ${ROUNDING}`,
  none: () => `With this hospital’s wage index and capital GAF. This hospital gets no IME or DSH. Outliers are left out. ${ROUNDING}`,
};
const YEAR_LEAD = (year, drgs) => `${esc(ceiling(year, drgs))} Change any count and the row, total and heading follow; your counts are not saved.`;
const YEAR_NOTES = {
  teaching: (ratio, addOns) => {
    const onMa = series(addOns.filter((a) => a.ma).map((a) => a.name));
    const tradOnly = series(addOns.filter((a) => !a.ma).map((a) => a.name));
    return [
      `${onMa} is paid on traditional Medicare and Medicare Advantage cases${tradOnly ? `, ${tradOnly} on traditional Medicare only` : ''}: MA cases carry ${MA_ADD_ON} only (${cfr('412.105', '42 CFR 412.105(g)')}).`,
    `MA plans must follow the 2-midnight rule and may not treat a removal from the inpatient-only list as requiring outpatient care (${fr('91 FR 70572')}); the risk is that they default removed procedures to outpatient anyway, so MA cases count here. MA counts are estimates${ratio === null ? '' : ` (${esc(ratio.toFixed(2))} MA cases per traditional case in CMS’s impact file)`}. ${esc(MA_MIX)}`,
      `Direct GME is not counted: it follows the Medicare and MA share of inpatient days, so it falls slightly and later (${cfr('413.76', '42 CFR 413.76')}). Medicaid GME is separate and state-run; commercial payers pay no add-on.`,
    ];
  },
  other: (addOns) => [`${series(addOns.map((a) => a.name))} ${addOns.length > 1 ? 'are' : 'is'} paid on traditional Medicare cases only. Medicare Advantage cases carry no add-on at a hospital without ${MA_ADD_ON} (${cfr('412.105', '42 CFR 412.105(g)')}), and commercial payers pay none.`],
  source: (year) => `Traditional counts: CMS’s Medicare Inpatient Hospitals by Provider and Service, ${esc(year)}. CMS does not publish a count under 11.`,
};

/** "165 without CC/MCC": the DRG and the severity part of its title (hospitals list meta.drg_sev). */
export const drgLabel = (drg, sev = {}) => (sev[drg] ? `${drg} ${sev[drg]}` : drg);

const id = (...parts) => `hf-${parts.map((p) => String(p).replace(/[^0-9A-Za-z]/g, '')).join('-')}`;

function fold(kind, open, summary, body) {
  return `<details class="hfold" data-fold="${kind}"${open ? ' open' : ''}><summary>${summary}</summary>
<div class="hfold__body">${body}</div></details>`;
}

/**
 * The split by DRG: one table per family (named when a code has several), and what is left out. Only the
 * add-ons the hospital gets have a row (a DSH-only hospital has no IME row of $0.00s).
 */
function splitFold(item, ctx, { name, addOns, sev, open }) {
  const families = splitRows(item, ctx);
  const many = families.length > 1;
  // A column per DRG, its parts above its total: three DRGs fit a 400 px phone. A capital-only add-on's
  // row says so ("Capital IME").
  const rowLabel = (a) => (a.side === 'capital' ? `Capital ${a.name}` : a.name);
  const parts = ctx.addOns ? [['Base', 'base'], ...addOns.map((a) => [rowLabel(a), a.name.toLowerCase()])] : [['Operating', 'operating'], ['Capital', 'capital']];
  const tables = families.map((family, i) => {
    const source = item.ip.families[i];
    const capId = id(item.code, 's', i);
    const caption = `MS-DRG ${drgList(source.drgs)} ${family.name}${many ? `, ${whenLabel(source)}` : ''}: payment per case at ${name}`;
    const row = (label, key) => `<tr><th scope="row">${label}</th>${family.rows.map((r) => `<td class="num">${cents(r[key])}</td>`).join('')}</tr>`;
    return scroller(capId, `<table class="hsplit"><caption class="${many ? 'hfold__cap' : 'sr'}" id="${capId}">${esc(caption)}</caption>
<thead><tr><td></td>${family.rows.map((r) => `<th scope="col" class="num">MS-DRG ${esc(drgLabel(r.drg, sev))}</th>`).join('')}</tr></thead>
<tbody>${parts.map(([label, key]) => row(label, key)).join('')}</tbody><tfoot>${row('Total', 'total')}</tfoot></table>`);
  }).join('');
  const note = (ctx.addOns ? SPLIT_NOTE.addOns : SPLIT_NOTE.none)(addOns);
  const sub = ctx.addOns ? ['base', ...addOns.map((a) => a.name)].join(', ') : 'operating and capital, no IME or DSH';
  return fold('split', open, `The split by DRG <span class="hfold__sub">· ${sub}</span>`, `${tables}<p class="hfold__note">${note}</p>`);
}

/**
 * Everything the per-year fold shows that changes with the counts: {table (perYearTable), cells, total,
 * headline (after "Per year at <hospital> ·")}. cells: {"<DRG>:trad" | "<DRG>:ma": {text (the row's
 * figure a year), value (what its count box holds: the typed text, else the CMS count or MA estimate),
 * note (the line under the box), invalid (typed, but not a whole number)}}. edits: {DRG: {trad, ma}},
 * the text typed (see count()).
 */
export function yearUpdate(item, ctx, edits = {}) {
  const table = perYearTable(item, ctx, edits);
  const cells = {};
  for (const row of table.rows) {
    const typed = edits[row.drg] || {};
    for (const payer of ['trad', 'ma']) {
      const cell = row[payer];
      if (!cell) continue;
      // The note under the box, from perYearTable's source. A traditional cell CMS published no count for
      // keeps saying so after a count is typed in.
      const invalid = cell.source === 'invalid';
      cells[`${row.drg}:${payer}`] = {
        text: cell.perYear === null ? 'no count' : cents(cell.perYear),
        value: typed[payer] !== undefined ? String(typed[payer]) : cell.count === null ? '' : String(cell.count),
        note: invalid ? 'not a whole number'
          : payer === 'trad' ? (cell.suppressed ? EMPTY.suppressed : '')
            : cell.source === 'estimate' ? 'estimate' : cell.source === 'none' ? EMPTY[cell.reason] : '',
        invalid,
      };
    }
  }
  const published = table.rows.some((row) => count(ctx.volume[row.drg]) !== null);
  return {
    table,
    cells,
    total: table.total === null ? 'no counts' : cents(table.total),
    headline: table.total !== null ? `up to about ${roughMoney(table.total)}, a ceiling` : published ? 'no counts entered' : `no ${ctx.year} counts published`,
  };
}

function countCell(item, row, payer, cell) {
  const key = `${row.drg}:${payer}`;
  const why = id(item.code, row.drg, payer);
  const label = `MS-DRG ${row.drg}, ${PAYERS[payer]} cases${payer === 'ma' ? ' (estimate)' : ''}`;
  return `<td class="hyr__count"><input class="hyr__n" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" enterkeyhint="done" maxlength="7" size="6"`
    + ` value="${esc(cell.value)}" data-count="${esc(key)}" aria-label="${esc(label)}" aria-describedby="${why}"${cell.invalid ? ' aria-invalid="true"' : ''}>`
    + `<span class="hyr__why" id="${why}">${esc(cell.note)}</span></td>`;
}

// Each row's add-on per case sits under its name, so the table is three columns and fits a 400 px phone.
const perCase = (row, payer, what) => `<span class="hyr__sub">${cents(row[payer].perCase)} a case: ${what}</span>`;
// A row's parts that follow its count carry data-cell="<DRG>:<payer>" (the box, its note and its figure).
const line = (item, row, payer, up, label) => {
  const cell = up.cells[`${row.drg}:${payer}`];
  return `<tr data-cell="${esc(`${row.drg}:${payer}`)}"><th scope="row">${label}</th>${countCell(item, row, payer, cell)}<td class="num hyr__year">${esc(cell.text)}</td></tr>`;
};

/** Per year at the hospital: '' for a hospital with no add-ons (there is nothing a year to count). */
function yearFold(item, ctx, { name, addOns, sev, edits, open }) {
  if (!ctx.addOns) return '';
  const up = yearUpdate(item, ctx, edits);
  const { rows } = up.table;
  const teaching = ctx.teaching === 'teaching';
  const drgs = drgList(rows.map((row) => ({ drg: row.drg })));
  const capId = id(item.code, 'y');
  const what = addOnName(addOns);
  // Teaching: a heading row per DRG, then traditional Medicare and Medicare Advantage under it.
  const body = rows.map((row) => {
    const drg = esc(drgLabel(row.drg, sev));
    if (!teaching) return line(item, row, 'trad', up, `${drg}${perCase(row, 'trad', what)}`);
    return `<tbody><tr class="hyr__drg"><th scope="rowgroup" colspan="3">${drg}</th></tr>
${line(item, row, 'trad', up, `Traditional Medicare${perCase(row, 'trad', what)}`)}
${line(item, row, 'ma', up, `Medicare Advantage${perCase(row, 'ma', `${MA_ADD_ON} only`)}`)}</tbody>`;
  }).join('');
  const table = `<table class="hyr"><caption class="sr" id="${capId}">${series(addOns.map((a) => a.name))} a year on cases in MS-DRG ${esc(drgs)} at ${esc(name)}</caption>
<thead><tr><th scope="col">${teaching ? 'MS-DRG and payer' : 'MS-DRG'}</th><th scope="col">Cases (${esc(ctx.year)})</th><th scope="col" class="num">A year</th></tr></thead>${teaching ? body : `<tbody>${body}</tbody>`}
<tfoot><tr><th scope="row" colspan="2">Total, a ceiling</th><td class="num" data-year-total>${esc(up.total)}</td></tr></tfoot></table>`;
  const notes = [...(teaching ? YEAR_NOTES.teaching(ctx.maRatio, addOns) : YEAR_NOTES.other(addOns)), YEAR_NOTES.source(ctx.year)];
  const lead = `<p class="hfold__lead">${YEAR_LEAD(ctx.year, drgs)}</p>`;
  return fold('year', open, `Per year at ${esc(name)} <span class="hfold__sub">· <span data-year-head>${esc(up.headline)}</span></span>`,
    `${lead}${scroller(capId, table)}<ul class="hfold__notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>`);
}

/**
 * Both folds for one compared card ('' for a code with no comparison, which a hospital does not change).
 * opts: {name, addOns (hospital-words.mjs addOnsOf() of the hospital, computed once per view), sev (DRG
 * severities), edits ({DRG: {trad, ma}} typed for this card), open(kind)}.
 */
export function foldsHtml(item, ctx, { name, addOns, sev = {}, edits = {}, open = () => false }) {
  if (!ctx || item.kind !== 'compare') return '';
  return splitFold(item, ctx, { name, addOns, sev, open: open('split') }) + yearFold(item, ctx, { name, addOns, sev, edits, open: open('year') });
}
