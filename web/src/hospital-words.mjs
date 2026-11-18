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

/** The per-year caveat, in Methods and in the hospital CSV's total rows. year: the counts' data year. */
export const ceiling = (year) => `A ceiling, not a forecast: it counts every ${year} case in those MS-DRGs, not only the removed procedure, and not only the cases that could have been outpatient.`;

/** Why a per-year count cell is empty (perYearTable's trad.suppressed, and ma.reason: either key). */
export const EMPTY = {
  suppressed: 'under 11 or none',
  'no-ma-ratio': 'no MA count in CMS’s file',
};

const LADDER = [[1, 'all'], [7 / 8, 'nearly all'], [17 / 24, 'about three quarters'], [7 / 12, 'about two thirds'],
  [5 / 12, 'about half'], [7 / 24, 'about a third'], [1 / 5, 'about a quarter'], [-Infinity, 'a small part']];

/**
 * The fraction of the gap that is add-ons (summary().ratio), as a word for the lead sentence ("At
 * <hospital>, <word> of what a removed procedure loses ... is teaching and DSH add-ons"): the nearest
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
