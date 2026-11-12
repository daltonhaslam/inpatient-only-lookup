// Builds the static site into ../docs from the committed pipeline tables. No raw CMS files needed.
//   node build.mjs            build
//   BUILD_DATE=2026-11-11 node build.mjs   build as of a fixed date (for reproducible output)
//   CROSSWALK_JSON=/path/to/crosswalk.json node build.mjs   Revenue at stake from another crosswalk
//     (default pipeline/derived/crosswalk.json; without one the section is left out with a warning)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { SITE } from './src/site.mjs';
import { todayISO, isDate, monthYear, formatDate, clampDate, periodIndex, siAt, countsAt, exemptCodes, lookup, eventsOf, csv } from './src/engine.mjs';
import * as pages from './src/pages.mjs';
import * as stake from './src/stake.mjs';
import { normalize, credits, clientModel, removalMismatches } from './src/stake-data.mjs';

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
    throw new Error(`rules.json now reaches CY ${newestRule}, but the page copy describes CY ${COPY_YEAR}. In web/src/pages.mjs add YEAR_NOTES[${newestRule}] and PHASE_NOTES[${newestRule}], and reread the home status section, the History "end of the list" section, the phase-out page (its unfinished phase and descriptions) and the Methods page (removal files, scheduled year). Then set COPY_YEAR in web/build.mjs.`);
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
    rules[rule.cy] = { name: `CY ${rule.cy} final rule`, fr: rule.fr, cites: rule.event_cites, codes: rule.code_cites || {} };
  }
  const dosMin = periods.find((p) => p.basis === 'quarterly').date;
  const dosMax = `${periods[periods.length - 1].date.slice(0, 4)}-12-31`;
  const ruleIds = Object.fromEntries(rulebook.rules.map((rule) => [rule.cy, rule.rule]));
  // Cautions for single codes, from a date on: {code: [{from, text, cite}]}.
  const notes = {};
  for (const note of rulebook.notes) {
    for (const code of note.codes) (notes[code] ||= []).push({ from: note.from, text: note.text, cite: note.cite });
  }
  return {
    ruleIds,
    data: { built: today, dosMin, dosMax, periods: sitePeriods, exemptions, groups: groups.map((g) => [g.id, g.name]), families, codes, rules, notes },
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
  // The crosswalk's own sources (IPPS tables, MS-DRG definitions, code sets, ASC) are listed on the
  // Revenue at stake methods page instead.
  const lookupKinds = new Set(['addendum_b', 'rule_addenda', 'removal_file', 'fr_text']);
  return Object.values(sources).filter((s) => lookupKinds.has(s.kind)).map((s) => ({ label: label(s), use: use(s), landing: s.landing, sha256: s.sha256 }));
}

// The first year of the phase-out in 42 CFR 419.22(n); each January from here on is a phase.
const PHASE_OUT_FROM = 2026;

