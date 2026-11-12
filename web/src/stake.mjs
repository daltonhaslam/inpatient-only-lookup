// Revenue at stake: the three section pages, the block on each removed code's page, and the CSV.
// Build-time only. Reads the normalized model from stake-data.mjs, never crosswalk.json keys.
import { SITE, CFR, claimHref } from './site.mjs';
import { formatDate, num, plural, csv as toCsv } from './engine.mjs';
import { esc, out, cfr } from './views.mjs';
import { layout } from './pages.mjs';
import { BADGE, card, money, moneyRange, cents, drgList, dxCode, statusText, noCompareText, yearLines, alternativeLabel } from './stake-card.mjs';

export const ROOT = '/revenue-at-stake/';
export const PATHS = [ROOT, `${ROOT}help-review/`, `${ROOT}methods/`];
const INPATIENT_CREDS = 'CCS, CIC, CDIP, CCDS, RHIA, RHIT, or MD or DO';

/** Everything the pages need, derived once: {model, credits, groups, xlsx, items, byGroup, progress}. */
export function stakeContext(model, credits, groups, { xlsx = false } = {}) {
  const items = Object.values(model.codes);
  const present = new Set(items.map((item) => item.group));
  const shown = groups.filter(([id]) => present.has(id));
  const byGroup = Object.fromEntries(shown.map(([id]) => [id, items.filter((item) => item.group === id)]));
  const compared = items.filter((item) => item.kind === 'compare');
  const progress = {
    compared: compared.length,
    reviewed: compared.filter((item) => item.review.status !== 'unreviewed').length,
    confirmed: compared.filter((item) => item.review.status === 'confirmed').length,
    disputed: compared.filter((item) => item.review.status === 'disputed').length,
    packaged: items.filter((item) => item.kind === 'packaged' || item.kind === 'anesthesia').length,
    unmapped: items.filter((item) => item.kind === 'unmapped' || item.kind === 'pending').length,
  };
  return { model, credits, groups: shown, summary: coverage(items.length, progress), groupName: Object.fromEntries(groups), xlsx, items, byGroup, progress };
}


/** "922 procedures left the list; 852 have a comparison; the rest ..." from the data, never assumed. */
function coverage(total, p) {
  const rest = [p.packaged ? `${num(p.packaged)} have no separate outpatient payment (packaged)` : '',
    p.unmapped ? `${num(p.unmapped)} name no single operation to map` : ''].filter(Boolean);
  return { total, compared: p.compared, rest: rest.join(' and ') };
}
/** One sentence for the home page and the meta description. */
export const coverageSentence = (stake) => `Of the ${num(stake.summary.total)} procedures removed from Medicare’s inpatient-only list in 2026 and 2027, ${num(stake.summary.compared)} have a comparison${stake.summary.rest ? `; ${stake.summary.rest}` : ''}.`;
const draft = () => `<p class="draft">${esc(BADGE)}</p>`;

function guardrail() {
  return `<section class="block guard" aria-labelledby="guard-h">
<h2 id="guard-h">Before you use these numbers</h2>
<ul class="plain">
<li><strong>Outpatient-eligible is not outpatient-only.</strong> Removal from the list lets Medicare pay for a procedure in either setting. It does not require the outpatient setting.</li>
<li><strong>Status decisions stay clinical.</strong> Whether a patient is admitted is decided case by case under the two-midnight rule (${cfr('412.3', '42 CFR 412.3')}), not by what either setting pays. Use these figures to know your exposure, not to choose a setting.</li>
<li><strong>An estimate of revenue at stake, not a forecast.</strong> It shows the per-case difference if a case moves. It does not predict how many cases move, or which DRG in the family a case lands in.</li>
<li><strong>Not billing or legal advice.</strong> The mappings are a draft made by AI passes and are being checked by coders. A card’s review status says how far that has got.</li>
</ul>
</section>`;
}

function years(meta) {
  const lines = yearLines(meta);
  return `<p class="stake__years">${esc(lines.outpatient)}<br>${esc(lines.inpatient)}</p>`;
}

// ---- the main page ------------------------------------------------------------------------

