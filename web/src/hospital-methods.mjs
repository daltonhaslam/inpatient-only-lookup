// The Revenue at stake Methods sections for the hospital view, the per-year ceiling and the national
// patient share (stake.mjs methodsPage, at build time). Every figure and source is read from the derived
// tables' meta (hospitals.json, drg-volume.json, asc-new-2027.json, patient-shares.json; the CMS column
// names included), the crosswalk's rates, citations.json (quotes checked against their Federal Register
// pages) and sources.json; none is retyped here.
import { esc, out, fr, cfr, captionedScroller } from './views.mjs';
import { num } from './engine.mjs';
import { cents, money } from './stake-card.mjs';
import { pct as percent, ceiling, MA_MIX } from './hospital-words.mjs';

const PRICE_LOOKUP = 'https://www.medicare.gov/procedure-price-lookup';

const pct = (x) => percent(x, { trim: true });
const code = (name) => `<code>${esc(name)}</code>`;

/**
 * What the sections read, from the raw tables: the four derived tables' meta (hospitals and volume, or
 * ascNew and shares, may be null when the build has no hospital view or no patient share), the quotes (E27-MA, the
 * 618, 64629, the OPPS labor share) and the Federal Register document they come from. Throws if a quote
 * or that document is missing, so the build fails rather than printing a hole.
 */
export function methodsTables({ hospitals, volume, ascNew, shares, citations, sources }) {
  const quote = (id) => {
    const c = citations.citations[id];
    if (!c) throw new Error(`citations.json has no ${id}`);
    return c;
  };
  const quotes = { ma: quote('E27-MA'), asc618: quote('ASC27-618'), asc64629: quote('ASC27-64629'), labor: quote('OPPS27-labor-share') };
  if (hospitals) {
    // The page says Maryland is the one exclusion; another one must change the wording, not hide in it.
    const { in_file: inFile, offered, maryland } = hospitals.meta.counts;
    if (inFile - offered !== maryland) throw new Error(`hospitals.json leaves out ${inFile - offered} hospitals, ${maryland} of them Maryland: Methods says Maryland is the only exclusion`);
  }
  const rule = sources.sources.find((s) => s.id === quotes.asc618.source);
  if (!rule || !rule.doc) throw new Error(`sources.json has no Federal Register document ${quotes.asc618.source}`);
  const meta = (doc) => (doc ? doc.meta : null);
  return { hospitals: meta(hospitals), volume: meta(volume), ascNew: meta(ascNew), shares: meta(shares), quotes, rule };
}

/** Rows for the Methods sources table that the hospital view and the patient share add: {id, label, landing, file}. */
export const methodsSources = (t) => [...(t.hospitals ? [t.hospitals.source, t.volume.source] : []), ...(t.ascNew ? [t.ascNew.source] : [])];

/** The MUP file's count column "by" its CCN and MS-DRG columns. */
const mupKeys = (v) => `${code(v.columns.count)} by ${code(v.columns.ccn)} and ${code(v.columns.drg)}`;

/** The factor table: each figure a hospital's card uses, the file it is read from and the column. */
function factorTable(t, r) {
  const c = t.hospitals.columns;
  const impact = 'Impact file';
  const rows = [
    ['Hospital name and CCN (state from the CCN’s first two digits)', impact, `${code(c.name)}, ${code(c.ccn)}`],
    ['Wage index (inpatient operating and outpatient)', impact, code(c.wi)],
    ['Capital geographic adjustment factor (GAF)', impact, code(c.gaf)],
    ['Operating IME', impact, code(c.tchop)],
    ['Capital IME', impact, code(c.tchcp)],
    ['Operating DSH', impact, code(c.dshopp)],
    ['Capital DSH', impact, code(c.dshcpp)],
    ['Medicare Advantage cases per traditional Medicare case (the MA estimate)', impact, `${code(c.ime_caseta44)} ÷ ${code(c.caseta44)}`],
    ['Hospital type (sole community, Medicare-dependent and others)', impact, code(c.type)],
    ['MS-DRG relative weight', esc(r.weightsTable), 'weight'],
    [`Operating standardized amount, ${cents(r.operating)}; labor share ${pct(t.hospitals.rates.labor_share)} above a wage index of 1, else ${pct(t.hospitals.rates.labor_share_le1)}`, esc(r.operatingTable), ''],
    [`Capital federal rate, ${cents(r.capital)}`, esc(r.capitalTable), ''],
    [`Outpatient labor share, ${pct(t.hospitals.opps_labor_share)}`, `CY 2027 OPPS final rule, ${fr(t.hospitals.opps_labor_share_cite)}`, ''],
    [`Traditional Medicare discharges, ${t.volume.data_year}`, 'Inpatient counts file', mupKeys(t.volume)],
  ];
  return captionedScroller('m-factors-cap', 'Each factor, the CMS file it is read from, and the column', 'class="check files"',
    `<thead><tr><th scope="col">Factor</th><th scope="col">File</th><th scope="col">Column</th></tr></thead>
<tbody>${rows.map(([what, file, column]) => `<tr><td>${what}</td><td>${file}</td><td>${column}</td></tr>`).join('')}</tbody>`);
}

