// Browser behavior: the date of service, the search box, the timeline scrubber, the bulk check.
// Every page is complete without this script; it only makes the date and the search live.
import {
  isDate, formatDate, todayISO, clampDate, dayNumber, fromDayNumber, normalizeCode, isCode, periodIndex,
  stateAt, lookup, expandOther, countsAt, exemptCodes, buildIndex, search, extractCodes, num, csv, isScheduled,
} from './engine.mjs';
import { esc, chip, CHIP, verdict, verdictParts, eventList, codeRow, answer, axis, pct, scheduledNote } from './views.mjs';

// Vercel Web Analytics: never send what someone searched for or which date they chose.
window.va = window.va || function va() { (window.vaq = window.vaq || []).push(arguments); };
window.va('beforeSend', (event) => ({ ...event, url: event.url.split(/[?#]/)[0] }));

const $ = (selector, rootNode = document) => rootNode.querySelector(selector);
const $$ = (selector, rootNode = document) => [...rootNode.querySelectorAll(selector)];
const params = () => new URLSearchParams(window.location.search);

const BULK_LIMIT = 500;

const state = {
  data: null, other: null, otherLoading: null, otherFailed: false, index: null,
  date: null, today: null, period: null,   // period: index of the Addendum B in force on `date`
  query: '', bulk: [], bulkDropped: 0,
  cells: [],         // the whole-list squares, resolved once: {node, record, state}
  counts: new Map(), // period index -> countsAt()
};

function remember(date) {
  // Today is the default, not a choice: storing it would bring "yesterday" back tomorrow.
  try {
    if (date === state.today) window.sessionStorage.removeItem('dos'); else window.sessionStorage.setItem('dos', date);
  } catch { /* private mode: the URL still carries it */ }
}

const usable = (date) => isDate(date) && clampDate(state.data, date) === date;

/** The date this tab last chose, or today. */
function rememberedDate() {
  let kept = null;
  try { kept = window.sessionStorage.getItem('dos'); } catch { /* none */ }
  return usable(kept) ? kept : state.today;
}

/** A date in the link wins; otherwise the date this tab last chose; otherwise today. */
function startingDate() {
  // Coming back to a page, the tab's latest choice beats the date frozen in that page's address.
  const [navigation] = window.performance.getEntriesByType('navigation');
  if (navigation && navigation.type === 'back_forward') return rememberedDate();
  const fromUrl = params().get('dos');
  return usable(fromUrl) ? fromUrl : rememberedDate();
}

function writeUrl() {
  const next = params();
  if (state.date === state.today) next.delete('dos'); else next.set('dos', state.date);
  if (document.body.dataset.page === 'home') {
    if (state.query) next.set('q', state.query); else next.delete('q');
  }
  const text = next.toString();
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${text ? `?${text}` : ''}${window.location.hash}`);
  } catch { /* Safari refuses more than 100 of these in 30 seconds; the next one will catch up */ }
}

// Keep the address bar and the remembered date in step with the page, but not on every frame
// of a drag: browsers throttle history writes.
let persistTimer = 0;
function persist(now = false) {
  remember(state.date);   // at once: a link clicked in the next instant must carry the date
  clearTimeout(persistTimer);
  if (now) writeUrl(); else persistTimer = setTimeout(writeUrl, 250);
}

function loadOther() {
  if (!state.otherLoading) {
    state.otherFailed = false;
    state.otherLoading = fetch(document.body.dataset.other)
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .then((packed) => { state.other = expandOther(packed); })
      .catch(() => { state.otherLoading = null; state.otherFailed = true; })
      .then(() => { drawVerdicts(); drawBulk(); });
  }
  return state.otherLoading;
}

// ---- drawing ------------------------------------------------------------------------------
// A date change redraws in three tiers: the controls and each verdict's answer (every change),
// the lists, squares and counts (only when the date crosses into another Addendum B), and the
// search results (only when the query changes).

function setHtml(node, html) {
  if (node && node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
}

function drawControls() {
  const { date } = state;
  for (const input of $$('[data-dos]')) if (input.value !== date) input.value = date;
  for (const button of $$('[data-today]')) button.hidden = date === state.today;
  const day = String(dayNumber(date));
  const spoken = formatDate(date);
  for (const range of $$('[data-range]')) {
    if (range.value !== day) range.value = day;
    range.setAttribute('aria-valuetext', spoken);
  }
  for (const node of $$('[data-dos-text]')) node.textContent = spoken;
  for (const mark of $$('[data-mark]')) {
    mark.style.left = pct(axis.share(date));
    $('[data-mark-date]', mark).textContent = formatDate(date, 'short');
  }
  for (const link of $$('[data-more]')) link.href = link.pathname + (date === state.today ? '' : `?dos=${date}`);
  const period = state.data.periods[periodIndex(state.data, date)];
  const scheduled = isScheduled(period);
  for (const note of $$('[data-scheduled]')) {
    note.hidden = !scheduled;
    if (scheduled) setHtml(note, scheduledNote(period));
  }
}

function drawVerdicts() {
  const { data, date, today, other } = state;
  for (const host of $$('[data-verdict-host]')) {
    const code = host.dataset.verdictHost;
    const options = { title: host.dataset.title || 'h2', heading: host.dataset.heading || 'h3', link: host.dataset.link === '1' };
    const body = $('[data-verdict-body]', host);
    if (!data.codes[code] && !other && state.otherFailed) {
      setHtml(host, `<p class="results__none">Couldn’t load the list of codes that were never inpatient only, so ${esc(code)} can’t be checked right now. Check your connection and try again.</p>`);
      continue;
    }
    const parts = verdictParts(data, code, date, today, other, options);
    // Rebuild the whole panel when there is none yet, or when its timeline appears or disappears
    // (a code that turns out to have no history); otherwise swap only the answer.
    if (!body || Boolean(parts.timeline) !== Boolean($('.tl', host))) {
      host.innerHTML = verdict(data, code, date, today, other, options);
      delete host.dataset.html;
    } else {
      setHtml(body, parts.body);
      body.parentNode.className = `verdict verdict--${parts.state}`;
    }
  }
  for (const host of $$('[data-events-host]')) {
    setHtml(host, eventList(data, host.dataset.eventsHost, date, today));
  }
}

function drawLists() {
  const { data, period } = state;
  for (const row of $$('[data-row]')) {
    const now = stateAt(data.codes[row.dataset.row], period);
    const badge = $('.chip', row);
    if (badge && badge.dataset.state !== now) {
      badge.className = `chip chip--${now}`;
      badge.textContent = CHIP[now];
      badge.dataset.state = now;
    }
  }
  for (const cell of state.cells) {
    const now = stateAt(cell.record, period);
    if (cell.state !== now) { cell.node.className = `cell cell--${now}`; cell.state = now; }
  }
  const counted = $$('[data-count]');
  if (counted.length) {
    if (!state.counts.has(period)) state.counts.set(period, countsAt(data, period));
    const counts = state.counts.get(period);
    for (const node of counted) {
      const key = node.dataset.count;
      if (key !== 'exempt') node.textContent = num(key === 'total' ? counts.total : counts.groups[Number(key)]);
    }
  }
}

function drawExempt() {
  const nodes = $$('[data-count="exempt"]');
  if (nodes.length) {
    const count = num(exemptCodes(state.data, state.date).length);
    for (const node of nodes) node.textContent = count;
  }
}

function drawResults() {
  const host = $('[data-results]');
  if (!host) return;
  const { data, date } = state;
  const query = state.query.trim();
  document.documentElement.classList.toggle('asked', Boolean(query));
  if (!query) { host.innerHTML = ''; return; }
  // "27447", "CPT 27447", "27447-RT" and "hip replacement 27130" all mean one code.
  const named = extractCodes(query);
  const code = named.length === 1 ? named[0] : normalizeCode(query);
  if (isCode(code)) {
    if (!data.codes[code] && !state.other) loadOther();
    host.innerHTML = `<div data-verdict-host="${esc(code)}" data-link="1"></div>`;
    drawVerdicts();
    drawControls();
    return;
  }
  if (named.length > 1) {
    host.innerHTML = `<p class="results__none">That looks like ${named.length} codes. The search box takes one at a time; <a href="#several-h">check several codes at once</a> just below.</p>`;
    return;
  }
  state.index ||= buildIndex(data);
  const found = search(state.index, query);
  if (!found.total) {
    host.innerHTML = `<p class="results__none">Nothing matches “${esc(query)}”. Procedure names here cover only codes that have been on the list. A full five-character code gets an answer either way.</p>`;
    return;
  }
  const more = found.total > found.codes.length ? ` Showing the first ${found.codes.length}; keep typing to narrow it.` : '';
  host.innerHTML = `<p class="results__count">${num(found.total)} ${found.total === 1 ? 'code matches' : 'codes match'}, with status on <span data-dos-text>${formatDate(date)}</span>.${more}</p>
<ul class="rows" data-rows>${found.codes.map((match) => codeRow(data, match, date)).join('')}</ul>`;
}

function bulkRows() {
  return state.bulk.map((code) => {
    const result = lookup(state.data, code, state.date, state.other);
    const reply = answer(state.data, result, state.today);
    const exemption = result.state === 'off' && result.exemption;
    return {
      code,
      listed: result.kind === 'listed',
      unknown: result.kind === 'unknown',
      label: result.kind === 'listed' ? result.record.label : '',
      state: reply.state,
      status: result.kind === 'unknown' ? 'No record of this code' : CHIP[reply.state],
      removed: result.removed ? formatDate(result.removed, 'short') : '',
      exemption: exemption ? { active: 'Exempt', ended: 'Ended', none: 'None' }[exemption.status] : '',
      basis: result.kind === 'unknown' ? '' : isScheduled(result.period) ? 'scheduled (final rule)' : 'CMS Addendum B',
    };
  });
}

function drawBulk() {
  const host = $('[data-bulk-out]');
  if (!host || !state.bulk.length) return;
  if (!state.other) {
    setHtml(host, state.otherFailed
      ? '<p class="results__none">Couldn’t load the list of codes that were never inpatient only. Check your connection and try again.</p>'
      : '<p>Checking…</p>');
    return;
  }
  const rows = bulkRows();
  const body = rows.map((row) => `<tr><th scope="row">${row.listed ? `<a href="/code/${esc(row.code)}/">${esc(row.code)}</a>` : esc(row.code)}</th><td>${esc(row.label)}</td><td>${row.unknown ? esc(row.status) : chip(row.state)}</td><td>${esc(row.removed)}</td><td>${esc(row.exemption)}</td></tr>`).join('');
  const tally = (state) => rows.filter((row) => row.state === state).length;
  const missing = tally('gone');
  const notes = state.bulkDropped
    ? `<p class="note note--sched">Only the first ${rows.length} codes were checked; ${state.bulkDropped} more were left out.</p>` : '';
  setHtml(host, `<p class="results__count">${rows.length} ${rows.length === 1 ? 'code' : 'codes'} on ${formatDate(state.date)}: ${tally('ipo')} inpatient only, ${tally('off')} not${missing ? `, ${missing} not in CMS’s files on that date or not found` : ''}.</p>${notes}
<div class="scroll"><table class="check"><thead><tr><th scope="col">Code</th><th scope="col">Procedure</th><th scope="col">Status</th><th scope="col">Left the list</th><th scope="col">Review exemption</th></tr></thead><tbody>${body}</tbody></table></div>
<p><button type="button" class="quiet" data-bulk-csv>Download as CSV</button></p>`);
}

function downloadBulk() {
  const rows = [['code', 'procedure', 'date_of_service', 'status', 'left_the_list', 'review_exemption', 'source']]
    .concat(bulkRows().map((row) => [row.code, row.label, state.date, row.status, row.removed, row.exemption, row.basis]));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv' }));
  link.download = `inpatient-only-${state.date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function drawDate() {
  const period = periodIndex(state.data, state.date);
  drawVerdicts();
  drawControls();
  if (period !== state.period) {
    state.period = period;
    drawLists();
  }
  drawExempt();
  drawBulk();
}

/** On leaving the date field: a real date outside the range goes to the nearest date answered;
 *  a half-typed one (year 0202) is dropped. Either way the field ends up showing the date in force. */
function settleDateField(input) {
  if (isDate(input.value) && input.value >= '2000-01-01') setDate(input.value);
  input.value = state.date;
}

function setDate(date) {
  const next = clampDate(state.data, date);
  if (next === state.date) return;
  state.date = next;
  persist();
  drawDate();
}

// ---- events -------------------------------------------------------------------------------

function wire() {
  let frame = 0;
  let drag = null;   // the box of the track being dragged, read once when the drag starts
  const later = (job) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(job); };
  const dateAt = (clientX) => axis.at((clientX - drag.left) / drag.width);

  document.addEventListener('pointerdown', (event) => {
    const track = event.target.closest?.('[data-track]');
    if (!track || event.button > 0) return;
    const box = track.getBoundingClientRect();
    // A finger may be starting a scroll, so a touch only takes hold once it moves sideways
    // (or lifts without moving: a tap). A mouse or pen takes hold at once.
    drag = { left: box.left, width: box.width, x: event.clientX, y: event.clientY, held: event.pointerType !== 'touch' };
    if (drag.held) {
      event.preventDefault();
      setDate(dateAt(event.clientX));
    }
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (!drag.held) {
      const dx = Math.abs(event.clientX - drag.x);
      if (dx < 6 || dx < Math.abs(event.clientY - drag.y)) return;
      drag.held = true;
    }
    later(() => { if (drag) setDate(dateAt(event.clientX)); });
  });
  // A quick flick can end before the queued frame runs: land on the release point, then stop.
  document.addEventListener('pointerup', (event) => {
    if (!drag) return;
    cancelAnimationFrame(frame);
    const tap = Math.abs(event.clientX - drag.x) < 6 && Math.abs(event.clientY - drag.y) < 6;
    if (drag.held || tap) setDate(dateAt(event.clientX));
    drag = null;
    persist(true);
  });
  // The browser took the gesture for scrolling: leave the date alone.
  document.addEventListener('pointercancel', () => { drag = null; });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches('[data-range]')) setDate(fromDayNumber(Number(target.value)));
    else if (target.matches('[data-q]')) {
      state.query = target.value;
      writeUrl();
      later(() => { drawResults(); drawLists(); });
    }
  });
  // A date field reports each keystroke of the year as a complete date (0002, 0020, 0202...).
  // Act only on a date the site answers for; on leaving the field, show the date in force.
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-dos]') && usable(target.value)) setDate(target.value);
  });
  document.addEventListener('focusout', (event) => {
    const target = event.target;
    if (!target.matches?.('[data-dos]') || target.value === state.date) return;
    settleDateField(target);
  });
  // A page restored from the back/forward cache may be showing an older date than the tab's.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) setDate(rememberedDate());
  });
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.matches('[data-ask], [data-dos-form]')) {
      event.preventDefault();
      const input = $('[data-dos]', form);
      if (input) settleDateField(input);
      $('[data-results] a')?.focus();
    } else if (form.matches('[data-bulk]')) {
      event.preventDefault();
      const pasted = extractCodes($('[data-bulk-input]', form).value);
      state.bulk = pasted.slice(0, BULK_LIMIT);
      state.bulkDropped = pasted.length - state.bulk.length;
      if (!state.bulk.length) {
        setHtml($('[data-bulk-out]'), '<p class="results__none">No five-character codes found in that text.</p>');
        return;
      }
      drawBulk();
      loadOther();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target.closest('[data-today]')) setDate(state.today);
    else if (target.closest('[data-bulk-csv]')) downloadBulk();
    else if (target.matches('[data-cell]')) window.location.assign(`/code/${target.dataset.cell}/`);
  });

  const hint = $('[data-cell-hint]');
  if (hint) {
    const idle = hint.textContent;
    const cells = $('[data-cells]');
    cells.addEventListener('pointerover', (event) => {
      if (!event.target.matches('[data-cell]')) return;
      const code = event.target.dataset.cell;
      const record = state.data.codes[code];
      hint.textContent = `${code} ${record.label}: ${CHIP[stateAt(record, state.period)].toLowerCase()}`;
    });
    cells.addEventListener('pointerleave', () => { hint.textContent = idle; });
  }
}

async function start() {
  const source = document.body.dataset.ipo;
  if (!source) {         // a page that does not depend on the date
    document.documentElement.classList.add('live');
    return;
  }
  const response = await fetch(source);
  if (!response.ok) return;
  const data = await response.json();
  state.data = data;
  state.today = clampDate(data, todayISO());
  state.date = startingDate();
  state.cells = $$('[data-cell]').map((node) => ({ node, record: data.codes[node.dataset.cell], state: null }));
  const box = $('[data-q]');
  if (box) {
    state.query = params().get('q') || box.value || '';
    box.value = state.query;
  }
  wire();
  drawResults();
  drawDate();
  persist(true);
  document.documentElement.classList.add('live');
}

start().catch(() => { /* the static page stands on its own */ });