function tableRow(item) {
  const compare = item.kind === 'compare';
  const op = item.op.rate !== null ? money(item.op.rate) : (item.op.si === 'N' ? 'Packaged' : `No rate (SI ${esc(item.op.si || 'none')})`);
  const many = compare && item.ip.families.length > 1;
  const ip = compare
    ? `${moneyRange(item.ip.low, item.ip.high)}<span class="stab__sub">${many ? `${item.ip.families.length} families` : `MS-DRG ${esc(drgList(item.ip.families[0].drgs))}`}</span>`
    : `<span class="stab__sub">${item.kind === 'pending' ? 'Not mapped yet' : 'No comparison'}</span>`;
  const status = compare ? esc(statusText(item.review)) : '<span class="stab__sub">Not applicable</span>';
  const attrs = `data-code="${esc(item.code)}" data-group="${esc(item.group)}" data-kind="${esc(item.kind)}" data-status="${esc(compare ? item.review.status : '')}" data-tier="${item.tier ? item.tier.n : ''}" data-year="${item.year}"`;
  return `<tr ${attrs}><th scope="row"><a href="/code/${esc(item.code)}/#stake-h">${esc(item.code)}</a></th><td>${esc(item.label)}</td><td class="num">${op}</td><td class="num">${ip}</td><td>${status}</td></tr>`;
}

function codeTables(stake) {
  const jump = stake.groups.map(([id, name]) => `<a href="#g-${esc(id)}">${esc(name)} <span class="stab__n">${num(stake.byGroup[id].length)}</span></a>`).join('');
  const tables = stake.groups.map(([id, name]) => `<section class="stab" aria-labelledby="g-${esc(id)}">
<h3 id="g-${esc(id)}">${esc(name)}</h3>
<div class="scroll"><table class="stab__table" aria-labelledby="g-${esc(id)}">
<thead><tr><th scope="col">Code</th><th scope="col">Procedure</th><th scope="col" class="num">Outpatient</th><th scope="col" class="num">Inpatient family</th><th scope="col">Review</th></tr></thead>
<tbody>${stake.byGroup[id].map(tableRow).join('')}</tbody></table></div>
</section>`).join('\n');
  return `<section class="block" aria-labelledby="all-h" data-stake-table>
<h2 id="all-h">All ${num(stake.items.length)} codes</h2>
<p>Outpatient is the national CY 2027 rate. Inpatient is the national low–high range of the MS-DRG family. Open a code for its card: both payments, the difference, the review status and the work behind it.</p>
<nav class="stab__jump" aria-label="Body systems">${jump}</nav>
${tables}
</section>`;
}

function progressBar(stake) {
  const { compared, reviewed, confirmed } = stake.progress;
  const share = compared ? reviewed / compared : 0;
  return `<div class="meter">
<p class="meter__text"><strong>${num(reviewed)} of ${num(compared)}</strong> compared codes reviewed by a coder; ${num(confirmed)} confirmed.</p>
<div class="meter__bar" aria-hidden="true"><span style="width:${(share * 100).toFixed(2)}%"></span></div>
</div>`;
}

function downloads(stake) {
  const excel = stake.xlsx ? '<a class="btn" href="/data/revenue-at-stake.xlsx" download>Download Excel</a>' : '';
  return `<p class="stake__actions">${excel}<a class="btn${stake.xlsx ? ' btn--quiet' : ''}" href="/data/revenue-at-stake.csv" download>Download CSV</a><a class="btn btn--quiet" href="${ROOT}help-review/">Help review</a></p>`;
}

