// The revenue-at-stake card: one code's outpatient payment next to the inpatient MS-DRG family it
// would group to. Pure HTML from the normalized model (stake-data.mjs), so the build and the
// browser draw the same card. Inpatient dollars never appear without their range and review status.
import { num } from './engine.mjs';
import { esc, out } from './views.mjs';
import { agreeHref, wrongHref, STATUS as SI_STATUS } from './site.mjs';

export const BADGE = 'Draft · built with Claude Code · under coder review';

const whole = (n) => num(Math.round(n));
export const money = (n) => `$${whole(n)}`;
export const cents = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const moneyRange = (low, high) => (whole(low) === whole(high) ? money(low) : `${money(low)}–${money(high)}`);

/** "163–165" for a run of DRG numbers, else "689, 690, 694". */
export function drgList(drgs) {
  const numbers = drgs.map((d) => Number(d.drg));
  const run = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  return run && drgs.length > 1 ? `${drgs[0].drg}–${drgs[drgs.length - 1].drg}` : drgs.map((d) => d.drg).join(', ');
}

/** ICD-10-CM with its dot: C3411 -> C34.11. */
export const dxCode = (code) => (code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code);

export const STATUS = {
  unreviewed: 'Unreviewed',
  'one-agrees': 'One reviewer agrees',
  disputed: 'Disputed',
  'agree-needs-tiebreak': 'Two reviewers agree · needs a tiebreak',
  confirmed: 'Confirmed by coders',
};
export function statusText(review) {
  if (review.status === 'one-agrees' && review.needsInpatient) return 'Reviewers agree · needs an inpatient coder';
  return STATUS[review.status] || STATUS.unreviewed;
}
export const statusBadge = (review) => `<span class="badge badge--${esc(review.status)}">${esc(statusText(review))}</span>`;

/** "CY 2027" -> the two year lines the site uses everywhere. */
export function yearLines(meta) {
  const cy = Number(String(meta.years.outpatient).replace(/\D/g, ''));
  const fy = Number(String(meta.years.inpatient).replace(/\D/g, ''));
  return {
    outpatient: `Outpatient: CY ${cy} OPPS (from Jan 1, ${cy})`,
    inpatient: `Inpatient: FY ${fy} IPPS (Oct 1, ${fy - 1} – Sep 30, ${fy})`,
  };
}

const BASIS = {
  medical: 'groups by diagnosis (no operating-room procedure in MS-DRG terms)',
};
const basisText = (basis) => BASIS[basis] || (basis.startsWith('unrelated') ? 'unrelated to principal diagnosis: the operating-room procedure is outside the diagnosis’s MDC' : '');

/** "status indicator Q1 (outpatient service, packaged when ...)" for a code with no national rate. */
export const siText = (si) => (si ? `status indicator ${si}${SI_STATUS[si] ? ` (${SI_STATUS[si]})` : ''}` : 'no status indicator');

/** What selects a family when a code has several: diagnosis, operation variant, or both. */
function whenParts(f) {
  const when = f.when || { dx: f.condition, variant: null };
  const parts = [];
  if (when.dx) parts.push({ kind: 'dx', text: when.dx });
  if (when.variant) parts.push({ kind: 'variant', text: when.variant });
  return parts.length ? parts : [{ kind: 'dx', text: f.condition }];
}
export const whenLabel = (f) => whenParts(f).map((p) => (p.kind === 'dx' ? p.text : `coded as ${p.text}`)).join(', ');
/** A second or later family in the CSV: "alternative family (depends on diagnosis)", or on the operation
 * variant, or both. pipeline/crosswalk/workbook.py ALT_FLAG says the same in the workbook. */
export const alternativeLabel = (f) => `alternative family (depends on ${whenParts(f).map((p) => (p.kind === 'dx' ? 'diagnosis' : 'operation variant')).join(' and ')})`;

