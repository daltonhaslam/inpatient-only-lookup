// Page templates. Build-time only: everything here becomes static HTML in docs/.
import { SITE, feedbackHref, CFR } from './site.mjs';
import { formatDate, monthYear, lookup, countsAt, periodIndex, spanAt, eventsOf, stateOf } from './engine.mjs';
import { esc, out, fr, cfr, chip, verdict, eventList, codeRow, AXIS } from './views.mjs';

const NAV = [
  ['/', 'Lookup'],
  ['/history/', 'History'],
  ['/phase-out/', 'Phase-out'],
  ['/exemption/', 'Exemption'],
  ['/methods/', 'Methods'],
];

const num = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const codeLink = (data, code) => `<a href="/code/${esc(code)}/" title="${esc(data.codes[code] ? data.codes[code].label : '')}">${esc(code)}</a>`;

export function layout(ctx, { path, title, description, page, body }) {
  const full = path === '/' ? `${SITE.name}: Medicare’s inpatient-only list by date of service` : `${title} | ${SITE.name}`;
  const nav = NAV.map(([href, text]) => {
    const here = href === path || (href !== '/' && path.startsWith(href)) || (href === '/' && (path.startsWith('/code/') || path.startsWith('/group/')));
    return `<a href="${href}"${here ? ' aria-current="page"' : ''}>${text}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE.url}${path}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE.url}${path}">
<meta property="og:image" content="${SITE.url}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${ctx.assets.preload}
<link rel="stylesheet" href="${ctx.assets.css}">
<script defer src="${ctx.assets.js}"></script>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body data-page="${page}" data-ipo="${ctx.assets.data}" data-other="${ctx.assets.other}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<a class="top__name" href="/">${SITE.name}</a>
<nav class="top__nav" aria-label="Site">${nav}</nav>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
<p class="foot__warn"><strong>Not billing or legal advice.</strong> This site reports what CMS’s files and rules say about a code on a date. It does not decide whether a particular admission is payable: once a procedure is off the list, the two-midnight rule still applies. Not affiliated with or endorsed by CMS or the AMA. Check CMS’s own files before you rely on an answer.</p>
<p>Plain-language procedure labels are this site’s own wording, not CPT descriptors. CPT codes are copyright American Medical Association. CPT is a registered trademark of the American Medical Association.</p>
<p>Data as of ${formatDate(ctx.data.built)}: ${esc(ctx.latestFile)}. <a href="/methods/">Methods and sources</a>.</p>
<p>Built by ${out(SITE.linkedin, esc(SITE.author))}, using Claude Code. See something wrong? ${out(feedbackHref(path), 'Send a correction')}. ${out(SITE.repo, 'Code and data on GitHub')}. Part of ${out(SITE.family, 'Paid &amp; Penalized')}.</p>
</footer>
</body>
</html>
`;
}

/** The date-of-service control. The browser keeps it in step with the URL and other pages. */
export const dateControl = (data, date) => `<form class="dos" data-dos-form>
<label class="field field--dos"><span>Date of service</span><input type="date" name="dos" data-dos min="${data.dosMin}" max="${data.dosMax}" value="${date}" required></label>
<button type="button" class="quiet" data-today hidden>Today</button>
</form>`;

// ---- home ---------------------------------------------------------------------------------

function wholeList(ctx, date) {
  const { data } = ctx;
  const index = periodIndex(data, date);
  const counts = countsAt(data, index);
  const groups = data.groups.map(([id, name], g) => {
    const codes = ctx.byGroup[g];
    const cells = codes.map((code) => {
      const span = spanAt(data.codes[code], index);
      return `<i data-cell="${code}" class="cell cell--${stateOf(span ? span[1] : '')}"></i>`;
    }).join('');
    return `<div class="sys">
<p class="sys__name"><a href="/group/${id}/">${esc(name)}</a></p>
<p class="sys__count"><span data-count="${g}">${counts.groups[g]}</span> of ${codes.length}</p>
<div class="cells" aria-hidden="true">${cells}</div>
</div>`;
  }).join('\n');
  return `<section class="whole" aria-labelledby="whole-h">
<h2 id="whole-h">The whole list on <span data-dos-text>${formatDate(date)}</span></h2>
<p class="whole__sum"><strong data-count="total">${num(counts.total)}</strong> codes are inpatient only on this date, out of ${num(ctx.codes.length)} that have been on the list at some point since 2017. Each square is one code: filled is on the list, hollow is off it, a dot is a code not in use. Change the date and watch the list empty.</p>
<p class="cellkey" aria-hidden="true"><span><i class="cell cell--ipo"></i>On the list</span><span><i class="cell cell--off"></i>Off the list</span><span><i class="cell cell--gone"></i>Not in the files</span></p>
<div class="systems" data-cells>
${groups}
</div>
<p class="cellhint" data-cell-hint aria-hidden="true">Point at a square to see its code.</p>
</section>`;
}

export function home(ctx) {
  const { data } = ctx;
  const date = ctx.today;
  const body = `<section class="ask" aria-labelledby="ask-h">
<h1 id="ask-h">Was it inpatient only on that date?</h1>
<p class="ask__sub">Medicare’s inpatient-only list, code by code and day by day: every date of service from ${formatDate(data.dosMin)} through ${formatDate(data.dosMax)}, with what left the list, what came back, and what is still exempt from medical review.</p>
<form class="ask__form" role="search" action="/" method="get" data-ask>
<label class="field field--q"><span>Code or procedure</span><input type="search" name="q" data-q autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" placeholder="27447 or hip replacement"></label>
<label class="field field--dos"><span>Date of service</span><input type="date" name="dos" data-dos min="${data.dosMin}" max="${data.dosMax}" value="${date}" required></label>
<button type="button" class="quiet" data-today hidden>Today</button>
</form>
<p class="ask__try">Try <a href="/?q=27447">27447</a>, <a href="/?q=hip+replacement">hip replacement</a>, <a href="/?q=lumbar+fusion">lumbar fusion</a>, <a href="/?q=hysterectomy">hysterectomy</a> or <a href="/?q=CABG">CABG</a>. Have a list? <a href="#several-h">Check several codes at once</a>.</p>
<noscript><p class="note">Search needs JavaScript. Without it, every code still has its own page: start from a body system below.</p></noscript>
<div class="results" data-results aria-live="polite"></div>
</section>

${wholeList(ctx, date)}

<section class="several" aria-labelledby="several-h">
<h2 id="several-h">Check several codes at once</h2>
<p>Paste codes in any form: a column from a spreadsheet, a case list, a sentence. Each is checked for the date of service chosen above, <span data-dos-text>${formatDate(date)}</span>.</p>
<form data-bulk>
<label class="field field--bulk"><span>Codes</span><textarea name="codes" rows="3" data-bulk-input spellcheck="false" placeholder="27130, 27447, 22630, 63047"></textarea></label>
<button type="submit">Check these codes</button>
</form>
<div data-bulk-out aria-live="polite"></div>
</section>

<section class="status" aria-labelledby="status-h">
<h2 id="status-h">The list is being phased out</h2>
<div class="status__grid">
<p><strong>${num(ctx.stats.leaving2027)} codes leave on January 1, 2027.</strong> They follow the ${num(ctx.stats.left2026)} that left in 2026. CMS expects to remove the rest for 2028, and the regulation says the list is gone by January 1, 2029. <a href="/phase-out/">The schedule</a></p>
<p><strong>${num(ctx.stats.exemptNow)} codes are exempt from certain medical review today.</strong> A procedure removed in 2021 or later keeps its exemption until CMS ends it, code by code. None has ended. <a href="/exemption/">What the exemption covers</a></p>
<p><strong>This has happened before.</strong> CMS removed 298 codes in 2021 and put 293 of them back in 2022. A code’s status depends on the date. <a href="/history/">Year by year</a></p>
</div>
<p class="status__after">The lookup stays useful after the list ends. Audits and appeals turn on what was true on the date of service, and on whether a code’s exemption was still running.</p>
</section>`;
  return layout(ctx, {
    path: '/', page: 'home', title: SITE.name, body,
    description: 'Look up any CPT or HCPCS code and a date of service: was it on Medicare’s inpatient-only list, when did it leave, did it come back, and is it exempt from medical review? Built from CMS’s Addendum B files, 2020 to 2027.',
  });
}

// ---- one code -----------------------------------------------------------------------------

export function codePage(ctx, code) {
  const { data } = ctx;
  const record = data.codes[code];
  const date = ctx.today;
  const [family, groupIndex] = data.families[record.family];
  const [groupId, groupName] = data.groups[groupIndex];
  const siblings = ctx.byFamily[record.family].filter((other) => other !== code);
  const result = lookup(data, code, date);
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Lookup</a> <span aria-hidden="true">/</span> <a href="/group/${groupId}/">${esc(groupName)}</a> <span aria-hidden="true">/</span> <span>${esc(family)}</span></nav>
${dateControl(data, date)}
<div data-verdict-host="${code}" data-title="h1" data-heading="h2">
${verdict(data, code, date, ctx.today, null, { title: 'h1', heading: 'h2' })}
</div>
<section class="block" aria-labelledby="hist-h">
<h2 id="hist-h">History of ${code}</h2>
<div data-events-host="${code}">${eventList(data, record, date, ctx.today)}</div>
<p class="note">Dates before 2020 come from each year’s final rule, so a change is dated January 1 of its year. From 2020 on, changes are dated to the quarter CMS’s Addendum B first shows them.</p>
</section>
${siblings.length ? `<section class="block" aria-labelledby="sib-h">
<h2 id="sib-h">Related codes: ${esc(family)}</h2>
<ul class="rows" data-rows>${siblings.map((other) => codeRow(data, other, date)).join('')}</ul>
</section>` : ''}
<section class="block" aria-labelledby="chk-h">
<h2 id="chk-h">Check it against CMS</h2>
<p>“${esc(record.label)}” is this site’s plain-language label, written to help you find the code. It is not the CPT descriptor and may leave out detail that matters for coding. For the official descriptor and status indicator, open ${out(ctx.quarterlyPage, 'CMS’s Addendum B')} for the quarter of the date of service and find ${code}. Status indicator C means inpatient only.</p>
</section>`;
  const state = { ipo: 'Inpatient only', off: 'Not inpatient only', gone: 'Not in Medicare’s files' }[result.state];
  return layout(ctx, {
    path: `/code/${code}/`, page: 'code', body,
    title: `${code}: ${record.label}`,
    description: `Is ${code} (${record.label}) on Medicare’s inpatient-only list? ${state} as of ${formatDate(date)}. Status by date of service since 2020, removal history and medical-review exemption, with sources.`,
  });
}

// ---- one body system ----------------------------------------------------------------------

export function groupPage(ctx, g) {
  const { data } = ctx;
  const [id, name] = data.groups[g];
  const date = ctx.today;
  const counts = countsAt(data, periodIndex(data, date));
  const families = ctx.familiesByGroup[g].map((f) => `<section class="fam" aria-labelledby="fam-${f}">
<h2 id="fam-${f}">${esc(data.families[f][0])}</h2>
<ul class="rows" data-rows>${ctx.byFamily[f].map((code) => codeRow(data, code, date)).join('')}</ul>
</section>`).join('\n');
  const others = data.groups.map(([otherId, otherName], i) => (i === g ? '' : `<a href="/group/${otherId}/">${esc(otherName)}</a>`)).filter(Boolean).join('');
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Lookup</a> <span aria-hidden="true">/</span> <span>${esc(name)}</span></nav>
<h1>${esc(name)}</h1>
${dateControl(data, date)}
<p class="lede"><strong data-count="${g}">${counts.groups[g]}</strong> of ${ctx.byGroup[g].length} codes are inpatient only on <span data-dos-text>${formatDate(date)}</span>. The groups and procedure names are this site’s own; CMS’s files list codes only.</p>
${families}
<nav class="others" aria-label="Other body systems"><h2>Other body systems</h2><p>${others}</p></nav>`;
  return layout(ctx, {
    path: `/group/${id}/`, page: 'group', title: `${name}: inpatient-only codes`, body,
    description: `${name}: the ${ctx.byGroup[g].length} codes that have been on Medicare’s inpatient-only list since 2017, with each code’s status by date of service.`,
  });
}

// ---- history ------------------------------------------------------------------------------

const YEAR_NOTES = {
  2018: () => `Total knee replacement (27447) and five other procedures came off the list, and one was added (${fr('82 FR 52526')}). CMS barred recovery auditors from patient-status review of knee replacement for two years (${fr('82 FR 52362')}).`,
  2019: () => `Four codes left the list in CMS’s files (CY 2019 final rule, ${fr('83 FR 58818')}).`,
  2020: () => `Total hip replacement (27130), six spine procedures and their anesthesia codes came off (${fr('84 FR 61355')}; ${fr('84 FR 61357')}; ${fr('84 FR 61358')}). CMS created a two-year exemption from certain medical review for procedures removed from 2020 on (${fr('84 FR 61365')}).`,
  2021: () => `CMS decided to eliminate the list over three years and removed the first 298 codes: 266 musculoskeletal services, 16 recommended by its advisory panel, and related anesthesia codes (${fr('85 FR 86093')}). It made the medical-review exemption indefinite for anything removed in 2021 or later (${fr('85 FR 86119')}).`,
  2022: () => `CMS halted the elimination and put back the codes it had removed, except lumbar fusion 22630, shoulder replacement 23472, ankle replacement 27702 and two anesthesia codes (${fr('86 FR 63711')}). It classified one more code, 0643T, as inpatient only (${fr('86 FR 63710')}) and wrote removal criteria into the regulation (${fr('86 FR 63993')}). It also meant to cut the exemption back to two years, but left the indefinite paragraph in the regulation (${fr('90 FR 53829')}).`,
  2023: () => `Eleven codes came off: eight facial-bone procedures (${fr('87 FR 72009')}), plus 22632, 47550 and 21255. All eleven had been removed in 2021 and put back in 2022. Eight new codes were added (${fr('87 FR 72006')}). CMS said it was not considering eliminating the list (${fr('87 FR 72008')}).`,
  2024: () => `Nothing came off. Nine new codes were added and 0646T was moved onto the list (${fr('88 FR 81859')}).`,
  2025: () => `One code came off, 22848, and three new codes were confirmed on the list (${fr('89 FR 94274')}).`,
  2026: () => `CMS restarted the elimination, this time with a three-year schedule in the regulation (${fr('90 FR 54086')}). The first 285 codes came off, mostly musculoskeletal (${fr('90 FR 53788')}). The removal criteria were deleted (${fr('90 FR 53789')}), and the indefinite exemption was restated in 42 CFR 412.3(d)(2) (${fr('90 FR 54082')}).`,
  2027: () => `The second phase: 637 codes come off on January 1, 2027, from the auditory, digestive, endocrine, female genital, hemic and lymphatic, integumentary, male genital, maternity, mediastinum and diaphragm, respiratory and urinary families (${fr('91 FR 70570')}; ${fr('91 FR 70574')}). The Federal Register does not print the list; CMS posted it as a file.`,
};

function sizeChart(ctx) {
  const { data } = ctx;
  const max = Math.max(...ctx.sizes.map((s) => s.count));
  const span = Date.parse(AXIS.to) - Date.parse(AXIS.from);
  const x = (iso) => ((Date.parse(iso) - Date.parse(AXIS.from)) / span) * 100;
  const bars = ctx.sizes.map((s, i) => {
    const end = i + 1 < ctx.sizes.length ? ctx.sizes[i + 1].date : `${Number(data.dosMax.slice(0, 4)) + 1}-01-01`;
    const title = `${s.basis === 'q' ? monthYear(s.date) : s.date.slice(0, 4)}: ${num(s.count)} codes`;
    return `<span class="bar${s.basis === 'f' ? ' bar--sched' : ''}" style="left:${x(s.date).toFixed(3)}%;width:${(x(end) - x(s.date)).toFixed(3)}%;height:${((s.count / max) * 100).toFixed(2)}%" title="${title}"></span>`;
  }).join('');
  const labels = ctx.sizes.filter((s, i) => i === 0 || s.date.endsWith('-01-01') && Math.abs(s.count - ctx.sizes[i - 1].count) > 100)
    .map((s) => `<span class="chart__val" style="left:${x(s.date).toFixed(3)}%;bottom:${((s.count / max) * 100).toFixed(2)}%">${num(s.count)}</span>`).join('');
  const years = [];
  for (let year = 2017; year <= 2029; year += 1) years.push(`<span class="tl__year" style="left:${x(`${year}-01-01`).toFixed(3)}%">${year}</span>`);
  const rows = ctx.ledger.map((y) => `<tr><th scope="row">${y.year}</th><td>${num(y.start)}</td><td>${num(y.end)}</td></tr>`).join('');
  return `<figure class="chart">
<figcaption>Codes on the inpatient-only list, January 2017 to the regulation’s end date</figcaption>
<div class="chart__plot" role="img" aria-label="Bar chart of the number of codes on the list over time: about 1,740 through 2020, 1,438 in 2021, 1,728 in 2022, 1,438 in 2026, 813 in 2027, and none by January 2029.">${bars}${labels}<span class="chart__open" style="left:${x(`${Number(data.dosMax.slice(0, 4)) + 1}-01-01`).toFixed(3)}%;width:${(100 - x(`${Number(data.dosMax.slice(0, 4)) + 1}-01-01`)).toFixed(3)}%"><span>2028: CMS expects to remove the rest</span></span></div>
<div class="tl__axis" aria-hidden="true">${years.join('')}</div>
<details class="chart__table"><summary>The same numbers as a table</summary>
<table><thead><tr><th scope="col">Year</th><th scope="col">On January 1</th><th scope="col">On December 31</th></tr></thead><tbody>${rows}</tbody></table></details>
</figure>`;
}

function codeList(data, title, codes) {
  if (!codes.length) return '';
  return `<details class="codes"><summary>${title} (${num(codes.length)})</summary><p class="codes__list">${codes.map((code) => codeLink(data, code)).join(' ')}</p></details>`;
}

export function history(ctx) {
  const { data } = ctx;
  const years = ctx.ledger.filter((y) => y.year >= 2018).reverse().map((y) => {
    const change = y.january;
    const returned = change.added.filter((code) => ctx.returnedOn[`${y.year}-01-01`].has(code));
    const added = change.added.filter((code) => !ctx.returnedOn[`${y.year}-01-01`].has(code));
    const mid = y.midyear.flatMap((m) => [...m.new, ...m.added]);
    const facts = [
      ['On the list January 1', num(y.start)],
      ['Removed', num(change.removed.length)],
      ['Returned', num(returned.length)],
      ['New or added codes', num(change.new.length + added.length)],
      ['Codes retired', num(change.retired.length)],
      ['Added during the year', num(mid.length)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const rule = data.rules[y.year];
    const file = y.year === Number(data.dosMax.slice(0, 4)) && ctx.scheduled ? ' Scheduled: from the final rule, until CMS posts the January file.' : '';
    return `<section class="year" id="y${y.year}" aria-labelledby="yh${y.year}">
<h2 id="yh${y.year}">${y.year}</h2>
<p>${YEAR_NOTES[y.year]()}${file}</p>
<dl class="ledger">${facts}</dl>
${codeList(data, 'Removed', change.removed)}${codeList(data, 'Returned to the list', returned)}${codeList(data, 'New or added', [...change.new, ...added])}${codeList(data, 'Retired while on the list', change.retired)}${codeList(data, 'Added during the year', mid)}
<p class="year__src">${esc(rule.name)} (${esc(rule.id)}), ${fr(rule.fr)}${y.year < 2020 ? '. Before 2020 this site has one file a year, so mid-year changes are not shown.' : '.'}</p>
</section>`;
  }).join('\n');

  const checks = ctx.reconciliation.map((row) => `<tr><th scope="row">${row.year}</th><td>${esc(row.what)}</td><td>${num(row.cms)}</td><td>${num(row.computed)}</td><td>${row.cite ? fr(row.cite) : '—'}</td><td>${row.note ? esc(row.note) : 'Match'}</td></tr>`).join('');

  const body = `<h1>The list, year by year</h1>
<p class="lede">CMS has tried to end the inpatient-only list twice. The first attempt lasted one year. A code removed in 2021 may have been inpatient only again in 2022 and gone again in 2026, which is why the date of service matters.</p>
${sizeChart(ctx)}
<section class="block" aria-labelledby="next-h">
<h2 id="next-h">2028 and the end of the list</h2>
<p>CMS expects to remove everything left for 2028, in next year’s rule: the neurological and cardiovascular families and solid organ, intestinal and islet cell transplants (${fr('91 FR 70571')}). The regulation says the list is “eliminated in its entirety by January 1, 2029” (${cfr('419.22', '42 CFR 419.22(n)')}; ${fr('90 FR 54086')}). <a href="/phase-out/">The schedule, and what remains</a>.</p>
</section>
${years}
<section class="block" aria-labelledby="rec-h">
<h2 id="rec-h">Do these counts match CMS’s?</h2>
<p>Every count on this site is computed from status indicator C in CMS’s Addendum B files. Where a final rule states a number, the two are compared here. <a href="/methods/">How the comparison works</a>.</p>
<div class="scroll"><table class="check">
<thead><tr><th scope="col">Year</th><th scope="col">What CMS counted</th><th scope="col">CMS says</th><th scope="col">Files show</th><th scope="col">Source</th><th scope="col">Result</th></tr></thead>
<tbody>${checks}</tbody></table></div>
</section>`;
  return layout(ctx, {
    path: '/history/', page: 'history', title: 'The inpatient-only list, year by year', body,
    description: 'Every change to Medicare’s inpatient-only list since 2018: the 298 codes removed in 2021, the 293 returned in 2022, 285 removed in 2026 and 637 in 2027, reconciled against CMS’s own counts.',
  });
}

// ---- phase-out ----------------------------------------------------------------------------

function byGroupTable(ctx, codes, caption) {
  const { data } = ctx;
  const set = new Set(codes);
  const rows = data.groups.map(([id, name], g) => {
    const mine = ctx.byGroup[g].filter((code) => set.has(code));
    if (!mine.length) return '';
    return `<details class="codes"><summary><a href="/group/${id}/">${esc(name)}</a> (${num(mine.length)})</summary><p class="codes__list">${mine.map((code) => codeLink(data, code)).join(' ')}</p></details>`;
  }).join('');
  return `<div class="bygroup"><p class="bygroup__cap">${caption}</p>${rows}</div>`;
}

export function phaseOut(ctx) {
  const { stats } = ctx;
  const body = `<h1>The phase-out schedule</h1>
<p class="lede">Since January 1, 2026 the regulation has required CMS to eliminate the inpatient-only list “through a 3-year transition, with the list eliminated in its entirety by January 1, 2029” (${cfr('419.22', '42 CFR 419.22(n)')}; ${fr('90 FR 54086')}).</p>
<ol class="phases">
<li class="phase phase--done"><p class="phase__when">January 1, 2026</p><h2>${num(stats.left2026)} codes removed</h2><p>Mostly musculoskeletal: joint replacement, spine, fracture repair and amputation, with their anesthesia codes (${fr('90 FR 53788')}). <a href="/history/#y2026">The codes</a></p></li>
<li class="phase phase--next"><p class="phase__when">January 1, 2027</p><h2>${num(stats.leaving2027)} codes removed</h2><p>The auditory, digestive, endocrine, female genital, hemic and lymphatic, integumentary, male genital, maternity, mediastinum and diaphragm, respiratory and urinary families (${fr('91 FR 70570')}; ${fr('91 FR 70574')}). ${num(stats.after2027)} codes stay on the list for 2027.</p></li>
<li class="phase phase--open"><p class="phase__when">January 1, 2028, not yet final</p><h2>CMS expects to remove the rest</h2><p>“These remaining clinical families and services would be removed from the IPO list for CY 2028, during the third and final phase”: neurological, cardiovascular, and solid organ, intestinal and islet cell transplants (${fr('91 FR 70571')}). That needs next year’s rule. Until CMS finalizes it, this site does not answer for dates in 2028.</p></li>
<li class="phase phase--end"><p class="phase__when">By January 1, 2029</p><h2>The list is gone</h2><p>The regulation’s outside date. The CY 2026 rule’s preamble printed January 1, 2028 in one place; CMS corrected it to 2029 (${fr('91 FR 8384')}).</p></li>
</ol>

<section class="block" aria-labelledby="leave-h">
<h2 id="leave-h">Leaving on January 1, 2027</h2>
${byGroupTable(ctx, ctx.leaving2027, `The ${num(stats.leaving2027)} codes, in this site’s body-system groups. CMS’s own list is the file “Final Procedures Removed from the IPO List for CY 2027” (${fr('91 FR 70574')}).`)}
</section>
<section class="block" aria-labelledby="stay-h">
<h2 id="stay-h">Still on the list for 2027</h2>
${byGroupTable(ctx, ctx.after2027, `The ${num(stats.after2027)} codes with status indicator C in the CY 2027 final rule’s Addendum B.`)}
</section>

<section class="block" aria-labelledby="means-h">
<h2 id="means-h">What changes when a code leaves</h2>
<ul class="plain">
<li><strong>Either setting can be paid.</strong> “Removal of procedures from the IPO list allows for payment of the procedure in either the inpatient setting or the outpatient setting” (${fr('90 FR 53786')}). Removal does not require the service to be done outpatient (${fr('90 FR 53784')}).</li>
<li><strong>The two-midnight rule decides inpatient status.</strong> While a procedure is on the list, an inpatient admission is generally appropriate whatever the expected stay. Once it is off, the two-midnight benchmark applies (${cfr('412.3', '42 CFR 412.3(d)')}; ${fr('84 FR 61363')}).</li>
<li><strong>Certain medical review is suspended.</strong> Procedures removed in 2021 or later are exempt from site-of-service denials and recovery-auditor patient-status review until CMS ends the exemption for that procedure. <a href="/exemption/">The exemption</a></li>
<li><strong>The three-day stay for nursing-facility coverage is unchanged.</strong> “A prior 3-day inpatient hospital stay remains a statutory requirement for SNF coverage” (${fr('90 FR 53786')}).</li>
<li><strong>Many removed codes also became payable in surgery centers.</strong> CMS added 271 of the 2026 removals to the ambulatory surgical center list (${fr('90 FR 53450')}), and 618 codes for 2027 that were removed from the list or recommended by commenters (${fr('91 FR 70286')}). This site does not track the surgery-center list.</li>
<li><strong>Medicare Advantage.</strong> CMS notes that Medicare Advantage plans must follow the two-midnight benchmark (${fr('90 FR 53831')}). Plans’ own review practices are outside this site.</li>
</ul>
</section>

<section class="block" aria-labelledby="after-h">
<h2 id="after-h">After the list ends</h2>
<p>This site stays useful. A claim is judged by the rules in force on its date of service, so an audit or appeal years from now still needs to know whether a procedure was inpatient only that day. And the medical-review exemption outlives the list: each removed procedure keeps it until CMS ends it for that procedure, which CMS has not yet done for any (${fr('90 FR 53832')}).</p>
</section>`;
  return layout(ctx, {
    path: '/phase-out/', page: 'phase-out', title: 'The inpatient-only list phase-out schedule', body,
    description: 'Medicare’s inpatient-only list ends by January 1, 2029. What left in 2026, the 637 codes leaving January 1, 2027, what remains for 2028, and what changes when a code leaves.',
  });
}

// ---- exemption ----------------------------------------------------------------------------

export function exemption(ctx) {
  const { data, stats } = ctx;
  const cohorts = ctx.exemptCohorts.map((c) => `<details class="codes"><summary>Removed ${formatDate(c.from)}: ${plural(c.codes.length, 'code')}, ${c.status}</summary><p class="codes__list">${c.codes.map((code) => codeLink(data, code)).join(' ')}</p></details>`).join('');
  const body = `<h1>The medical-review exemption</h1>
<p class="lede">When a procedure comes off the inpatient-only list, the two-midnight rule starts to apply to it. To give hospitals time to adjust, CMS exempts claims for the procedure from some kinds of review. For anything removed in 2021 or later, that exemption has no end date yet.</p>

<section class="block" aria-labelledby="reg-h">
<h2 id="reg-h">The regulation</h2>
<blockquote><p>Claims for services and procedures removed from the inpatient only list under § 419.22 of this chapter on or after January 1, 2021 are exempt from certain medical review activities until the Secretary determines that the service or procedure is more commonly performed in the outpatient setting than the inpatient setting.</p><footer>${cfr('412.3', '42 CFR 412.3(d)(2)')}, as revised at ${fr('90 FR 54082')}</footer></blockquote>
</section>

<section class="block" aria-labelledby="what-h">
<h2 id="what-h">What is exempt</h2>
<p>CMS names three things (${fr('85 FR 86119')}; restated at ${fr('90 FR 53832')} and ${fr('91 FR 70573')}):</p>
<ul class="plain">
<li>site-of-service claim denials under Medicare Part A;</li>
<li>referrals from the initial medical review contractor to recovery auditors (RACs) for noncompliance with the two-midnight rule;</li>
<li>recovery-auditor reviews of “patient status”, meaning site of service.</li>
</ul>
<p>Review contractors may still look at these claims to educate providers, “but claims identified as noncompliant are not denied with respect to the site-of-service under Medicare Part A” (${fr('91 FR 70573')}). Short-stay reviews moved from the quality improvement organizations (BFCC-QIOs) to the Medicare administrative contractors on September 1, 2025 (${fr('90 FR 53829')}).</p>
</section>

<section class="block" aria-labelledby="not-h">
<h2 id="not-h">What is not exempt</h2>
<ul class="plain">
<li><strong>The two-midnight rule itself.</strong> “Providers are still required to comply with the 2-midnight rule during the exemption period” (${fr('90 FR 53830')}). The exemption is from certain review, not from the rule (${fr('85 FR 86120')}).</li>
<li><strong>Fraud and abuse review.</strong> CMS or its contractors “may still conduct patient status medical review in cases in which there is evidence of systemic fraud or abuse occurring” (${fr('90 FR 53830')}).</li>
<li><strong>Other payers.</strong> The exemption is a fee-for-service Medicare review policy. Medicare Advantage plans must follow the two-midnight benchmark (${fr('90 FR 53831')}), but this site does not speak to how any plan audits.</li>
<li><strong>Everything else about the claim.</strong> Medical necessity of the procedure, coding and documentation are reviewed as always.</li>
</ul>
</section>

<section class="block" aria-labelledby="long-h">
<h2 id="long-h">How long it lasts</h2>
<div class="scroll"><table class="check">
<thead><tr><th scope="col">Removed from the list</th><th scope="col">Exemption</th><th scope="col">Source</th></tr></thead>
<tbody>
<tr><th scope="row">Before 2020</th><td>None under this rule. For total knee replacement, removed in 2018, CMS separately barred recovery-auditor patient-status review for two years.</td><td>${fr('82 FR 52362')}</td></tr>
<tr><th scope="row">During 2020</th><td>Two years from removal: January 1, 2020 through December 31, 2021.</td><td>${fr('84 FR 61365')}; ${fr('85 FR 86300')}</td></tr>
<tr><th scope="row">2021 or later</th><td>Indefinite: until CMS determines the procedure is more commonly performed outpatient.</td><td>${fr('85 FR 86119')}; ${fr('90 FR 54082')}</td></tr>
</tbody></table></div>
<p>To end a procedure’s exemption, CMS needs Medicare claims showing it “being performed more than 50 percent of the time in the outpatient setting in a single calendar year” (${fr('90 FR 53830')}), and it will announce the end through notice-and-comment rulemaking (${fr('90 FR 53832')}; ${fr('91 FR 70573')}). <strong>CMS has not ended any procedure’s exemption.</strong> When it does, this site will show the end date on that code.</p>
</section>

<section class="block" aria-labelledby="gap-h">
<h2 id="gap-h">The 2022 to 2025 wrinkle</h2>
<p>For dates of service in 2023, 2024 and 2025, read the regulation as it stood with care. In the CY 2022 rule CMS said it was returning to a two-year exemption for everything removed on or after January 1, 2020, and it rewrote one paragraph of the regulation to say so (${fr('86 FR 63740')}; ${fr('86 FR 63992')}). It did not delete the paragraph that made the exemption indefinite for removals from 2021 on. In the CY 2026 rule CMS called that a drafting oversight and said the result was that “the exemption period was not changed to two years as we intended and instead remained the indefinite exemption period” (${fr('90 FR 53829')}).</p>
<p>This matters for ${plural(stats.disputedCodes, 'code')}: the five that stayed off the list after 2021, and the eleven removed in 2023. On those dates this site reports the exemption as in effect, as CMS now describes it, and flags the conflict.</p>
</section>

<section class="block" aria-labelledby="who-h">
<h2 id="who-h">Which codes</h2>
<p><strong>${num(stats.exemptNow)} codes are exempt on ${formatDate(ctx.today)}.</strong> A code that was removed and later put back on the list has no exemption while it is on the list; if it is removed again, the exemption runs from the new removal.</p>
${cohorts}
<p class="note">Look up any code for its exemption on a given date of service: <a href="/">Lookup</a>.</p>
</section>`;
  return layout(ctx, {
    path: '/exemption/', page: 'exemption', title: 'The medical-review exemption for procedures removed from the inpatient-only list', body,
    description: 'Procedures removed from Medicare’s inpatient-only list in 2021 or later are indefinitely exempt from site-of-service denials and RAC patient-status review (42 CFR 412.3(d)(2)). What is exempt, what is not, and which codes.',
  });
}

// ---- methods ------------------------------------------------------------------------------

export function methods(ctx) {
  const { data } = ctx;
  const files = ctx.sources.map((s) => `<tr><td>${out(s.landing, esc(s.label))}</td><td>${esc(s.use)}</td><td><code title="${esc(s.sha256)}">${esc(s.sha256.slice(0, 12))}</code></td></tr>`).join('');
  const gaps = ctx.gaps.map((g) => `<li><strong>${g.year}, ${esc(g.table)}.</strong> ${esc(g.why)} <span class="gap__codes">${g.codes.map((code) => (data.codes[code] ? codeLink(data, code) : esc(code))).join(' ')}</span></li>`).join('');
  const body = `<h1>Methods and sources</h1>
<p class="lede">Every answer on this site comes from a file CMS published. This page says which files, how they are read, where they disagree with each other, and what the site cannot tell you.</p>

<section class="block" aria-labelledby="test-h">
<h2 id="test-h">The test: status indicator C</h2>
<p>CMS marks an inpatient-only service with status indicator C in Addendum B of the outpatient payment system: “Inpatient Procedures. Not paid under OPPS. Admit patient. Bill as inpatient.” (Addendum D1). Addendum B is reissued every quarter, so it gives the status for a date of service. Addendum E, published once a year with the final rule, is the same list as of January 1. This site reads Addendum B and uses Addendum E as a check.</p>
<ul class="plain">
<li><strong>From January 2020:</strong> ${ctx.counts.quarterly} quarterly Addendum B files, one for each quarter through ${monthYear(ctx.lastQuarter)}. Where CMS posted a correction, the correction is used.</li>
<li><strong>2017 to 2019:</strong> the Addendum B published with each year’s final rule, one a year. These date earlier removals, such as knee replacement in 2018. The lookup does not answer for dates before 2020.</li>
<li><strong>${ctx.scheduled ? `${ctx.scheduled}: ` : ''}</strong>${ctx.scheduled ? `the final rule’s Addendum B stands in until CMS posts the January quarterly file. Answers for that year are marked “scheduled”.` : 'The newest year uses CMS’s January quarterly file.'}</li>
</ul>
<p>A date of service is matched to the file in force that day. A code counts as <em>removed</em> when it goes from C to any other active status, as <em>retired</em> when it leaves the file or is marked discontinued while on the list, as <em>new</em> when it first appears already marked C, and as <em>returned</em> when it goes back to C after a removal.</p>
</section>

<section class="block" aria-labelledby="rec-h">
<h2 id="rec-h">Reconciliation</h2>
<p>The build fails unless all of these hold. The latest run: ${ctx.counts.checks} checks, all passing.</p>
<ul class="plain">
<li>Each file’s spreadsheet and its text copy list the same inpatient-only codes.</li>
<li>Each year’s Addendum E equals status C in that rule’s Addendum B and in the January quarterly file: ${ctx.eCounts}.</li>
<li>CMS’s two removal files (298 codes for 2021, 637 for 2027) equal the codes that leave status C on those dates.</li>
<li>Counts CMS states in the rules equal the counts computed from the files. <a href="/history/#rec-h">The table</a></li>
<li>The code lists printed in the Federal Register for 2020 through 2026 equal the computed changes, except for the differences explained below.</li>
<li>${ctx.counts.quotes} passages quoted from the Federal Register appear on the pages cited.</li>
</ul>
<h3>Differences, explained</h3>
<ul class="plain gaps">${gaps}</ul>
<p>CMS’s removal file for 2021 also carries full procedure descriptions, and several rows have the wrong description for their code. This site does not use CMS’s descriptions.</p>
</section>

<section class="block" aria-labelledby="lab-h">
<h2 id="lab-h">Procedure labels</h2>
<p>CPT descriptors belong to the American Medical Association, and showing them needs a license this site does not have. So every label here is original: a short plain-language name written for this site, then checked code by code in a second clinical pass, and tested to make sure none repeats a CMS or AMA descriptor. Labels exist to help you find a code. They can be less specific than the descriptor, and a few may be wrong. If one is, ${out(feedbackHref('/methods/'), 'say so')}.</p>
<p>Body-system groups and procedure families are also this site’s own. CMS’s phase-out uses its own clinical families, which do not line up exactly with these.</p>
</section>

<section class="block" aria-labelledby="lim-h">
<h2 id="lim-h">Limits</h2>
<ul class="plain">
<li>This is fee-for-service Medicare. Other payers keep their own lists.</li>
<li>Off the inpatient-only list does not mean payable. A code can carry another status that Medicare does not pay on an outpatient claim.</li>
<li>Changes are dated to the first day of the quarter in which Addendum B shows them.</li>
<li>For a code that was never on the list, the site says only that. It has no label and no status history for those codes.</li>
<li>When CPT retires a code and replaces it, the site does not link the old code to the new one.</li>
<li>Exemption status follows the regulation and CMS’s statements in the rules. It is not a prediction of what a contractor will do.</li>
</ul>
</section>

<section class="block" aria-labelledby="upd-h">
<h2 id="upd-h">Updates and data</h2>
<p>The site is rebuilt when CMS posts a quarterly Addendum B (January, April, July, October) and when the annual final rule comes out in November. Data as of ${formatDate(data.built)}.</p>
<p>${out(`${SITE.repo}`, 'The code and the derived tables')} are public under the MIT license: every code’s status by quarter, the reconciliation report, and the script that rebuilds it all from CMS’s files. The CMS downloads themselves are not redistributed, because they carry AMA descriptors. <a href="/data/inpatient-only-history.csv" download>Download the history as CSV</a> (codes, this site’s labels, and each code’s events; no AMA content).</p>
</section>

<section class="block" aria-labelledby="src-h">
<h2 id="src-h">Files</h2>
<p>Each file is pinned by its SHA-256 hash, so a silent replacement by CMS is caught on the next refresh.</p>
<div class="scroll"><table class="check files">
<thead><tr><th scope="col">File</th><th scope="col">Used for</th><th scope="col">SHA-256</th></tr></thead>
<tbody>${files}</tbody></table></div>
<p>Regulations: ${out(CFR['412.3'], '42 CFR 412.3')} (inpatient admissions and the exemption) and ${out(CFR['419.22'], '42 CFR 419.22(n)')} (the list and its elimination).</p>
</section>`;
  return layout(ctx, {
    path: '/methods/', page: 'methods', title: 'Methods and sources', body,
    description: 'How Inpatient Only Lookup is built: CMS’s quarterly Addendum B files, status indicator C, reconciliation against Addendum E and CMS’s published counts, original procedure labels, and limits.',
  });
}

export function notFound(ctx) {
  return layout(ctx, {
    path: '/404.html', page: 'missing', title: 'Page not found', description: 'That page does not exist.',
    body: `<h1>That page does not exist</h1><p class="lede">If you were looking for a code, it may never have been on the inpatient-only list. <a href="/">Look it up</a> to check.</p>`,
  });
}

export { chip };
