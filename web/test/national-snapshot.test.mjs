// National mode must not drift: the Revenue at stake pages, every code page, the browser's cards and
// the existing downloads stay exactly as they were before the hospital view (Review Focus 5).
// The test builds the site into a temp directory and compares hashes with national-snapshot.json,
// which was written from the build before the hospital view existed (commit 47018f0).
// Normalized, and only these: the hashed names of the site's own CSS and JS bundles, whose contents
// legitimately change, and the hospital picker's mount on /revenue-at-stake/: exactly stake.mjs PICK_MOUNT,
// its labeled box included (ruling A1). The main page's download links also carry their two labels
// (data-national-label, data-hospital-label: the A52 relabel); that hash was updated for them, 2026-11-19.
//   UPDATE_SNAPSHOT=1 node --test test/national-snapshot.test.mjs   rewrite the snapshot (a deliberate
//   change to national output only, such as a new CSV column; say why in the commit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { card } from '../src/stake-card.mjs';
import { prepare } from '../src/stake-engine.mjs';
import { PICK_MOUNT } from '../src/stake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const SNAPSHOT = join(here, 'national-snapshot.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** The differences national mode may have from the base build on any page: bundle hashes and the picker mount. */
export const normalize = (html) => html
  .replace(/\/assets\/(app|stake|site)\.[0-9a-f]{10}\.(js|css)/g, '/assets/$1.$2')
  .split(`\n${PICK_MOUNT}`).join('');

// The two deliberate additions to a compared code's Revenue at stake block (Task 4), each in its one
// exact place: the patient-share line between the card and the links line, and the hospital link at the
// start of that links line. Stripped so the code-page hash stays pinned to the base build (anything else
// that changes on 1,861 pages still fails); their own text is pinned under a separate key below.
const SHARE = /\n<p class="stake-block__share"><strong>Patient’s share, national:<\/strong> [^<\n]*(?:<strong>more at a surgery center<\/strong>[^<\n]*)?<\/p>(?=\n<p class="stake-block__more">)/g;
const LINK = /(?<=<p class="stake-block__more">)<a href="\/revenue-at-stake\/\?q=([0-9A-Z]{5})">See this at your hospital →<\/a> <span aria-hidden="true">\/<\/span> /g;

/** A code page without the two additions, and what was stripped; throws unless each is there exactly once on a compared code's page and nowhere else. */
function stripAdditions(code, html, compared) {
  const shares = html.match(SHARE) || [];
  const links = [...html.matchAll(LINK)];
  const want = compared ? 1 : 0;
  if (shares.length !== want || links.length !== want) throw new Error(`code ${code}: ${shares.length} share lines and ${links.length} hospital links, expected ${want} each`);
  if (links.length && links[0][1] !== code) throw new Error(`code ${code}: the hospital link points at ${links[0][1]}`);
  return { html: html.replace(SHARE, '').replace(LINK, ''), added: [...shares, ...links.map((m) => m[0])].join('') };
}

// The deliberate addition to the national CSV (Task 6): three patient-share columns at the end of every
// row (two amounts and true/false, or three empty cells; never a comma or quote inside them). Split off
// so the pinned CSV hash stays the base build's (every existing column and value byte-identical); the
// added columns are pinned under their own key below.
const SHARE_COLS = /,([^,\n]*),([^,\n]*),([^,\n]*)$/gm;

/** The national CSV without the three patient-share columns, and those columns; throws unless every row has exactly them. */
function splitShareColumns(text) {
  const lines = text.split('\n').filter(Boolean);
  if (!lines[0].endsWith(',opps_patient_share,asc_patient_share,asc_costs_patient_more')) throw new Error('CSV header does not end with the three patient-share columns');
  for (const line of lines.slice(1)) {
    if (!/,(?:\d+(?:\.\d{1,2})?,\d+(?:\.\d{1,2})?,(?:true|false)|,,)$/.test(line)) throw new Error(`CSV row has unexpected share columns: ${line.slice(0, 40)}…`);
  }
  return { base: text.replace(SHARE_COLS, ''), added: [...text.matchAll(SHARE_COLS)].map((m) => m[0]).join('\n') };
}

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'iol-national-'));
  const env = { ...process.env, OUT_DIR: dir, BUILD_DATE: '2026-11-11' };
  delete env.CROSSWALK_JSON;
  const run = spawnSync(process.execPath, ['build.mjs'], { cwd: web, env, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`build failed:\n${run.stderr}`);
  return dir;
}

function manifest(dir) {
  const page = (path) => sha(normalize(readFileSync(join(dir, path), 'utf8')));
  const codes = readdirSync(join(dir, 'code')).sort();
  const stakeFile = readdirSync(join(dir, 'data')).find((name) => /^stake\.[0-9a-f]{10}\.json$/.test(name));
  const doc = JSON.parse(readFileSync(join(dir, 'data', stakeFile), 'utf8'));
  const compared = new Set(prepare(doc).items.filter((item) => item.kind === 'compare').map((item) => item.code));
  const codePages = createHash('sha256');
  const additions = createHash('sha256');
  for (const code of codes) {
    const { html, added } = stripAdditions(code, normalize(readFileSync(join(dir, 'code', code, 'index.html'), 'utf8')), compared.has(code));
    codePages.update(`${code}\n${html}\n`);
    if (added) additions.update(`${code}\n${added}\n`);
  }
  // The browser's cards: stake-client.mjs draws card(item, model.meta, {detail: false}) for each item.
  const cards = prepare(doc).items.map((item) => card(item, doc.meta, { detail: false })).join('\n');
  const csvFile = splitShareColumns(readFileSync(join(dir, 'data/revenue-at-stake.csv'), 'utf8'));
  return {
    'revenue-at-stake/index.html': page('revenue-at-stake/index.html'),
    'revenue-at-stake/help-review/index.html': page('revenue-at-stake/help-review/index.html'),
    'revenue-at-stake/methods/index.html': page('revenue-at-stake/methods/index.html'),
    'index.html': page('index.html'),
    [`code/*/index.html (${codes.length} pages)`]: codePages.digest('hex'),
    [`code pages: share line and hospital link (${compared.size} compared codes)`]: additions.digest('hex'),
    [`data/${stakeFile}`]: sha(readFileSync(join(dir, 'data', stakeFile))),
    'data/revenue-at-stake.csv': sha(csvFile.base),
    'data/revenue-at-stake.csv: patient-share columns (opps, asc, asc more)': sha(csvFile.added),
    'data/revenue-at-stake.xlsx': sha(readFileSync(join(dir, 'data/revenue-at-stake.xlsx'))),
    'browser cards, national (stake-card.mjs card, detail off)': sha(cards),
  };
}

test('national mode: pages, code pages, browser cards and downloads match the pre-hospital build', { skip: !existsSync(join(web, '..', 'pipeline/derived/crosswalk.json')) && 'no crosswalk.json' }, () => {
  const dir = build();
  try {
    const actual = manifest(dir);
    if (process.env.UPDATE_SNAPSHOT) writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 1)}\n`);
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const changed = Object.keys({ ...expected, ...actual }).filter((key) => expected[key] !== actual[key]);
    assert.deepEqual(changed, [], `national output changed: ${changed.join('; ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
