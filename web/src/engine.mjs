// Lookup logic shared by the build (prerendered pages) and the browser.
// Pure functions over the site data; no DOM. Dates are ISO strings (YYYY-MM-DD) and compare as text.

const EVENT = { l: 'listed', n: 'new', a: 'added', t: 'returned', r: 'removed', x: 'retired' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const isDate = (text) => /^\d{4}-\d\d-\d\d$/.test(text || '') && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))
  && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;

export function formatDate(iso, style = 'long') {
  const [y, m, d] = iso.split('-').map(Number);
  const month = style === 'short' ? MONTHS[m - 1].slice(0, 3) : MONTHS[m - 1];
  return `${month} ${d}, ${y}`;
}

export const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
export const fromDayNumber = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

export function todayISO(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const clampDate = (data, iso) => (iso < data.dosMin ? data.dosMin : iso > data.dosMax ? data.dosMax : iso);

// A CPT/HCPCS code is five characters: a digit or letter, three digits, a digit or letter.
export const normalizeCode = (text) => String(text || '').trim().toUpperCase();
export const isCode = (text) => /^[0-9A-Z]\d{3}[0-9A-Z]$/.test(text);

/** Index of the Addendum B snapshot in force on a date, or -1 before the first one. */
export function periodIndex(data, iso) {
  let low = 0;
  let high = data.periods.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (data.periods[mid].d <= iso) { found = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return found;
}

/** True while a date is answered from a final rule's Addendum B, before CMS posts that January's file. */
export const isScheduled = (period) => Boolean(period) && period.basis === 'f';
export const stateOf = (si) => (si === 'C' ? 'ipo' : si === '' || si === 'D' ? 'gone' : 'off');
export const num = (n) => n.toLocaleString('en-US');

/** Rows of strings as CSV text. A cell a spreadsheet would run as a formula gets a leading apostrophe. */
export function csv(rows) {
  const cell = (value) => {
    if (typeof value === 'number') return String(value);     // a plain number is never a formula
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`;
}

/** A linear scale between two dates: share(iso) is 0..1 (clamped); at(share) is the date at a share. */
export function scale(from, to) {
  const start = dayNumber(from);
  const length = dayNumber(to) - start;
  return {
    share: (iso) => Math.max(0, Math.min(1, (dayNumber(iso) - start) / length)),
    at: (share) => fromDayNumber(Math.round(start + Math.max(0, Math.min(1, share)) * length)),
  };
}

/** The span of a code's history in force at a period index. Spans are [period index, SI, exemption index]. */
export function spanAt(record, index) {
  let current = null;
  for (const span of record.spans) {
    if (span[0] <= index) current = span; else break;
  }
  return current;
}

/** A code's status indicator, and its state, at a period index ('' and 'gone' before it exists). */
export const siAt = (record, index) => (spanAt(record, index) || [0, ''])[1];
export const stateAt = (record, index) => stateOf(siAt(record, index));

/**
 * Where a removal's medical-review exemption stands on a date.
 * status: 'active' | 'ended' (it had one; it is over) | 'none' (removed before the exemptions began)
 * disputed: the date falls where the regulation's two-year text would have ended an indefinite exemption.
 */
export function exemptionOn(exemption, iso) {
  if (!exemption) return null;
  if (exemption.kind === 'before-2020') return { ...exemption, status: 'none', disputed: false };
  const status = exemption.through && iso > exemption.through ? 'ended' : 'active';
  const window = exemption.tyt;
  return { ...exemption, status, disputed: Boolean(window && iso >= window[0] && iso <= window[1]) };
}

/**
 * Everything the site says about one code on one date of service.
 * kind: 'listed' (the code has inpatient-only history), 'other' (in CMS's files, never on the list),
 *       'unknown' (not in any Addendum B we hold). `other` is the never-listed table, or null if not loaded.
 */
export function lookup(data, code, iso, other = null) {
  const index = periodIndex(data, iso);
  const period = index >= 0 ? data.periods[index] : null;
  const base = { code, date: iso, period, periodIndex: index };
  const record = data.codes[code];
  if (record) {
    const span = spanAt(record, index);
    const si = span ? span[1] : '';
    const state = stateOf(si);
    const exemption = span && span[2] >= 0 ? exemptionOn(data.exemptions[span[2]], iso) : null;
    return { ...base, kind: 'listed', record, state, si, exemption, removed: exemption ? exemption.from : null };
  }
  if (other && other[code]) {
    const [first, last] = other[code];
    return { ...base, kind: 'other', state: index >= first && index <= last ? 'off' : 'gone', first, last };
  }
  return { ...base, kind: other ? 'unknown' : 'pending' };
}

/** The never-listed table ships as {"first-last": "CODE1CODE2..."}; expand it to {code: [first, last]}. */
export function expandOther(packed) {
  const out = {};
  for (const [range, codes] of Object.entries(packed)) {
    const bounds = range.split('-').map(Number);
    for (let i = 0; i < codes.length; i += 5) out[codes.slice(i, i + 5)] = bounds;
  }
  return out;
}

/** Events of a code as objects, oldest first. */
export function eventsOf(data, record) {
  return record.events.map(([index, type, si]) => ({ date: data.periods[index].d, period: data.periods[index], type: EVENT[type], si }));
}

/** How many codes are on the list in a period, in total and per group. */
export function countsAt(data, index) {
  const groups = new Array(data.groups.length).fill(0);
  let total = 0;
  for (const record of Object.values(data.codes)) {
    if (siAt(record, index) === 'C') { total += 1; groups[data.families[record.family][1]] += 1; }
  }
  return { total, groups };
}

/** The codes whose medical-review exemption is in the given status ('active' or 'ended') on a date. */
export function exemptCodes(data, iso, status = 'active') {
  const index = periodIndex(data, iso);
  return Object.keys(data.codes).filter((code) => {
    const span = spanAt(data.codes[code], index);
    const exemption = span && span[2] >= 0 ? exemptionOn(data.exemptions[span[2]], iso) : null;
    return exemption && exemption.status === status;
  });
}

// ---- search -------------------------------------------------------------------------------

const fold = (text) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const wordsOf = (text) => fold(text).match(/[a-z0-9]+/g) || [];

/** Build the search index once: one entry per code with its searchable words. */
export function buildIndex(data) {
  return Object.keys(data.codes).sort().map((code) => {
    const record = data.codes[code];
    const [familyName, groupIndex] = data.families[record.family];
    return {
      code,
      label: wordsOf(record.label),
      extra: wordsOf(`${record.keywords} ${familyName} ${data.groups[groupIndex][1]}`),
    };
  });
}

/**
 * Codes matching a query, best first. A query that looks like a code (starts with a digit, or a
 * letter then digits) matches by code prefix; anything else matches when every word in it starts
 * a word of the label, keywords, family or group. Label matches rank above the rest, then shorter labels.
 */
export function search(index, query, limit = 60) {
  const text = fold(String(query || '').trim());
  if (!text) return { codes: [], total: 0 };
  const scored = [];   // [score, label length in words, code]: lower is better
  if (/^(\d[0-9a-z]{0,4}|[a-z]\d{1,4})$/.test(text)) {
    const prefix = text.toUpperCase();
    for (const entry of index) if (entry.code.startsWith(prefix)) scored.push([entry.code === prefix ? 0 : 1, 0, entry.code]);
  }
  const terms = wordsOf(text);
  if (!scored.length && terms.length) {
    for (const entry of index) {
      let score = 0;
      for (const term of terms) {
        if (entry.label.some((word) => word.startsWith(term))) score += 0;
        else if (entry.extra.some((word) => word.startsWith(term))) score += 3;
        else { score = -1; break; }
      }
      // Anesthesia codes echo the procedure they go with; list the procedure first unless asked.
      if (score >= 0 && entry.label[0] === 'anesthesia' && !terms.some((term) => 'anesthesia'.startsWith(term))) score += 1;
      // Among equal matches the shorter label is the plainer procedure ("Total hip replacement").
      if (score >= 0) scored.push([score + 2, entry.label.length, entry.code]);
    }
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return { codes: scored.slice(0, limit).map((item) => item[2]), total: scored.length };
}

/** Pull every distinct five-character code out of free text (a pasted list, a spreadsheet column). */
export function extractCodes(text) {
  return [...new Set(String(text || '').toUpperCase().split(/[^0-9A-Z]+/).filter(isCode))];
}