/**
 * The new Methods sections, as HTML. t: methodsTables(); r: the crosswalk's rates (stake model
 * meta.rates: operating, capital and the table names).
 */
export function hospitalMethods(t, r) {
  return [t.hospitals && hospitalSections(t, r), t.shares && shareSection(t)].filter(Boolean).join('\n\n');
}

/** At a hospital's rates, what it leaves out, Medicare Advantage and the per-year ceiling. */
function hospitalSections(t, r) {
  const h = t.hospitals;
  const v = t.volume;
  const { quotes } = t;
  const counts = h.counts;
  const opps = h.opps_labor_share;
  return `<section class="block" aria-labelledby="m-hosp-h">
<h2 id="m-hosp-h">At a hospital’s rates</h2>
<p>Pick a hospital on the <a href="/revenue-at-stake/">Revenue at stake</a> page and every compared card is recomputed in your browser at that hospital’s FY 2027 inpatient and CY 2027 outpatient rates. The national figures are the same formula with each factor at its national value: wage index and GAF of 1, no IME or DSH.</p>
<ol class="plain steps">
<li><strong>Operating base</strong> = MS-DRG weight × ${cents(r.operating)} × (labor share × wage index + 1 − labor share). The labor share is ${pct(h.rates.labor_share)} when the wage index is above 1, else ${pct(h.rates.labor_share_le1)}.</li>
<li><strong>Capital base</strong> = MS-DRG weight × ${cents(r.capital)} × GAF.</li>
<li><strong>IME</strong> = operating base × the operating IME factor + capital base × the capital IME factor.</li>
<li><strong>DSH</strong> = operating base × the operating DSH factor + capital base × the capital DSH factor. CMS’s operating factor already pays only the empirically justified 25% of DSH; the other 75%, adjusted for the change in the uninsured rate, funds uncompensated care payments, which are left out (below).</li>
<li><strong>Total</strong> = operating base + capital base + IME + DSH.</li>
<li><strong>Outpatient</strong> = the APC’s national rate × (${pct(opps)} × wage index + ${pct(1 - opps)}). Outpatient payment carries no IME or DSH, at a hospital or a surgery center. The surgery-center rate stays national: its wage rules differ.</li>
<li><strong>Rounding.</strong> Every figure is computed unrounded and rounded to the cent once, so a part can differ from its total by a cent. A per-year figure is the count × the unrounded per-case amount, rounded once.</li>
</ol>
<p>The hospital factors come from CMS’s ${out(h.source.landing, esc(h.source.label))} (${esc(h.source.file)}): its modeled values for each IPPS hospital, not a hospital’s actual payments. The counts come from CMS’s ${out(v.source.landing, esc(v.source.label))} (${esc(v.source.file)}). The rates run on two calendars, as above: FY 2027 for inpatient, CY 2027 for outpatient. The counts are ${v.data_year} discharges.</p>
${factorTable(t, r)}
<p>The picker offers ${num(counts.offered)} of the ${num(counts.in_file)} hospitals in the impact file; ${num(counts.teaching)} of them are teaching hospitals (operating IME above 0). The other ${num(counts.maryland)} Maryland hospitals are left out: ${esc(h.maryland)} Puerto Rico’s hospitals are in.</p>
</section>

<section class="block" aria-labelledby="m-left-h">
<h2 id="m-left-h">What a hospital’s figures leave out</h2>
<ul class="plain">
<li><strong>Uncompensated care payments.</strong> Paid with each claim during the year as an interim amount, but settled at cost report to a fixed yearly total (${cfr('412.106', '42 CFR 412.106(i)')}), so a case billed outpatient does not lose it.</li>
<li><strong>Outliers.</strong> Extra payment for an unusually costly case is not modelled.</li>
<li><strong>Quality adjustments.</strong> The value-based purchasing, readmissions reduction and hospital-acquired condition reduction programs change a hospital’s payments by percentages the cards do not apply.</li>
<li><strong>Sole community and Medicare-dependent hospitals.</strong> SCHs are paid the higher of the federal rate or a hospital-specific rate (${cfr('412.92', '42 CFR 412.92(d)')}); MDHs get the federal rate plus 75% of any difference (${cfr('412.108', '42 CFR 412.108(c)')}, which as written covers cost-reporting periods beginning before January 1, 2027 unless Congress extends it). This page shows the federal rate.</li>
<li><strong>Direct GME</strong> is not a per-case payment. It follows the Medicare and Medicare Advantage share of a hospital’s inpatient days (${cfr('413.76', '42 CFR 413.76')}), so cases moving outpatient lower it slightly, and later. It is described here, not counted.</li>
</ul>
</section>

<section class="block" aria-labelledby="m-ma-h">
<h2 id="m-ma-h">Medicare Advantage</h2>
<p>Medicare Advantage plans must follow the inpatient-only list too, and the risk is that they default removed procedures to outpatient anyway; that is why the per-year view counts MA cases. The rule:</p>
<blockquote><p>${esc(quotes.ma.quote)}</p><footer>${fr(quotes.ma.cite)}</footer></blockquote>
<p>An MA case carries operating IME (${cfr('412.105', '42 CFR 412.105(g)')}) and no DSH. Capital IME is left out too: we found no provision for MA discharges in the capital teaching adjustment (${cfr('412.322', '42 CFR 412.322')}). So an MA case’s add-on is operating IME only.</p>
</section>

<section class="block" aria-labelledby="m-year-h">
<h2 id="m-year-h">Per year: a ceiling</h2>
<p>Each card’s per-year fold multiplies the add-on per case by the hospital’s ${v.data_year} traditional Medicare discharges in each MS-DRG of the family (${mupKeys(v)}). ${ceiling(v.data_year)} CMS publishes no count under ${num(v.suppressed_below)}, so an empty cell reads “under ${num(v.suppressed_below)} or none”, and you can fill it in. ${num(v.counts.hospitals)} hospitals have counts.</p>
<p>Medicare Advantage counts are estimates: the traditional count × the hospital’s MA cases per traditional case (${code(h.columns.ime_caseta44)} ÷ ${code(h.columns.caseta44)} in the impact file), rounded to a whole case. ${MA_MIX} Teaching hospitals only: elsewhere an MA case carries no add-on. Any count can be changed on the page. Your counts are not saved; they leave your browser only in the hospital CSV you download.</p>
</section>`;
}

