// The one place that reads crosswalk.json and reviews.json keys (pipeline/crosswalk/build.py writes
// them). Everything else on the site, build and browser, uses the shape normalize() returns, so a
// renamed key in the pipeline is a one-line change here.

import { mappingSummary } from './stake-card.mjs';
import { eventsOf } from './engine.mjs';

const list = (value) => (Array.isArray(value) ? value : []);
const numberOr = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** How a code is shown: compared, or the one-line reason it is not. */
function kindOf(raw, group) {
  if (raw.outpatient && raw.outpatient.packaged) return group === 'anesthesia' ? 'anesthesia' : 'packaged';
  if (raw.tier && raw.tier.tier === null) return 'unmapped';
  if (!raw.inpatient || !raw.mapping) return 'pending';
  return 'compare';
}

function outpatient(raw) {
  const op = raw || {};
  const proposed = op.proposed && (op.proposed.apc || numberOr(op.proposed.rate) !== null)
    ? { si: op.proposed.si || null, apc: op.proposed.apc || null, rate: numberOr(op.proposed.rate) } : null;
  return { si: op.si || null, apc: op.apc || null, apcTitle: op.apc_title || null, rate: numberOr(op.rate), asc: numberOr(op.asc), proposed };
}

function inpatient(raw) {
  if (!raw) return null;
  const families = list(raw.families).map((f) => ({
    condition: f.condition || '',
    dx: f.dx ? { code: f.dx.code, title: f.dx.title } : null,
    mdc: f.mdc || null,
    name: f.family || '',
    basis: f.basis || '',
    drgs: list(f.drgs).map((d) => ({ drg: d.drg, title: d.title, weight: d.weight, amount: d.amount })),
    low: f.low,
    high: f.high,
    indexRows: list(f.index_rows).map((r) => ({
      pcs: r.pcs, mdc: r.mdc || null, drgs: list(r.drgs), family: r.family || null, nonOr: Boolean(r.non_or),
      cluster: r.cluster || null, note: r.note || null,
    })),
    caveat: f.caveat || null,
    when: f.when ? { dx: f.when.dx || null, variant: f.when.variant || null } : null,
  }));
  return families.length ? { low: raw.low, high: raw.high, families } : null;
}

function mapping(raw) {
  if (!raw) return null;
  return {
    fp: raw.fp,
    sets: list(raw.pcs_sets).map((s) => ({ codes: list(s.codes).map((c) => ({ code: c.code, title: c.title })), note: s.note || null })),
    dx: list(raw.principal_dx).map((d) => ({ code: d.code, title: d.title, condition: d.condition || null, role: d.role })),
    rationale: raw.rationale || null,
    passesAgree: Boolean(raw.passes_agree),
    adjudication: raw.adjudication || null,
  };
}

function review(raw) {
  const r = raw || {};
  return {
    status: r.status || 'unreviewed', agrees: r.agrees || 0, disputes: r.disputes || 0, stale: r.stale || 0,
    last: r.last || null, needsInpatient: Boolean(r.needs_inpatient_credential),
  };
}

function entry(code, raw) {
  const kind = kindOf(raw, raw.group);
  const compare = kind === 'compare';
  return {
    code,
    label: raw.label,
    group: raw.group,
    family: raw.family,
    removed: raw.removed,
    year: Number(String(raw.removed).slice(0, 4)),
    kind,
    op: outpatient(raw.outpatient),
    ip: compare ? inpatient(raw.inpatient) : null,
    diff: compare && raw.difference ? { low: raw.difference.low, high: raw.difference.high } : null,
    tier: raw.tier && raw.tier.tier ? { n: Number(raw.tier.tier), why: raw.tier.why } : null,
    review: review(raw.review),
    map: compare ? mapping(raw.mapping) : null,
    batch: raw.batch || null,
  };
}

