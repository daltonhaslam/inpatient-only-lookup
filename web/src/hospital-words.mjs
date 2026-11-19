// Words and round figures for the hospital view: the summary's fraction word, the empty-cell labels of
// the per-year table and the fold's ceiling. Pure; the numbers come from hospital-math.mjs.
import { money } from './stake-card.mjs';

/**
 * A share as a percentage: 0.311 -> "31.1%". digits: decimals shown; trim: drop trailing zeros
 * (0.66 -> "66%", for prose); without it the digits are fixed (0.07 -> "7.0%", for the facts line).
 */
export const pct = (x, { digits = 1, trim = false } = {}) => {
  const fixed = (x * 100).toFixed(digits);
  return `${trim ? Number(fixed) : fixed}%`;
};

/**
 * The per-year caveat, in Methods, the per-year fold and the hospital CSV's total rows (plain text).
 * year: the counts' data year; drgs: the family's MS-DRGs ("163–165"), or none for "those MS-DRGs".
 */
export const ceiling = (year, drgs) => `A ceiling, not a forecast: it counts every ${year} case in ${drgs ? `MS-DRG ${drgs}` : 'those MS-DRGs'}, not only the removed procedure, and not only the cases that could have been outpatient.`;

/** The MA estimate's assumption, in Methods, the per-year fold, the hospital CSV and the workbook (pinned equal there). */
export const MA_MIX = 'That assumes the hospital’s MA cases have the same MS-DRG mix as its traditional Medicare cases.';

/** Why a per-year count cell is empty (perYearTable's trad.suppressed, and ma.reason: either key). */
export const EMPTY = {
  suppressed: 'under 11 or none',
  'no-ma-ratio': 'no MA count in CMS’s file',
};

// The two add-ons, each with CMS's operating and capital factor (hospitals.json keys) and the plain word
// the summary's lead puts first: teaching (IME), safety-net (DSH). "Safety-net" is this site's gloss; CMS's
// names are the indirect medical education and disproportionate share hospital adjustments (Methods).
const ADD_ONS = [
  { name: 'IME', operating: 'tchop', capital: 'tchcp', plain: 'teaching' },
  { name: 'DSH', operating: 'dshopp', capital: 'dshcpp', plain: 'safety-net' },
];

/** A list in prose: "IME", "IME and DSH", "wage index, IME and DSH". join: "and" or "or". */
export const series = (words, join = 'and') => (words.length > 1 ? `${words.slice(0, -1).join(', ')} ${join} ${words[words.length - 1]}` : words.join(''));

/**
 * The add-ons a hospital gets, from its own factors (a hospitals.json record), IME first:
 * [{name: 'IME' | 'DSH', plain, capitalOnly}]. An add-on counts when either of its factors is above 0;
 * capitalOnly when its operating factor is 0 (the "Capital IME only" and "Capital DSH only" hospitals).
 * [] for none. Every add-on word the hospital view says starts here.
 */
export const addOnsOf = (h) => ADD_ONS.filter((a) => h[a.operating] > 0 || h[a.capital] > 0)
  .map((a) => ({ name: a.name, plain: a.plain, capitalOnly: !(h[a.operating] > 0) }));

/** The names alone: ['IME', 'DSH'], ['DSH'], ['IME'] or []. */
export const addOnNames = (h) => addOnsOf(h).map((a) => a.name);

/**
 * What a traditional Medicare case's add-on is made of (the per-year fold's per-case label): "IME + DSH",
 * "DSH", "IME", "capital IME + DSH", "capital DSH"… (an add-on with an operating factor includes its capital part).
 */
export const addOnName = (h) => addOnsOf(h).map((a) => (a.capitalOnly ? `capital ${a.name}` : a.name)).join(' + ');

const spelled = (a) => `${a.plain} (${a.name})`;

/**
 * The add-ons in plain words first, the acronym after, for the summary's lead (where a reader meets them
 * after a pick): "teaching (IME) and safety-net (DSH) add-ons", "a safety-net (DSH) add-on", "a teaching
 * (IME) add-on". With none, both, negated: "no teaching (IME) or safety-net (DSH) add-ons".
 */
export function addOnsSpelled(h) {
  const got = addOnsOf(h);
  if (!got.length) return `no ${series(ADD_ONS.map(spelled), 'or')} add-ons`;
  return got.length > 1 ? `${series(got.map(spelled))} add-ons` : `a ${spelled(got[0])} add-on`;
}

const LADDER = [[1, 'all'], [7 / 8, 'nearly all'], [17 / 24, 'about three quarters'], [7 / 12, 'about two thirds'],
  [5 / 12, 'about half'], [7 / 24, 'about a third'], [1 / 5, 'about a quarter'], [-Infinity, 'a small part']];

/**
 * The fraction of the gap that is add-ons (summary().ratio), as a word for the lead sentence ("At
 * <hospital>, <word> of what a removed procedure loses ... is <addOnsSpelled()>"): the nearest
 * of a quarter, a third, half, two thirds and three quarters, with the cutoffs at the midpoints between
 * them (7/24, 5/12, 7/12, 17/24, 7/8); under a fifth is "a small part", from 7/8 "nearly all", and
 * from 1 "all". null for no ratio.
 */
export function fractionWord(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return LADDER.find(([from]) => ratio >= from)[1];
}

/**
 * A per-year ceiling in round figures: "$1.1 million", "$61,000", "$9,500", "$480". null for no total
 * (perYearTable's total when no count is published or typed), so the view says so instead of "$0".
 */
export function roughMoney(n) {
  if (!Number.isFinite(n)) return null;
  const step = n >= 10_000 ? 1000 : n >= 1000 ? 100 : 1;
  const r = Math.round(n / step) * step;
  return r >= 1_000_000 ? `$${Number((n / 1_000_000).toFixed(1))} million` : money(r);
}