function context(buildDate) {
  const { data, rulebook, sources, periods, ruleIds } = siteData(buildDate);
  const today = clampDate(data, buildDate);
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

  // The copy says no exemption has been ended and describes one 2022-2025 conflict. If the data
  // stops agreeing, fail here instead of publishing a sentence that is no longer true.
  const ended = data.exemptions.filter((e) => e.kind === 'indefinite' && e.through);
  if (ended.length) {
    throw new Error('rules.json now ends an exemption. Update the copy that says none has ended (views.mjs exemptionText; pages.mjs home, phase-out "After the list ends", exemption page) and cite the rule that ended it, then remove this check.');
  }
  const disputedCodes = codes.filter((code) => {
    const last = data.codes[code].spans[data.codes[code].spans.length - 1];
    return last[2] >= 0 && data.exemptions[last[2]].tyt;
  }).length;
  if (disputedCodes !== 16) {
    throw new Error(`The exemption page says the 2022-2025 conflict affects 16 codes (5 + 11); the data now says ${disputedCodes}. Update pages.mjs.`);
  }

  // Removals since 2020, grouped by removal date and by whether the exemption still runs today.
  const cohorts = new Map();
  for (const status of ['active', 'ended']) {
    for (const code of exemptCodes(data, today, status)) {
      const exemption = lookup(data, code, today).exemption;
      const key = `${exemption.from}|${exemption.through || ''}|${status}`;
      cohorts.set(key, [...(cohorts.get(key) || []), code]);
    }
  }
  const exemptCohorts = [...cohorts.entries()].sort().map(([key, list]) => {
    const [from, through, status] = key.split('|');
    return { from, codes: list, status: status === 'active' ? 'exempt now' : `exemption ended ${formatDate(through)}` };
  });

  const ledger = read('pipeline/derived/years.json');
  const returnedOn = Object.fromEntries(ledger.map((entry) => [`${entry.year}-01-01`, new Set()]));
  for (const code of codes) {
    for (const event of eventsOf(data, data.codes[code])) {
      if (event.type === 'returned') (returnedOn[event.date] ||= new Set()).add(code);
    }
  }
  const phases = ledger.filter((entry) => entry.year >= PHASE_OUT_FROM).map((entry) => {
    const date = `${entry.year}-01-01`;
    const index = periodIndex(data, date);
    return {
      year: entry.year, date, past: date <= today, removed: entry.january.removed.length, codes: entry.january.removed,
      start: entry.start, staying: codes.filter((code) => siAt(data.codes[code], index) === 'C'), file: data.periods[index].label,
    };
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
    data, codes, byGroup, byFamily, familiesByGroup, today, ledger, returnedOn, ruleIds, notes: rulebook.notes, exemptCohorts, gaps, phases, disputedCodes,
    sizes: periods.map((p, i) => ({ date: p.date, basis: BASIS[p.basis], count: countsAt(data, i).total })),
    reconciliation: reconciliation.rows.filter((row) => row.cms || row.computed),
    exemptNow: exemptCodes(data, today).length,
    firstYear: data.periods[0].d.slice(0, 4),
    nextYear: Number(data.dosMax.slice(0, 4)) + 1,
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
  const rows = [['code', 'label', 'body_system', 'procedure_family', 'date', 'event', 'status_indicator_after', 'source_file']];
  for (const code of ctx.codes) {
    const record = data.codes[code];
    const [family, g] = data.families[record.family];
    for (const event of eventsOf(data, record)) {
      rows.push([code, record.label, data.groups[g][1], family, event.date, event.type, event.si || 'not in file', event.period.label]);
    }
  }
  return csv(rows);
}

/** The Revenue at stake model, or null (with a warning) when there is no crosswalk to build it from. */
function stakeData(ctx) {
  const path = process.env.CROSSWALK_JSON ? resolve(process.env.CROSSWALK_JSON) : join(root, 'pipeline/derived/crosswalk.json');
  if (!existsSync(path)) {
    console.warn(`No crosswalk at ${process.env.CROSSWALK_JSON ? path : 'pipeline/derived/crosswalk.json'}: building without the Revenue at stake section. Run python3 pipeline/crosswalk/build.py, or set CROSSWALK_JSON.`);
    return null;
  }
  const model = normalize(JSON.parse(readFileSync(path, 'utf8')));
  const missing = Object.keys(model.codes).filter((code) => !ctx.data.codes[code]);
  if (missing.length) throw new Error(`crosswalk.json has codes with no page on this site: ${missing.slice(0, 10).join(', ')}`);
  const moved = removalMismatches(model, ctx.data);
  if (moved.length) {
    const list = moved.slice(0, 10).map((m) => `${m.code} (crosswalk ${m.crosswalk}, history ${m.history || 'none'})`).join(', ');
    throw new Error(`crosswalk.json removal dates disagree with the site's list history for ${moved.length} code(s): ${list}. The history changed after the crosswalk was built: run python3 pipeline/crosswalk/build.py, then build again.`);
  }
  // The review ingest reads the first 8-hex word of the prefilled mapping; anything else would lose reviews.
  const badFp = Object.values(model.codes).filter((item) => item.map && !/^[0-9a-f]{8}$/.test(item.map.fp)).map((item) => item.code);
  if (badFp.length) throw new Error(`crosswalk.json has mapping fingerprints that are not 8 hex digits: ${badFp.slice(0, 10).join(', ')}`);
  const reviewsPath = join(root, 'data/crosswalk/reviews.json');
  const reviews = existsSync(reviewsPath) ? JSON.parse(readFileSync(reviewsPath, 'utf8')) : [];
  const xlsx = join(dirname(path), 'crosswalk.xlsx');
  if (!existsSync(xlsx)) console.warn('No crosswalk.xlsx next to crosswalk.json: the Excel download is left out.');
  return { ...stake.stakeContext(model, credits(reviews, model), ctx.data.groups, { xlsx: existsSync(xlsx) }), xlsxPath: xlsx };
}

const FONTS = [
  ['Archivo', '@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2', '100 900'],
  ['Besley', '@fontsource-variable/besley/files/besley-latin-wght-normal.woff2', '400 900'],
];

async function main() {
  const today = process.env.BUILD_DATE || todayISO();
  if (!isDate(today)) throw new Error(`BUILD_DATE must be YYYY-MM-DD, got ${today}`);
  const ctx = context(today);
  ctx.stake = stakeData(ctx);
  if (ctx.stake) {
    ctx.stakeBlock = (code) => stake.codeBlock(ctx, code);
    ctx.stakeSummary = stake.coverageSentence(ctx.stake);
  }

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
  const stakeScript = ctx.stake ? await bundle({
    entryPoints: [join(here, 'src/stake-client.mjs')], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none',
  }) : null;
  ctx.assets = {
    css,
    js: hashed('assets', 'app', 'js', script.outputFiles[0].contents),
    stakeJs: stakeScript ? hashed('assets', 'stake', 'js', stakeScript.outputFiles[0].contents) : null,
    data: hashed('data', 'ipo', 'json', JSON.stringify(ctx.data)),
    other: hashed('data', 'other', 'json', JSON.stringify(packOther())),
    stake: ctx.stake ? hashed('data', 'stake', 'json', JSON.stringify(clientModel(ctx.stake.model, ctx.stake.groups, ctx.codes))) : null,
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
  if (ctx.stake) {
    write('revenue-at-stake/index.html', stake.mainPage(ctx));
    write('revenue-at-stake/help-review/index.html', stake.helpPage(ctx));
    write('revenue-at-stake/methods/index.html', stake.methodsPage(ctx));
    write('data/revenue-at-stake.csv', stake.csvText(ctx.stake));
    if (ctx.stake.xlsx) copyFileSync(ctx.stake.xlsxPath, join(out, 'data/revenue-at-stake.xlsx'));
  }

  const urls = ['/', '/history/', '/phase-out/', '/exemption/', '/methods/', ...(ctx.stake ? stake.PATHS : []), ...ctx.data.groups.map(([id]) => `/group/${id}/`), ...ctx.codes.map((code) => `/code/${code}/`)];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE.url}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
  for (const file of ['favicon.svg', 'og.png']) {
    if (existsSync(join(here, 'static', file))) copyFileSync(join(here, 'static', file), join(out, file));
  }
  console.log(`Built ${urls.length} pages as of ${today}: ${ctx.codes.length} codes, ${ctx.data.periods.length} snapshots.`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
