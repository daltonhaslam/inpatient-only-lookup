// Revenue at stake: checks over the built docs/ tree and the form links.
// Runs when the build had a crosswalk (CROSSWALK_JSON, else pipeline/derived/crosswalk.json);
// without one the section is not built and these tests are skipped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agreeHref, wrongHref, claimHref, REVIEW_ENTRY } from '../src/site.mjs';
import { normalize, clientModel, hydrate, removalMismatches } from '../src/stake-data.mjs';
import { card, alternativeLabel } from '../src/stake-card.mjs';
import { CSV_HEADER, csvRows } from '../src/stake.mjs';
import { out } from '../src/views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const docs = join(repo, 'docs');
const source = process.env.CROSSWALK_JSON ? resolve(process.env.CROSSWALK_JSON) : join(repo, 'pipeline/derived/crosswalk.json');
const built = existsSync(join(docs, 'revenue-at-stake', 'index.html'));
const skip = !existsSync(source) && !built ? 'no crosswalk.json: the Revenue at stake section is not built' : false;

const read = (path) => readFileSync(join(docs, path), 'utf8');
const textOf = (html) => html.replace(/<span class="sr">[\s\S]*?<\/span>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"');
const decode = (href) => href.replaceAll('&amp;', '&');
/** The Revenue at stake block on a code page, or null. */
function block(code) {
  const html = read(`code/${code}/index.html`);
  const start = html.indexOf('<section class="block stake-block"');
  return start < 0 ? null : html.slice(start, html.indexOf('</section>', start) + 10);
}
const cards = (html) => [...html.matchAll(/<article class="scard[\s\S]*?<\/article>/g)].map((m) => m[0]);

describe('revenue at stake', { skip }, () => {
  test('the section was built from the crosswalk', () => {
    assert.ok(existsSync(source), `docs/ has the section but there is no ${source} to check it against: set CROSSWALK_JSON`);
    assert.ok(built, 'crosswalk.json exists but docs/revenue-at-stake/ was not built: run cd web && node build.mjs');
  });

  const doc = existsSync(source) ? JSON.parse(readFileSync(source, 'utf8')) : null;
  if (!doc) return;
  const model = doc ? normalize(doc) : null;
  const codes = model ? Object.keys(model.codes) : [];
  const items = model ? Object.values(model.codes) : [];
  const stake = { items, groupName: {} };

  test('the trimmed browser model draws the same cards as the full one, and stays under 700 KB', () => {
    const slim = clientModel(model, [], ['27447']);
    const text = JSON.stringify(slim);
    assert.ok(text.length < 700000, `client JSON is ${text.length} bytes`);
    assert.ok(!('27447' in slim.codes) && slim.siteCodes.includes('27447'));
    const back = hydrate(JSON.parse(text));
    for (const code of codes) assert.equal(card(back.codes[code], model.meta, { detail: false }), card(model.codes[code], model.meta, { detail: false }), code);
  });

  test('browser cards carry the review buttons but not the work; code-page cards carry both', () => {
    const compared = items.find((item) => item.kind === 'compare');
    assert.ok(card(compared, model.meta, { detail: false }).includes('forms/d/e'));
    assert.ok(!card(compared, model.meta, { detail: false }).includes('Show the work</summary>'));
    assert.ok(card(compared, model.meta).includes('Show the work</summary>'));
  });

  test('every removed code page has one block, and no other code page has one', () => {
    assert.equal(codes.length, doc.meta.counts.codes);
    const withBlock = readdirSync(join(docs, 'code')).filter((code) => read(`code/${code}/index.html`).includes('data-stake-code='));
    assert.deepEqual(withBlock.sort(), [...codes].sort());
    for (const code of codes) assert.equal(cards(block(code)).length, 1, `${code}: expected one card`);
  });

  test('a packaged code has the packaged note and no range or review buttons', () => {
    const html = block('00176');
    assert.match(textOf(html), /no separate outpatient payment/);
    assert.doesNotMatch(html, /scard__fam|MS-DRG|docs\.google\.com|badge--/);
    const packaged = items.filter((item) => item.kind === 'packaged' || item.kind === 'anesthesia');
    assert.equal(packaged.length, doc.meta.counts.packaged);
    for (const item of packaged) assert.doesNotMatch(block(item.code), /scard__fam|scard__gap/, item.code);
  });

  test('Tier 3 cards stack two or more ranges, each labeled with its condition, and ask for reviewers', () => {
    const tier3 = items.filter((item) => item.kind === 'compare' && item.tier && item.tier.n === 3 && item.ip.families.length > 1);
    assert.ok(tier3.length > 0, 'no multi-family Tier 3 codes in the data');
    for (const item of tier3) {
      const html = block(item.code);
      const families = [...html.matchAll(/<div class="scard__fam">([\s\S]*?)<\/div>/g)].map((m) => textOf(m[1]));
      assert.ok(families.length >= 2, `${item.code}: ${families.length} ranges`);
      for (const family of families) {
        assert.match(family, /\$[\d,]+(–\$[\d,]+)?/, `${item.code}: a range without dollars`);
        assert.match(family, /If the principal diagnosis is \S|If coded as: \S/, `${item.code}: a range without what selects it`);
      }
      assert.match(textOf(html), /Reviewers wanted\./, item.code);
      assert.doesNotMatch(html, /awaiting physician review/i);
    }
  });

  test('family labels follow what splits them: diagnosis, coded variant, or both', () => {
    const split = items.filter((item) => item.kind === 'compare' && item.ip.families.length > 1);
    const seen = { dx: 0, variant: 0 };
    for (const item of split) {
      const html = block(item.code);
      const families = [...html.matchAll(/<div class="scard__fam">([\s\S]*?)<\/div>/g)].map((m) => textOf(m[1]).replace(/\s+/g, ' '));
      item.ip.families.forEach((f, i) => {
        assert.ok(f.when, `${item.code}: no "when" in the data`);
        if (f.when.dx) { seen.dx += 1; assert.ok(families[i].includes(`If the principal diagnosis is ${f.when.dx}`), `${item.code}: ${families[i]}`); }
        if (f.when.variant) { seen.variant += 1; assert.ok(families[i].includes(`If coded as: ${f.when.variant}`), `${item.code}: ${families[i]}`); }
        if (!f.when.dx && f.when.variant) assert.ok(!families[i].includes('If the principal diagnosis is'), `${item.code}: a variant split labeled as a diagnosis`);
      });
      const why = textOf(html).replace(/\s+/g, ' ');
      assert.ok(why.includes(item.tier.why), `${item.code}: card lacks its tier wording`);
      if (item.ip.families.every((f) => !f.when.dx)) assert.ok(!item.tier.why.includes('principal diagnosis'), `${item.code}: ${item.tier.why}`);
    }
    assert.ok(seen.dx > 0 && seen.variant > 0, `labels seen: ${JSON.stringify(seen)}`);
  });

  test('an adjudicated card shows pass A\'s note only beside pass A\'s own mapping, and always the adjudicator\'s note', () => {
    const adjudicated = items.filter((item) => item.kind === 'compare' && item.map.adjudication);
    assert.ok(adjudicated.some((item) => !item.map.rationale), 'no adjudicated code with its mapper\'s note withheld');
    for (const item of adjudicated) {
      const text = textOf(block(item.code));
      assert.ok(text.includes('Adjudicator’s note:'), `${item.code}: no adjudicator's note`);
      assert.equal(text.includes('Mapper’s note:'), Boolean(item.map.rationale), `${item.code}: mapper's note shown ${!item.map.rationale ? 'without' : 'with'} a rationale`);
    }
  });

  test('CSV alternative rows say what selects the family: diagnosis, operation variant, or both', () => {
    const rows = csvRows(stake);
    const order = CSV_HEADER.indexOf('family_order');
    const labels = new Set(rows.slice(1).map((row) => row[order]).filter((v) => v.startsWith('alternative')));
    assert.ok(labels.has('alternative family (depends on operation variant)'), [...labels].join(' | '));
    assert.ok(labels.has('alternative family (depends on diagnosis)'), [...labels].join(' | '));
    for (const item of items.filter((i) => i.kind === 'compare' && i.ip.families.length > 1)) {
      const mine = rows.filter((row) => row[0] === item.code);
      item.ip.families.slice(1).forEach((f, i) => assert.equal(mine[i + 1][order], alternativeLabel(f), item.code));
    }
  });

  test('every card with an inpatient range also shows a review status', () => {
    for (const code of codes) {
      for (const html of cards(block(code))) {
        if (html.includes('scard__fam')) assert.match(html, /<span class="badge badge--[a-z-]+">[^<]+<\/span>/, code);
      }
    }
    const main = read('revenue-at-stake/index.html');
    const rows = [...main.matchAll(/<tr data-code="([^"]+)"[^>]*data-kind="compare"[^>]*>([\s\S]*?)<\/tr>/g)];
    assert.equal(rows.length, items.filter((item) => item.kind === 'compare').length);
    for (const [, code, row] of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => textOf(m[1]).trim());
      assert.match(cells[2], /^\$[\d,]+(–\$[\d,]+)?/, `${code}: inpatient cell`);
      assert.ok(cells[3].length > 3, `${code}: no status next to the range`);
    }
  });

  test('review links carry the prefill entry IDs, the code and the encoded fingerprint', () => {
    const lobectomy = model.codes['32480'];
    const hrefs = [...block('32480').matchAll(/href="(https:\/\/docs\.google\.com[^"]+)"/g)].map((m) => decode(m[1]));
    assert.equal(hrefs.length, 2);
    for (const href of hrefs) {
      const url = new URL(href);
      assert.equal(url.searchParams.get('usp'), 'pp_url');
      assert.equal(url.searchParams.get(REVIEW_ENTRY.code), '32480');
      const mapping = url.searchParams.get(REVIEW_ENTRY.mapping);
      assert.match(mapping, /^[0-9a-f]{8} /);
      assert.equal(mapping.slice(0, 8), lobectomy.map.fp);
      assert.ok(mapping.length <= 200);
      assert.ok(href.includes(`${REVIEW_ENTRY.mapping}=${lobectomy.map.fp}%20`), 'the space after the fingerprint is encoded');
    }
  });

  test('help page lists every batch with an unreviewed count and a claim link', () => {
    const html = read('revenue-at-stake/help-review/index.html');
    for (const batch of model.meta.batches) {
      assert.ok(decode(html).includes(claimHref(batch.id)), `no claim link for ${batch.id}`);
    }
    assert.match(textOf(html), /\d+ of \d+/);
    assert.ok(textOf(html).includes('Agreements under the same name count as one reviewer.'), 'help page does not say how reviewers are counted');
  });

  test('main page: badge, guardrail, years, progress, downloads, a row per code', () => {
    const html = read('revenue-at-stake/index.html');
    const text = textOf(html);
    for (const phrase of ['Draft · built with Claude Code · under coder review', 'Outpatient-eligible is not outpatient-only',
      'Status decisions stay clinical', 'not a forecast', 'Not billing or legal advice', 'Outpatient: CY 2027 OPPS (from Jan 1, 2027)',
      'Inpatient: FY 2027 IPPS (Oct 1, 2026 – Sep 30, 2027)', 'compared codes reviewed']) {
      assert.ok(text.includes(phrase), `main page lacks "${phrase}"`);
    }
    assert.match(html, /data-stake="\/data\/stake\.[0-9a-f]{10}\.json"/);
    assert.match(html, /href="\/data\/revenue-at-stake\.csv"/);
    assert.equal([...html.matchAll(/<tr data-code="/g)].length, items.length);
    const compared = items.filter((item) => item.kind === 'compare').length;
    assert.ok(text.includes(`${compared.toLocaleString('en-US')} have a comparison`), 'lede does not say how many are compared');
    assert.doesNotMatch(text, /For each of the [\d,]+ procedures/);
  });

  test('help-review is easy to find: callout, sub-nav on all three pages, card links, home link', () => {
    const main = read('revenue-at-stake/index.html');
    assert.match(main, /data-help-callout/);
    assert.ok(textOf(main).includes('Help check these mappings'));
    assert.match(main, /class="callout__act"><a class="btn" href="\/revenue-at-stake\/help-review\/">Help review →<\/a>/);
    assert.equal((main.match(/>Help review →</g) || []).length, 1, 'one Help review button on the main page');
    const pages = { 'revenue-at-stake/index.html': 'Compare', 'revenue-at-stake/help-review/index.html': 'Help review', 'revenue-at-stake/methods/index.html': 'Methods' };
    for (const [file, current] of Object.entries(pages)) {
      const nav = read(file).match(/<nav class="subnav"[^>]*>([\s\S]*?)<\/nav>/);
      assert.ok(nav, `${file}: no sub-nav`);
      for (const href of ['/revenue-at-stake/', '/revenue-at-stake/help-review/', '/revenue-at-stake/methods/']) assert.ok(nav[1].includes(`href="${href}"`), `${file}: no ${href}`);
      assert.equal([...nav[1].matchAll(/aria-current="page"/g)].length, 1);
      assert.match(nav[1], new RegExp(`aria-current="page">${current}<`));
    }
    assert.ok(read('index.html').includes('href="/revenue-at-stake/help-review/">help review it</a>'));
    const withCard = readdirSync(join(docs, 'code')).filter((code) => read(`code/${code}/index.html`).includes('scard__act'));
    assert.ok(withCard.length > 0);
    for (const code of withCard.slice(0, 20)) assert.ok(read(`code/${code}/index.html`).includes('Review a batch of 10 →'), code);
  });

  test('methods page cites every source file, the guardrail and the years', () => {
    const html = read('revenue-at-stake/methods/index.html');
    const text = textOf(html);
    for (const s of model.meta.sources) {
      assert.ok(html.includes(`href="${s.landing}"`), `no link to ${s.id}`);
      for (const file of s.file.split('; ')) assert.ok(text.includes(file), `methods does not name ${file}`);
    }
    const drg165 = items.flatMap((item) => (item.ip ? item.ip.families : [])).flatMap((f) => f.drgs).find((d) => d.drg === '165');
    if (drg165) assert.ok(!text.includes(drg165.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })), 'methods headlines the DRG 165 dollar amount');
    for (const phrase of ['Outpatient-eligible is not outpatient-only', 'two-midnight rule', 'not a forecast', 'Built with Claude Code', 'Run it on your own claims', 'may include those adjustments']) {
      assert.ok(text.includes(phrase), `methods lacks "${phrase}"`);
    }
  });

  test('nav, home link and sitemap', () => {
    const home = read('index.html');
    assert.match(home, /<nav class="top__nav"[^>]*>[\s\S]*href="\/revenue-at-stake\/"/);
    const sitemap = read('sitemap.xml');
    for (const path of ['/revenue-at-stake/', '/revenue-at-stake/help-review/', '/revenue-at-stake/methods/']) {
      assert.ok(sitemap.includes(`${path}</loc>`), `sitemap lacks ${path}`);
    }
  });

  test('CSV: one row per code and family, plain values, same rows as the workbook', () => {
    const rows = readFileSync(join(docs, 'data', 'revenue-at-stake.csv'), 'utf8').trim().split('\n');
    assert.equal(rows[0], CSV_HEADER.join(','));
    const want = items.reduce((n, item) => n + (item.kind === 'compare' ? item.ip.families.length : 1), 0);
    assert.equal(rows.length - 1, want);
    assert.ok(!rows.some((row) => /(^|,)[=+@]/.test(row)), 'a cell starts like a formula');
    const xlsx = join(docs, 'data', 'revenue-at-stake.xlsx');
    if (existsSync(xlsx)) {
      const count = execFileSync('python3', ['-c', `import re, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1], read_only=True)["Crosswalk"]
print(sum(1 for row in ws.iter_rows(values_only=True) if row and isinstance(row[0], str) and re.fullmatch(r"[0-9A-Z]{4}[0-9A-Z]", row[0])))`, xlsx], { encoding: 'utf8' });
      assert.equal(rows.length - 1, Number(count), 'CSV rows differ from the workbook Crosswalk rows');
    }
  });

  test('no CPT descriptor text in what the section publishes', { skip: !existsSync(join(repo, 'data', 'raw')) && 'data/raw/ is absent' }, () => {
    const texts = [];
    const segments = (where, html) => {
      for (const part of textOf(html.replace(/>/g, '>\n')).split('\n')) if (part.trim()) texts.push([where, part.trim()]);
    };
    for (const path of ['revenue-at-stake/index.html', 'revenue-at-stake/help-review/index.html', 'revenue-at-stake/methods/index.html']) segments(path, read(path));
    for (const code of codes) segments(`code/${code}`, block(code));
    for (const row of readFileSync(join(docs, 'data', 'revenue-at-stake.csv'), 'utf8').split('\n')) texts.push(['revenue-at-stake.csv', row]);
    const stakeJson = readdirSync(join(docs, 'data')).find((name) => /^stake\.[0-9a-f]+\.json$/.test(name));
    const walk = (value) => {
      if (typeof value === 'string') texts.push([stakeJson, value]);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(read(`data/${stakeJson}`)));
    // pipeline/crosswalk/checks.py holds the rule; it prints only where a copy is, never the text.
    const script = `import json, sys
sys.path.insert(0, sys.argv[1])
from crosswalk import checks
payload = json.load(sys.stdin)
known = checks._all_descriptors()
grams = checks.descriptor_grams(t for code in payload["codes"] for t in known.get(code, ()))
print(json.dumps(sorted({where for where, text in payload["texts"] if checks.copies_descriptor(text, grams)})))`;
    const hits = JSON.parse(execFileSync('python3', ['-I', '-c', script, join(repo, 'pipeline')], {
      input: JSON.stringify({ codes, texts }), encoding: 'utf8', maxBuffer: 1 << 26,
    }));
    assert.deepEqual(hits, []);
  });
});

describe('alternative family label', () => {
  test('built from what selects the family, like the card labels, and worded as the workbook says it', () => {
    const f = (when) => ({ condition: 'lung cancer', when });
    assert.equal(alternativeLabel(f(null)), 'alternative family (depends on diagnosis)');
    assert.equal(alternativeLabel(f({ dx: 'lung cancer', variant: null })), 'alternative family (depends on diagnosis)');
    assert.equal(alternativeLabel(f({ dx: null, variant: 'open' })), 'alternative family (depends on operation variant)');
    assert.equal(alternativeLabel(f({ dx: 'lung cancer', variant: 'open' })), 'alternative family (depends on diagnosis and operation variant)');
    const flags = JSON.parse(execFileSync('python3', ['-c', `import json, sys
sys.path.insert(0, sys.argv[1])
from crosswalk import workbook
print(json.dumps(workbook.ALT_FLAG))`, join(repo, 'pipeline')], { encoding: 'utf8' }));
    for (const [kind, when] of [['dx', { dx: 'x', variant: null }], ['variant', { dx: null, variant: 'y' }], ['both', { dx: 'x', variant: 'y' }]]) {
      assert.equal(flags[kind].toLowerCase(), alternativeLabel(f(when)), kind);
    }
  });
});

describe('crosswalk removal dates against the site history', () => {
  const data = {
    periods: [{ d: '2021-01-01' }, { d: '2022-01-01' }, { d: '2026-01-01' }, { d: '2027-01-01' }],
    codes: { A: { events: [[0, 'r', 'C'], [1, 't', 'C'], [3, 'r', 'J1']] }, B: { events: [[2, 'r', 'J1']] }, C: { events: [[0, 'l', 'C']] } },
  };
  const model = (removed) => ({ codes: Object.fromEntries(Object.entries(removed).map(([code, date]) => [code, { removed: date }])) });
  test('a crosswalk that matches the history passes', () => {
    assert.deepEqual(removalMismatches(model({ A: '2027-01-01', B: '2026-01-01' }), data), []);
  });
  test('a moved or missing removal is reported with both dates', () => {
    assert.deepEqual(removalMismatches(model({ A: '2026-01-01', B: '2026-01-01', C: '2027-01-01' }), data), [
      { code: 'A', crosswalk: '2026-01-01', history: '2027-01-01' },
      { code: 'C', crosswalk: '2027-01-01', history: null },
    ]);
  });
});

describe('outbound links', () => {
  test('out() takes an optional class and is unchanged without one', () => {
    assert.equal(out('https://x.test/?a=1&b=2', 'Agree', 'btn btn--quiet'),
      '<a class="btn btn--quiet" href="https://x.test/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Agree<span class="sr"> (opens in a new tab)</span></a>');
    assert.equal(out('https://x.test/', 'X'), '<a href="https://x.test/" target="_blank" rel="noopener noreferrer">X<span class="sr"> (opens in a new tab)</span></a>');
  });

  test('every name stake-client.mjs imports is exported by its module', async () => {
    const text = readFileSync(join(here, '..', 'src', 'stake-client.mjs'), 'utf8');
    for (const [, names, from] of text.matchAll(/import \{([^}]+)\} from '([^']+)';/g)) {
      const mod = await import(join(here, '..', 'src', from));
      for (const name of names.split(',').map((n) => n.trim()).filter(Boolean)) assert.ok(name in mod, `${from} does not export ${name}`);
    }
  });
});

describe('review form links', () => {
  test('agree, wrong and claim encode every value', () => {
    const summary = 'PCS 0BTC0ZZ (+4 alt) | DRG 163-165 (lung cancer & more?)';
    for (const make of [agreeHref, wrongHref]) {
      const href = make('32480', 'ffeec187', summary);
      const url = new URL(href);
      assert.equal(url.searchParams.get(REVIEW_ENTRY.code), '32480');
      assert.equal(url.searchParams.get(REVIEW_ENTRY.mapping), `ffeec187 ${summary}`);
      assert.ok(!/[ |&?]/.test(href.split(`${REVIEW_ENTRY.mapping}=`)[1]), 'raw reserved characters in the mapping value');
    }
    assert.notEqual(new URL(agreeHref('1', 'a', 'b')).pathname, new URL(wrongHref('1', 'a', 'b')).pathname);
    const long = new URL(agreeHref('32480', 'ffeec187', 'x'.repeat(400))).searchParams.get(REVIEW_ENTRY.mapping);
    assert.equal(long.length, 200);
    assert.equal(new URL(claimHref('abdomen-1')).searchParams.get(REVIEW_ENTRY.code), 'abdomen-1');
  });
});
