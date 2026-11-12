// The revenue-at-stake card: one code's outpatient payment next to the inpatient MS-DRG family it
// would group to. Pure HTML from the normalized model (stake-data.mjs), so the build and the
// browser draw the same card. Inpatient dollars never appear without their range and review status.
import { esc, out } from './views.mjs';
import { agreeHref, wrongHref, STATUS as SI_STATUS } from './site.mjs';

export const BADGE = 'Draft · built with Claude Code · under coder review';

const whole = (n) => Math.round(n).toLocaleString('en-US');
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

/** The prefilled "Mapping reviewed" summary after the fingerprint. */
export function mappingSummary(item) {
  const first = item.map.sets[0];
  const more = item.map.sets.length - 1;
  const pcs = `PCS ${first.codes.map((c) => c.code).join('+')}${more ? ` (+${more} alt)` : ''}`;
  const families = item.ip.families;
  const lead = `DRG ${drgList(families[0].drgs).replace('–', '-')} (${families.length > 1 ? whenLabel(families[0]) : families[0].condition})`;
  return `${pcs} | ${lead}${families.length > 1 ? `; +${families.length - 1} more` : ''}`;
}

/** One sentence: what outpatient pays against the inpatient family. Reads as exposure, not advice. */
export function gapText(item) {
  const d = item.diff;
  const what = item.ip.families.length > 1 ? 'the inpatient DRG families' : 'the inpatient DRG family';
  if (!d) return `No national outpatient rate for ${siText(item.op.si)}, so no difference is shown.`;
  if (d.high <= 0) return `Outpatient pays ${moneyRange(-d.high, -d.low)} less than ${what}.`;
  if (d.low >= 0) return `Outpatient pays ${moneyRange(d.low, d.high)} more than ${what}.`;
  return `Outpatient pays from ${money(-d.low)} less to ${money(d.high)} more than ${what}.`;
}

const NO_COMPARE = {
  packaged: 'Packaged: no separate outpatient payment, so there is nothing to compare. Medicare pays for it inside the payment for the main procedure.',
  anesthesia: 'Anesthesia code, packaged: no separate outpatient payment, and the code describes the anesthesia, not the operation. No comparison.',
  unmapped: 'Not mapped: the code does not name one specific operation (an unlisted procedure, for example), so there is no inpatient DRG family to compare.',
  pending: 'Not mapped yet: the two mapping passes have not been settled, so the inpatient comparison is not shown.',
};
export const noCompareText = (item) => NO_COMPARE[item.kind];

function opLine(item) {
  const op = item.op;
  if (op.rate === null) return `<span class="scard__amt">No national rate</span><span class="scard__what">${esc(siText(op.si).replace(/^s/, 'S'))}</span>`;
  return `<span class="scard__amt">${money(op.rate)}</span><span class="scard__what">APC ${esc(op.apc)}${op.apcTitle ? ` ${esc(op.apcTitle)}` : ''}</span>${op.asc !== null ? `<span class="scard__asc">Surgery center (ASC): ${money(op.asc)}</span>` : ''}`;
}

function familyLine(f, many) {
  const basis = basisText(f.basis);
  const code = f.dx ? ` (${esc(dxCode(f.dx.code))})` : '';
  const lines = many
    ? whenParts(f).map((p) => (p.kind === 'dx' ? `If the principal diagnosis is ${esc(p.text)}${code}` : `If coded as: ${esc(p.text)}`))
    : [`Principal diagnosis: ${esc(f.condition)}${code}`];
  if (basis) lines.push(esc(basis.charAt(0).toUpperCase() + basis.slice(1)));
  return `<div class="scard__fam"><span class="scard__amt">${moneyRange(f.low, f.high)}</span><span class="scard__what">MS-DRG ${esc(drgList(f.drgs))} ${esc(f.name)}</span>`
    + lines.map((line) => `<span class="scard__cond">${line}</span>`).join('')
    + `${f.caveat ? `<span class="scard__caveat">${esc(f.caveat)}</span>` : ''}</div>`;
}

const pct = (n) => `${(n * 100).toFixed(2)}%`;

/** Bars on one dollar scale: hollow for outpatient, filled for each inpatient range. Decorative; the text says it all. */
function scaleBar(item) {
  const top = Math.max(item.op.rate || 0, item.ip.high);
  const lane = (name, bar) => `<div class="sbar__lane"><span class="sbar__name">${esc(name)}</span><span class="sbar__track">${bar}</span></div>`;
  const lanes = [lane('Outpatient', item.op.rate !== null ? `<i class="sbar__op" style="width:${pct(item.op.rate / top)}"></i>` : '')];
  for (const f of item.ip.families) {
    lanes.push(lane(item.ip.families.length > 1 ? `Inpatient, ${whenLabel(f)}` : 'Inpatient', `<i class="sbar__ip" style="left:${pct(f.low / top)};width:${pct(Math.max(f.high - f.low, top * 0.006) / top)}"></i>`));
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

const formLink = (href, text, cls) => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}<span class="sr"> (opens in a new tab)</span></a>`;

/** The full card. title: render the code and label (off on the code's own page, where the h1 says it). */
export function card(item, meta, { title = true } = {}) {
  const head = title ? `<p class="scard__title"><span class="scard__code">${esc(item.code)}</span> <span class="scard__label">${esc(item.label)}</span></p>` : '';
  if (item.kind !== 'compare') {
    return `<article class="scard scard--none" data-stake-card="${esc(item.code)}" data-kind="${esc(item.kind)}">
${head}<p class="scard__none">${esc(noCompareText(item))}</p>
${item.kind === 'pending' || item.kind === 'unmapped' ? `<dl class="scard__pay"><div><dt>Outpatient <span>${esc(meta.years.outpatient)} OPPS</span></dt><dd>${opLine(item)}</dd></div></dl>` : ''}
</article>`;
  }
  const many = item.ip.families.length > 1;
  const tier = item.tier ? `<p class="scard__tier"><strong>Tier ${item.tier.n}.</strong> ${esc(item.tier.why)}</p>` : '';
  const summary = mappingSummary(item);
  return `<article class="scard scard--t${item.tier ? item.tier.n : 0}" data-stake-card="${esc(item.code)}" data-kind="compare">
${head}<p class="scard__status">${statusBadge(item.review)}</p>
<p class="scard__gap">${esc(gapText(item)).replace(/\$[\d,]+–\$[\d,]+/g, (range) => `<span class="nw">${range}</span>`)}</p>
<dl class="scard__pay">
<div class="scard__op"><dt>Outpatient <span>${esc(meta.years.outpatient)} OPPS</span></dt><dd>${opLine(item)}</dd></div>
<div class="scard__ip"><dt>Inpatient <span>${esc(meta.years.inpatient)} IPPS</span></dt><dd>${item.ip.families.map((f) => familyLine(f, many)).join('')}</dd></div>
</dl>
${scaleBar(item)}
${tier}
<p class="scard__fine">National, unadjusted: no wage index, IME or DSH. <span class="scard__draft">${esc(BADGE)}</span></p>
${work(item, meta)}
<p class="scard__act">${formLink(agreeHref(item.code, item.map.fp, summary), 'Agree', 'btn')}${formLink(wrongHref(item.code, item.map.fp, summary), 'Something’s wrong', 'btn btn--quiet')}</p>
</article>`;
}
