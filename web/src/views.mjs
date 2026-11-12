// HTML for the parts of the site that change with the date of service. Used by the build to
// prerender pages and by the browser to redraw them, so both always say the same thing.
import { STATUS, CFR } from './site.mjs';
import { formatDate, monthYear, addDays, dayNumber, lookup, eventsOf, stateOf, scale } from './engine.mjs';

export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A link that leaves the site: new tab, no referrer, and a spoken hint. cls: an optional class (a button, say). */
export const out = (href, text, cls) =>
  `<a${cls ? ` class="${esc(cls)}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}<span class="sr"> (opens in a new tab)</span></a>`;

/** "85 FR 86093" as a link to that page of the Federal Register on govinfo.gov. */
export function fr(cite) {
  const match = /^(\d+) FR (\d+)$/.exec(cite);
  return match ? out(`https://www.govinfo.gov/link/fr/${match[1]}/${match[2]}`, esc(cite)) : esc(cite);
}

export const cfr = (section, text) => out(CFR[section], esc(text || `42 CFR ${section}`));

export const CHIP = { ipo: 'Inpatient only', off: 'Not inpatient only', gone: 'Not in the files' };
export const chip = (state) => `<span class="chip chip--${state}">${CHIP[state]}</span>`;

const statusText = (si) => (STATUS[si] ? `Status indicator ${esc(si)}: ${STATUS[si]}.` : `Status indicator ${esc(si)}.`);
const fileLink = (period) => out(period.href, esc(period.label));

/** One event as a phrase: "Removed from the list January 1, 2021". Future events read as scheduled. */
function eventPhrase(event, today) {
  const date = formatDate(event.date);
  const future = event.date > today;
  switch (event.type) {
    case 'listed': return `On the list in ${monthYear(event.date)}, the earliest file on this site`;
    case 'new': return future ? `New code, due on the list ${date}` : `New code, placed on the list ${date}`;
    case 'added': return future ? `Due on the list ${date}` : `Placed on the list ${date}`;
    case 'returned': return future ? `Due back on the list ${date}` : `Returned to the list ${date}`;
    case 'removed': return future ? `Scheduled to leave the list ${date}` : `Removed from the list ${date}`;
    default: return future ? `Code to be retired ${date}` : `Code retired ${date}`;
  }
}

/** Where a code's event is documented: the final rule's page if we have one, and always the CMS file. */
function eventSource(data, event, code) {
  const rule = event.date.endsWith('-01-01') ? data.rules[event.date.slice(0, 4)] : null;
  const cite = rule && (rule.codes[code] || rule.cites[event.type]);
  const file = fileLink(event.period);
  if (cite) return `${esc(rule.name)}, ${fr(cite)}; ${file}`;
  if (rule && event.type !== 'listed' && event.period.basis !== 'q') return `${esc(rule.name)}, ${fr(rule.fr)}; ${file}`;
  return file;
}

function exemptionText(data, result) {
  const { exemption, state } = result;
  const more = ' <a href="/exemption/">What the exemption covers</a>.';
  if (state === 'ipo') {
    return `Does not apply: the code is on the list on this date. An inpatient admission for an inpatient-only procedure is generally appropriate for Part A payment whatever the expected length of stay (${cfr('412.3', '42 CFR 412.3(d)(2)')}).`;
  }
  if (state === 'gone') return 'Not applicable: the code is not in Medicare’s files on this date.';
  if (!exemption) {
    return `No exemption: this code had not been on the list before this date (files back to ${data.periods[0].d.slice(0, 4)}), so it was never removed.`;
  }
  const removed = formatDate(exemption.from);
  if (exemption.status === 'none') {
    return `No exemption on this date. It left the list ${removed}; CMS’s medical-review exemption began with procedures removed in 2020 (${fr('84 FR 61365')}; ${fr('85 FR 86300')}).${more}`;
  }
  if (exemption.kind === 'two-year') {
    const window = `${removed} through ${formatDate(exemption.through)}`;
    return exemption.status === 'active'
      ? `<strong>Exempt on this date.</strong> Procedures removed during 2020 were exempt for two years from removal: ${window} (${fr('84 FR 61365')}; ${fr('85 FR 86300')}).${more}`
      : `No exemption on this date. Its two-year exemption ran ${window} (${fr('84 FR 61365')}; ${fr('85 FR 86300')}).${more}`;
  }
  if (exemption.status === 'ended') {
    return `No exemption on this date. CMS ended this code’s exemption after ${formatDate(exemption.through)}.${more}`;
  }
  let text = `<strong>Exempt on this date.</strong> It left the list ${removed}, so claims for it are exempt from site-of-service denials, referral to recovery auditors for two-midnight noncompliance, and recovery-auditor patient-status review. The exemption lasts until CMS determines from claims data that the procedure is done outpatient more than half the time in a calendar year, and ends it through rulemaking. CMS has not ended any (${cfr('412.3', '42 CFR 412.3(d)(2)')}; ${fr('90 FR 53832')}; ${fr('91 FR 70573')}).`;
  if (exemption.disputed) {
    text += ` One caution for this date: from 2022 through 2025 the regulation also said removals on or after January 1, 2020 were exempt for two years (${fr('86 FR 63992')}). CMS has since called that a drafting oversight and said the exemption “remained the indefinite exemption period” (${fr('90 FR 53829')}).`;
  }
  return text + more;
}

