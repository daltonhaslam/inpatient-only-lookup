// The hospital picker's search: pure, over the hospital list the build ships (data/hospitals.*.json):
// {states: {code: name}, h: [[ccn, name or null, state, teaching 0|1|2]], md: [[ccn, name]]}.
// Teaching: 0 none, 1 capital IME only, 2 teaching (operating IME). Maryland hospitals are listed only
// so a search for one can say why it is not offered.

import { num, plural } from './engine.mjs';

/**
 * The teaching code the list ships for each hospital (index into TEACHING; hospital-math.mjs teaching()
 * gives the word) and how the picker and the facts line say it. One source for all three.
 */
export const TEACHING = ['none', 'capital-only', 'teaching'];
export const TEACHING_LABEL = { none: 'Not a teaching hospital', 'capital-only': 'Capital IME only', teaching: 'Teaching' };

/** How many options the list shows at once. */
export const LIMIT = 8;

const words = (text) => String(text || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function entry([ccn, name, state, teaching], states) {
  const nameWords = words(name);
  return { ccn, name, state, teaching, words: nameWords, joined: nameWords.join(' '), stateWords: [state.toLowerCase(), ...words(states[state])] };
}

/** The list, ready to search: {all, byCcn, maryland: Map(ccn -> entry)}. */
export function hospitalIndex(list) {
  const states = list.states || {};
  const all = list.h.map((row) => entry(row, states));
  const maryland = list.md.map(([ccn, name]) => entry([ccn, name, 'MD', 0], states));
  return { all, byCcn: new Map(all.map((h) => [h.ccn, h])), maryland: new Map(maryland.map((h) => [h.ccn, h])) };
}

/** 0: a whole word of the name, the CCN, or the state; null when the token matches none of them. */
function tokenRank(h, token) {
  if (/^\d+$/.test(token) && h.ccn.startsWith(token)) return 0;
  if (h.words.some((w) => w.startsWith(token))) return 0;
  if (token === h.stateWords[0] || h.stateWords.slice(1).some((w) => w.startsWith(token))) return 1;
  return null;
}

/** 0: the name starts with the query; 1: every word is in the name or CCN; 2: some only match the state. null: no match. */
function rank(h, tokens) {
  let worst = 0;
  for (const token of tokens) {
    const r = tokenRank(h, token);
    if (r === null) return null;
    worst = Math.max(worst, r);
  }
  if (worst === 0 && h.joined.startsWith(tokens.join(' '))) return 0;
  return worst + 1;
}

const byName = (a, b) => (a.name || `~${a.ccn}`).localeCompare(b.name || `~${b.ccn}`) || a.ccn.localeCompare(b.ccn);

/**
 * Hospitals for a query: by CCN (whole or its first digits), by the starts of words in the name, by
 * state code or state name, in any mix; every word of the query must match. {matches (at most LIMIT),
 * total, maryland: true when a Maryland hospital would have matched}.
 */
export function findHospitals(index, query) {
  const tokens = words(query);
  if (!tokens.length) return { matches: [], total: 0, maryland: false };
  const hits = [];
  for (const h of index.all) {
    const r = rank(h, tokens);
    if (r !== null) hits.push([r, h]);
  }
  hits.sort((a, b) => a[0] - b[0] || byName(a[1], b[1]));
  let maryland = false;
  for (const h of index.maryland.values()) if (rank(h, tokens) !== null) { maryland = true; break; }
  return { matches: hits.slice(0, LIMIT).map(([, h]) => h), total: hits.length, maryland };
}

/** The name in sentences: CMS's name, or its CCN when the file has none. */
export const shortName = (h) => h.name || `CCN ${h.ccn}`;
/** The name in the list of options. */
export const optionName = (h) => h.name || `CCN ${h.ccn} (no name in CMS’s file)`;

/**
 * What the picker says under the box (note) and to a screen reader (spoken) for a search result.
 * maryland: hospitals.json meta.maryland, said whenever a Maryland hospital would have matched.
 */
export function pickerMessage(result, query, maryland) {
  if (!query.trim()) return { note: '', spoken: '' };
  const md = result.maryland ? `${maryland} So they are not in this list.` : '';
  const { matches, total } = result;
  if (!matches.length) {
    const none = md || 'No IPPS hospital matches. Try part of its name, its state, or its six-digit CCN.';
    return { note: none, spoken: none };
  }
  const more = total > matches.length ? `${num(total)} hospitals match; keep typing to narrow the list.` : '';
  const count = total > matches.length ? `${matches.length} of ${num(total)} hospitals` : plural(total, 'hospital');
  return { note: [md, more].filter(Boolean).join(' '), spoken: [`${count}. Use the arrow keys to choose.`, md].filter(Boolean).join(' ') };
}
