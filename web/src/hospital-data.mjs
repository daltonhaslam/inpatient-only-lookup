// Build-time: the hospital files Revenue at stake loads on first use, from the committed
// pipeline/derived/hospitals.json and drg-volume.json. Nothing here reaches the national page.
//   hospitalList: one small list for the picker (search, labels, the Maryland reason) plus the
//     constants the math needs (hospitals.json meta: rates, drg_weights, opps_labor_share).
//   hospitalRecord: one hospital's factors and its 2024 counts, for data/h.<hash>/<ccn>.json.
import { teaching } from './hospital-math.mjs';
import { TEACHING } from './hospital-pick.mjs';

// USPS names for the state codes hospitals.json writes (from each CCN's first two digits), so a
// search can say "oregon" as well as "OR".
const STATES = {
  AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AS: 'American Samoa', AZ: 'Arizona', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', GU: 'Guam', HI: 'Hawaii',
  IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MP: 'Northern Mariana Islands',
  MS: 'Mississippi', MT: 'Montana', NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VA: 'Virginia', VI: 'Virgin Islands', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin',
  WV: 'West Virginia', WY: 'Wyoming',
};
const FACTORS = ['name', 'state', 'wi', 'gaf', 'tchop', 'tchcp', 'dshopp', 'dshcpp', 'caseta44', 'ime_caseta44'];

/**
 * The severity part of a CMS MS-DRG title, for the split and per-year rows ("165 without CC/MCC"): the
 * last "with/without MCC, CC or CC/MCC" and anything CMS adds after it ("with MCC or Disc Device ..."),
 * or null for a title without one.
 */
export function drgSeverity(title) {
  const match = /.*\b((?:with|without) (?:CC\/MCC|MCC|CC)\b.*)$/.exec(title || '');
  return match ? match[1] : null;
}

/**
 * {meta: {rates, drg_weights, drg_sev, opps_labor_share, maryland, source, volume_year}, states: {code: name},
 *  h: [[ccn, name or null, state, teaching 0|1|2]], md: [[ccn, name]]}, in CCN order.
 * model: the normalized crosswalk (stake-data.mjs normalize), for drg_sev: {DRG: severity} from the
 * MS-DRG titles of the DRGs the crosswalk prices (CMS's public titles; no CPT text). volumeMeta:
 * drg-volume.json meta, for volume_year (the counts' data year, which the folds and the CSV name).
 */
export function hospitalList(doc, model, volumeMeta) {
  const { meta } = doc;
  const rows = Object.entries(doc.hospitals).sort(([a], [b]) => a.localeCompare(b));
  const used = new Set([...rows.map(([, h]) => h.state), 'MD']);
  const missing = [...used].filter((code) => !STATES[code]);
  if (missing.length) throw new Error(`hospitals.json has state codes with no name in web/src/hospital-data.mjs: ${missing.join(', ')}`);
  return {
    meta: { rates: meta.rates, drg_weights: meta.drg_weights, drg_sev: drgSeverities(model), opps_labor_share: meta.opps_labor_share, maryland: meta.maryland, source: meta.source, volume_year: volumeMeta.data_year },
    states: Object.fromEntries([...used].sort().map((code) => [code, STATES[code]])),
    h: rows.map(([ccn, h]) => [ccn, h.name, h.state, TEACHING.indexOf(teaching(h))]),
    md: Object.entries(doc.maryland).sort(([a], [b]) => a.localeCompare(b)).map(([ccn, h]) => [ccn, h.name]),
  };
}

function drgSeverities(model) {
  const sev = {};
  for (const item of Object.values(model ? model.codes : {})) {
    for (const family of item.ip ? item.ip.families : []) {
      for (const d of family.drgs) {
        const text = drgSeverity(d.title);
        if (text) sev[d.drg] = text;
      }
    }
  }
  return Object.fromEntries(Object.entries(sev).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The MS-DRGs a crosswalk (normalized model) prices that the hospital tables do not cover, by table:
 * {'hospitals.json meta.drg_weights': [...], 'drg-volume.json meta.drgs': [...]}; both empty when they
 * match. The build fails on any: a card would throw for a missing weight, or read "under 11 or none" for
 * a count that was never looked up.
 */
export function uncoveredDrgs(model, hospitalsMeta, volumeMeta) {
  const priced = [...new Set(Object.values(model.codes).flatMap((item) => (item.ip ? item.ip.families.flatMap((f) => f.drgs.map((d) => d.drg)) : [])))].sort();
  const counted = new Set(volumeMeta.drgs);
  return {
    'hospitals.json meta.drg_weights': priced.filter((drg) => !Number.isFinite(hospitalsMeta.drg_weights[drg])),
    'drg-volume.json meta.drgs': priced.filter((drg) => !counted.has(drg)),
  };
}

/**
 * One hospital's file: its hospitals.json factors and v: {DRG: discharges in the counts' data year} for the
 * crosswalk's DRGs (drgs: drg-volume.json meta.drgs). volume is undefined for a hospital CMS gives no counts.
 */
export function hospitalRecord(hospital, volume = {}, drgs) {
  const record = Object.fromEntries(FACTORS.map((key) => [key, hospital[key]]));
  const priced = new Set(drgs);
  record.v = Object.fromEntries(Object.entries(volume).filter(([drg]) => priced.has(drg)));
  return record;
}
