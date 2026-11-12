// Pure search, filter, sort and URL-state logic for the Revenue at stake page. No DOM, so it is
// unit tested. Works on the browser model from stake-data.mjs clientModel().
import { search, isCode, normalizeCode, wordsOf, num } from './engine.mjs';
import { hydrate } from './stake-data.mjs';
import { STATUS } from './stake-card.mjs';

export const PAGE_SIZE = 50;
export const STATUSES = Object.keys(STATUS);
export const TIERS = ['1', '2', '3'];
export const SORTS = ['code', 'gap'];

const words = (text) => wordsOf(String(text || ''));

/** Items in code order plus the search index: label words rank above group, family and DRG-family words. */
export function prepare(doc) {
  const model = hydrate(doc);
  const groupName = Object.fromEntries(model.meta.groups);
  const items = Object.values(model.codes).sort((a, b) => (a.code < b.code ? -1 : 1));
  const index = items.map((item) => ({
    code: item.code,
    label: words(item.label),
    extra: words(`${groupName[item.group] || ''} ${item.ip ? item.ip.families.map((f) => `${f.name} ${f.condition}`).join(' ') : ''}`),
  }));
  return { items, byCode: model.codes, index, siteCodes: new Set(model.siteCodes || []), groups: model.meta.groups, groupName, years: [...new Set(items.map((item) => String(item.year)))].sort() };
}

/** The size of the gap: the larger absolute end of the difference. Codes with no comparison have none. */
export const gapSize = (item) => (item.diff ? Math.max(Math.abs(item.diff.low), Math.abs(item.diff.high)) : -1);

export function sortCodes(items, sort) {
  const byCode = (a, b) => (a.code < b.code ? -1 : 1);
  return [...items].sort(sort === 'gap' ? (a, b) => gapSize(b) - gapSize(a) || byCode(a, b) : byCode);
}

/**
 * The matching items, sorted. filters: {q, group, status, tier, year, compared}. A filter that
 * is empty/false is off. Status and tier apply to compared codes only. "compared" keeps codes with a
 * comparison.
 */
export function filterCodes(data, filters = {}) {
  const { q = '', group = '', status = '', tier = '', year = '', compared = false, sort = 'code' } = filters;
  let items = data.items;
  if (q.trim()) {
    const hits = new Set(search(data.index, q, data.items.length).codes);
    items = items.filter((item) => hits.has(item.code));
  }
  items = items.filter((item) => (!group || item.group === group)
    && (!status || (item.kind === 'compare' && item.review.status === status))
    && (!tier || (item.tier && String(item.tier.n) === tier))
    && (!year || String(item.year) === year)
    && (!compared || item.kind === 'compare'));
  return sortCodes(items, sort);
}

/**
 * What to say when a code-shaped query is not in the crosswalk: the code, and whether it has its own
 * page on this site (a code still on the list). null when the query is not a whole code or is in the crosswalk.
 */
export function outsideCrosswalk(data, q) {
  const code = normalizeCode(q);
  if (!isCode(code) || data.byCode[code]) return null;
  return { code, page: data.siteCodes.has(code) };
}

export const DEFAULTS = { q: '', group: '', status: '', tier: '', year: '', compared: false, sort: 'code' };

/** Filter state from a query string. Anything not a known value is dropped, so a URL cannot inject one. */
export function stateFromParams(search, data) {
  const p = new URLSearchParams(search);
  const pick = (name, allowed) => (allowed.includes(p.get(name)) ? p.get(name) : '');
  return {
    q: (p.get('q') || '').slice(0, 80),
    group: pick('group', data.groups.map(([id]) => id)),
    status: pick('status', STATUSES),
    tier: pick('tier', TIERS),
    year: pick('year', data.years),
    compared: p.get('compared') === '1',
    sort: pick('sort', SORTS) || 'code',
  };
}

/** The query string for a state; defaults are left out so the plain page keeps a plain URL. */
export function paramsFromState(state) {
  const p = new URLSearchParams();
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (state[key] !== fallback && state[key] !== undefined) p.set(key, state[key] === true ? '1' : state[key]);
  }
  return p.toString();
}

/** "12 codes" / "1 code" / "No codes", and how many are showing. */
export function countText(total, shown) {
  if (!total) return 'No codes match.';
  const noun = total === 1 ? '1 code' : `${num(total)} codes`;
  return shown < total ? `Showing ${num(shown)} of ${noun}.` : `${noun}.`;
}