/** The prefilled "Mapping reviewed" summary after the fingerprint. */
export function mappingSummary(item) {
  if (item.map.summary) return item.map.summary;   // precomputed in the browser model
  const first = item.map.sets[0];
  const more = item.map.sets.length - 1;
  const pcs = `PCS ${first.codes.map((c) => c.code).join('+')}${more ? ` (+${more} alt)` : ''}`;
  const families = item.ip.families;
  const lead = `DRG ${drgList(families[0].drgs).replace('–', '-')} (${families.length > 1 ? whenLabel(families[0]) : families[0].condition})`;
  return `${pcs} | ${lead}${families.length > 1 ? `; +${families.length - 1} more` : ''}`;
}

/**
 * One sentence: what outpatient pays against the inpatient family. Reads as exposure, not advice. As
 * parts [before, range, after] when it has a dollar range (so the card can keep the range on one line),
 * else [sentence]. lead: "Outpatient pays", or a hospital's conditional "If billed outpatient, <H> is paid".
 */
export function gapParts(item, lead = 'Outpatient pays') {
  const d = item.diff;
  const what = item.ip.families.length > 1 ? 'the inpatient DRG families' : 'the inpatient DRG family';
  if (!d) return [`No national outpatient rate for ${siText(item.op.si)}, so no difference is shown.`];
  if (d.high <= 0) return [`${lead} `, moneyRange(-d.high, -d.low), ` less than ${what}.`];
  if (d.low >= 0) return [`${lead} `, moneyRange(d.low, d.high), ` more than ${what}.`];
  return [`${lead} from ${money(-d.low)} less to ${money(d.high)} more than ${what}.`];
}

/**
 * A family's IME and DSH as "$6,067–$14,116" (the card says "Includes <range> in IME and DSH"), or ''
 * when it carries none: no hospital picked (national items have no addOn), no add-ons, or both ends round to $0.
 */
const addOnRange = (addOn) => (addOn && (whole(addOn.low) !== '0' || whole(addOn.high) !== '0') ? moneyRange(addOn.low, addOn.high) : '');

/**
 * What a card says around its figures. NATIONAL_CARD is the national card; hospital-view.mjs builds a
 * hospital's: gapLead (the gap sentence's start), ascLabel, rateNote (under the outpatient rate), opNote
 * (after the surgery-center line), fine (the fine print) and workLink (link text to the code page's
 * national work in place of Show the work; null: the card's own).
 */
const NATIONAL_CARD = Object.freeze({
  gapLead: 'Outpatient pays', ascLabel: 'Surgery center (ASC)', rateNote: '', opNote: '',
  fine: 'National, unadjusted: no wage index, IME or DSH.', workLink: null,
});

const NO_COMPARE = {
  packaged: 'Packaged: no separate outpatient payment, so there is nothing to compare. Medicare pays for it inside the payment for the main procedure.',
  anesthesia: 'Anesthesia code, packaged: no separate outpatient payment, and the code describes the anesthesia, not the operation. No comparison.',
  unmapped: 'Not mapped: the code does not name one specific operation (an unlisted procedure, for example), so there is no inpatient DRG family to compare.',
  pending: 'Not mapped yet: the two mapping passes have not been settled, so the inpatient comparison is not shown.',
};
export const noCompareText = (item) => NO_COMPARE[item.kind];

function opLine(item, v = NATIONAL_CARD) {
  const op = item.op;
  if (op.rate === null) return `<span class="scard__amt">No national rate</span><span class="scard__what">${esc(siText(op.si).replace(/^s/, 'S'))}</span>`;
  return `<span class="scard__amt">${money(op.rate)}</span><span class="scard__what">APC ${esc(op.apc)}${op.apcTitle ? ` ${esc(op.apcTitle)}` : ''}</span>`
    + (v.rateNote ? `<span class="scard__cond">${esc(v.rateNote)}</span>` : '')
    + (op.asc !== null ? `<span class="scard__asc">${esc(v.ascLabel)}: ${money(op.asc)}</span>` : '')
    + (v.opNote ? `<span class="scard__asc">${esc(v.opNote)}</span>` : '');
}

