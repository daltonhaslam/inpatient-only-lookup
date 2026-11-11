// HTML for the parts of the site that change with the date of service. Used by the build to
// prerender pages and by the browser to redraw them, so both always say the same thing.
import { STATUS, CFR } from './site.mjs';
import { formatDate, monthYear, addDays, dayNumber, lookup, eventsOf, stateOf } from './engine.mjs';

export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A link that leaves the site: new tab, no referrer, and a spoken hint. */
export const out = (href, text) =>
  `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}<span class="sr"> (opens in a new tab)</span></a>`;

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
export function eventPhrase(event, today) {
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

/** Where an event is documented: the final rule's page if we have one, and always the CMS file. */
export function eventSource(data, event) {
  const rule = event.date.endsWith('-01-01') ? data.rules[event.date.slice(0, 4)] : null;
  const cite = rule && rule.cites[event.type];
  const file = fileLink(event.period);
  if (cite) return `${esc(rule.name)}, ${fr(cite)}; ${file}`;
  if (rule && event.type !== 'listed' && event.period.basis !== 'q') return `${esc(rule.name)}, ${fr(rule.fr)}; ${file}`;
  return file;
}

function exemptionText(result) {
  const { exemption, state } = result;
  const more = ' <a href="/exemption/">What the exemption covers</a>.';
  if (state === 'ipo') {
    return `Not in play while the code is on the list. An inpatient admission for an inpatient-only procedure is generally appropriate for Part A payment whatever the expected length of stay (${cfr('412.3', '42 CFR 412.3(d)(2)')}).`;
  }
  if (state === 'gone') return 'Nothing to apply: the code is not in Medicare’s files on this date.';
  if (!exemption) {
    return 'No exemption. The exemption is for procedures taken off the list, and this code had not been on it (in files back to 2017).';
  }
  const removed = formatDate(exemption.from);
  if (exemption.status === 'none') {
    return `No exemption on this date. It left the list ${removed}; the exemptions in 42 CFR 412.3(d)(2) begin with procedures removed in 2020 (${fr('84 FR 61365')}).${more}`;
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
  let text = `<strong>Exempt on this date.</strong> It left the list ${removed}, so claims for it are exempt from site-of-service denials, referral to recovery auditors for two-midnight noncompliance, and recovery-auditor patient-status review. The exemption lasts until CMS finds the procedure is done outpatient more than half the time in a calendar year; CMS has ended none so far (${cfr('412.3', '42 CFR 412.3(d)(2)')}; ${fr('90 FR 53832')}).`;
  if (exemption.disputed) {
    text += ` One caution for this date: from 2022 through 2025 the regulation also said removals on or after January 1, 2020 were exempt for two years (${fr('86 FR 63992')}). CMS has since said that change never took effect and the indefinite exemption remained (${fr('90 FR 53829')}).`;
  }
  return text + more;
}

function appliesText(result) {
  if (result.state === 'ipo') {
    return 'Medicare pays for this only as an inpatient service. Performed on an outpatient, it is not paid under the outpatient system.';
  }
  if (result.state === 'gone') return 'If the code was replaced, look up the code that replaced it.';
  if (result.si === 'E1') return 'Off the inpatient-only list, but CMS’s file shows it as not paid on outpatient claims on this date.';
  return `Medicare can pay for it in either setting. Whether an inpatient admission is appropriate turns on the two-midnight rule: an expected stay crossing two midnights, or the physician’s documented case-by-case judgment (${cfr('412.3', '42 CFR 412.3(d)(1) and (3)')}).`;
}

/** The one-sentence answer and the sentence under it. */
export function answer(data, result, today) {
  const on = `on ${formatDate(result.date)}`;
  const code = esc(result.code);
  if (result.kind === 'unknown') {
    return { state: 'gone', head: `No record of ${code}.`, lead: 'It is not in any Addendum B on this site, January 2017 onward. Check the code.' };
  }
  if (result.kind === 'other') {
    return result.state === 'off'
      ? { state: 'off', head: `Not inpatient only ${on}.`, lead: `${code} has not been on the inpatient-only list at any time since January 2017.` }
      : { state: 'gone', head: `Not in Medicare’s files ${on}.`, lead: `${code} is in other Addendum B files, and was never on the inpatient-only list in any of them (January 2017 onward).` };
  }
  const events = eventsOf(data, result.record);
  const before = events.filter((event) => event.date <= result.date);
  const last = before[before.length - 1];
  if (result.state === 'ipo') {
    return { state: 'ipo', head: `Inpatient only ${on}.`, lead: `${eventPhrase(last, today)}.`, last };
  }
  if (result.state === 'off') {
    const lead = last ? `${eventPhrase(last, today)}.` : `Not on the list yet. ${eventPhrase(events[0], today)}.`;
    return { state: 'off', head: `Not inpatient only ${on}.`, lead, last };
  }
  if (!last) {
    return { state: 'gone', head: `Not in Medicare’s files ${on}.`, lead: `${eventPhrase(events[0], today)}.` };
  }
  return { state: 'gone', head: `Not in Medicare’s files ${on}.`, lead: `${eventPhrase(last, today)}.`, last };
}

// The timeline runs from the first file we hold to the day the regulation says the list is gone.
export const AXIS = { from: '2017-01-01', to: '2029-01-01' };
const percent = (iso) => {
  const span = dayNumber(AXIS.to) - dayNumber(AXIS.from);
  return Math.max(0, Math.min(100, ((dayNumber(iso) - dayNumber(AXIS.from)) / span) * 100));
};
const box = (from, to) => `left:${percent(from).toFixed(3)}%;width:${(percent(to) - percent(from)).toFixed(3)}%`;

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
  const years = [];
  for (let year = 2017; year <= 2029; year += 1) {
    years.push(`<span class="tl__year" style="left:${percent(`${year}-01-01`).toFixed(3)}%">${year}</span>`);
  }
  return `<figure class="tl">
<div class="tl__track" data-track>${parts.join('')}<span class="tl__mark" data-mark style="left:${percent(date).toFixed(3)}%"><span class="tl__date" data-mark-date>${formatDate(date, 'short')}</span></span></div>
<div class="tl__axis" aria-hidden="true">${years.join('')}</div>
<input class="tl__range" data-range type="range" min="${dayNumber(data.dosMin)}" max="${dayNumber(data.dosMax)}" value="${dayNumber(date)}" aria-label="Date of service, ${formatDate(data.dosMin)} to ${formatDate(data.dosMax)}" aria-valuetext="${formatDate(date)}">
<figcaption class="tl__legend"><span><i class="key key--ipo"></i>On the inpatient-only list</span><span><i class="key key--off"></i>Off the list</span><span><i class="key key--ex"></i>Exempt from certain medical review</span><span><i class="key key--open"></i>2028: not yet decided</span></figcaption>
</figure>`;
}

/** The full list of a code's events, each with its source. */
export function eventList(data, record, date, today) {
  const rows = eventsOf(data, record).map((event) => {
    const later = event.date > date ? ' class="later"' : '';
    return `<li${later}><span class="events__what">${esc(eventPhrase(event, today))}</span><span class="events__src">${eventSource(data, event)}</span></li>`;
  });
  return `<ol class="events">${rows.join('')}</ol>`;
}

/** The code and its label, as the page title (h1) or as a heading inside a results panel. */
function identity(title, code, label, where) {
  const text = `<span class="verdict__code">${esc(code)}</span> <span class="verdict__label">${label}</span>`;
  return `<header class="verdict__id"><${title} class="verdict__title">${text}</${title}>${where}</header>`;
}

/**
 * Everything about one code on one date: the answer, the facts behind it, the timeline.
 * title/heading are the tags for the code's name and for the answer; link adds a link to the code's page.
 */
export function verdict(data, code, date, today, other = null, { title = 'h2', heading = 'h3', link = false } = {}) {
  const result = lookup(data, code, date, other);
  if (result.kind === 'pending') return `<p class="verdict__wait">Checking ${esc(code)}…</p>`;
  const reply = answer(data, result, today);
  const scheduled = result.period && result.period.basis === 'f'
    ? `<p class="verdict__note">Scheduled. This comes from the ${esc(result.period.label)}; CMS’s January file will confirm it.</p>` : '';
  if (result.kind !== 'listed') {
    const file = result.kind === 'other' && result.state === 'off' ? ` It is in the ${fileLink(result.period)}; see that file for its status indicator.` : '';
    return `<article class="verdict verdict--${reply.state}" data-verdict="${esc(code)}">
${identity(title, code, '<span class="verdict__none">No description: this site describes only codes that have been on the list.</span>', '')}
<${heading} class="verdict__answer">${reply.head}</${heading}>
<p class="verdict__lead">${reply.lead}${file}</p>
<p class="verdict__note">Off the inpatient-only list is not the same as payable. Other status indicators also mean Medicare does not pay a code on an outpatient claim.</p>
</article>`;
  }
  const record = result.record;
  const [family, groupIndex] = data.families[record.family];
  const [groupId, groupName] = data.groups[groupIndex];
  const status = result.state === 'gone'
    ? `Not in the ${result.period ? fileLink(result.period) : 'files'}${result.si === 'D' ? ' as an active code (status indicator D, discontinued)' : ''}.`
    : `${statusText(result.si)} ${fileLink(result.period)}.`;
  const full = link ? `<p class="verdict__more"><a href="/code/${esc(code)}/?dos=${esc(date)}">Full history and sources for ${esc(code)}</a></p>` : '';
  return `<article class="verdict verdict--${reply.state}" data-verdict="${esc(code)}">
${identity(title, code, esc(record.label), `<p class="verdict__where"><a href="/group/${esc(groupId)}/">${esc(groupName)}</a>: ${esc(family)}</p>`)}
<${heading} class="verdict__answer">${reply.head}</${heading}>
<p class="verdict__lead">${esc(reply.lead)}${reply.last ? ` <span class="verdict__src">${eventSource(data, reply.last)}</span>` : ''}</p>
${scheduled}
<dl class="facts">
<div><dt>In CMS’s file</dt><dd>${status}</dd></div>
<div><dt>Medical review</dt><dd>${exemptionText(result)}</dd></div>
<div><dt>What applies</dt><dd>${appliesText(result)}</dd></div>
</dl>
${timeline(data, record, date)}
${full}
</article>`;
}

/** One line of a code list: code, label, and its status on the date. */
export function codeRow(data, code, date) {
  const record = data.codes[code];
  const result = lookup(data, code, date);
  return `<li><a class="row" href="/code/${esc(code)}/" data-row="${esc(code)}"><span class="row__code">${esc(code)}</span><span class="row__label">${esc(record.label)}</span>${chip(result.state)}</a></li>`;
}
