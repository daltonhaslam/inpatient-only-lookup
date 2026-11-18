// The hospital picker on /revenue-at-stake/, and the entry of the hospital bundle (assets/hospital.*.js).
// The national page ships only the empty text box (hospital-field.mjs); stake-client.mjs imports this
// bundle when someone first focuses the box or lands on ?h=, and it takes the box over: an ARIA 1.2
// combobox (a text box that owns a listbox, with aria-activedescendant), the hospital list, each
// hospital's file and its view (hospital-view.mjs).
// No inline handlers, no eval: every string put into the page goes through esc(), and a fetch URL is
// built only from a CCN that is six digits and in the shipped list.
import { esc } from './views.mjs';
import { field } from './hospital-field.mjs';
import { hospitalIndex, findHospitals, optionName, pickerMessage, TEACHING, TEACHING_LABEL } from './hospital-pick.mjs';
import { createView, hospitalLede } from './hospital-view.mjs';
import { CCN } from './stake-engine.mjs';
import { fetchJson } from './fetch.mjs';
import { announcer } from './announce.mjs';

// The option's meta line: state, CCN and, for a teaching hospital, its kind (nothing for the others).
const teachingTag = (code) => (code ? TEACHING_LABEL[TEACHING[code]] : '');

const optionHtml = (h, i) => `<li role="option" id="hp-o-${esc(h.ccn)}" aria-selected="false" data-i="${i}">`
  + `<span class="hpick__oname">${esc(optionName(h))}</span><span class="hpick__ometa">${esc([h.state, h.ccn, teachingTag(h.teaching)].filter(Boolean).join(' · '))}</span></li>`;

/** Resolves when the hospital view's stylesheet has loaded (added once, on first use) or failed to. */
function styles(url) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  const ready = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
  document.head.append(link);
  return ready;
}

const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
/** A brief tint on a figure that just changed with a typed count; none when less motion is asked for. */
function flash(el) {
  if (calm.matches) return;
  const tint = getComputedStyle(el).getPropertyValue('--panel').trim();   // the theme's panel color, light or dark
  el.animate([{ backgroundColor: tint }, { backgroundColor: 'transparent' }], { duration: 900, easing: 'ease-out' });
}

/**
 * The cards' folds after a pick. A count typed into a per-year table updates that card in place: each
 * row's figure, the MA estimates that follow a traditional count, the total and the fold's heading. The
 * box being typed in is never redrawn, so focus and the caret stay. Its text reaches the view as a
 * string (count() reads it; HTML gets it only through esc()). Open folds are remembered for a redraw.
 * The new heading is said once, after typing settles, through the picker's one status line.
 */
function folds(results, current, say) {
  results.addEventListener('input', (event) => {
    const input = event.target.closest('[data-count]');
    const view = current();
    const card = input && input.closest('[data-stake-card]');
    if (!view || !card) return;
    const up = view.count(card.dataset.stakeCard, input.dataset.count, input.value);
    if (!up) return;
    const set = (el, text) => {
      if (el && el.textContent !== text) { el.textContent = text; flash(el); }
    };
    for (const [key, cell] of Object.entries(up.cells)) {
      const row = card.querySelector(`[data-cell="${key}"]`);
      if (!row) continue;
      const box = row.querySelector('[data-count]');
      if (box !== input && box.value !== cell.value) { box.value = cell.value; flash(box); }
      if (cell.invalid) box.setAttribute('aria-invalid', 'true'); else box.removeAttribute('aria-invalid');
      row.querySelector('.hyr__why').textContent = cell.note;
      set(row.querySelector('.hyr__year'), cell.text);
    }
    set(card.querySelector('[data-year-total]'), up.total);
    set(card.querySelector('[data-year-head]'), up.headline);
    say(`${card.dataset.stakeCard}, per year at ${view.name}: ${up.headline}.`);
  });
  // toggle does not bubble: listen in the capture phase. A redraw of an open fold fires one too; the
  // view ignores a toggle that changes nothing, so its drawn card is kept.
  results.addEventListener('toggle', (event) => {
    const fold = event.target;
    const view = current();
    if (!view || !(fold instanceof HTMLDetailsElement) || !fold.matches('.hfold')) return;
    const card = fold.closest('[data-stake-card]');
    if (card) view.toggle(card.dataset.stakeCard, fold.dataset.fold, fold.open);
  }, true);
}

/**
 * Take over the picker in mount (already holding hospital-field.mjs SHELL and field()).
 * assets: {list, dir, css} URLs from the build. data, meta: the page's prepare()d items and browser meta.
 * onPick(view, {initial, ui}): show this hospital (the page swaps the cards and calls ui.show()).
 * onClear(ui): back to national. onInvalid({keepUrl}): an ?h= that named no offered hospital, or (keepUrl)
 * one whose files could not be fetched. results: the cards' container, where the picked hospital's
 * per-year counts are typed and its folds opened (folds() below). Returns ui: {show, say, start(ccn)}.
 */
