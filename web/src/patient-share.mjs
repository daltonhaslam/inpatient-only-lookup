// The ASC patient-share line: what a Medicare patient pays for one removed procedure at a surgery
// center (20% of the CY 2027 ASC rate) and in the hospital outpatient department (Addendum B's national
// unadjusted copayment, capped at the inpatient deductible), from pipeline/derived/patient-shares.json.
// National only. Shown on the code pages of the compared codes (stake.mjs codeBlock, at build time)
// and in the lookup answer for CMS's 2027 ASC additions once they are off the list (client.mjs, from a
// small file loaded when an answer needs it). Pure; whole dollars at display only.
import { num } from './engine.mjs';

// stake-card.mjs money(), restated so the lookup's bundle does not pull in the card.
const money = (n) => `$${num(Math.round(n))}`;

/**
 * [asc share, hospital outpatient share, ASC costs more (1|0), hospital share capped (1|0)], unrounded,
 * from one patient-shares.json entry; null when either share is missing (packaged in the ASC: 64629).
 * The ASC-costs-more flag is the pipeline's (asc_more compares unrounded values), never recomputed.
 */
export function packShare(entry) {
  if (!entry || !Number.isFinite(entry.asc_share) || !Number.isFinite(entry.opps_share)) return null;
  return [entry.asc_share, entry.opps_share, entry.asc_more ? 1 : 0, entry.opps_capped ? 1 : 0];
}

/**
 * The line after "Patient’s share, national:", as HTML (only money() figures and fixed words, so
 * nothing needs escaping). It leads with the surgery center when the patient pays more there.
 * deductibles: patient-shares.json meta.deductibles (part_b). capital: start with a capital letter.
 */
export function shareHtml([asc, opps, ascMore, capped], deductibles, { capital = false } = {}) {
  const hospital = `${money(opps)} in the hospital outpatient department${capped ? ' (capped at the inpatient deductible)' : ''}`;
  const [more, about] = capital ? ['More', 'About'] : ['more', 'about'];
  const lead = ascMore ? `<strong>${more} at a surgery center</strong>, about ${money(asc)}, than the ${hospital}` : `${about} ${money(asc)} at a surgery center, ${hospital}`;
  return `${lead}, plus the ${money(deductibles.part_b)} Part B deductible in either. Most Medigap plans pay the coinsurance; Medicare Advantage plans set their own.`;
}

/**
 * The lookup's file: {d: {part_b}, c: {code: packShare()}} for the codes CMS adds to the ASC list for
 * 2027 (asc-new-2027.json) that have both shares.
 */
export function sharesFile(shares, ascNew) {
  const c = {};
  for (const code of Object.keys(ascNew.codes).sort()) {
    const packed = packShare(shares.codes[code]);
    if (packed) c[code] = packed;
  }
  return { d: { part_b: shares.meta.deductibles.part_b }, c };
}

/**
 * The lookup answer's share line for a code on a date, or '': only for a code in the file, only once it
 * is off the list (state 'off', on or after the date it was removed), starting with a capital (it
 * stands under its own label).
 */
export function lookupShare(file, code, state, date, removed) {
  const packed = file && file.c[code];
  if (!packed || state !== 'off' || !removed || date < removed) return '';
  return shareHtml(packed, file.d, { capital: true });
}
