// National mode must not drift: the Revenue at stake pages, every code page, the browser's cards and
// the existing downloads stay exactly as they were before the hospital view (Review Focus 5).
// The test builds the site into a temp directory and compares hashes with national-snapshot.json,
// which was written from the build before the hospital view existed (commit 47018f0).
// Normalized, and only these: the hashed names of the site's own CSS and JS bundles, whose contents
// legitimately change, and the empty hospital-picker mount on /revenue-at-stake/ (stake.mjs PICK_MOUNT).
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

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const SNAPSHOT = join(here, 'national-snapshot.json');
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** The two differences national mode may have from the base build, and nothing else. */
export const normalize = (html) => html
  .replace(/\/assets\/(app|stake|site)\.[0-9a-f]{10}\.(js|css)/g, '/assets/$1.$2')
  .replace(/\n<div class="hpick" data-hospital-pick><\/div>/g, '');

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
  const codePages = createHash('sha256');
  for (const code of codes) codePages.update(`${code}\n${normalize(readFileSync(join(dir, 'code', code, 'index.html'), 'utf8'))}\n`);
  const stakeFile = readdirSync(join(dir, 'data')).find((name) => /^stake\.[0-9a-f]{10}\.json$/.test(name));
  const doc = JSON.parse(readFileSync(join(dir, 'data', stakeFile), 'utf8'));
  // The browser's cards: stake-client.mjs draws card(item, model.meta, {detail: false}) for each item.
  const cards = prepare(doc).items.map((item) => card(item, doc.meta, { detail: false })).join('\n');
  return {
    'revenue-at-stake/index.html': page('revenue-at-stake/index.html'),
    'revenue-at-stake/help-review/index.html': page('revenue-at-stake/help-review/index.html'),
    'revenue-at-stake/methods/index.html': page('revenue-at-stake/methods/index.html'),
    'index.html': page('index.html'),
    [`code/*/index.html (${codes.length} pages)`]: codePages.digest('hex'),
    [`data/${stakeFile}`]: sha(readFileSync(join(dir, 'data', stakeFile))),
    'data/revenue-at-stake.csv': sha(readFileSync(join(dir, 'data/revenue-at-stake.csv'))),
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