function appliesText(result) {
  if (result.state === 'ipo') {
    return 'Medicare pays the hospital for this only as an inpatient service. On an outpatient claim, the hospital is not paid for it under the outpatient system.';
  }
  if (result.state === 'gone') return 'If the code was replaced, look up the code that replaced it.';
  if (result.si === 'E1') return 'Off the inpatient-only list, but CMS’s file shows it as not paid on outpatient claims on this date.';
  return `Medicare can pay for it in either setting. Whether an inpatient admission is appropriate turns on the two-midnight rule: an expected stay crossing two midnights, or the physician’s documented case-by-case judgment (${cfr('412.3', '42 CFR 412.3(d)(1) and (3)')}).`;
}

const firstFile = (data) => monthYear(data.periods[0].d);

/** The one-sentence answer and the sentence under it, both as HTML. `last` is the event in force. */
export function answer(data, result, today) {
  const on = `on ${formatDate(result.date)}`;
  const code = esc(result.code);
  if (result.kind === 'unknown') {
    return { state: 'gone', head: `No record of ${code}.`, lead: `It is not in any Addendum B on this site, ${firstFile(data)} onward. Check the code.` };
  }
  if (result.kind === 'other') {
    return result.state === 'off'
      ? { state: 'off', head: `Not inpatient only ${on}.`, lead: `${code} has not been on the inpatient-only list at any time since ${firstFile(data)}.` }
      : { state: 'gone', head: `Not in Medicare’s files ${on}.`, lead: `${code} is in other Addendum B files, and was never on the inpatient-only list in any of them (${firstFile(data)} onward).` };
  }
  const events = eventsOf(data, result.record);
  const before = events.filter((event) => event.date <= result.date);
  const last = before[before.length - 1];
  const head = { ipo: `Inpatient only ${on}.`, off: `Not inpatient only ${on}.`, gone: `Not in Medicare’s files ${on}.` }[result.state];
  if (!last) {
    const first = `${esc(eventPhrase(events[0], today))}.`;
    return { state: result.state, head, lead: result.state === 'off' ? `Not on the list yet. ${first}` : first };
  }
  return { state: result.state, head, lead: `${esc(eventPhrase(last, today))}.`, last };
}

// The timeline runs from the first file we hold to the day the regulation says the list is gone.
// 2029-01-01 is the regulation's date: 42 CFR 419.22(n).
export const AXIS = { from: '2017-01-01', to: '2029-01-01' };
export const axis = scale(AXIS.from, AXIS.to);
/** A CSS percentage for a 0..1 share. */
export const pct = (share) => `${(share * 100).toFixed(3)}%`;
/** A year label at each January 1 along the axis. */
export function axisYears(className) {
  const out = [];
  for (let year = Number(AXIS.from.slice(0, 4)); year <= Number(AXIS.to.slice(0, 4)); year += 1) {
    out.push(`<span class="${className}" style="left:${pct(axis.share(`${year}-01-01`))}">${year}</span>`);
  }
  return out.join('');
}
const box = (from, to) => `left:${pct(axis.share(from))};width:${pct(axis.share(to) - axis.share(from))}`;

/** A code's status across time, with a marker at the date of service. */
export function timeline(data, record, date) {
  const known = addDays(data.dosMax, 1);
  const parts = [];
  record.spans.forEach((span, i) => {
    const from = data.periods[span[0]].d;
    const to = i + 1 < record.spans.length ? data.periods[record.spans[i + 1][0]].d : known;
    const state = stateOf(span[1]);
    if (state !== 'gone') parts.push(`<span class="tl__seg tl__seg--${state}" style="${box(from, to)}"></span>`);
    const exemption = span[2] >= 0 ? data.exemptions[span[2]] : null;
    if (exemption && exemption.kind !== 'before-2020') {
      const end = exemption.through && addDays(exemption.through, 1) < to ? addDays(exemption.through, 1) : to;
      if (end > from) parts.push(`<span class="tl__ex" style="${box(from, end)}"></span>`);
    }
  });
  parts.push(`<span class="tl__open" style="${box(known, AXIS.to)}"></span>`);
  const years = axisYears('tl__year');
  return `<figure class="tl">
<div class="tl__track" data-track>${parts.join('')}<span class="tl__mark" data-mark style="left:${pct(axis.share(date))}"><span class="tl__date" data-mark-date>${formatDate(date, 'short')}</span></span></div>
<div class="tl__axis" aria-hidden="true">${years}</div>
<input class="tl__range" data-range type="range" min="${dayNumber(data.dosMin)}" max="${dayNumber(data.dosMax)}" value="${dayNumber(date)}" aria-label="Date of service, ${formatDate(data.dosMin)} to ${formatDate(data.dosMax)}" aria-valuetext="${formatDate(date)}">
<figcaption class="tl__legend"><span><i class="key key--ipo"></i>On the inpatient-only list</span><span><i class="key key--off"></i>Off the list</span><span><i class="key key--ex"></i>Exempt from certain medical review</span><span><i class="key key--open"></i>${Number(data.dosMax.slice(0, 4)) + 1}: not yet decided</span></figcaption>
</figure>`;
}

