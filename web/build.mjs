// Builds the static site into ../docs from the committed pipeline tables. No raw CMS files needed.
//   node build.mjs            build
//   BUILD_DATE=2026-11-11 node build.mjs   build as of a fixed date (for reproducible output)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { SITE } from './src/site.mjs';
import { todayISO, isDate, monthYear, periodIndex, spanAt, exemptionOn, eventsOf } from './src/engine.mjs';
import * as pages from './src/pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'docs');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const sha = (content) => createHash('sha256').update(content).digest('hex').slice(0, 10);

function write(path, content) {
  const full = join(out, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Write a file under a content-hashed name and return its URL. */
function hashed(dir, name, ext, content) {
  const url = `${dir}/${name}.${sha(content)}.${ext}`;
  write(url, content);
  return `/${url}`;
}

// The year the hand-written copy in pages.mjs describes. A newer final rule needs new copy first.
const COPY_YEAR = 2027;
const EVENT_CODE = { listed: 'l', new: 'n', added: 'a', returned: 't', removed: 'r', retired: 'x' };
const BASIS = { quarterly: 'q', annual: 'a', 'final-rule': 'f' };

function siteData(today) {
  const periods = read('pipeline/derived/periods.json');
  const history = read('pipeline/derived/ipo-history.json');
  const labels = read('data/labels.json');
  const groups = read('data/groups.json');
  const rulebook = read('pipeline/rules.json');
  const sources = Object.fromEntries(read('pipeline/sources.json').sources.map((s) => [s.id, s]));

  const newestRule = Math.max(...rulebook.rules.map((rule) => rule.cy));
  if (newestRule !== COPY_YEAR) {
    throw new Error(`rules.json now reaches CY ${newestRule}, but the page copy in web/src/pages.mjs describes CY ${COPY_YEAR}. Update the copy (YEAR_NOTES, phase-out, home) and COPY_YEAR.`);
  }
  const missing = Object.keys(history).filter((code) => !labels[code]);
  if (missing.length) console.warn(`No label yet for: ${missing.join(', ')} (shown as "No plain-language label yet")`);

  const periodIndexOf = Object.fromEntries(periods.map((p, i) => [p.date, i]));
  const sitePeriods = periods.map((p) => {
    const year = p.date.slice(0, 4);
    const label = p.basis === 'quarterly' ? `${monthYear(p.date)} Addendum B` : `CY ${year} final rule’s Addendum B`;
    return { d: p.date, basis: BASIS[p.basis], label, href: sources[p.source].landing };
  });

  const exemptions = [];
  const exemptionKeys = new Map();
  const exemptionIndex = (e) => {
    if (!e) return -1;
    const key = JSON.stringify(e);
    if (!exemptionKeys.has(key)) {
      exemptionKeys.set(key, exemptions.length);
      exemptions.push({ kind: e.kind, from: e.from, through: e.through, tyt: e.two_year_text ? [e.two_year_text.from, e.two_year_text.through] : null });
    }
    return exemptionKeys.get(key);
  };

  const groupIndex = Object.fromEntries(groups.map((g, i) => [g.id, i]));
  const families = [];
  const familyKeys = new Map();
  const codes = {};
  const fallback = { label: 'No plain-language label yet', group: 'other', family: 'Not yet labeled', keywords: [] };
  for (const code of Object.keys(history).sort()) {
    const label = labels[code] || fallback;
    const key = `${label.group}\u0000${label.family}`;
    if (!familyKeys.has(key)) {
      familyKeys.set(key, families.length);
      families.push([label.family, groupIndex[label.group]]);
    }
    codes[code] = {
      label: label.label,
      family: familyKeys.get(key),
      keywords: label.keywords.join(' '),
      spans: history[code].spans.map((s) => [periodIndexOf[s.from], s.si, exemptionIndex(s.exemption)]),
      events: history[code].events.map((e) => [periodIndexOf[e.date], EVENT_CODE[e.type], e.si]),
    };
  }

  const rules = {};
  for (const rule of rulebook.rules) {
    rules[rule.cy] = { name: `CY ${rule.cy} final rule`, id: rule.rule, fr: rule.fr, cites: rule.event_cites };
  }
  const dosMin = periods.find((p) => p.basis === 'quarterly').date;
  const dosMax = `${periods[periods.length - 1].date.slice(0, 4)}-12-31`;
  return {
    data: { built: today, dosMin, dosMax, periods: sitePeriods, exemptions, groups: groups.map((g) => [g.id, g.name]), families, codes, rules },
    rulebook, sources, periods,
  };
}

/** The never-listed codes, packed as {"first-last": "CODE1CODE2..."} to keep the download small. */
function packOther() {
  const packed = {};
  for (const [code, [first, last]] of Object.entries(read('pipeline/derived/other-codes.json'))) {
    const key = `${first}-${last}`;
    packed[key] = (packed[key] || '') + code;
  }
  return packed;
}

function sourceRows(sources, periods) {
  const inUse = new Set(periods.map((p) => p.source));
  const label = (s) => {
    if (s.kind === 'addendum_b') return `${monthYear(s.effective)} Addendum B${s.corrects ? ' (correction)' : ''}`;
    if (s.kind === 'rule_addenda') return `CY ${s.cy} final rule addenda (${s.rule})`;
    if (s.kind === 'removal_file') return `CY ${s.cy} services removed from the inpatient-only list (${s.rule})`;
    return `${s.rule}, ${s.fr}: Federal Register text`;
  };
  const use = (s) => {
    if (s.kind === 'addendum_b') return inUse.has(s.id) ? 'Status by date of service' : 'Replaced by CMS’s correction';
    if (s.kind === 'rule_addenda') {
      const period = periods.find((p) => p.source === s.id);
      if (period && period.basis === 'annual') return `Status for ${s.cy} (one file a year before 2020)`;
      return period ? `Scheduled status for ${s.cy}; Addendum E check` : 'Addendum E check';
    }
    return s.kind === 'removal_file' ? 'Check on the computed removals' : 'Quotes and citations';
  };
  return Object.values(sources).map((s) => ({ label: label(s), use: use(s), landing: s.landing, sha256: s.sha256 }));
}

function context(today) {
  const { data, rulebook, sources, periods } = siteData(today);
  const codes = Object.keys(data.codes).sort();
  const byGroup = data.groups.map(() => []);
  const byFamily = data.families.map(() => []);
  const familiesByGroup = data.groups.map(() => []);
  data.families.forEach(([, g], f) => familiesByGroup[g].push(f));
  for (const code of codes) {
    const family = data.codes[code].family;
    byFamily[family].push(code);
    byGroup[data.families[family][1]].push(code);
  }

  const ledger = read('pipeline/derived/years.json');
  const year = (n) => ledger.find((entry) => entry.year === n);
  const todayIndex = periodIndex(data, today);
  const lastIndex = data.periods.length - 1;
  const exemptOn = (code, date, index) => {
    const span = spanAt(data.codes[code], index);
    const state = span && span[2] >= 0 ? exemptionOn(data.exemptions[span[2]], date) : null;
    return state && state.status === 'active' ? state : null;
  };
  const cohorts = new Map();
  for (const code of codes) {
    const state = exemptOn(code, today, todayIndex);
    if (state) cohorts.set(state.from, [...(cohorts.get(state.from) || []), code]);
    else {
      // Removals whose exemption has run out are listed too, so the page accounts for every removal since 2020.
      const span = spanAt(data.codes[code], todayIndex);
      const past = span && span[2] >= 0 ? exemptionOn(data.exemptions[span[2]], today) : null;
      if (past && past.status === 'ended') cohorts.set(`${past.from}|ended`, [...(cohorts.get(`${past.from}|ended`) || []), code]);
    }
  }
  const exemptCohorts = [...cohorts.entries()].sort().map(([key, list]) => {
    const [from, ended] = key.split('|');
    return { from, codes: list, status: ended ? 'exemption ended December 31, 2021' : 'exempt now' };
  });

  const returnedOn = {};
  for (const code of codes) {
    for (const event of eventsOf(data, data.codes[code])) {
      if (event.type === 'returned') (returnedOn[event.date] ||= new Set()).add(code);
    }
  }
  for (const entry of ledger) returnedOn[`${entry.year}-01-01`] ||= new Set();

  const sizes = periods.map((p, i) => {
    let count = 0;
    for (const code of codes) { const span = spanAt(data.codes[code], i); if (span && span[1] === 'C') count += 1; }
    return { date: p.date, basis: BASIS[p.basis], count };
  });

  const reconciliation = read('pipeline/derived/reconciliation.json');
  const gaps = rulebook.rules.flatMap((rule) => ((rule.table && rule.table.explained) || []).map((item) => ({
    year: rule.cy, table: rule.table.name, why: item.why, codes: item.codes,
  })));
  const quarterly = periods.filter((p) => p.basis === 'quarterly');
  const scheduledPeriod = periods.find((p) => p.basis === 'final-rule');
  const eRules = Object.values(sources).filter((s) => s.kind === 'rule_addenda' && s.cy >= 2020).map((s) => s.cy);
  const lastQuarterly = quarterly[quarterly.length - 1];

  return {
    data, codes, byGroup, byFamily, familiesByGroup, today, ledger, sizes, returnedOn, exemptCohorts, gaps,
    reconciliation: reconciliation.rows.filter((row) => row.cms || row.computed),
    leaving2027: year(2027).january.removed,
    after2027: codes.filter((code) => { const span = spanAt(data.codes[code], lastIndex); return span && span[1] === 'C'; }),
    stats: {
      left2026: year(2026).january.removed.length,
      leaving2027: year(2027).january.removed.length,
      after2027: year(2027).start,
      exemptNow: exemptCohorts.filter((c) => c.status === 'exempt now').reduce((n, c) => n + c.codes.length, 0),
      disputedCodes: codes.filter((code) => data.codes[code].spans.some((s, i, all) => i === all.length - 1 && s[2] >= 0 && data.exemptions[s[2]].tyt)).length,
    },
    sources: sourceRows(sources, periods),
    counts: { quarterly: quarterly.length, checks: reconciliation.checks, quotes: reconciliation.quotes },
    lastQuarter: lastQuarterly.date,
    scheduled: scheduledPeriod ? scheduledPeriod.date.slice(0, 4) : null,
    eCounts: `${eRules[0]} through ${eRules[eRules.length - 1]}`,
    latestFile: `CMS’s ${monthYear(lastQuarterly.date)} Addendum B${scheduledPeriod ? ` and the CY ${scheduledPeriod.date.slice(0, 4)} final rule` : ''}`,
    quarterlyPage: sources[lastQuarterly.source].landing,
  };
}

function historyCsv(ctx) {
  const { data } = ctx;
  const cell = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [['code', 'label', 'body_system', 'procedure_family', 'date', 'event', 'status_indicator_after', 'source_file']];
  for (const code of ctx.codes) {
    const record = data.codes[code];
    const [family, g] = data.families[record.family];
    for (const event of eventsOf(data, record)) {
      rows.push([code, record.label, data.groups[g][1], family, event.date, event.type, event.si || 'not in file', event.period.label]);
    }
  }
  return `${rows.map((row) => row.map(cell).join(',')).join('\n')}\n`;
}

const FONTS = [
  ['Archivo', '@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2', '100 900'],
  ['Besley', '@fontsource-variable/besley/files/besley-latin-wght-normal.woff2', '400 900'],
];

async function main() {
  const today = process.env.BUILD_DATE || todayISO();
  if (!isDate(today)) throw new Error(`BUILD_DATE must be YYYY-MM-DD, got ${today}`);
  const ctx = context(today);
  ctx.today = today < ctx.data.dosMin ? ctx.data.dosMin : today > ctx.data.dosMax ? ctx.data.dosMax : today;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const faces = FONTS.map(([family, path, weights]) => {
    const bytes = readFileSync(join(here, 'node_modules', path));
    return { family, weights, url: hashed('fonts', family.toLowerCase(), 'woff2', bytes) };
  });
  const fontCss = faces.map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-display:swap;font-weight:${f.weights};src:url(${f.url}) format('woff2')}`).join('\n');
  const css = hashed('assets', 'site', 'css', `${fontCss}\n${readFileSync(join(here, 'src/styles.css'), 'utf8')}`);
  const script = await bundle({
    entryPoints: [join(here, 'src/client.mjs')], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none',
  });
  ctx.assets = {
    css,
    js: hashed('assets', 'app', 'js', script.outputFiles[0].contents),
    data: hashed('data', 'ipo', 'json', JSON.stringify(ctx.data)),
    other: hashed('data', 'other', 'json', JSON.stringify(packOther())),
    preload: faces.map((f) => `<link rel="preload" href="${f.url}" as="font" type="font/woff2" crossorigin>`).join('\n'),
  };

  write('index.html', pages.home(ctx));
  for (const code of ctx.codes) write(`code/${code}/index.html`, pages.codePage(ctx, code));
  ctx.data.groups.forEach(([id], g) => write(`group/${id}/index.html`, pages.groupPage(ctx, g)));
  write('history/index.html', pages.history(ctx));
  write('phase-out/index.html', pages.phaseOut(ctx));
  write('exemption/index.html', pages.exemption(ctx));
  write('methods/index.html', pages.methods(ctx));
  write('404.html', pages.notFound(ctx));
  write('data/inpatient-only-history.csv', historyCsv(ctx));

  const urls = ['/', '/history/', '/phase-out/', '/exemption/', '/methods/', ...ctx.data.groups.map(([id]) => `/group/${id}/`), ...ctx.codes.map((code) => `/code/${code}/`)];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE.url}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
  for (const file of ['favicon.svg', 'og.png']) {
    if (existsSync(join(here, 'static', file))) copyFileSync(join(here, 'static', file), join(out, file));
  }
  console.log(`Built ${urls.length} pages as of ${today}: ${ctx.codes.length} codes, ${ctx.data.periods.length} snapshots.`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