/** {meta, codes: {code: entry}} from a parsed crosswalk.json. */
export function normalize(doc) {
  const raw = doc.meta || {};
  const counts = raw.counts || {};
  const rates = raw.rates || {};
  const codes = {};
  for (const code of Object.keys(doc.codes || {}).sort()) codes[code] = entry(code, doc.codes[code]);
  const meta = {
    built: raw.built,
    counts: {
      codes: counts.codes, removed2026: counts.removed_2026, removed2027: counts.removed_2027,
      mappable: counts.mappable, packaged: counts.packaged, mapped: counts.mapped,
      tiers: counts.tiers || {}, statuses: counts.statuses || {}, batches: counts.batches,
    },
    rates: {
      operating: rates.operating, capital: rates.capital, combined: rates.combined,
      operatingTable: rates.operating_table, capitalTable: rates.capital_table, weightsTable: rates.weights_table,
      version: rates.version, adjusters: rates.adjusters,
    },
    sources: Object.entries(raw.sources || {}).map(([id, s]) => ({ id, label: s.label, landing: s.landing, file: s.file })),
    years: { outpatient: (raw.years || {}).outpatient, inpatient: (raw.years || {}).inpatient },
    batches: list(raw.batches).map((b) => ({ id: b.id, group: b.group, codes: list(b.codes) })),
  };
  return { meta, codes };
}

/**
 * Codes whose crosswalk removal date is not the one the site's own list history gives: [{code, crosswalk,
 * history}]. The history date is the code's latest removal on one of the crosswalk's removal dates (null
 * when it has none). crosswalk.json is built from pipeline/derived/ipo-history.json, so a mismatch means
 * the history changed since; rebuild the crosswalk.
 */
export function removalMismatches(model, data) {
  const dates = new Set(Object.values(model.codes).map((item) => item.removed));
  const found = [];
  for (const [code, item] of Object.entries(model.codes)) {
    const record = data.codes[code];
    const removals = record ? eventsOf(data, record).filter((e) => e.type === 'removed' && dates.has(e.date)).map((e) => e.date) : [];
    const history = removals.length ? removals.sort()[removals.length - 1] : null;
    if (history !== item.removed) found.push({ code, crosswalk: item.removed, history });
  }
  return found;
}

/** Credit lines from reviews.json: named agreements on each code's current mapping. */
export function credits(reviews, model) {
  const byCode = {};
  for (const row of list(reviews)) {
    const item = model.codes[row.code];
    if (!item || !item.map || row.fp !== item.map.fp || row.verdict !== 'agree' || !row.name) continue;
    (byCode[row.code] ||= []).push({ name: row.name, credential: row.credential || '', date: row.date || '' });
  }
  return byCode;
}

/**
 * What the browser needs to search, filter and draw cards, and nothing else: the card without
 * "Show the work" (it stays on each code page) and with only the fingerprint and prefill summary the
 * review links need. Repeated strings (tier wording, DRG family names) go in tables. `siteCodes` are codes
 * that have a page on the site but are not in the crosswalk. hydrate() reverses this in the browser.
 */
export function clientModel(model, groups, siteCodes = []) {
  const strings = [];
  const at = new Map();
  const ref = (text) => {
    if (!at.has(text)) at.set(text, strings.push(text) - 1);
    return at.get(text);
  };
  const codes = {};
  for (const [code, item] of Object.entries(model.codes)) {
    const { op } = item;
    const slim = { label: item.label, group: item.group, year: item.year, kind: item.kind, op: { si: op.si, apc: op.apc, apcTitle: op.apcTitle, rate: op.rate, asc: op.asc }, review: { status: item.review.status, needsInpatient: item.review.needsInpatient }, tier: item.tier && { n: item.tier.n, why: ref(item.tier.why) }, diff: item.diff };
    if (item.ip) {
      slim.ip = {
        low: item.ip.low, high: item.ip.high,
        families: item.ip.families.map((f) => ({ condition: f.condition, dx: f.dx ? { code: f.dx.code } : undefined, name: ref(f.name), basis: f.basis, drgs: f.drgs.map((d) => ({ drg: d.drg })), low: f.low, high: f.high, caveat: f.caveat || undefined, when: f.when && (f.when.dx || f.when.variant) ? f.when : undefined })),
      };
      slim.map = { fp: item.map.fp, summary: mappingSummary(item) };   // all the Agree / Something's wrong links need
    }
    codes[code] = slim;
  }
  const { years } = model.meta;
  return { meta: { years, groups }, strings, codes, siteCodes: [...siteCodes].filter((code) => !model.codes[code]).sort() };
}

/** The items card() draws, from a clientModel() document. */
export function hydrate(doc) {
  const codes = {};
  for (const [code, slim] of Object.entries(doc.codes)) {
    codes[code] = {
      ...slim, code,
      tier: slim.tier && { n: slim.tier.n, why: doc.strings[slim.tier.why] },
      ip: slim.ip && { ...slim.ip, families: slim.ip.families.map((f) => ({ ...f, name: doc.strings[f.name] })) },
    };
  }
  return { ...doc, codes };
}