/** The full list of a code's events, each with its source. */
export function eventList(data, code, date, today) {
  const rows = eventsOf(data, data.codes[code]).map((event) => {
    const later = event.date > date ? ' class="later"' : '';
    return `<li${later}><span class="events__what">${esc(eventPhrase(event, today))}</span><span class="events__src">${eventSource(data, event, code)}</span></li>`;
  });
  return `<ol class="events">${rows.join('')}</ol>`;
}

/** The code and its label, as the page title (h1) or as a heading inside a results panel. */
function identity(title, code, label, where) {
  const text = `<span class="verdict__code">${esc(code)}</span> <span class="verdict__label">${label}</span>`;
  return `<header class="verdict__id"><${title} class="verdict__title">${text}</${title}>${where}</header>`;
}

/** The caution shown, once per page beside the date, for dates answered from a final rule before CMS posts that January's file. */
export const scheduledNote = (period) => `Scheduled. This comes from the ${esc(period.label)}; CMS’s January file will confirm it.`;

/**
 * Everything about one code on one date, in two parts so the browser can redraw the answer
 * without rebuilding the timeline under the reader's finger:
 *   state     'ipo' | 'off' | 'gone', for the panel's class
 *   body      the code's name, the answer, and the facts behind it (changes with the date)
 *   timeline  the code's status across time (only its marker moves with the date)
 * title/heading are the tags for the code's name and for the answer.
 */
export function verdictParts(data, code, date, today, other = null, { title = 'h2', heading = 'h3' } = {}) {
  const result = lookup(data, code, date, other);
  if (result.kind === 'pending') return { state: 'gone', body: `<p class="verdict__wait">Checking ${esc(code)}…</p>`, timeline: '' };
  const reply = answer(data, result, today);
  if (result.kind !== 'listed') {
    const file = result.kind === 'other' && result.state === 'off' ? ` It is in the ${fileLink(result.period)}; see that file for its status indicator.` : '';
    return {
      state: reply.state,
      timeline: '',
      body: `${identity(title, code, '<span class="verdict__none">No description: this site describes only codes that have been on the list.</span>', '')}
<${heading} class="verdict__answer">${reply.head}</${heading}>
<p class="verdict__lead">${reply.lead}${file}</p>
<p class="verdict__note">Off the inpatient-only list is not the same as payable. Other status indicators also mean Medicare does not pay a code on an outpatient claim.</p>`,
    };
  }
  const record = result.record;
  const cautions = (data.notes[code] || []).filter((note) => date >= note.from)
    .map((note) => `<p class="verdict__note">${esc(note.text)} (${fr(note.cite)})</p>`).join('');
  const [family, groupIndex] = data.families[record.family];
  const [groupId, groupName] = data.groups[groupIndex];
  const status = result.state === 'gone'
    ? `Not in the ${result.period ? fileLink(result.period) : 'files'}${result.si === 'D' ? ' as an active code (status indicator D, discontinued)' : ''}.`
    : `${statusText(result.si)} ${fileLink(result.period)}.`;
  return {
    state: reply.state,
    timeline: timeline(data, record, date),
    body: `${identity(title, code, esc(record.label), `<p class="verdict__where"><a href="/group/${esc(groupId)}/">${esc(groupName)}</a>: ${esc(family)}</p>`)}
<${heading} class="verdict__answer">${reply.head}</${heading}>
<p class="verdict__lead">${reply.lead}${reply.last ? ` <span class="verdict__src">${eventSource(data, reply.last, code)}</span>` : ''}</p>
${cautions}
<dl class="facts">
<div><dt>In CMS’s file</dt><dd>${status}</dd></div>
<div><dt>Medical review</dt><dd>${exemptionText(data, result)}</dd></div>
<div><dt>What applies</dt><dd>${appliesText(result)}</dd></div>
</dl>`,
  };
}

/** The whole panel. `link` adds a link to the code's own page (for results on the home page). */
export function verdict(data, code, date, today, other = null, options = {}) {
  const parts = verdictParts(data, code, date, today, other, options);
  const more = options.link && parts.timeline
    ? `<p class="verdict__more"><a href="/code/${esc(code)}/" data-more>Full history and sources for ${esc(code)}</a></p>` : '';
  return `<article class="verdict verdict--${parts.state}" data-verdict="${esc(code)}"><div data-verdict-body>${parts.body}</div>${parts.timeline}${more}</article>`;
}

/** One line of a code list: code, label, and its status on the date. */
export function codeRow(data, code, date) {
  const record = data.codes[code];
  const result = lookup(data, code, date);
  return `<li><a class="row" href="/code/${esc(code)}/" data-row="${esc(code)}"><span class="row__code">${esc(code)}</span><span class="row__label">${esc(record.label)}</span>${chip(result.state)}</a></li>`;
}
