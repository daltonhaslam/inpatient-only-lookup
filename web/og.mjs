// Draws the social-share image (web/static/og.png) from the built site's fonts and data.
//   node og.mjs      (after node build.mjs)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './e2e/browser.mjs';
import { periodIndex, spanAt } from './src/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '..', 'docs');
const font = (prefix) => {
  const file = readdirSync(join(docs, 'fonts')).find((name) => name.startsWith(prefix));
  return `data:font/woff2;base64,${readFileSync(join(docs, 'fonts', file)).toString('base64')}`;
};
const dataFile = readdirSync(join(docs, 'data')).find((name) => name.startsWith('ipo.'));
const data = JSON.parse(readFileSync(join(docs, 'data', dataFile), 'utf8'));

// One strip of squares per year, 2020 to the last year on file: the list emptying, refilling, emptying.
const codes = Object.keys(data.codes).sort();
const rows = [];
for (let year = 2020; year <= Number(data.dosMax.slice(0, 4)); year += 1) {
  const index = periodIndex(data, `${year}-01-01`);
  const cells = codes.filter((_, i) => i % 14 === 0).map((code) => {
    const span = spanAt(data.codes[code], index);
    const si = span ? span[1] : '';
    return `<i class="${si === 'C' ? 'on' : si === '' || si === 'D' ? 'gone' : 'off'}"></i>`;
  }).join('');
  rows.push(`<div class="row"><b>${year}</b><div class="cells">${cells}</div></div>`);
}

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Besley;src:url(${font('besley')}) format('woff2');font-weight:400 900}
@font-face{font-family:Archivo;src:url(${font('archivo')}) format('woff2');font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#fbfcfb;color:#14221f;font-family:Archivo;padding:54px 64px;display:flex;flex-direction:column;justify-content:space-between}
h1{font:650 68px/1.05 Besley;letter-spacing:-0.012em;max-width:900px}
p{font:500 26px/1.35 Archivo;color:#4a615c;margin-top:16px;max-width:940px}
.row{display:flex;align-items:center;gap:14px;margin-top:6px}
.row b{font:600 17px/1 Archivo;color:#4a615c;width:44px;font-variant-numeric:tabular-nums}
.cells{display:flex;gap:2.5px;flex:1}
i{flex:1;height:17px;border-radius:2px}
.on{background:#108a78}.off{border:1.5px solid #8ea19c}.gone{background:transparent}
footer{display:flex;justify-content:space-between;font:600 22px/1 Archivo;margin-top:18px}
footer span:last-child{color:#4a615c;font-weight:500}
</style><div><h1>Was it inpatient only on that date?</h1><p>Medicare’s inpatient-only list, code by code and day by day: what left, what came back, what is still exempt from review.</p></div>
<div>${rows.join('')}<footer><span>Inpatient Only Lookup</span><span>inpatient-only-lookup.vercel.app</span></footer></div>`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(here, 'static', 'og.png') });
await browser.close();
console.log('wrote static/og.png');
