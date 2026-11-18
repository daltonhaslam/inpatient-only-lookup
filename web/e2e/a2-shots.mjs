// Screenshots of the approved mockup A2, the "before" for the review list's A2 departures:
//   node e2e/a2-shots.mjs [outdir]   (a2.html is local-only, in planning-docs/; output is gitignored)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// planning-docs/ is local-only, so it lives in the main checkout, not in a worktree: find that checkout
// through git's shared directory (the same from the main checkout and from any worktree). A2_HTML wins.
function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim();
    return dirname(common);
  } catch {
    return join(here, '..', '..');
  }
}
const mockup = process.env.A2_HTML || join(mainCheckout(), 'planning-docs/mockups/2026-11-18-teaching/a2.html');
if (!existsSync(mockup)) { console.error(`No mockup at ${mockup}; set A2_HTML.`); process.exit(2); }
const outDir = process.argv[2] || join(here, 'screenshots', 'a2');
mkdirSync(outDir, { recursive: true });
const browser = await launch();
for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 900 }, phone: { width: 400, height: 860 } })) {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport, colorScheme: scheme, deviceScaleFactor: name === 'phone' ? 2 : 1 });
    await page.goto(pathToFileURL(mockup).href);
    await page.locator('.stake-head').screenshot({ path: `${outDir}/a2-head-${name}-${scheme}.png` });
    await page.locator('article.scard').screenshot({ path: `${outDir}/a2-card-${name}-${scheme}.png` });
    await page.close();
  }
}
await browser.close();
console.log(`screenshots in ${outDir}`);
