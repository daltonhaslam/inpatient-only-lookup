// Screenshots for design review: node e2e/shot.mjs <outdir> [path ...]
import { launch } from './browser.mjs';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';

const [outDir, ...paths] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launch();
const views = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
for (const [name, viewport] of Object.entries(views)) {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: name === 'phone' ? 2 : 1 });
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text()); });
    page.on('pageerror', (error) => console.log('page error:', error.message));
    for (const path of paths.length ? paths : ['/']) {
      await page.goto(base + path, { waitUntil: 'networkidle' });
      const slug = path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
      await page.screenshot({ path: `${outDir}/${slug}-${name}-${scheme}.png`, fullPage: !process.env.FOLD });
    }
    await context.close();
  }
}
await browser.close();
server.close();
