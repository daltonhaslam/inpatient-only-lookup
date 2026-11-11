// Browser behavior: the date of service, the search box, the timeline scrubber, the bulk check.
// Every page is complete without this script; it only makes the date and the search live.
import {
  isDate, formatDate, todayISO, clampDate, dayNumber, fromDayNumber, normalizeCode, isCode, periodIndex,
  spanAt, stateOf, lookup, expandOther, countsAt, buildIndex, search, extractCodes,
} from './engine.mjs';
import { esc, chip, CHIP, verdict, eventList, codeRow, answer, AXIS } from './views.mjs';

// Vercel Web Analytics: never send what someone searched for or which date they chose.
window.va = window.va || function va() { (window.vaq = window.vaq || []).push(arguments); };
window.va('beforeSend', (event) => ({ ...event, url: event.url.split(/[?#]/)[0] }));

const $ = (selector, rootNode = document) => rootNode.querySelector(selector);
const $$ = (selector, rootNode = document) => [...rootNode.querySelectorAll(selector)];
const params = () => new URLSearchParams(window.location.search);

const state = { data: null, other: null, otherLoading: null, index: null, date: null, today: null, query: '', bulk: [] };

function remember(date) {
  try { window.sessionStorage.setItem('dos', date); } catch { /* private mode: the URL still carries it */ }
}

function recall() {
  try { return window.sessionStorage.getItem('dos'); } catch { return null; }
}

function startingDate(data) {
  const fromUrl = params().get('dos');
  if (isDate(fromUrl) && fromUrl >= data.dosMin && fromUrl <= data.dosMax) return fromUrl;
  const kept = recall();
  if (isDate(kept) && kept >= data.dosMin && kept <= data.dosMax) return kept;
  return clampDate(data, todayISO());
}

function writeUrl() {
  const next = params();
  if (state.date === state.today) next.delete('dos'); else next.set('dos', state.date);
  if (document.body.dataset.page === 'home') {
    if (state.query) next.set('q', state.query); else next.delete('q');
  }
  const text = next.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${text ? `?${text}` : ''}${window.location.hash}`);
}

function loadOther() {
  if (!state.otherLoading) {
    state.otherLoading = fetch(document.body.dataset.other)
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .then((packed) => { state.other = expandOther(packed); })
      .catch(() => { state.otherLoading = null; });
  }
  return state.otherLoading;
}

// ---- drawing ------------------------------------------------------------------------------

function drawVerdictHosts() {
  for (const host of $$('[data-verdict-host]')) {
    const focused = host.contains(document.activeElement) && document.activeElement.matches('[data-range]');
    const code = host.dataset.verdictHost;
    host.innerHTML = verdict(state.data, code, state.date, state.today, state.other, {
      title: host.dataset.title || 'h2', heading: host.dataset.heading || 'h3', link: host.dataset.link === '1',
    });
    if (focused) $('[data-range]', host)?.focus();
  }
  for (const host of $$('[data-events-host]')) {
    host.innerHTML = eventList(state.data, state.data.codes[host.dataset.eventsHost], state.date, state.today);
  }
}

function drawLists() {
  const { data, date } = state;
  const index = periodIndex(data, date);
  for (const row of $$('[data-row]')) {
    const span = spanAt(data.codes[row.dataset.row], index);
    const now = stateOf(span ? span[1] : '');
    const badge = $('.chip', row);
    if (badge) { badge.className = `chip chip--${now}`; badge.textContent = CHIP[now]; }
  }
  for (const cell of $$('[data-cell]')) {
    const span = spanAt(data.codes[cell.dataset.cell], index);
    cell.className = `cell cell--${stateOf(span ? span[1] : '')}`;
  }
  const counted = $$('[data-count]');
  if (counted.length) {
    const counts = countsAt(data, index);
    for (const node of counted) {
      const key = node.dataset.count;
      node.textContent = (key === 'total' ? counts.total : counts.groups[Number(key)]).toLocaleString('en-US');
    }
  }
  for (const node of $$('[data-dos-text]')) node.textContent = formatDate(date);
}

function drawControls() {
  for (const input of $$('[data-dos]')) if (input.value !== state.date) input.value = state.date;
  const day = String(dayNumber(state.date));
  for (const range of $$('[data-range]')) {
    if (range.value !== day) range.value = day;
    range.setAttribute('aria-valuetext', formatDate(state.date));
  }
  for (const button of $$('[data-today]')) button.hidden = state.date === state.today;
}

function drawResults() {
  const host = $('[data-results]');
  if (!host) return;
  const { data, date } = state;
  const query = state.query.trim();
  document.documentElement.classList.toggle('asked', Boolean(query));
  if (!query) { host.innerHTML = ''; return; }
  const code = normalizeCode(query);
  if (isCode(code)) {
    if (!data.codes[code] && !state.other) loadOther().then(drawResults);
    host.innerHTML = `<div data-verdict-host="${esc(code)}" data-link="1">${verdict(data, code, date, state.today, state.other, { link: true })}</div>`;
    return;
  }
  state.index ||= buildIndex(data);
  const found = search(state.index, query);
  if (!found.total) {
    host.innerHTML = `<p class="results__none">Nothing matches “${esc(query)}”. Procedure names here cover only codes that have been on the list. A full five-character code gets an answer either way.</p>`;
    return;
  }
  const more = found.total > found.codes.length ? ` Showing the first ${found.codes.length}; keep typing to narrow it.` : '';
  host.innerHTML = `<p class="results__count">${found.total.toLocaleString('en-US')} ${found.total === 1 ? 'code matches' : 'codes match'}, with status on ${formatDate(date)}.${more}</p>
<ul class="rows" data-rows>${found.codes.map((match) => codeRow(data, match, date)).join('')}</ul>`;
}

function exemptionWord(result) {
  if (result.kind !== 'listed' || result.state !== 'off' || !result.exemption) return '';
  if (result.exemption.status === 'active') return 'Exempt';
  return result.exemption.status === 'ended' ? 'Ended' : 'None';
}

function bulkRows() {
  return state.bulk.map((code) => {
    const result = lookup(state.data, code, state.date, state.other);
    const reply = answer(state.data, result, state.today);
    return {
      code,
      label: result.kind === 'listed' ? result.record.label : '',
      status: result.kind === 'unknown' ? 'No record of this code' : CHIP[reply.state],
      state: reply.state,
      removed: result.removed ? formatDate(result.removed, 'short') : '',
      exemption: exemptionWord(result),
      listed: result.kind === 'listed',
    };
  });
}

function drawBulk() {
  const host = $('[data-bulk-out]');
  if (!host || !state.bulk.length) return;
  if (!state.other) { host.innerHTML = '<p>Checking…</p>'; return; }
  const rows = bulkRows();
  const body = rows.map((row) => `<tr><th scope="row">${row.listed ? `<a href="/code/${esc(row.code)}/">${esc(row.code)}</a>` : esc(row.code)}</th><td>${esc(row.label)}</td><td>${row.status === CHIP[row.state] ? chip(row.state) : esc(row.status)}</td><td>${esc(row.removed)}</td><td>${esc(row.exemption)}</td></tr>`).join('');
  const on = rows.filter((row) => row.state === 'ipo').length;
  host.innerHTML = `<p class="results__count">${rows.length} ${rows.length === 1 ? 'code' : 'codes'} on ${formatDate(state.date)}: ${on} inpatient only, ${rows.length - on} not.</p>
<div class="scroll"><table class="check"><thead><tr><th scope="col">Code</th><th scope="col">Procedure</th><th scope="col">Status</th><th scope="col">Left the list</th><th scope="col">Review exemption</th></tr></thead><tbody>${body}</tbody></table></div>
<p><button type="button" class="quiet" data-bulk-csv>Download as CSV</button></p>`;
}

function downloadBulk() {
  const cell = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [['code', 'procedure', 'date_of_service', 'status', 'left_the_list', 'review_exemption']]
    .concat(bulkRows().map((row) => [row.code, row.label, state.date, row.status, row.removed, row.exemption]))
    .map((row) => row.map(cell).join(','));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }));
  link.download = `inpatient-only-${state.date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function draw() {
  drawControls();
  drawResults();
  drawVerdictHosts();
  drawLists();
  drawBulk();
}

function setDate(date) {
  const next = clampDate(state.data, date);
  if (next === state.date) return;
  state.date = next;
  remember(next);
  writeUrl();
  draw();
}

// ---- events -------------------------------------------------------------------------------

function dateAt(track, clientX) {
  const box = track.getBoundingClientRect();
  const share = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
  const from = dayNumber(AXIS.from);
  return fromDayNumber(Math.round(from + share * (dayNumber(AXIS.to) - from)));
}

function wire() {
  let frame = 0;
  let dragging = false;
  const later = (job) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(job); };

  document.addEventListener('pointerdown', (event) => {
    const track = event.target.closest?.('[data-track]');
    if (!track || event.button > 0) return;
    dragging = true;
    event.preventDefault();
    setDate(dateAt(track, event.clientX));
  });
  document.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const track = $('[data-track]');
    if (track) later(() => setDate(dateAt(track, event.clientX)));
  });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { dragging = false; });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches('[data-range]')) setDate(fromDayNumber(Number(target.value)));
    else if (target.matches('[data-q]')) { state.query = target.value; writeUrl(); later(drawResults); }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('[data-dos]') && isDate(target.value)) setDate(target.value);
  });
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.matches('[data-ask], [data-dos-form]')) {
      event.preventDefault();
      const input = $('[data-dos]', form);
      if (input && isDate(input.value)) setDate(input.value);
      $('[data-results] a, [data-results] [data-range]')?.focus();
    } else if (form.matches('[data-bulk]')) {
      event.preventDefault();
      state.bulk = extractCodes($('[data-bulk-input]', form).value).slice(0, 500);
      const host = $('[data-bulk-out]');
      if (!state.bulk.length) { host.innerHTML = '<p class="results__none">No five-character codes found in that text.</p>'; return; }
      drawBulk();
      loadOther().then(drawBulk);
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
      const result = lookup(state.data, code, state.date);
      hint.textContent = `${code} ${result.record.label}: ${CHIP[result.state].toLowerCase()}`;
    });
    cells.addEventListener('pointerleave', () => { hint.textContent = idle; });
  }
}

async function start() {
  const response = await fetch(document.body.dataset.ipo);
  if (!response.ok) return;
  const data = await response.json();
  state.data = data;
  state.today = clampDate(data, todayISO());
  state.date = startingDate(data);
  const box = $('[data-q]');
  if (box) {
    state.query = params().get('q') || box.value || '';
    box.value = state.query;
  }
  remember(state.date);
  wire();
  draw();
  document.documentElement.classList.add('live');
}

start().catch(() => { /* the static page stands on its own */ });