/** The national patient's share and CMS's 2027 ASC additions. */
function shareSection(t) {
  const d = t.shares.deductibles;
  const a = t.ascNew;
  const { quotes, rule } = t;
  const extra = a.also_added.map(esc).join(', ');
  return `<section class="block" aria-labelledby="m-share-h">
<h2 id="m-share-h">The patient’s share, national</h2>
<p>The code page of each of the ${num(t.shares.counts.compared)} compared codes, and the lookup’s answer for a code CMS adds to the surgery-center list for 2027 once it is off the inpatient-only list, show what a Medicare patient pays for the procedure, national:</p>
<ul class="plain">
<li><strong>At a surgery center:</strong> the 20% coinsurance on the CY 2027 national ASC rate (Addendum AA).</li>
<li><strong>In the hospital outpatient department:</strong> ${esc(t.shares.opps_share)}: ${money(d.part_a_inpatient)} in ${d.year}.</li>
<li><strong>Plus the Part B deductible</strong> in either: ${money(d.part_b)} in ${d.year}.</li>
</ul>
<p>Deductibles: ${out(d.url, esc(d.source))}. Most Medigap plans pay the coinsurance; Medicare Advantage plans set their own. This is not advice for a patient. For what a procedure costs a patient, see medicare.gov’s ${out(PRICE_LOOKUP, 'Procedure Price Lookup')}.</p>
<p>The 2027 additions are CMS’s own list, the file ${fr(a.cite)} points to: ${num(a.ipo_removed_2027)} codes removed from the inpatient-only list for 2027 (FR Doc. ${esc(rule.doc)}, ${fr(quotes.asc618.cite)}), plus ${extra}, added on commenters’ recommendation (${fr(quotes.asc64629.cite)}), for ${num(a.count)} in all. The build fails unless the removals on it number the rule’s ${num(a.ipo_removed_2027)}, the only other code is ${extra}, every code is on the CY 2027 Addendum AA, and none was on the CY 2026 list or is new to HCPCS. The lookup shows the line only for the ${num(a.ipo_removed_2027)} removals, from the date they leave the list, and not for one with no separate surgery-center payment; ${extra}, not a removal, gets none.</p>
</section>`;
}
