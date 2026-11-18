// The hospital picker on /revenue-at-stake/, and the entry of the hospital bundle (assets/hospital.*.js).
// The national page ships only the empty text box (hospital-field.mjs); stake-client.mjs imports this
// bundle when someone first focuses the box or lands on ?h=, and it takes the box over: an ARIA 1.2
// combobox (a text box that owns a listbox, with aria-activedescendant), the hospital list, each
// hospital's file and its view (hospital-view.mjs).
// No inline handlers, no eval: every string put into the page goes through esc(), and a fetch URL is
// built only from a CCN that is six digits and in the shipped list.
import { esc } from './views.mjs';
import { field } from './hospital-field.mjs';
import { hospitalIndex, findHospitals, optionName, pickerMessage } from './hospital-pick.mjs';
import { createView } from './hospital-view.mjs';
import { CCN } from './stake-engine.mjs';

const TEACHING = ['', 'Capital IME only', 'Teaching'];

const optionHtml = (h, i) => `<li role="option" id="hp-o-${esc(h.ccn)}" aria-selected="false" data-i="${i}">`
  + `<span class="hpick__oname">${esc(optionName(h))}</span><span class="hpick__ometa">${esc([h.state, h.ccn, TEACHING[h.teaching]].filter(Boolean).join(' · '))}</span></li>`;

const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${url}`))));

/** Resolves when the hospital view's stylesheet has loaded (added once, on first use) or failed to. */
function styles(url) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  const ready = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
  document.head.append(link);
  return ready;
}

/**
 * Take over the picker in mount (already holding hospital-field.mjs SHELL and field()).
 * assets: {list, dir, css} URLs from the build. data, meta: the page's prepare()d items and browser meta.
 * onPick(view, {initial}): show this hospital (the page swaps the cards and calls show()).
 * onClear(): back to national. onInvalid({keepUrl}): an ?h= that named no offered hospital, or (keepUrl)
 * one whose files could not be fetched. Returns {show, say, start(ccn)}.
 */
export function attachPicker(mount, assets, { data, meta, onPick, onClear, onInvalid }) {
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
  let said = 0;

  const $ = (selector) => body.querySelector(selector);
  const say = (text, wait = 150) => { clearTimeout(said); said = setTimeout(() => { status.textContent = text; }, wait); };
  const note = (text) => { const el = $('#hp-note'); if (el) el.textContent = text; };
  const loadList = () => {
    listPromise ||= Promise.all([json(assets.list), css])
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
    if (message.spoken) say(message.spoken, 400);
  }

  /**
   * Fetch a hospital's file and show its view. The CCN must be six digits and in the shipped list
   * before any URL is built from it. A later pick (or Back to national) wins over a slower earlier one.
   */
  async function load(ccn, initial) {
    const mine = ++token;
    try {
      const list = await loadList();
      if (!CCN.test(ccn) || !index.byCcn.has(ccn)) { if (initial) onInvalid({}); return; }
      if (!initial) note(`Loading ${optionName(index.byCcn.get(ccn))}…`);
      const record = await json(`${assets.dir}/${ccn}.json`);
      if (mine !== token) return;
      await onPick(createView({ list, record, ccn, data, meta }), { initial });
    } catch {
      if (mine !== token) return;
      if (initial) onInvalid({ keepUrl: true });
      else note('Could not load that hospital’s rates. Check the connection and pick it again.');
    }
  }

  function choose(i) {
    const h = matches[i];
    if (!h) return;
    close();
    $('#hp-q').value = optionName(h);
    load(h.ccn, false);
  }

  /** Draw the picked hospital's bar and summary, or the empty picker for national. */
  function show(view, { focus = false } = {}) {
    picked = view;
    body.innerHTML = view ? view.barHtml + view.summaryHtml : field(null);
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
    else if (event.target.closest('[data-hpick-clear]')) { token += 1; onClear(); }
  });
  body.addEventListener('focusout', (event) => {
    if (event.target.id === 'hp-q' && !body.contains(event.relatedTarget)) close();
  });

  loadList().catch(() => {});
  if ($('#hp-q') && $('#hp-q').value) typed();   // they typed while this bundle loaded
  return { show, say, start: (ccn) => load(ccn, true) };
}