function familyLine(f, many) {
  const basis = basisText(f.basis);
  const code = f.dx ? ` (${esc(dxCode(f.dx.code))})` : '';
  const lines = many
    ? whenParts(f).map((p) => (p.kind === 'dx' ? `If the principal diagnosis is ${esc(p.text)}${code}` : `If coded as: ${esc(p.text)}`))
    : [`Principal diagnosis: ${esc(f.condition)}${code}`];
  if (basis) lines.push(esc(basis.charAt(0).toUpperCase() + basis.slice(1)));
  const addOn = addOnRange(f.addOn);
  return `<div class="scard__fam"><span class="scard__amt">${moneyRange(f.low, f.high)}</span><span class="scard__what">MS-DRG ${esc(drgList(f.drgs))} ${esc(f.name)}</span>`
    + (addOn ? `<span class="scard__addon">Includes <b class="nw">${addOn}</b> in IME and DSH</span>` : '')
    + lines.map((line) => `<span class="scard__cond">${line}</span>`).join('')
    + `${f.caveat ? `<span class="scard__caveat">${esc(f.caveat)}</span>` : ''}</div>`;
}

// Not views.pct: that one gives 3 decimals (timeline ticks), and these bars are drawn to 2; reusing it
// would change every card's markup for no visible gain.
const pct = (n) => `${(n * 100).toFixed(2)}%`;

/**
 * Bars on one dollar scale: hollow for outpatient, filled for each inpatient range. Decorative; the text
 * says it all. With a hospital's add-ons (exactly when the card says "Includes $A–$B"), the top of each
 * inpatient range gets an end segment in its own color for the top DRG's IME and DSH: the dollars above
 * that DRG's base payment (never left of the range's low end). Its legend is a swatch of that color, not
 * a word like "darker", which is not true in dark mode or forced colors.
 */
function scaleBar(item) {
  const top = Math.max(item.op.rate || 0, item.ip.high);
  // key: the add-on legend, right after "Inpatient" so a long family name after it is what truncates.
  const lane = (name, bar, key = '', rest = '') => `<div class="sbar__lane"><span class="sbar__name">${esc(name)}${key}${esc(rest)}</span><span class="sbar__track">${bar}</span></div>`;
  const lanes = [lane('Outpatient', item.op.rate !== null ? `<i class="sbar__op" style="width:${pct(item.op.rate / top)}"></i>` : '')];
  const addOnPart = (f) => {
    if (!addOnRange(f.addOn)) return '';
    const from = Math.max(f.high - f.addOn.high, f.low);
    return `<i class="sbar__add" style="left:${pct(from / top)};width:${pct((f.high - from) / top)}"></i>`;
  };
  for (const f of item.ip.families) {
    const add = addOnPart(f);
    lanes.push(lane('Inpatient', `<i class="sbar__ip" style="left:${pct(f.low / top)};width:${pct(Math.max(f.high - f.low, top * 0.006) / top)}"></i>${add}`,
      add ? ' <span class="sbar__keyed">(<i class="sbar__key"></i>IME and DSH)</span>' : '', item.ip.families.length > 1 ? `, ${whenLabel(f)}` : ''));
  }
  return `<div class="sbar" aria-hidden="true">${lanes.join('')}<div class="sbar__axis"><span>$0</span><span>${money(top)}</span></div></div>`;
}

const srcLink = (meta, id, text) => {
  const source = meta.sources.find((s) => s.id === id);
  return source ? out(source.landing, esc(text || source.label)) : esc(text || id);
};