export function attachPicker(mount, assets, { data, meta, onPick, onClear, onInvalid, results }) {
  const body = mount.querySelector('[data-hpick-body]');
  const status = mount.querySelector('[data-hpick-status]');
  const css = styles(assets.css);
  let index = null;
  let maryland = '';   // why Maryland hospitals are not offered (hospitals.json meta.maryland)
  let listPromise = null;
  let matches = [];
  let active = -1;
  let token = 0;
  let picked = null;   // the view on screen, if any

  const $ = (selector) => body.querySelector(selector);
  const say = announcer(status);
  const note = (text) => { const el = $('#hp-note'); if (el) el.textContent = text; };
  const loadList = () => {
    listPromise ||= Promise.all([fetchJson(assets.list), css])
      .then(([list]) => { index = hospitalIndex(list); maryland = list.meta.maryland; return list; })
      .catch((error) => { listPromise = null; throw error; });
    return listPromise;
  };

  function close() {
    const input = $('#hp-q');
    if (!input) return;
    $('.hpick__pop').hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function highlight(i) {
    const options = body.querySelectorAll('[role="option"]');
    if (!options.length) return;
    active = (i + options.length) % options.length;
    options.forEach((el, n) => el.setAttribute('aria-selected', String(n === active)));
    $('#hp-q').setAttribute('aria-activedescendant', options[active].id);
    options[active].scrollIntoView({ block: 'nearest' });
  }

  function refresh() {
    const input = $('#hp-q');
    if (!input || !index) return;
    const result = findHospitals(index, input.value);
    matches = result.matches;
    $('#hp-list').innerHTML = matches.map(optionHtml).join('');
    $('.hpick__pop').hidden = !matches.length;
    input.setAttribute('aria-expanded', String(matches.length > 0));
    input.removeAttribute('aria-activedescendant');
    active = -1;
    const message = pickerMessage(result, input.value, maryland);
    note(message.note);
    if (message.spoken) say(message.spoken);
  }

  /**
   * Fetch a hospital's file and show its view. The CCN must be six digits and in the shipped list
   * before any URL is built from it. A later pick (or Back to national) wins over a slower earlier one.
   */
  async function load(ccn, initial) {
    const mine = ++token;
    let list;
    let record;
    try {
      list = await loadList();
      if (!CCN.test(ccn) || !index.byCcn.has(ccn)) { if (initial) onInvalid({}); return; }
      if (!initial) note(`Loading ${optionName(index.byCcn.get(ccn))}…`);
      record = await fetchJson(`${assets.dir}/${ccn}.json`);
    } catch {
      // The network: worth another try.
      if (mine !== token) return;
      if (initial) onInvalid({ keepUrl: true });
      else note('Could not load that hospital’s rates. Check the connection and pick it again.');
      return;
    }
    if (mine !== token) return;
    try {
      await onPick(createView({ list, record, ccn, data, meta }), { initial, ui });
    } catch (error) {
      // The files arrived but the view could not be built or shown: a fault in the data or the code, not
      // the connection. National stays (the URL keeps h), and the page says so plainly.
      console.error(`Revenue at stake: the hospital view for ${ccn} could not be shown.`, error);
      if (mine !== token) return;
      if (initial) onInvalid({ keepUrl: true });
      note(`Could not show ${optionName(index.byCcn.get(ccn))}’s rates: something in its data could not be computed. This is not a connection problem; trying again will not help.`);
    }
  }

  function choose(i) {
    const h = matches[i];
    if (!h) return;
    close();
    $('#hp-q').value = optionName(h);
    load(h.ccn, false);
  }

  // The page's lede says "national and unadjusted"; after a pick it names the hospital's rates instead.
  const lede = document.querySelector('.stake-head .lede');
  const nationalLede = lede ? lede.innerHTML : '';

  /** Draw the picked hospital's bar and summary, or the empty picker for national. */
  function show(view, { focus = false } = {}) {
    picked = view;
    body.innerHTML = view ? view.barHtml + view.summaryHtml : field(null);
    if (lede) lede.innerHTML = view ? hospitalLede(nationalLede, view.name, view.ctx.addOns) : nationalLede;
    if (focus) $(view ? '[data-hpick-change]' : '#hp-q').focus();
  }

  const typed = () => {
    if (index) { refresh(); return; }
    note('Loading the hospital list…');
    loadList().then(refresh).catch(() => note('Could not load the hospital list. Check the connection and try again.'));
  };
  body.addEventListener('input', (event) => { if (event.target.id === 'hp-q') typed(); });
  body.addEventListener('keydown', (event) => {
    if (event.target.id !== 'hp-q') return;
    const open = !$('.hpick__pop').hidden;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { refresh(); if (!matches.length) return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight(active === -1 ? (step === 1 ? 0 : -1) : active + step);
    } else if (event.key === 'Enter') {
      event.preventDefault();   // there is no form to submit
      if (open && active >= 0) choose(active);
      else if (open && matches.length === 1) choose(0);
    } else if (event.key === 'Escape') {
      if (open) { event.preventDefault(); close(); } else if (event.target.value) { event.target.value = ''; refresh(); } else if (picked) { event.preventDefault(); show(picked, { focus: true }); }
    } else if (event.key === 'Tab') {
      close();
    }
  });
  // Keep focus in the text box when an option is pressed, so the click lands and the box stays labeled.
  body.addEventListener('pointerdown', (event) => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
  body.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(Number(option.dataset.i));
    else if (event.target.closest('[data-hpick-change]')) { body.innerHTML = field(picked.name); $('#hp-q').focus(); }
    else if (event.target.closest('[data-hpick-cancel]')) show(picked, { focus: true });
    else if (event.target.closest('[data-hpick-clear]')) { token += 1; onClear(ui); }
  });
  body.addEventListener('focusout', (event) => {
    if (event.target.id === 'hp-q' && !body.contains(event.relatedTarget)) close();
  });

  const ui = { show, say, start: (ccn) => load(ccn, true) };
  if (results) folds(results, () => picked, say);
  loadList().catch(() => {});
  if ($('#hp-q') && $('#hp-q').value) typed();   // they typed while this bundle loaded
  return ui;
}