export function mainPage(ctx) {
  const stake = ctx.stake;
  const { meta } = stake.model;
  const body = `<section class="stake-head" aria-labelledby="stake-h1">
<h1 id="stake-h1">Revenue at stake</h1>
<p class="lede">${coverageSentence(stake)} For those ${num(stake.summary.compared)}: what outpatient pays next to the inpatient MS-DRG family the same operation would group to, national and unadjusted, from CMS’s ${esc(meta.years.outpatient)} and ${esc(meta.years.inpatient)} final rules.</p>
${draft()}
${years(meta)}
${progressBar(stake)}
${downloads(stake)}
</section>
${guardrail()}
<div class="stake-app" data-stake-app></div>
${codeTables(stake)}
<p class="note">How the mappings, families and amounts are built, and their limits: <a href="${ROOT}methods/">Methods</a>.</p>`;
  return layout(ctx, {
    path: ROOT, page: 'stake', title: 'Revenue at stake: outpatient vs inpatient payment for removed procedures', body,
    description: `${coverageSentence(stake)} For those, the national CY 2027 outpatient payment next to the FY 2027 inpatient MS-DRG family range, with each mapping’s coder-review status.`,
  });
}

// ---- help review --------------------------------------------------------------------------

function batchTable(stake) {
  const { model } = stake;
  const byGroup = new Map();
  for (const batch of model.meta.batches) (byGroup.get(batch.group) || byGroup.set(batch.group, []).get(batch.group)).push(batch);
  return stake.groups.filter(([id]) => byGroup.has(id)).map(([id, name]) => {
    const rows = byGroup.get(id).map((batch) => {
      const open = batch.codes.filter((code) => model.codes[code] && model.codes[code].review.status === 'unreviewed').length;
      const codes = batch.codes.map((code) => `<a href="/code/${esc(code)}/#stake-h">${esc(code)}</a>`).join(' ');
      return `<tr><th scope="row">${esc(batch.id)}</th><td class="stab__codes">${codes}</td><td class="num">${num(open)} of ${num(batch.codes.length)}</td><td>${out(claimHref(batch.id), `Claim ${esc(batch.id)}`)}</td></tr>`;
    }).join('');
    return `<section class="stab" aria-labelledby="b-${esc(id)}"><h3 id="b-${esc(id)}">${esc(name)}</h3>
<div class="scroll"><table class="stab__table"><thead><tr><th scope="col">Batch</th><th scope="col">Codes</th><th scope="col" class="num">Unreviewed</th><th scope="col">Claim</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join('\n');
}

function creditList(stake) {
  const confirmed = stake.items.filter((item) => item.kind === 'compare' && item.review.status === 'confirmed')
    .sort((a, b) => String(b.review.last || '').localeCompare(String(a.review.last || '')) || a.code.localeCompare(b.code));
  const names = new Map();
  for (const rows of Object.values(stake.credits)) {
    for (const row of rows) names.set(row.name, row.credential);
  }
  if (!confirmed.length && !names.size) {
    return '<p>No code is confirmed yet. Reviewers who give a name are thanked here after each update.</p>';
  }
  const codes = confirmed.slice(0, 40).map((item) => {
    const who = (stake.credits[item.code] || []).map((row) => esc(row.name)).join(', ');
    return `<li><a href="/code/${esc(item.code)}/#stake-h">${esc(item.code)}</a> ${esc(item.label)}${item.review.last ? `, ${formatDate(item.review.last)}` : ''}${who ? `. Thanks to ${who}.` : ''}</li>`;
  }).join('');
  const people = [...names.keys()].sort((a, b) => a.localeCompare(b)).map((name) => `<li>${esc(name)}</li>`).join('');
  return `${codes ? `<h3>Recently confirmed</h3><ul class="plain">${codes}</ul>` : ''}${people ? `<h3>Reviewers</h3><ul class="credits">${people}</ul>` : ''}`;
}

export function helpPage(ctx) {
  const stake = ctx.stake;
  const { progress } = stake;
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${ROOT}">Revenue at stake</a> <span aria-hidden="true">/</span> <span>Help review</span></nav>
<h1>Help review the crosswalk</h1>
<p class="lede">Each code’s map from CPT to ICD-10-PCS and an expected principal diagnosis was made by two AI passes. Coders can tell us where they are wrong. ${num(progress.reviewed)} of ${num(progress.compared)} compared codes have a review so far.</p>
${draft()}

<section class="block" aria-labelledby="how-h">
<h2 id="how-h">How a review works</h2>
<ol class="plain steps">
<li>Open a code’s page and its “Show the work”: the ICD-10-PCS codes, the expected principal diagnosis, the MS-DRG family and the arithmetic.</li>
<li>If you would code it the same way, press <strong>Agree</strong>. If not, press <strong>Something’s wrong</strong> and say what you would code instead. Each opens a short Google Form in a new tab with the code and the mapping filled in. Leave those as they are.</li>
<li>Pick your credential. Add a name if you want credit; leave it blank to stay anonymous.</li>
<li>Reviews are added at the next update, and the card’s status changes then.</li>
</ol>
</section>

<section class="block" aria-labelledby="count-h">
<h2 id="count-h">What makes a code confirmed</h2>
<ul class="plain">
<li><strong>Confirmed:</strong> two different reviewers agree with the current mapping, at least one with an inpatient coding credential (${INPATIENT_CREDS}), and no one has disputed it.</li>
<li><strong>Each reviewer counts once.</strong> Agreements under the same name count as one reviewer. Anonymous agreements with the same credential in the same hour also count as one.</li>
<li><strong>Tier 3 codes</strong>, where the DRG family depends on the principal diagnosis or on which variant of the operation is coded, or where the two AI passes disagreed, also need a tiebreak. Two reviewers agreeing show “Two reviewers agree · needs a tiebreak”.</li>
<li><strong>Disputed:</strong> a reviewer said something is wrong. It stays disputed until the mapping is changed or the dispute is settled.</li>
<li><strong>A changed mapping starts over.</strong> Each review records the mapping it saw. When a mapping changes, earlier reviews stop counting and the card says so.</li>
</ul>
<p>Any credential is welcome, outpatient and professional coders included. Inpatient coders and CDI specialists are the reviewers we most need, because the question is how the inpatient claim would be coded and grouped.</p>
</section>

<section class="block" aria-labelledby="phi-h">
<h2 id="phi-h">No patient information</h2>
<p>Don’t put any patient information in a form: no names, dates of birth, record numbers or details about anyone’s care. If you checked a mapping against your own claims, share only totals, for example “of our 40 cases, 70% grouped to DRG 165”. Answers go to a private sheet. Contributions are published under the site’s MIT license, and your name appears only if you give one.</p>
</section>

<section class="block" aria-labelledby="batch-h">
<h2 id="batch-h">Take a batch</h2>
<p>The ${plural(stake.model.meta.batches.length, 'batch', 'batches')} below hold about ten codes each, grouped by body system. Claiming one tells others you are on it; then use the review buttons on each code’s card. Unreviewed counts are as of ${formatDate(stake.model.meta.built)}.</p>
${batchTable(stake)}
</section>

<section class="block" aria-labelledby="credit-h">
<h2 id="credit-h">Credit</h2>
${creditList(stake)}
</section>`;
  return layout(ctx, {
    path: `${ROOT}help-review/`, page: 'stake-help', title: 'Help review the revenue-at-stake crosswalk', body,
    description: 'How credentialed coders can review the CPT to ICD-10-PCS and MS-DRG mappings behind Revenue at stake: what a review does, what makes a code confirmed, and batches by body system to claim.',
  });
}

// ---- methods ------------------------------------------------------------------------------

export function methodsPage(ctx) {
  const stake = ctx.stake;
  const { meta } = stake.model;
  const r = meta.rates;
  const lines = yearLines(meta);
  const tiers = meta.counts.tiers;
  const drg165 = stake.items.flatMap((item) => (item.ip ? item.ip.families : [])).flatMap((f) => f.drgs).find((d) => d.drg === '165');
  const formula = drg165 ? ` For example, DRG 165 (major chest procedures without CC/MCC) is its relative weight, ${drg165.weight.toFixed(4)}, × ${cents(r.combined)}.` : '';
  const files = meta.sources.map((s) => `<tr><td>${out(s.landing, esc(s.label))}</td><td>${esc(s.file).replace(/; /g, '<br>')}</td></tr>`).join('');
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${ROOT}">Revenue at stake</a> <span aria-hidden="true">/</span> <span>Methods</span></nav>
<h1>Revenue at stake: methods</h1>
<p class="lede">How each card’s two payments are found, where every number comes from, and what the comparison cannot tell you.</p>
${draft()}

<section class="block" aria-labelledby="m-steps-h">
<h2 id="m-steps-h">Method</h2>
<ol class="plain steps">
<li><strong>Which codes.</strong> The ${num(meta.counts.codes)} codes that left the inpatient-only list on January 1, 2026 (${num(meta.counts.removed2026)}) or January 1, 2027 (${num(meta.counts.removed2027)}), from this site’s own history of CMS’s Addendum B files.</li>
<li><strong>CPT to ICD-10-PCS.</strong> Each code was mapped to the ICD-10-PCS codes a hospital would report for the same operation as an inpatient, with an expected principal diagnosis. Some codes have several alternative sets (a different lobe, a different approach). Two separate AI passes made the maps without seeing each other’s work; where they grouped to different DRG families, a third pass chose. Every PCS and ICD-10-CM code is checked against the FY 2027 code sets.</li>
<li><strong>ICD-10-PCS to an MS-DRG family.</strong> A small grouper written for this project places each set and diagnosis in an MS-DRG family from the MS-DRG v44 Definitions Manual: the diagnosis gives the MDC, and the highest operating-room procedure in that MDC’s surgical hierarchy gives the family. With no operating-room procedure, the family is the diagnosis’s medical DRGs. With an operating-room procedure outside the diagnosis’s MDC, it is the “unrelated” family (981–983 or 987–989). This is the surgical-family part of a grouper, not the full MS-DRG software; it does not pick the severity level within a family, which is why each family is a range.</li>
<li><strong>Inpatient payment.</strong> Each DRG’s FY 2027 relative weight × (${cents(r.operating)} operating standardized amount + ${cents(r.capital)} capital federal rate) = weight × ${cents(r.combined)}. The family’s range runs from its lowest-weighted DRG (usually without CC/MCC) to its highest (with MCC).</li>
<li><strong>Outpatient payment.</strong> The code’s CY 2027 status indicator, APC and national payment rate from the final rule’s Addendum B, with the APC title from Addendum A, and the surgery-center rate from ASC Addendum AA where CMS lists the code.</li>
<li><strong>The difference.</strong> Outpatient rate minus the inpatient range. A negative number means outpatient pays less.</li>
</ol>
</section>

<section class="block" aria-labelledby="m-years-h">
<h2 id="m-years-h">Two different years</h2>
<p>${esc(lines.outpatient)}. ${esc(lines.inpatient)}. The two systems run on different calendars, so these are the rates in force for a case on January 1, 2027. An inpatient case after September 30, 2027 is paid on FY 2028 rates.</p>
</section>

<section class="block" aria-labelledby="m-nat-h">
<h2 id="m-nat-h">National, unadjusted</h2>
<p>Every dollar figure here is a national amount with no hospital-specific adjustment: ${esc(r.adjusters)}. A hospital’s own inpatient payment is usually higher. Its wage index adjusts the labor share of the operating amount, and teaching (IME) and disproportionate-share (DSH) add-ons raise it further. Published hand-worked examples, such as a figure of about $20,000 for a lobectomy, may include those adjustments. The figures here include none of them.${formula}</p>
<p>Outpatient payments are wage-adjusted too (60% of the rate), but get no IME or DSH add-on. ${stake.xlsx ? 'The Excel download has an Inputs tab where you can enter your own wage index, IME and DSH; every amount recalculates.' : ''}</p>
</section>

<section class="block" aria-labelledby="m-tier-h">
<h2 id="m-tier-h">Tiers and review status</h2>
<p>Each mapped code gets a tier, computed from the mapping passes, never set by hand.</p>
<ul class="plain">
<li><strong>Tier 1</strong> (${num(tiers['1'] || 0)} codes): two separate AI mapping passes agree on one DRG family. Not yet checked by a coder.</li>
<li><strong>Tier 2</strong> (${num(tiers['2'] || 0)}): one family, but several PCS codes are reported together, the passes chose different PCS codes, or the family comes from the diagnosis rather than an in-MDC operation.</li>
<li><strong>Tier 3</strong> (${num(tiers['3'] || 0)}): the family depends on the principal diagnosis, on which variant of the operation is done and how it is coded, or both; or the two passes disagreed and an adjudicating pass chose the mapping. Each family is labeled with what selects it. Reviewers wanted.</li>
</ul>
<p>The two passes are not fully independent: both are AI, working from the code, CMS’s short descriptor and this site’s label, not from the AMA’s full descriptors. Agreement makes a wrong map less likely, not impossible. A coder’s review is what moves a code to confirmed. <a href="${ROOT}help-review/">How review works</a></p>
</section>

${guardrail()}

<section class="block" aria-labelledby="m-lim-h">
<h2 id="m-lim-h">Limits</h2>
<ul class="plain">
<li>Facility payment only. The surgeon’s professional fee is the same idea under a different fee schedule and is not shown.</li>
<li>Packaged codes (status indicator N) and anesthesia codes are listed without a comparison: they have no separate outpatient payment.</li>
<li>The range is the whole MS-DRG family. Where a real case lands depends on its secondary diagnoses (CC/MCC), which this cannot know.</li>
<li>The expected principal diagnosis is one typical choice, with an alternative only where it changes the family. Real cases vary.</li>
<li>Outliers, transfers, post-acute transfer reductions, new-technology add-on payments and device credits are not modelled.</li>
<li>Fee-for-service Medicare only. Medicare Advantage and other payers pay on their own contracts.</li>
<li>Labels are this site’s own plain-language names, not CPT descriptors, and may be less specific than the code.</li>
</ul>
</section>

<section class="block" aria-labelledby="m-own-h">
<h2 id="m-own-h">Run it on your own claims</h2>
<p>A national family range is a starting point. A hospital can replace it with its own experience:</p>
<ol class="plain steps">
<li>Pull your Medicare inpatient claims from the last year or two with an ICD-10-PCS procedure code listed on these cards.</li>
<li>Count which MS-DRG each claim grouped to. That is your own distribution within the family, CC and MCC included.</li>
<li>Weight the DRG amounts by that distribution, using your own wage index, IME and DSH (the Excel Inputs tab does this arithmetic).</li>
<li>Compare with the outpatient APC rate adjusted by your wage index, for the cases that could have been outpatient under the two-midnight rule.</li>
</ol>
<p>If you do, and you can share only totals (no patient information), a correction through <a href="${ROOT}help-review/">Help review</a> improves the estimate for everyone.</p>
</section>

<section class="block" aria-labelledby="m-ai-h">
<h2 id="m-ai-h">Built with Claude Code</h2>
<p>This section was built by ${esc(SITE.author)} using Claude Code, Anthropic’s AI coding tool. Claude wrote the pipeline, the grouper and the pages, made the two mapping passes and the adjudications, and wrote the first-pass diagnosis choices. Each build checks, and fails if any check fails, that every PCS and ICD-10-CM code is valid in the FY 2027 code sets; that every PCS set and diagnosis regroups to its family and traces to an MS-DRG v44 Appendix E row; that DRG weights, titles and MDCs match Table 5 and Appendix A; that APC and surgery-center rates match the addenda; that every dollar amount and difference recomputes to the cent; and that no published text copies a CPT descriptor. None of that checks whether a mapping is the right clinical or coding choice; only the coders who review it do. Until a card says confirmed, treat its mapping as a draft.</p>
</section>

<section class="block" aria-labelledby="m-src-h">
<h2 id="m-src-h">Sources</h2>
<p>Every number on a card comes from one of these CMS files.</p>
<div class="scroll"><table class="check files">
<thead><tr><th scope="col">Source</th><th scope="col">Files read</th></tr></thead>
<tbody>${files}</tbody></table></div>
<ul class="plain">
<li>Operating: ${esc(r.operatingTable)}: ${cents(r.operating)}.</li>
<li>Capital: ${esc(r.capitalTable)}: ${cents(r.capital)}.</li>
<li>Weights: ${esc(r.weightsTable)}.</li>
<li>${esc(r.version)}.</li>
</ul>
<p>Regulations: ${out(CFR['412.3'], '42 CFR 412.3')} (inpatient admissions and the two-midnight rule).</p>
</section>

<section class="block" aria-labelledby="m-upd-h">
<h2 id="m-upd-h">Updates and downloads</h2>
<p>Built ${formatDate(meta.built)}. Rebuilt each October for the new fiscal year’s inpatient weights, rates and grouper version, and each January for the new calendar year’s outpatient rates and the next removals from the list. Coder reviews are added between those updates; a status changes only when they are.</p>
<p>${stake.xlsx ? '<a href="/data/revenue-at-stake.xlsx" download>Download Excel</a> (live formulas off an Inputs tab) or ' : ''}<a href="/data/revenue-at-stake.csv" download>download the CSV</a>: one row per code and DRG family, plain values. No AMA content: codes and this site’s labels only. ${out(SITE.repo, 'The code and the mappings')} are public under the MIT license.</p>
</section>`;
  return layout(ctx, {
    path: `${ROOT}methods/`, page: 'stake-methods', title: 'Revenue at stake: methods and sources', body,
    description: 'How Revenue at stake maps removed inpatient-only procedures to ICD-10-PCS and MS-DRG families, prices them from the FY 2027 IPPS and CY 2027 OPPS final rules, and what the national, unadjusted comparison cannot tell you.',
  });
}

// ---- the block on each code page ----------------------------------------------------------

export function codeBlock(ctx, code) {
  const stake = ctx.stake;
  const item = stake.model.codes[code];
  if (!item) return '';
  return `<section class="block stake-block" aria-labelledby="stake-h" data-stake-code="${esc(code)}">
<h2 id="stake-h">Revenue at stake</h2>
<p class="stake-block__lede">Left the list ${formatDate(item.removed)}. ${item.kind === 'compare' ? 'What Medicare pays for it as a hospital outpatient, next to the inpatient MS-DRG family the same operation would group to.' : 'Why there is no payment comparison for it:'}</p>
${card(item, stake.model.meta, { title: false })}
<p class="stake-block__more"><a href="${ROOT}">All ${num(stake.items.length)} removed codes</a> <span aria-hidden="true">/</span> <a href="${ROOT}methods/">How the numbers are built</a></p>
</section>`;
}

// ---- downloads ----------------------------------------------------------------------------

export const CSV_HEADER = ['code', 'label', 'body_system', 'removed', 'outpatient_status_indicator', 'apc', 'apc_title',
  'outpatient_rate', 'asc_rate', 'comparison', 'family_order', 'principal_dx', 'principal_dx_condition', 'coded_as', 'mdc', 'drg_family',
  'drgs', 'inpatient_low', 'inpatient_high', 'outpatient_minus_inpatient_low', 'outpatient_minus_inpatient_high', 'tier',
  'review_status', 'mapping_fingerprint'];

const round2 = (n) => Math.round(n * 100) / 100;
const blank = (n) => (n === null || n === undefined ? '' : n);

/** One row per code and inpatient family (a code with no comparison is one row). Plain values, no formulas. */
export function csvRows(stake) {
  const rows = [CSV_HEADER];
  for (const item of stake.items) {
    const base = [item.code, item.label, stake.groupName[item.group] || item.group, item.removed, item.op.si || '', item.op.apc || '',
      item.op.apcTitle || '', blank(item.op.rate), blank(item.op.asc)];
    if (item.kind !== 'compare') {
      rows.push([...base, noCompareText(item), ...CSV_HEADER.slice(base.length + 1).map(() => '')]);
      continue;
    }
    item.ip.families.forEach((f, i) => {
      const diff = item.op.rate === null ? ['', ''] : [round2(item.op.rate - f.high), round2(item.op.rate - f.low)];
      rows.push([...base, 'compared', i === 0 ? 'primary' : alternativeLabel(f), f.dx ? dxCode(f.dx.code) : '',
        f.condition, f.when && f.when.variant ? f.when.variant : '', f.mdc || '', f.name, f.drgs.map((d) => d.drg).join(' '), f.low, f.high, ...diff,
        item.tier ? item.tier.n : '', item.review.status, item.map.fp]);
    });
  }
  return rows;
}
export const csvText = (stake) => toCsv(csvRows(stake));
