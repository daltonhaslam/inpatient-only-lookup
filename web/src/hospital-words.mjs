// Words and round figures for the hospital view: the summary's fraction word, the empty-cell labels of
// the per-year table and the fold's ceiling. Pure; the numbers come from hospital-math.mjs.
import { num } from './engine.mjs';

/** Why a per-year count cell is empty (perYearTable's trad.suppressed and ma.reason). */
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

/** A per-year ceiling in round figures: "$1.1 million", "$61,000", "$9,500", "$480". */
export function roughMoney(n) {
  const step = n >= 10_000 ? 1000 : n >= 1000 ? 100 : 1;
  const r = Math.round(n / step) * step;
  return r >= 1_000_000 ? `$${Number((n / 1_000_000).toFixed(1))} million` : `$${num(r)}`;
}
