// Screenshots of the hospital view for design review: node e2e/hospital-shots.mjs <outdir>
// National landing, the open picker, OHSU picked (with 32480's card), a hospital with no add-ons,
// at 1280 and 400 px, light and dark. The folder is gitignored (e2e/screenshots/).
import { mkdirSync } from 'node:fs';
import { launch } from './browser.mjs';
import { serve } from './serve.mjs';

const outDir = process.argv[2] || new URL('./screenshots/hospital', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const views = { desktop: { width: 1280, height: 900 }, phone: { width: 400, height: 860 } };
const pick = async (page, query, ccn) => {
  await page.locator('#hp-q').fill(query);
  await page.locator(`#hp-o-${ccn}`).click();
  await page.waitForSelector('.hsum, .hpick__on');
};
const head = (page) => page.locator('.stake-head');
for (const [name, viewport] of Object.entries(views)) {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: name === 'phone' ? 2 : 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
    page.on('pageerror', (e) => console.log('page error:', e.message));
    const shot = (slug, locator) => (locator || page).screenshot({ path: `${outDir}/${slug}-${name}-${scheme}.png`, ...(locator ? {} : { fullPage: false }) });
    await page.goto(`${base}/revenue-at-stake/`);
    await page.waitForSelector('#hp-q');
    await shot('1-national', head(page));
    await page.locator('#hp-q').fill('providence');
    await page.waitForSelector('#hp-list [role="option"]');
    await shot('2-picker-open');
    await page.locator('#hp-q').fill('meritus');
    await page.waitForFunction(() => document.querySelector('#hp-note').textContent.includes('Maryland'));
    await shot('3-maryland', head(page));
    await pick(page, 'ohsu', '380009');
    await shot('4-ohsu-head', head(page));
    await page.locator('#sf-q').fill('32480');
    await page.waitForFunction(() => document.querySelectorAll('[data-results] [data-stake-card]').length === 1);
    await shot('5-ohsu-32480', page.locator('[data-stake-card="32480"]'));
    for (const kind of ['split', 'year']) await page.locator(`[data-stake-card="32480"] [data-fold="${kind}"] > summary`).click();
    await shot('8-ohsu-folds-open', page.locator('[data-stake-card="32480"]'));
    await page.locator('[data-count="165:trad"]').fill('10');
    await page.locator('[data-count="164:trad"]').fill('');
    await shot('9-ohsu-counts-edited', page.locator('[data-stake-card="32480"] [data-fold="year"]'));
    await page.locator('#sf-q').fill('19305');
    await page.waitForFunction(() => document.querySelector('[data-results] [data-stake-card="19305"]'));
    const two = page.locator('[data-stake-card="19305"]');
    await two.locator('[data-fold="split"] > summary').click();
    await shot('10-ohsu-two-family', two);
    await page.locator('[data-hpick-change]').click();
    await pick(page, 'arizona spine', '030107');
    await page.locator('#sf-q').fill('32480');
    await page.waitForFunction(() => document.querySelectorAll('[data-results] [data-stake-card]').length === 1);
    await shot('6-no-addons-head', head(page));
    await shot('7-no-addons-32480', page.locator('[data-stake-card="32480"]'));
    await context.close();
  }
}
await browser.close();
server.close();
console.log(`screenshots in ${outDir}`);
