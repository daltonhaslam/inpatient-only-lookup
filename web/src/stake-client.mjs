// Browser side of /revenue-at-stake/: search, filters, sort and cards over the table the page ships.
// The server-rendered tables are the baseline; this only adds to them. No inline handlers, no eval:
// every string put into the page goes through esc() or is a validated code.
import { num } from './engine.mjs';
import { esc } from './views.mjs';
import { card, STATUS } from './stake-card.mjs';
import { prepare, filterCodes, outsideCrosswalk, stateFromParams, hospitalParam, queryString, countText, PAGE_SIZE, TIERS, DEFAULTS } from './stake-engine.mjs';
import { SHELL, field } from './hospital-field.mjs';

// The hospital view's file URLs, put into this bundle by build.mjs (null: no picker in this build).
const HOSPITAL = typeof __HOSPITAL_ASSETS__ === 'undefined' ? null : __HOSPITAL_ASSETS__;

const $ = (selector, root = document) => root.querySelector(selector);

/** Run a DOM change as a view transition where the browser has them and motion is welcome; else at once. */
function transition(change) {
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return Promise.resolve();
  }
  return document.startViewTransition(change).updateCallbackDone;
}

const option = (value, text, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`;
const select = (id, label, options, current, hint) => `<label class="sfilter__field" for="${id}"><span>${label}</span><select id="${id}" data-f="${id.replace('sf-', '')}"${hint ? ` aria-describedby="${hint}"` : ''}>${options.map(([v, t]) => option(v, t, current)).join('')}</select></label>`;

function form(data, state) {
  return `<form class="sfilter" role="search" aria-label="Find a code" novalidate>
<label class="field sfilter__q" for="sf-q"><span>Search by code or procedure</span>
<input id="sf-q" data-f="q" type="search" value="${esc(state.q)}" placeholder="32480, or lobectomy" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></label>
<div class="sfilter__row">
${select('sf-group', 'Body system', [['', 'All'], ...data.groups], state.group)}
${select('sf-status', 'Review status', [['', 'Any'], ...Object.entries(STATUS)], state.status, 'sf-hint')}
${select('sf-tier', 'Tier', [['', 'Any'], ...TIERS.map((t) => [t, `Tier ${t}`])], state.tier, 'sf-hint')}
${select('sf-year', 'Year removed', [['', 'Any'], ...data.years.map((y) => [y, y])], state.year)}
${select('sf-sort', 'Sort by', [['gap', 'Biggest gap'], ['code', 'Code']], state.sort)}
</div>
<p class="sfilter__hint" id="sf-hint">Status and tier apply only to codes with a comparison.</p>
<div class="sfilter__foot">
<label class="sfilter__check"><input type="checkbox" id="sf-compared" data-f="compared"${state.compared ? ' checked' : ''}> Has a comparison</label>
<button type="button" class="btn btn--quiet" data-reset>Clear filters</button>
</div>
</form>
<p class="sfilter__count" id="sf-count" role="status" aria-live="polite"></p>
<div class="sresults" data-results></div>
<p class="sresults__more"><button type="button" class="btn" data-more hidden></button></p>`;
}

function missing(miss) {
  const where = miss.page
    ? `<a href="/code/${esc(miss.code)}/">Open the code page for ${esc(miss.code)}</a>`
    : `<a href="/?q=${esc(miss.code)}">Look ${esc(miss.code)} up in the inpatient-only lookup</a>`;
  return `<div class="scard scard--none" data-outside="${esc(miss.code)}"><p class="scard__title"><span class="scard__code">${esc(miss.code)}</span></p>
<p class="scard__none">Not in this crosswalk. It covers only the procedures removed from the inpatient-only list in 2026 and 2027.</p>
<p class="scard__more">${where}</p></div>`;
}

/** Filters that match nothing, when the search is not a code outside the crosswalk. */
const empty = () => `<div class="scard scard--none" data-empty><p class="scard__none">No codes match these filters.</p>
<p class="scard__more"><button type="button" class="btn btn--quiet" data-reset>Clear filters</button></p></div>`;

/** The cards replace the long table; keep it one click away. Without JS it is never touched. */
function collapseTable(total) {
  const section = $('[data-stake-table]');
  if (!section || section.querySelector('.stake-tablewrap')) return;
  const wrap = document.createElement('details');
  wrap.className = 'stake-tablewrap';
  wrap.innerHTML = `<summary>All ${num(total)} codes as a table</summary>`;
  wrap.append(...section.childNodes);
  section.append(wrap);
  document.documentElement.classList.add('stake-live');
}

export function start(model) {
  const host = $('[data-stake-app]');
  if (!host) return;
  const data = prepare(model);
  const state = stateFromParams(window.location.search, data);
  // The picked hospital: its view (hospital-view.mjs createView), or null for national. pending: a
  // six-digit ?h= still being checked against the list, kept in the URL until then.
  let view = null;
  let pending = hospitalParam(window.location.search);
  let matches = [];
  let shown = 0;

  collapseTable(data.items.length);
  host.innerHTML = form(data, state);
  const results = $('[data-results]', host);
  const more = $('[data-more]', host);
  const count = $('#sf-count', host);
  const box = $('#sf-q', host);
  let announce = 0;

  const writeUrl = () => {
    const text = queryString(state, view ? view.ccn : pending);
    try { window.history.replaceState(null, '', `${window.location.pathname}${text ? `?${text}` : ''}${window.location.hash}`); } catch { /* the page still works without a remembered state */ }
  };

  // Cards are drawn in slices of PAGE_SIZE; the results node is rebuilt only when the filters change.
  const draw = (from) => {
    const slice = matches.slice(from, from + PAGE_SIZE);
    const html = slice.map((item) => (view ? view.card(item) : card(item, model.meta, { detail: false }))).join('');
    if (from === 0) {
      const miss = matches.length ? null : outsideCrosswalk(data, state.q);
      results.innerHTML = matches.length ? html : (miss ? missing(miss) : empty());
    } else {
      results.insertAdjacentHTML('beforeend', html);
    }
    shown = from + slice.length;
    const left = matches.length - shown;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(PAGE_SIZE, left)} more (${num(left)} left)`;
  };

  const update = () => {
    matches = filterCodes(view ? view.data : data, state);
    draw(0);
    writeUrl();
    const miss = !matches.length && outsideCrosswalk(data, state.q);
    const text = miss ? `${miss.code} is not in this crosswalk.` : countText(matches.length, shown);
    clearTimeout(announce);
    announce = setTimeout(() => { count.textContent = text; }, 250);   // one announcement after typing settles
  };

  host.addEventListener('input', (event) => {
    const field = event.target.closest('[data-f]');
    if (!field) return;
    state[field.dataset.f] = field.type === 'checkbox' ? field.checked : field.value;
    update();
  });
  // Enter in the search box must not submit (there is no server); the results already follow the text.
  host.addEventListener('submit', (event) => event.preventDefault());
  host.addEventListener('click', (event) => {
    if (event.target.closest('[data-more]')) {
      const from = shown;
      draw(from);
      const first = results.querySelectorAll('[data-stake-card]')[from];
      if (first) { first.tabIndex = -1; first.focus(); }   // keyboard users continue from the first new card
      clearTimeout(announce);
      count.textContent = countText(matches.length, shown);
    } else if (event.target.closest('[data-reset]')) {
      Object.assign(state, DEFAULTS);
      host.querySelectorAll('[data-f]').forEach((field) => {
        if (field.type === 'checkbox') field.checked = false; else field.value = DEFAULTS[field.dataset.f];
      });
      update();
      box.focus();
    }
  });

  update();
  count.textContent = countText(matches.length, shown);

  const mount = HOSPITAL && $('[data-hospital-pick]');
  if (!mount) return;
  // The empty picker draws now; the code that makes it work, the hospital list and each hospital's file
  // load on first use (focus, a tap, or an ?h= in the address), so the national page carries none of it.
  mount.innerHTML = SHELL;
  $('[data-hpick-body]', mount).innerHTML = field(null);
  let picker = null;   // the import of the picker bundle, once started
  let ui = null;       // the picker, once it has taken over the box
  const attach = () => {
    picker ||= import(HOSPITAL.view).then((mod) => mod.attachPicker(mount, HOSPITAL, {
      data, meta: model.meta, results,
      // One hospital's view, computed once: swap the strip and the cards together, then say so once.
      onPick: (next, { initial }) => transition(() => { view = next; pending = ''; ui.show(next); update(); })
        .then(() => {
          if (!initial) $('[data-hpick-change]', mount)?.focus();
          ui.say(next.announce);
        }),
      onClear: () => transition(() => { view = null; ui.show(null); update(); })
        .then(() => { $('#hp-q', mount)?.focus(); ui.say('Showing national rates.'); }),
      // An ?h= that names no hospital the picker offers (Maryland, unknown): national, clean URL.
      onInvalid: ({ keepUrl = false }) => { if (!keepUrl) { pending = ''; writeUrl(); } },
    })).then((ready) => { ui = ready; return ready; })
      .catch((error) => { picker = null; throw error; });
    return picker;
  };
  for (const type of ['focusin', 'pointerdown']) mount.addEventListener(type, () => { attach().catch(() => {}); });
  if (pending) attach().then((ready) => ready.start(pending)).catch(() => { /* national stays; the URL keeps h for a reload */ });
}

async function load() {
  const source = document.body.dataset.stake;
  if (!source) return;
  const response = await fetch(source);
  if (!response.ok) return;
  start(await response.json());
}

load().catch(() => { /* the tables below stand on their own */ });