function work(item, meta) {
  const { map, ip, op } = item;
  const rates = meta.rates;
  const years = yearLines(meta);
  const sets = map.sets.map((s) => `<li>${s.codes.map((c) => `<code>${esc(c.code)}</code> ${esc(c.title)}`).join(' <em>with</em> ')}${s.note ? ` <span class="work__note">(${esc(s.note)})</span>` : ''}</li>`).join('');
  const dx = map.dx.map((d) => `<li><code>${esc(dxCode(d.code))}</code> ${esc(d.title)}${d.condition ? ` <span class="work__note">(${esc(d.condition)})</span>` : ''}${d.role === 'alternative' ? ' <span class="work__note">alternative that changes the family</span>' : ''}</li>`).join('');
  const families = ip.families.map((f) => {
    const rows = f.drgs.map((d) => `<tr><th scope="row">${esc(d.drg)}</th><td>${esc(d.title)}</td><td class="num">${d.weight.toFixed(4)}</td><td class="num">${cents(d.amount)}</td></tr>`).join('');
    const basis = basisText(f.basis);
    const index = f.indexRows.map((r) => `<li><code>${esc(r.pcs)}</code> ${r.drgs.length
      ? `MDC ${esc(r.mdc)}, DRGs ${esc(r.drgs.join(', '))}${r.family ? ` ${esc(r.family)}` : ''}${r.nonOr ? ' (non-OR)' : ''}`
      : ''}${r.note ? ` <span class="work__note">${esc(r.note)}</span>` : (r.drgs.length ? '' : ' no row for this family')}</li>`).join('');
    return `<p class="work__fam">MDC ${esc(f.mdc || '')}, ${esc(f.name)}${ip.families.length > 1 ? `, ${esc(whenLabel(f).replace(/^(?!coded as)/, 'for '))}` : ''}${basis ? `: ${esc(basis)}` : ''}</p>
${index ? `<p class="work__sub">MS-DRG v44 Appendix E rows behind it:</p><ul class="work__list">${index}</ul>` : ''}${f.caveat ? `<p class="work__stale">${esc(f.caveat)}</p>` : ''}
<div class="scroll" tabindex="0" role="region" aria-label="MS-DRG ${esc(drgList(f.drgs))} amounts"><table class="work__drgs"><thead><tr><th scope="col">MS-DRG</th><th scope="col">Title</th><th scope="col" class="num">Weight</th><th scope="col" class="num">Weight × ${cents(rates.combined)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
  const sum = item.diff && op.rate !== null
    ? `<p>${cents(op.rate)} − ${cents(ip.high)} = ${cents(item.diff.low)}; ${cents(op.rate)} − ${cents(ip.low)} = ${cents(item.diff.high)}. Negative means outpatient pays less.</p>` : '';
  const proposed = op.proposed && op.proposed.rate !== null
    ? ` The CY 2027 proposed rule had APC ${esc(op.proposed.apc || 'none')} at ${cents(op.proposed.rate)} (${srcLink(meta, 'addenda-2027-proposed', 'proposed Addendum B')}).` : '';
  const stale = item.review.stale ? `<p class="work__stale">The mapping changed after ${item.review.stale === 1 ? 'one earlier review' : `${item.review.stale} earlier reviews`}; ${item.review.stale === 1 ? 'it no longer counts' : 'they no longer count'}.</p>` : '';
  return `<details class="scard__work"><summary>Show the work</summary>
<div class="work">
<p class="work__h">ICD-10-PCS: any one of these ${map.sets.length === 1 ? 'set' : 'sets'}</p>
<ul class="work__list">${sets}</ul>
<p class="work__h">Expected principal diagnosis</p>
<ul class="work__list">${dx}</ul>
<p class="work__h">MS-DRG v44 family and national amounts</p>
${families}
<p>Each amount is the DRG’s relative weight × ${cents(rates.combined)}: the ${cents(rates.operating)} operating standardized amount plus the ${cents(rates.capital)} capital federal rate. National, unadjusted: no wage index, IME, DSH or outlier (${srcLink(meta, 'ipps-2027-table5', 'Table 5')}; ${srcLink(meta, 'ipps-2027-table1', 'Tables 1A and 1D')}; ${srcLink(meta, 'msdrg-v44', 'MS-DRG v44 definitions')}).</p>
<p class="work__h">Outpatient</p>
<p>${op.rate !== null ? `Status indicator ${esc(op.si)}, APC ${esc(op.apc)}${op.apcTitle ? ` ${esc(op.apcTitle)}` : ''}, national rate ${cents(op.rate)} (${srcLink(meta, 'addenda-2027', 'CY 2027 Addenda A and B')}).` : `Status indicator ${esc(op.si || 'none')}: no national rate.`}${op.asc !== null ? ` Surgery-center rate ${cents(op.asc)} (${srcLink(meta, 'asc-2027-aa', 'ASC Addendum AA')}).` : ''}${proposed}</p>
${sum}
<p class="work__h">Who mapped it</p>
<p>${map.passesAgree ? `Two separate AI mapping passes, made with Claude, agree on ${ip.families.length > 1 ? 'these DRG families' : 'this DRG family'}.` : 'Two AI mapping passes, made with Claude, disagreed; an adjudicating pass chose this mapping.'}${map.rationale ? ` Mapper’s note: ${esc(map.rationale)}` : ''}${map.adjudication ? ` Adjudicator’s note: ${esc(map.adjudication)}` : ''}</p>
${stale}
<p class="work__meta">Mapping <code>${esc(map.fp)}</code>. ${esc(years.outpatient)}. ${esc(years.inpatient)}. <a href="/revenue-at-stake/methods/">Methods</a></p>
</div>
</details>`;
}

/**
 * The full card. title: render the code and label (off on the code's own page, where the h1 says it).
 * detail: include Show the work (off in the browser, which links to the code page instead).
 * variant: the words around the figures (NATIONAL_CARD, or a hospital's from hospital-view.mjs, whose
 * workLink also keeps the national Show the work off the card). An item from hospital-math.mjs
 * hospitalItem() carries each family's IME and DSH, drawn as an "Includes" line and the bar's end
 * segment. folds: HTML for the hospital's folded sections, placed before the fine print.
 * A code with no comparison draws the same with or without a hospital.
 */
export function card(item, meta, { title = true, detail = true, variant = NATIONAL_CARD, folds = '' } = {}) {
  const head = title ? `<p class="scard__title"><span class="scard__code">${esc(item.code)}</span> <span class="scard__label">${esc(item.label)}</span></p>` : '';
  if (item.kind !== 'compare') {
    return `<article class="scard scard--none" data-stake-card="${esc(item.code)}" data-kind="${esc(item.kind)}">
${head}<p class="scard__none">${esc(noCompareText(item))}</p>
${item.kind === 'pending' || item.kind === 'unmapped' ? `<dl class="scard__pay"><div><dt>Outpatient <span>${esc(meta.years.outpatient)} OPPS</span></dt><dd>${opLine(item)}</dd></div></dl>` : ''}
</article>`;
  }
  const many = item.ip.families.length > 1;
  const gap = gapParts(item, variant.gapLead).map((part, i) => (i === 1 && part.includes('–') ? `<span class="nw">${esc(part)}</span>` : esc(part))).join('');
  const tier = item.tier ? `<p class="scard__tier"><strong>Tier ${item.tier.n}.</strong> ${esc(item.tier.why)}</p>` : '';
  return `<article class="scard scard--t${item.tier ? item.tier.n : 0}" data-stake-card="${esc(item.code)}" data-kind="compare">
${head}<p class="scard__status">${statusBadge(item.review)}</p>
<p class="scard__gap">${gap}</p>
<dl class="scard__pay">
<div class="scard__op"><dt>Outpatient <span>${esc(meta.years.outpatient)} OPPS</span></dt><dd>${opLine(item, variant)}</dd></div>
<div class="scard__ip"><dt>Inpatient <span>${esc(meta.years.inpatient)} IPPS</span></dt><dd>${item.ip.families.map((f) => familyLine(f, many)).join('')}</dd></div>
</dl>
${scaleBar(item)}
${tier}${folds}
<p class="scard__fine">${esc(variant.fine)} <span class="scard__draft">${esc(BADGE)}</span></p>
${detail && !variant.workLink ? work(item, meta) : `<p class="scard__more"><a href="/code/${esc(item.code)}/#stake-h">${esc(variant.workLink || `Show the work for ${item.code}`)}</a></p>`}
<p class="scard__act">${out(agreeHref(item.code, item.map.fp, mappingSummary(item)), 'Agree', 'btn')}${out(wrongHref(item.code, item.map.fp, mappingSummary(item)), 'Something’s wrong', 'btn btn--quiet')} <a class="scard__batch" href="/revenue-at-stake/help-review/">Review a batch of 10 →</a></p>
</article>`;
}
