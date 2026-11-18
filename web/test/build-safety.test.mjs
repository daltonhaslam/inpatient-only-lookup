// The build empties OUT_DIR before writing, so it refuses an OUT_DIR that is not safely a build output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const build = (outDir) => spawnSync(process.execPath, ['build.mjs'], { cwd: web, env: { ...process.env, OUT_DIR: outDir, BUILD_DATE: '2026-11-11' }, encoding: 'utf8' });

test('OUT_DIR: the repository, web/, a parent of them, or an existing non-build directory is refused before anything is deleted', () => {
  for (const dir of [repo, web, dirname(repo), join(repo, 'pipeline')]) {
    const run = build(dir);
    assert.notEqual(run.status, 0, dir);
    assert.match(run.stderr, /Refusing OUT_DIR=/, dir);
    assert.ok(existsSync(join(repo, 'pipeline', 'derived')), 'nothing deleted');
  }
});

test('OUT_DIR: a directory under the temp dir is built, and marked as a build output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iol-out-'));
  try {
    const run = build(dir);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(dir, '.iol-build-output')));
    assert.ok(existsSync(join(dir, 'index.html')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
