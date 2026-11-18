// End-to-end smoke test: node e2e/smoke.mjs   (exits non-zero if any check fails)
// Serves docs/ locally and drives the cached Chromium. No test framework.
// BASE_URL=https://example.com node e2e/smoke.mjs   runs the same checks against a deployed site instead.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { launch } from './browser.mjs';
import { serve } from './serve.mjs';
import { formatDate, outsideRangeNote, unreadDateNote } from '../src/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const AXE = join(here, '..', 'node_modules', 'axe-core', 'axe.min.js');
const LIVE = process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : null;
if (!LIVE && !existsSync(join(here, '..', '..', 'docs', 'index.html'))) {
  console.error('docs/ is not built. Run: cd web && BUILD_DATE=2026-11-11 node build.mjs');
  process.exit(2);
}

const server = LIVE ? null : await serve();
const base = LIVE || `http://127.0.0.1:${server.address().port}`;
const browser = await launch();

let passed = 0;
let skipped = 0;
const failures = [];
const problems = []; // console errors and page errors, in order
let ignore404 = false;

async function newContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  // Test runs must not send page views to the live site's analytics (the local stub serves the same empty script).
  await context.route('**/_vercel/insights/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  if (options.javaScriptEnabled !== false) await context.clock.setFixedTime(new Date('2026-11-11T12:00:00'));
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (ignore404 && /status of 404/.test(message.text())) return;
      problems.push(`console error on ${page.url()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`page error on ${page.url()}: ${error.message}`));
  });
  return context;
}

/** Run one check in a fresh context; any console/page error during it fails the check. */
async function check(name, fn, options = {}) {
  const before = problems.length;
  const context = await newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  try {
    const outcome = await fn(page, context);
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/page errors:\n    ${fresh.join('\n    ')}`);
    if (outcome && outcome.skip) { skipped += 1; console.log(`– skipped: ${outcome.skip}`); } else { passed += 1; console.log(`✓ ${name}`); }
  } catch (error) {
    failures.push(name);
    console.log(`✗ ${name}\n    ${String(error.message || error).split('\n').join('\n    ')}`);
  } finally {
    await context.close();
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eq = (actual, expected, what) => assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const has = (actual, part, what) => assert(String(actual).includes(part), `${what}: expected to include ${JSON.stringify(part)}, got ${JSON.stringify(String(actual).slice(0, 300))}`);

async function open(page, path) {
  await page.goto(base + path);
  await page.waitForSelector('html.live', { timeout: 20000 }).catch(() => { throw new Error(`${path}: page never went live (html.live)`); });
}
const answer = (page, scope = '') => page.locator(`${scope} .verdict__answer`.trim()).first();
/** Wait until a locator's text satisfies a test, then return it (or throw with the last text). */
async function waitText(locator, test, what) {
  let last = '';
  for (let i = 0; i < 60; i += 1) {
    last = ((await locator.textContent().catch(() => '')) || '').trim();
    if (test(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: last text was ${JSON.stringify(last)}`);
}
async function setDate(page, iso) {
  const input = page.locator('[data-dos]').first();
  await input.fill(iso);
  await input.dispatchEvent('change');
}

// ---- home ---------------------------------------------------------------------------------

await check('home: typing a code, changing the date, searching by name, opening a row', async (page) => {
  await open(page, '/');
  await page.fill('[data-q]', '27447');
  const first = await waitText(answer(page), (t) => /inpatient only on/i.test(t), 'verdict for 27447');
  has(first, 'inpatient only on', 'answer');

  await setDate(page, '2021-03-03');
  eq(await waitText(answer(page), (t) => t.includes('March 3, 2021'), 'answer after date change'), 'Not inpatient only on March 3, 2021.', 'answer');
  // The address bar follows a moment later (history writes are debounced).
  await page.waitForURL(/dos=2021-03-03/, { timeout: 3000 });

  await page.fill('[data-q]', 'hip replacement');
  const row = page.locator('[data-results] [data-row="27130"]');
  await row.waitFor();
  assert(await row.locator('.chip').count() === 1, 'row 27130 has no status chip');
  assert((await row.locator('.chip').textContent()).trim().length > 0, 'status chip is empty');
  await row.click();
  await page.waitForURL('**/code/27130/**');
  await page.waitForSelector('html.live');
  await page.waitForFunction(() => document.querySelector('[data-dos]').value === '2021-03-03');
  eq(await page.inputValue('[data-dos]'), '2021-03-03', 'date input on the code page');
});

await check('home: a code inside a longer query is still a code lookup', async (page) => {
  await open(page, '/');
  for (const query of ['CPT 27447', '27447-RT', 'knee 27447', ' 27447 ']) {
    await page.fill('[data-q]', query);
    await waitText(page.locator('[data-results] .verdict__code'), (t) => t === '27447', `code shown for ${JSON.stringify(query)}`);
  }
});

await check('date field: typing a year digit by digit does not jump; an out-of-range date snaps on leaving', async (page) => {
  await open(page, '/code/27447/');
  const input = page.locator('[data-dos]').first();
  const shown = () => page.locator('.verdict__answer').first().textContent();
  const before = await shown();
  // What Chrome reports while "2021" is typed into the year: 0002, 0020, 0202, then 2021.
  for (const partial of ['0002-03-03', '0020-03-03', '0202-03-03']) {
    await input.fill(partial);
    await input.dispatchEvent('change');
    eq(await input.inputValue(), partial, 'field left alone while typing');
    eq(await shown(), before, 'answer unchanged while typing');
  }
  await input.fill('2021-03-03');
  await input.dispatchEvent('change');
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('March 3, 2021'), 'answer after a full date');
  await input.fill('2031-05-05');
  await input.dispatchEvent('change');
  await input.blur();
  const dosMax = await input.getAttribute('max');
  eq(await input.inputValue(), dosMax, 'out-of-range date snaps to the last date answered');
  await input.fill('0202-03-03');
  await input.dispatchEvent('change');
  await input.blur();
  eq(await input.inputValue(), dosMax, 'a half-typed year is dropped, not acted on');
});

await check('a date carried from another page is written into the address bar', async (page) => {
  await open(page, '/?dos=2021-03-03');
  await page.waitForURL(/dos=2021-03-03/);
  await open(page, '/code/27130/');
  await page.waitForURL(/\/code\/27130\/\?dos=2021-03-03/, { timeout: 3000 });
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('March 3, 2021'), 'answer on the carried date');
});

await check('touch: a vertical swipe over the timeline scrolls and leaves the date alone; a tap sets it', async (page) => {
  await open(page, '/code/27132/?dos=2026-02-01');
  const track = page.locator('[data-track]').first();
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height / 2;
  const fire = (type, cx, cy) => page.evaluate(([t, px, py]) => {
    document.querySelector('[data-track]').dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: px, clientY: py, button: 0 }));
  }, [type, cx, cy]);
  await fire('pointerdown', x, y);
  await fire('pointermove', x + 2, y + 30);
  await fire('pointercancel', x + 2, y + 60);
  eq(await page.locator('[data-dos]').first().inputValue(), '2026-02-01', 'date after a vertical swipe');
  await fire('pointerdown', x, y);
  await fire('pointerup', x, y);
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('2022'), 'answer after a tap in 2022');
});

await check('scheduled dates are marked once, beside the date', async (page) => {
  await open(page, '/');
  // The date answered from a final rule, if the data has one (it goes away when CMS posts the January file).
  const scheduled = await page.evaluate(async () => {
    const data = await (await fetch(document.body.dataset.ipo)).json();
    const period = data.periods.find((p) => p.basis === 'f');
    return period ? period.d : null;
  });
  if (!scheduled) return { skip: 'no scheduled period in the data' };
  await open(page, `/?q=99213&dos=${scheduled}`);
  const banner = page.locator('[data-scheduled]').first();
  await waitText(banner, (t) => t.startsWith('Scheduled'), 'scheduled banner');
  assert(await banner.isVisible(), 'scheduled banner is not visible');
  eq(await page.locator('body').evaluate((body) => (body.innerText.match(/Scheduled\. This comes from/g) || []).length), 1, 'scheduled caution appears once');
  await setDate(page, '2026-06-01');
  await page.waitForFunction(() => document.querySelector('[data-scheduled]').hidden);
});

await check('several codes in the search box point to the bulk check; a late click keeps the date', async (page) => {
  await open(page, '/');
  await page.fill('[data-q]', '27447 vs 27130');
  await waitText(page.locator('[data-results]'), (t) => t.includes('2 codes'), 'hint for two codes');
  await waitText(page.locator('[data-results] .verdict__code'), (t) => t === '27447', 'verdict for the first code');
  await page.fill('[data-q]', 'hip replacement');
  await page.locator('[data-results] [data-row="27130"]').waitFor();
  await setDate(page, '2021-03-03');
  await page.locator('[data-results] [data-row="27130"]').click();   // inside the URL debounce
  await page.waitForURL('**/code/27130/**');
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('March 3, 2021'), 'date carried by an immediate click');
});

await check('back with nothing stored: the date in the address wins', async (page) => {
  await open(page, '/');
  await page.evaluate(() => sessionStorage.clear());
  await open(page, '/code/27130/?dos=2021-03-03');
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('March 3, 2021'), 'answer on the linked date');
  await open(page, '/methods/');
  await page.evaluate(() => sessionStorage.clear());
  await page.goBack();
  await page.waitForSelector('html.live');
  await waitText(page.locator('.verdict__answer').first(), (t) => t.includes('March 3, 2021'), 'answer after going back');
});

await check('home: Today button resets the date, then hides', async (page) => {
  await open(page, '/');
  const today = page.locator('[data-today]').first();
  assert(await today.isHidden(), 'Today is visible while the date is today');
  await setDate(page, '2021-03-03');
  await today.waitFor({ state: 'visible' });
  await today.click();
  await page.waitForFunction(() => document.querySelector('[data-dos]').value === '2026-11-11');
  eq(await page.inputValue('[data-dos]'), '2026-11-11', 'date after Today');
  assert(await today.isHidden(), 'Today did not hide after reset');
  assert(!page.url().includes('dos='), `URL still carries dos: ${page.url()}`);
});

await check('bulk check on a scheduled date carries the Scheduled note', async (page) => {
  await open(page, '/');
  const scheduled = await page.evaluate(async () => {
    const period = (await (await fetch(document.body.dataset.ipo)).json()).periods.find((p) => p.basis === 'f');
    return period ? period.d : null;
  });
  if (!scheduled) return { skip: 'no scheduled period in the data' };
  await open(page, `/?dos=${scheduled}`);
  await page.fill('[data-bulk-input]', '27130 27447');
  await page.click('[data-bulk] button[type="submit"]');
  await waitText(page.locator('[data-bulk-out]'), (t) => t.includes('Scheduled'), 'scheduled note in the bulk output');
});

await check('home: a never-listed code and a nonsense code', async (page) => {
  await open(page, '/');
  await page.fill('[data-q]', '99213');
  await waitText(page.locator('[data-results]'), (t) => t.includes('has not been on the inpatient-only list'), '99213 result');
  await page.fill('[data-q]', '0000Z');
  await waitText(page.locator('[data-results]'), (t) => t.includes('No record of'), '0000Z result');
});

await check('home: bulk check table and CSV download', async (page) => {
  await open(page, '/');
  await page.fill('[data-bulk-input]', '27130, 27447 22630\n99213 0000Z');
  await page.click('[data-bulk] button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-bulk-out] table tbody tr').length === 5);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download as CSV' }).click()]);
  const stream = await download.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;
  const lines = text.split('\n').filter((line) => line.trim());
  eq(lines.length, 6, `CSV line count (header + 5); text was:\n${text}`);
  has(download.suggestedFilename(), '.csv', 'download name');
});

await check('home: whole-list count follows the date', async (page) => {
  await open(page, '/');
  await setDate(page, '2026-11-11');
  eq(await waitText(page.locator('[data-count="total"]'), (t) => t === '1,448', 'total on 2026-11-11'), '1,448', 'total on 2026-11-11');
  await setDate(page, '2021-03-03');
  eq(await waitText(page.locator('[data-count="total"]'), (t) => t === '1,438', 'total on 2021-03-03'), '1,438', 'total on 2021-03-03');
});

await check('date field: a typed date outside the range is named beside the field until an in-range date replaces it', async (page) => {
  await open(page, '/code/27447/');
  const input = page.locator('[data-dos]').first();
  const note = page.locator('[data-dos-note]');
  const [min, max] = [await input.getAttribute('min'), await input.getAttribute('max')];
  assert(await note.isHidden(), 'note shown before anything was typed');
  await input.fill('2019-03-03');
  await input.dispatchEvent('change');
  await input.blur();
  await note.waitFor({ state: 'visible' });
  eq(await note.textContent(), outsideRangeNote({ dosMin: min, dosMax: max }, '2019-03-03', min), 'note');
  eq(await input.inputValue(), min, 'field shows the date answered');
  eq(await input.getAttribute('aria-describedby'), await note.getAttribute('id'), 'field is described by the note');
  await waitText(answer(page), (t) => t.includes(formatDate(min)), 'answer for the first date covered');
  await input.fill('2031-05-05');
  await input.dispatchEvent('change');
  await input.blur();
  await waitText(note, (t) => t === outsideRangeNote({ dosMin: min, dosMax: max }, '2031-05-05', max), 'note after a date past the range');
  await setDate(page, '2021-03-03');
  await note.waitFor({ state: 'hidden' });
  eq(await input.getAttribute('aria-describedby'), null, 'description removed with the note');
});

await check('a link with a date outside the range moves to the nearest date covered and says so', async (page, context) => {
  await open(page, '/code/27447/?dos=2019-03-03');
  const input = page.locator('[data-dos]').first();
  const note = page.locator('[data-dos-note]');
  const [min, max] = [await input.getAttribute('min'), await input.getAttribute('max')];
  await note.waitFor({ state: 'visible' });
  eq(await note.textContent(), outsideRangeNote({ dosMin: min, dosMax: max }, '2019-03-03', min), 'note');
  eq(await input.inputValue(), min, 'field shows the first date covered');
  eq(await input.getAttribute('aria-describedby'), await note.getAttribute('id'), 'field is described by the note');
  await waitText(answer(page), (t) => t.includes(formatDate(min)), 'answer for the first date covered');
  await page.waitForURL(new RegExp(`dos=${min}`), { timeout: 3000 });
  await waitText(page.locator('[data-announce]'), (t) => t.startsWith('March 3, 2019 is outside'), 'status line');
  await open(page, '/?q=27447&dos=2031-05-05');
  await waitText(page.locator('[data-dos-note]'), (t) => t === outsideRangeNote({ dosMin: min, dosMax: max }, '2031-05-05', max), 'note past the range');
  eq(await page.locator('[data-dos]').first().inputValue(), max, 'field shows the last date covered');
  await waitText(page.locator('[data-announce]'), (t) => t.startsWith('May 5, 2031 is outside') && t.includes('27447: '), 'status line with the answer');
  // A click on the timeline before the range moves the date to the first date covered; the old note
  // ("Showing December 31, 2027") must not stay behind.
  await open(page, '/code/27447/?dos=2031-05-05');
  await page.locator('[data-dos-note]').waitFor({ state: 'visible' });
  const track = page.locator('[data-track]').first();
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height / 2);   // about mid-2018 on the 2017-2029 axis
  await page.waitForFunction((first) => document.querySelector('[data-dos]').value === first, min);
  const left = page.locator('[data-dos-note]');
  assert(await left.isHidden() || (await left.textContent()).endsWith(`Showing ${formatDate(min)}.`), `stale note: ${await left.textContent()}`);
  if (await left.isHidden()) eq(await input.getAttribute('aria-describedby'), null, 'description removed with the note');
  // A malformed date falls back as before: to this tab's last choice, else today (a new tab has none).
  const tab = await context.newPage();
  await open(tab, '/?dos=not-a-date');
  await waitText(tab.locator('[data-dos-note]'), (t) => t === unreadDateNote('not-a-date', '2026-11-11'), 'note for a malformed date');
  eq(await tab.locator('[data-dos]').first().inputValue(), '2026-11-11', 'malformed date falls back to today');
});

await check('home: Enter in the search box submits, and the status line sums up the answer', async (page) => {
  await open(page, '/');
  assert(await page.locator('[data-ask] button[type="submit"]').isVisible(), 'submit button in the live search form');
  eq(await page.locator('[data-results]').getAttribute('aria-live'), null, 'results panel is not a live region');
  await page.fill('[data-q]', '27447');
  await waitText(answer(page), (t) => /inpatient only on/i.test(t), 'verdict for 27447');
  await page.locator('[data-q]').press('Enter');
  await page.waitForFunction(() => document.activeElement.matches('[data-results] .verdict__answer'));
  const head = (await answer(page).textContent()).trim();
  await waitText(page.locator('[data-announce]'), (t) => t === `27447: ${head}`, 'status line');
  // Typed and submitted in one go, before the results frame runs: Enter still lands on the new results.
  await page.evaluate(() => {
    const box = document.querySelector('[data-q]');
    box.value = 'hip replacement';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.form.requestSubmit();
  });
  eq(await page.evaluate(() => document.activeElement.matches('[data-results] .row')), true, 'focus on the first matching code');
  // Two codes: Enter lands on the note that says only the first is shown, and the status line says it first.
  await page.fill('[data-q]', '27447 27130');
  await waitText(page.locator('[data-results] .verdict__code'), (t) => t === '27447', 'verdict for the first of two codes');
  await page.locator('[data-q]').press('Enter');
  await page.waitForFunction(() => document.activeElement.matches('[data-results] > .results__none'));
  await waitText(page.locator('[data-announce]'), (t) => t.startsWith('That looks like 2 codes.') && t.endsWith(`27447: ${head}`), 'status line for two codes');
  // The same sentence again, after a real action, is said again.
  await page.fill('[data-q]', '27447');
  await waitText(page.locator('[data-announce]'), (t) => t === `27447: ${head}`, 'status line, back to 27447');
  await page.fill('[data-q]', '');
  await page.fill('[data-q]', '27447');
  await page.waitForFunction(() => document.querySelector('[data-announce]').textContent === '');
  await waitText(page.locator('[data-announce]'), (t) => t === `27447: ${head}`, 'status line said again');
  // An out-of-range date settles on leaving the field (Chromium does not submit from a date field on Enter),
  // and the status line leads with the note, then the answer for the date shown.
  const dos = page.locator('[data-ask] [data-dos]');
  await dos.fill('2019-03-03');
  await dos.blur();
  await page.locator('[data-dos-note]').waitFor({ state: 'visible' });
  await waitText(page.locator('[data-announce]'), (t) => t.startsWith('March 3, 2019 is outside') && t.includes('27447: '), 'status line with the note');
});

await check('home: a touch tap on a whole-list square stays on the page; other clicks open the code', async (page) => {
  await open(page, '/');
  const cell = page.locator('[data-cells] [data-cell]').first();
  const code = await cell.getAttribute('data-cell');
  const click = (pointerType) => cell.evaluate((node, type) => node.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType: type })), pointerType);
  await click('touch');
  await new Promise((r) => setTimeout(r, 400));
  eq(new URL(page.url()).pathname, '/', 'page after a touch tap');
  // Each click decides for itself: a click with no pointer (the kind a keyboard sends) right after a touch tap
  // still navigates. (The squares are aria-hidden and not focusable, so a real Enter cannot reach them.)
  await click('');
  await page.waitForURL(`**/code/${code}/**`);
  // Where a click has no pointerType (older Safari), a touch press on the same square just before counts;
  // a stale one does not.
  await open(page, '/');
  const press = (wait) => cell.evaluate(async (node, ms) => {
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await new Promise((r) => setTimeout(r, ms));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, wait);
  await press(0);
  await new Promise((r) => setTimeout(r, 400));
  eq(new URL(page.url()).pathname, '/', 'page after a touch tap without pointerType on the click');
  await press(900);
  await page.waitForURL(`**/code/${code}/**`);
  await open(page, '/');
  await cell.click();
  await page.waitForURL(`**/code/${code}/**`);
});

await check('forced colors: on-list marks stay filled and the not-in-the-files dot stays visible', async (page) => {
  const paint = (selector, pseudo = null, prop = 'backgroundColor') => page.evaluate(([s, p, k]) => {
    const node = document.querySelector(s);
    return node ? getComputedStyle(node, p)[k] : 'missing';
  }, [selector, pseudo, prop]);
  await open(page, '/');
  const canvas = await paint('body');
  for (const selector of ['.cellkey .cell--ipo', '.cells .cell--ipo']) {
    const fill = await paint(selector);
    assert(fill !== canvas && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'missing', `${selector} fill is ${fill} on a ${canvas} page`);
  }
  const dot = await paint('.cellkey .cell--gone', '::after', 'borderTopColor');
  assert(dot !== canvas && dot !== 'missing', `not-in-the-files dot is ${dot}`);
  await open(page, '/history/');
  const bar = await paint('.bar:not(.bar--sched)');
  assert(bar !== canvas && bar !== 'rgba(0, 0, 0, 0)', `history bar fill is ${bar}`);
  await open(page, '/code/27132/');
  const seg = await paint('.tl__seg--ipo');
  assert(seg !== canvas && seg !== 'rgba(0, 0, 0, 0)', `timeline segment fill is ${seg}`);
  const handle = await paint('.tl__mark', '::before');
  assert(handle !== canvas && handle !== 'rgba(0, 0, 0, 0)', `timeline date handle fill is ${handle}`);
}, { forcedColors: 'active' });

// ---- a code page --------------------------------------------------------------------------

await check('code page: range input by keyboard keeps focus', async (page) => {
  await open(page, '/code/27132/?dos=2026-02-01');
  eq(await waitText(answer(page), (t) => t.includes('2026'), 'answer'), 'Not inpatient only on February 1, 2026.', 'answer');
  await page.locator('[data-range]').focus();
  await page.keyboard.press('ArrowRight');
  eq(await waitText(answer(page), (t) => t.includes('February 2'), 'answer after ArrowRight'), 'Not inpatient only on February 2, 2026.', 'answer');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-range]'));
  assert(focused, 'focus left the range input after redraw');
});

await check('code page: timeline track press and drag', async (page) => {
  await open(page, '/code/27132/?dos=2026-02-01');
  await waitText(answer(page), (t) => t.includes('2026'), 'answer');
  await page.locator('[data-track]').scrollIntoViewIfNeeded();
  const box = await page.locator('[data-track]').boundingBox();
  const at = (share) => ({ x: box.x + box.width * share, y: box.y + box.height / 2 });
  const markDate = () => page.locator('[data-mark-date]').textContent();
  const start = at(0.45);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const afterPress = await waitText(answer(page), (t) => /2022/.test(t) || /2021/.test(t) || /2023/.test(t), 'answer after pressing the track at 45%');
  assert(/in 2022|, 2022\./.test(afterPress), `date after press at 45% is not in 2022: ${afterPress}`);
  has(afterPress, 'Inpatient only on', 'answer after press');
  const seen = new Set([await markDate()]);
  for (const share of [0.55, 0.62, 0.7, 0.8]) {
    const p = at(share);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForFunction((was) => document.querySelector('[data-mark-date]').textContent !== was, [...seen].pop());
    seen.add(await markDate());
  }
  await page.mouse.up();
  assert(seen.size === 5, `dragging produced ${seen.size} distinct dates, expected 5: ${[...seen].join(' | ')}`);
  eq(await waitText(answer(page), (t) => /2026/.test(t), 'answer at 80%'), await answer(page).textContent(), 'answer stable');
  has(await answer(page).textContent(), 'Not inpatient only on', 'answer at 80% (August 2026 is after the 2026 removal)');
});

// ---- group page ---------------------------------------------------------------------------

await check('group page: chips follow the date', async (page) => {
  await open(page, '/group/spine/');
  const chips = () => page.locator('[data-row] .chip').allTextContents();
  await setDate(page, '2026-11-11');
  const now = await waitText(page.locator('[data-row] .chip').first(), (t) => t.length > 0, 'first chip');
  const a = await chips();
  assert(a.length > 5, `only ${a.length} chips`);
  await setDate(page, '2022-06-01');
  await page.waitForFunction((was) => [...document.querySelectorAll('[data-row] .chip')].map((c) => c.textContent).join('|') !== was, a.join('|'));
  const b = await chips();
  assert(a.join('|') !== b.join('|'), `chips identical on both dates (${now})`);
  eq(await page.locator('[data-row] .chip.chip--ipo').count() > 0 || b.some((t) => t === 'Inpatient only'), true, 'some spine code is inpatient only in mid-2022');
});

// ---- no JavaScript ------------------------------------------------------------------------

await check('no-JS: code page still answers, home shows the noscript note and system links', async (page) => {
  await page.goto(`${base}/code/27447/`);
  const head = await answer(page).textContent();
  assert(/(Not i|I)npatient only on .+\d{4}\./.test(head), `no answer sentence: ${head}`);
  assert(await page.locator('.events li').count() > 0, 'history list is empty');
  await page.goto(`${base}/`);
  has(await page.locator('noscript').first().textContent(), 'Search needs JavaScript', 'noscript note');
  assert(await page.locator('[data-ask] [data-submit]').isHidden(), 'Look up button shows without JavaScript');
  assert(await page.locator('a[href^="/group/"]').count() >= 20, 'body-system links missing');
}, { javaScriptEnabled: false });

// ---- phone --------------------------------------------------------------------------------

await check('phone 390x844: no horizontal overflow', async (page) => {
  const paths = ['/', '/?q=27447', '/code/27132/', '/history/', '/phase-out/', '/exemption/', '/methods/', '/group/heart/'];
  const wide = [];
  for (const path of paths) {
    await open(page, path);
    if (path.includes('q=')) await page.waitForSelector('[data-results] .verdict');
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    if (m.s > m.c + 1) {
      const culprit = await page.evaluate((c) => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > c + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`).join(', '), m.c);
      wide.push(`${path}: scrollWidth ${m.s} > clientWidth ${m.c} (${culprit})`);
    }
  }
  assert(wide.length === 0, wide.join('\n'));
}, { viewport: { width: 390, height: 844 } });

// ---- Revenue at stake: search, filters and cards -----------------------------------------

const hasStake = LIVE ? (await fetch(`${base}/revenue-at-stake/`)).ok : existsSync(join(here, '..', '..', 'docs', 'revenue-at-stake', 'index.html'));
const cardsOf = (page) => page.locator('[data-results] [data-stake-card]');
async function openStake(page, query = '') {
  await open(page, `/revenue-at-stake/${query}`);
  await page.waitForSelector('[data-results] [data-stake-card], [data-results] [data-outside]');
}
/** Wait for the live count line to say something that satisfies the test. */
const countLine = (page, test, what) => waitText(page.locator('#sf-count'), test, what);

if (!hasStake) {
  console.log('– skipped: no Revenue at stake pages in this build');
  skipped += 1;
} else {
  await check('stake: the page starts with cards, 50 at a time, and Show more adds more', async (page) => {
    await openStake(page);
    eq(await cardsOf(page).count(), 50, 'first slice');
    await countLine(page, (t) => /^Showing 50 of [\d,]+ codes\.$/.test(t), 'count line');
    await page.locator('[data-more]').click();
    eq(await cardsOf(page).count(), 100, 'after Show more');
    const focused = await page.evaluate(() => document.activeElement.getAttribute('data-stake-card'));
    assert(focused, 'focus did not move to the first new card');
    assert(await page.locator('.sresults__more [data-more]').isVisible(), 'Show more should stay while codes remain');
  });

  await check('stake: searching 32480 shows its card, with a range, a status and a link to the code page', async (page) => {
    await openStake(page);
    await page.locator('#sf-q').fill('32480');
    await countLine(page, (t) => t === '1 code.', 'count line');
    eq(await cardsOf(page).count(), 1, 'cards');
    const card = page.locator('[data-stake-card="32480"]');
    has(await card.textContent(), '$', 'card has dollars');
    assert(await card.locator('.badge').count() === 1, 'card has a review status');
    assert(await card.locator('a[href="/code/32480/#stake-h"]').count() === 1, 'card links to its code page');
    assert(await card.locator('.scard__work').count() === 0, 'client cards leave the work to the code page');
    const forms = await card.locator('.scard__act a.btn').evaluateAll((as) => as.map((a) => a.href));
    eq(forms.length, 2, 'Agree and Something\'s wrong');
    assert(await card.locator('.scard__act a[href="/revenue-at-stake/help-review/"]').count() === 1, 'card links to the review batches');
    assert(forms.every((h) => h.includes('entry.53591076=32480') && /entry\.1873233910=[0-9a-f]{8}%20/.test(h)), `form links: ${forms}`);
    has(page.url(), 'q=32480', 'URL remembers the search');
  });

  await check('stake: searching by words finds procedures', async (page) => {
    await openStake(page);
    await page.locator('#sf-q').fill('lobectomy');
    await page.waitForFunction(() => document.querySelectorAll('[data-results] [data-stake-card]').length > 0 && document.querySelectorAll('[data-results] [data-stake-card]').length < 40);
    assert(await page.locator('[data-stake-card="32480"]').count() === 1 || await cardsOf(page).count() > 0, 'no results for lobectomy');
  });

  await check('stake: the Tier 3 filter shows only Tier 3 cards and survives a reload', async (page) => {
    await openStake(page);
    await page.locator('#sf-tier').selectOption('3');
    await countLine(page, (t) => /codes?\.$/.test(t) && !/^No /.test(t), 'count line');
    const tiers = await page.locator('[data-results] [data-stake-card]').evaluateAll((nodes) => nodes.map((n) => n.className));
    assert(tiers.length > 0, 'no Tier 3 cards');
    assert(tiers.every((c) => c.includes('scard--t3')), `non-Tier-3 card shown: ${tiers.find((c) => !c.includes('scard--t3'))}`);
    has(page.url(), 'tier=3', 'URL remembers the filter');
    await page.reload();
    await page.waitForSelector('[data-results] [data-stake-card]');
    eq(await page.locator('#sf-tier').inputValue(), '3', 'tier select after reload');
    const again = await page.locator('[data-results] [data-stake-card]').evaluateAll((nodes) => nodes.every((n) => n.className.includes('scard--t3')));
    assert(again, 'reload lost the Tier 3 filter');
  });

  await check('stake: filters combine, sort by biggest gap, clear resets', async (page) => {
    await openStake(page);
    await page.locator('#sf-year').selectOption('2027');
    await page.locator('#sf-compared').check();
    eq(await page.locator('#sf-sort').inputValue(), 'gap', 'biggest gap is the default sort');
    await page.locator('#sf-sort').selectOption('code');
    await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'code');
    await page.locator('#sf-sort').selectOption('gap');
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('sort'));
    const gaps = await page.locator('[data-results] [data-stake-card] .scard__gap').allTextContents();
    assert(gaps.length > 5 && gaps.every((g) => g.includes('$')), 'cards in the gap sort should all carry a gap');
    await page.locator('[data-reset]').click();
    eq(await page.locator('#sf-year').inputValue(), '', 'year after clear');
    eq(await page.evaluate(() => location.search), '', 'URL after clear');
    eq(await page.evaluate(() => document.activeElement.id), 'sf-q', 'focus returns to the search box');
  });

  await check('stake: a code outside the crosswalk says so and points to the lookup or its code page', async (page) => {
    await openStake(page);
    await page.locator('#sf-q').fill('99213');
    await page.waitForSelector('[data-outside="99213"]');
    has(await page.locator('[data-outside]').textContent(), 'Not in this crosswalk', 'message');
    eq(await page.locator('[data-outside] a').getAttribute('href'), '/?q=99213', 'lookup link');
    await countLine(page, (t) => t === '99213 is not in this crosswalk.', 'live region');
    await page.locator('#sf-q').fill('27447');
    await page.waitForSelector('[data-outside="27447"]');
    eq(await page.locator('[data-outside] a').getAttribute('href'), '/code/27447/', 'code page link');
  });

  await check('stake: filters that match nothing show an empty-state card whose Clear filters resets them', async (page) => {
    await openStake(page);
    has(await page.locator('#sf-hint').textContent(), 'Status and tier apply only to codes with a comparison.', 'filter hint');
    eq(await page.locator('#sf-tier').getAttribute('aria-describedby'), 'sf-hint', 'tier select is described by the hint');
    await page.locator('#sf-q').fill('qqqzzzx');
    await page.waitForSelector('[data-results] [data-empty]');
    has(await page.locator('[data-empty]').textContent(), 'No codes match these filters.', 'empty state');
    eq(await cardsOf(page).count(), 0, 'cards');
    await page.locator('[data-empty] [data-reset]').click();
    await page.waitForSelector('[data-results] [data-stake-card]');
    eq(await page.locator('#sf-q').inputValue(), '', 'search after clear');
    eq(await page.locator('[data-empty]').count(), 0, 'empty state gone');
    eq(await page.evaluate(() => document.activeElement.id), 'sf-q', 'focus returns to the search box');
  });

  await check('stake: keyboard only, from search to filters to clear', async (page) => {
    await openStake(page);
    for (let i = 0; i < 40 && (await page.evaluate(() => document.activeElement.id)) !== 'sf-q'; i += 1) await page.keyboard.press('Tab');
    eq(await page.evaluate(() => document.activeElement.id), 'sf-q', 'Tab reaches the search box');
    await page.keyboard.type('32480');
    await countLine(page, (t) => t === '1 code.', 'count after typing');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await countLine(page, (t) => /^Showing 50/.test(t), 'count after clearing');
    for (const id of ['sf-group', 'sf-status', 'sf-tier']) {
      await page.keyboard.press('Tab');
      eq(await page.evaluate(() => document.activeElement.id), id, `Tab order reaches ${id}`);
    }
    await page.keyboard.type('Tier 3');   // type-ahead picks the option without opening the list
    await page.waitForFunction(() => document.querySelector('#sf-tier').value === '3');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-results] [data-stake-card]')].every((n) => n.className.includes('scard--t3')));
    for (let i = 0; i < 20 && (await page.evaluate(() => document.activeElement.hasAttribute('data-reset'))) === false; i += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    eq(await page.evaluate(() => document.activeElement.id), 'sf-q', 'Clear returns focus to search');
    eq(await page.locator('#sf-tier').inputValue(), '', 'tier cleared');
  });

  await check('stake: dark mode draws the filters on the dark page', async (page) => {
    await openStake(page, '?tier=3');
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, select: getComputedStyle(document.querySelector('#sf-tier')).backgroundColor, card: getComputedStyle(document.querySelector('[data-stake-card]')).backgroundColor }));
    eq(colors.select, colors.body, 'select background');
    eq(colors.card, colors.body, 'card background');
    const lum = (rgb) => rgb.match(/\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
    assert(lum(colors.body) < 60, `page is not dark: ${colors.body}`);
  }, { colorScheme: 'dark' });

  await check('stake 375px: no horizontal overflow with a search and with the Tier 3 filter', async (page) => {
    const wide = [];
    for (const query of ['', '?q=32480', '?tier=3', '?q=99213']) {
      await openStake(page, query);
      await page.locator('[data-more]').click().catch(() => {});
      const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      if (m.s > m.c + 1) wide.push(`${query || '/'}: ${m.s} > ${m.c}`);
    }
    assert(wide.length === 0, wide.join('\n'));
  }, { viewport: { width: 375, height: 800 } });

  await check('stake: with JavaScript on the table is collapsed into a closed details', async (page) => {
    await openStake(page);
    const wrap = page.locator('details.stake-tablewrap');
    eq(await wrap.count(), 1, 'details');
    has(await wrap.locator('summary').textContent(), 'codes as a table', 'summary');
    assert(!(await wrap.evaluate((d) => d.open)), 'closed by default');
    await wrap.locator('summary').click();
    assert(await page.locator('tr[data-code="32480"]').isVisible(), 'table opens');
  });

  await check('stake: with JavaScript off the table is still there', async (page) => {
    await page.goto(`${base}/revenue-at-stake/`);
    assert(await page.locator('tr[data-code="32480"]').count() === 1, 'table row for 32480');
    eq(await page.locator('[data-stake-app] *').count(), 0, 'app is empty without JS');
    eq(await page.locator('details.stake-tablewrap').count(), 0, 'table not wrapped without JS');
    // The tables render lazily (content-visibility); a jump link must still land on its table.
    const jump = page.locator('.stab__jump a').last();
    const target = (await jump.getAttribute('href')).slice(1);
    await jump.click();
    await page.waitForFunction((id) => { const box = document.getElementById(id).getBoundingClientRect(); return box.top >= -2 && box.top < innerHeight / 2; }, target);
    assert(await page.locator(`#${target} + .scroll tbody tr`).first().isVisible(), 'jumped-to table shows its rows');
  }, { javaScriptEnabled: false });

  // ---- the hospital view -------------------------------------------------------------------
  const HOSPITAL_FILES = /\/(data\/hospitals\.|data\/h\.|assets\/hospital\.)/;
  const lazyRequests = (page) => {
    const seen = [];
    page.on('request', (request) => { if (HOSPITAL_FILES.test(new URL(request.url()).pathname)) seen.push(new URL(request.url()).pathname); });
    return seen;
  };
  async function pickHospital(page, query, ccn) {
    await page.locator('#hp-q').fill(query);
    await page.locator(`#hp-o-${ccn}`).click();
    await page.waitForSelector('.hpick__on');
  }
  const headText = async (page) => (await page.locator('[data-hospital-pick]').textContent()).replace(/\s+/g, ' ');
  async function cardFor(page, code) {
    await page.locator('#sf-q').fill(code);
    await countLine(page, (t) => t === '1 code.', `count for ${code}`);
    return (await page.locator(`[data-stake-card="${code}"]`).textContent()).replace(/\s+/g, ' ');
  }
  const noJunk = (text, what) => assert(!/NaN|undefined|Infinity|\$0–\$0|null/.test(text), `${what}: ${text}`);

  await check('hospital: the national landing shows only the empty picker and loads no hospital files', async (page) => {
    const seen = lazyRequests(page);
    await openStake(page);
    eq((await page.locator('label[for="hp-q"]').textContent()).trim(), 'Pick a hospital to apply its wage index, IME and DSH.', 'picker label');
    eq(await page.locator('#hp-q').getAttribute('role'), 'combobox', 'combobox role');
    eq(await page.locator('.hsum, .hpick__on').count(), 0, 'no summary or hospital bar');
    await page.waitForTimeout(400);
    eq(seen.length, 0, `hospital files on the national landing: ${seen.join(', ')}`);
    has(await cardFor(page, '32480'), 'Outpatient pays', 'national card');
    eq(page.url().includes('h='), false, 'no h in the URL');
  });

  await check('hospital: pick OHSU: bar, summary, URL, hospital card for 32480, one announcement, focus', async (page) => {
    await openStake(page);
    await pickHospital(page, 'ohsu', '380009');
    await page.waitForFunction(() => new URLSearchParams(location.search).get('h') === '380009');
    const head = await headText(page);
    has(head, 'Rates for Ohsu Hospital And Clinics (380009)', 'bar');
    has(head, 'Teaching · IME 31.1% · DSH 7.0% · wage index 1.19', 'facts');
    has(head, 'At Ohsu Hospital And Clinics, about half of what a removed procedure loses when billed outpatient is teaching and DSH add-ons.', 'lead');
    for (const part of ['$10,478', '$5,156', '822 of 849']) has(head, part, 'summary number');
    eq(await page.evaluate(() => document.activeElement.hasAttribute('data-hpick-change')), true, 'focus moves to Change hospital');
    await waitText(page.locator('[data-hpick-status]'), (t) => t.startsWith('Showing Ohsu Hospital And Clinics’s rates.'), 'status line');
    const text = await cardFor(page, '32480');
    for (const part of ['If billed outpatient, Ohsu Hospital And Clinics is paid $18,121–$47,464 less than the inpatient DRG family.', '$3,995', 'national rate $3,585',
      'Surgery center (ASC), national: $1,585', '$22,117–$51,459', 'Includes $6,067–$14,116 in IME and DSH', 'No teaching or DSH add-on in either outpatient setting.',
      'Ohsu Hospital And Clinics rates: wage index, IME and DSH (operating and capital).']) has(text, part, '32480 card');
    assert(!text.includes('National, unadjusted'), 'no national fine print on a hospital card');
    eq(await page.locator('[data-stake-card="32480"] .sbar__add').count(), 1, 'add-on end segment of the bar');
    const legend = await page.locator('[data-stake-card="32480"] .sbar__keyed').textContent();
    eq(legend, '(IME and DSH)', 'bar legend: a swatch and words true in every color mode');
    const key = await page.locator('[data-stake-card="32480"] .sbar__key').evaluate((el) => getComputedStyle(el).backgroundColor);
    eq(key, await page.locator('[data-stake-card="32480"] .sbar__add').evaluate((el) => getComputedStyle(el).backgroundColor), 'swatch matches the segment');
    has(page.url(), 'h=380009&q=32480', 'URL keeps the hospital and the search');
    await page.reload();
    await page.waitForSelector('.hsum');
    has(await page.locator('[data-stake-card="32480"]').textContent(), '$18,121–$47,464', 'reload keeps the hospital');
  });

  await check('hospital: keyboard only, type a CCN, arrow to it, Enter', async (page) => {
    await openStake(page);
    await page.locator('#hp-q').focus();
    await page.keyboard.type('380009');
    await page.waitForSelector('#hp-o-380009');
    eq(await page.locator('#hp-q').getAttribute('aria-expanded'), 'true', 'list open');
    await page.keyboard.press('ArrowDown');
    eq(await page.locator('#hp-q').getAttribute('aria-activedescendant'), 'hp-o-380009', 'active option');
    eq(await page.locator('#hp-o-380009').getAttribute('aria-selected'), 'true', 'option selected');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.hsum');
    await page.keyboard.press('Enter');   // Change hospital
    eq(await page.evaluate(() => document.activeElement.id), 'hp-q', 'Change returns to the search box');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.hpick__on');
    has(await headText(page), 'Ohsu Hospital And Clinics (380009)', 'Escape keeps the picked hospital');
  });

  await check('hospital: a non-teaching DSH hospital, a hospital with no add-ons, and Puerto Rico', async (page) => {
    await openStake(page);
    await pickHospital(page, '010005', '010005');
    let head = await headText(page);
    has(head, 'Not a teaching hospital · DSH', 'DSH-only facts');
    noJunk(head, 'DSH-only summary');
    let text = await cardFor(page, '32480');
    has(text, 'If billed outpatient, Marshall Medical Centers South Campus is paid', 'DSH-only gap');
    has(text, 'in IME and DSH', 'DSH-only add-on line');
    noJunk(text, 'DSH-only card');

    await page.locator('[data-hpick-change]').click();
    await pickHospital(page, 'arizona spine', '030107');
    head = await headText(page);
    has(head, 'Arizona Spine And Joint Hospital gets no teaching or DSH add-ons, so what a removed procedure loses when billed outpatient is base payment only.', 'no add-ons lead');
    has(head, 'No DSH', 'facts');
    noJunk(head, 'no add-ons summary');
    text = (await page.locator('[data-stake-card="32480"]').textContent()).replace(/\s+/g, ' ');
    assert(!text.includes('Includes'), 'no add-on line');
    has(text, 'This hospital gets no IME or DSH.', 'fine print');
    eq(await page.locator('[data-stake-card="32480"] .sbar__add').count(), 0, 'no darker part');

    await page.locator('[data-hpick-change]').click();
    await pickHospital(page, 'puerto rico presbyterian', '400001');
    head = await headText(page);
    has(head, 'Presbyterian Community Hospital (400001)', 'PR bar');
    has(head, 'wage index 0.53', 'PR wage index');
    noJunk(head, 'PR summary');
    text = (await page.locator('[data-stake-card="32480"]').textContent()).replace(/\s+/g, ' ');
    has(text, 'If billed outpatient, Presbyterian Community Hospital is paid', 'PR gap');
    noJunk(text, 'PR card');
    eq(new URL(page.url()).searchParams.get('h'), '400001', 'URL follows the newest pick');
  });

  await check('hospital: a Maryland search says why, and offers nothing', async (page) => {
    await openStake(page);
    await page.locator('#hp-q').fill('meritus');
    await waitText(page.locator('#hp-note'), (t) => t.includes('Maryland hospitals are paid under the state'), 'Maryland note');
    eq(await page.locator('#hp-list [role="option"]').count(), 0, 'no options');
    eq(await page.locator('#hp-q').getAttribute('aria-expanded'), 'false', 'list closed');
    await page.locator('#hp-q').fill('zzzzqq');
    await waitText(page.locator('#hp-note'), (t) => t.startsWith('No IPPS hospital matches'), 'no-match note');
  });

  await check('hospital: ?h= junk, Maryland or unknown falls back to national with a clean URL and no error', async (page) => {
    const seen = lazyRequests(page);
    for (const [query, left] of [['?h=abc', ''], ['?h=..%2Fhospitals', ''], ['?h=210001', ''], ['?h=999999&tier=3', '?tier=3'], ['?h=38000&q=32480', '?q=32480']]) {
      await openStake(page, query);
      await page.waitForFunction((rest) => location.search === rest, left, { timeout: 5000 }).catch(async () => { throw new Error(`${query}: URL is ${await page.evaluate(() => location.search)}, expected ${JSON.stringify(left)}`); });
      eq(await page.locator('.hsum, .hpick__on').count(), 0, `${query}: no hospital view`);
      const first = await page.locator('[data-results] .scard__gap').first().textContent();
      assert(!first.includes('If billed outpatient'), `${query}: cards stay national`);
    }
    const perHospital = seen.filter((path) => path.startsWith('/data/h.'));
    eq(perHospital.length, 0, `no hospital file fetched for a bad h: ${perHospital.join(', ')}`);
  });

  await check('hospital: Back to national restores the national page, URL and focus', async (page) => {
    await openStake(page, '?h=380009&q=32480');
    await page.waitForSelector('.hsum');
    has(await page.locator('[data-stake-card="32480"]').textContent(), 'Ohsu Hospital And Clinics', 'landing on ?h= shows the hospital');
    await page.locator('[data-hpick-clear]').click();
    await page.waitForFunction(() => !document.querySelector('.hsum'));
    eq(await page.evaluate(() => location.search), '?q=32480', 'URL keeps only the search');
    eq(await page.evaluate(() => document.activeElement.id), 'hp-q', 'focus returns to the picker');
    const text = (await page.locator('[data-stake-card="32480"]').textContent()).replace(/\s+/g, ' ');
    has(text, 'Outpatient pays', 'national card again');
    has(text, 'National, unadjusted: no wage index, IME or DSH.', 'national fine print again');
    await waitText(page.locator('[data-hpick-status]'), (t) => t === 'Showing national rates.', 'status line');
  });

  await check('hospital 400px: no horizontal overflow with the picker open and with OHSU picked', async (page) => {
    await openStake(page);
    await page.locator('#hp-q').fill('providence');
    await page.waitForSelector('#hp-list [role="option"]');
    const wide = [];
    const measure = async (what) => {
      const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      if (m.s > m.c + 1) wide.push(`${what}: ${m.s} > ${m.c}`);
    };
    await measure('picker open');
    await pickHospital(page, 'ohsu', '380009');
    await measure('OHSU picked');
    await cardFor(page, '32480');
    await measure('OHSU 32480');
    await openFolds(page, '32480');
    await measure('OHSU 32480, folds open');
    // The fold tables fit the card at 400 px (a three-DRG family), so no figure hides behind a scroll.
    const tables = await page.evaluate(() => [...document.querySelectorAll('[data-stake-card="32480"] .hfold .scroll')].map((el) => el.scrollWidth - el.clientWidth));
    assert(tables.every((d) => d <= 1), `fold tables scroll sideways at 400 px: ${tables.join(', ')}`);
    await cardFor(page, '19305');
    await openFolds(page, '19305');
    await measure('OHSU 19305 (two families), folds open');
    assert(wide.length === 0, wide.join('\n'));
  }, { viewport: { width: 400, height: 860 } });

  // ---- the hospital view: folds, counts, lede, color modes -------------------------------------
  async function openFolds(page, code) {
    for (const kind of ['split', 'year']) {
      const fold = page.locator(`[data-stake-card="${code}"] [data-fold="${kind}"]`);
      if (await fold.count() && !(await fold.evaluate((d) => d.open))) await fold.locator('> summary').click();
    }
  }
  const foldText = async (page, code, kind) => (await page.locator(`[data-stake-card="${code}"] [data-fold="${kind}"]`).textContent()).replace(/\s+/g, ' ');

  await check('hospital: the split by DRG and per year folds, to the cent', async (page) => {
    await openStake(page, '?h=380009&q=32480');
    await page.waitForSelector('.hsum');
    eq(await page.locator('[data-stake-card="32480"] details.hfold[open]').count(), 0, 'folds start closed');
    await openFolds(page, '32480');
    const split = await foldText(page, '32480', 'split');
    for (const part of ['MS-DRG 165 without CC/MCC', '$16,049.53', '$22,116.60', '$51,459.44', 'Uncompensated care is left out']) has(split, part, 'split');
    const year = await foldText(page, '32480', 'year');
    for (const part of ['Per year at Ohsu Hospital And Clinics · up to about $1 million, a ceiling', '$14,116.45 a case: IME + DSH', '$4,632.08 a case: operating IME only', '$1,015,760.07', 'A ceiling, not a forecast', 'not saved']) has(year, part, 'per year');
    noJunk(split + year, 'folds');
    // The summary is a button-like disclosure: keyboard toggles it.
    await page.locator('[data-stake-card="32480"] [data-fold="split"] > summary').focus();
    await page.keyboard.press('Enter');
    eq(await page.locator('[data-stake-card="32480"] [data-fold="split"]').evaluate((d) => d.open), false, 'Enter closes the split');
  });

  await check('hospital: editing counts updates the row, the MA estimate, the total and the heading, and keeps focus', async (page) => {
    await openStake(page, '?h=380009&q=32480');
    await page.waitForSelector('.hsum');
    await openFolds(page, '32480');
    const card = page.locator('[data-stake-card="32480"]');
    const box = card.locator('[data-count="165:trad"]');
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('10');
    eq(await card.locator('[data-py="165:trad"]').textContent(), '$60,670.69', '10 traditional cases of DRG 165');
    eq(await card.locator('[data-count="165:ma"]').inputValue(), '11', 'MA estimate follows the traditional count');
    eq(await card.locator('[data-py="165:ma"]').textContent(), '$50,952.86', 'MA row');
    eq(await card.locator('[data-year-total]').textContent(), '$1,005,060.92', 'total');
    eq(await card.locator('[data-year-head]').textContent(), 'up to about $1 million, a ceiling', 'heading');
    eq(await page.evaluate(() => document.activeElement.dataset.count), '165:trad', 'focus stays in the box');
    await waitText(page.locator('[data-hpick-status]'), (t) => t === '32480, per year at Ohsu Hospital And Clinics: up to about $1 million, a ceiling.', 'one announcement');
    // Clearing 163 and 164 moves the heading.
    for (const key of ['163:trad', '164:trad']) await card.locator(`[data-count="${key}"]`).fill('');
    eq(await card.locator('[data-year-head]').textContent(), 'up to about $112,000, a ceiling', 'heading after clearing');
    // Not a whole number: flagged in words and to assistive tech, never drawn raw.
    await card.locator('[data-count="163:ma"]').fill('2.5');
    eq(await card.locator('[data-count="163:ma"]').getAttribute('aria-invalid'), 'true', 'aria-invalid');
    eq(await card.locator('[data-why="163:ma"]').textContent(), 'not a whole number', 'note');
    eq(await card.locator('[data-py="163:ma"]').textContent(), 'no count', 'no figure for a bad count');
    await card.locator('[data-count="163:ma"]').fill('<b>x</b>');
    eq(await card.locator('b', { hasText: /^x$/ }).count(), 0, 'typed markup never becomes markup');
    // A redraw (a filter change) keeps the counts and the open folds.
    await page.locator('#sf-compared').check();
    await countLine(page, (t) => t === '1 code.', 'count after the filter');
    eq(await page.locator('[data-stake-card="32480"] [data-count="165:trad"]').inputValue(), '10', 'typed count kept');
    eq(await page.locator('[data-stake-card="32480"] details.hfold[open]').count(), 2, 'folds stay open');
  });

  await check('hospital: Review Focus 3, suppressed counts read "under 11 or none", stay editable, and totals still work', async (page) => {
    await openStake(page, '?h=010001&q=32480');
    await page.waitForSelector('.hsum');
    await openFolds(page, '32480');
    const card = page.locator('[data-stake-card="32480"]');
    eq(await card.locator('[data-count="164:trad"]').inputValue(), '', 'suppressed cell is empty');
    eq(await card.locator('[data-why="164:trad"]').textContent(), 'under 11 or none', 'suppressed note');
    const before = await card.locator('[data-year-total]').textContent();
    await card.locator('[data-count="164:trad"]').fill('20');
    assert((await card.locator('[data-py="164:trad"]').textContent()).startsWith('$'), 'typed count gives a figure');
    assert((await card.locator('[data-year-total]').textContent()) !== before, 'total moves');
    eq(await card.locator('[data-why="164:trad"]').textContent(), 'under 11 or none', 'still says CMS published none');

    await page.locator('[data-hpick-change]').click();
    await pickHospital(page, '010006', '010006');
    await openFolds(page, '32480');
    eq(await page.locator('[data-stake-card="32480"] [data-year-head]').textContent(), 'no 2024 counts published', 'no counts for the family');
    noJunk(await foldText(page, '32480', 'year'), 'no-count fold');
  });

  await check('hospital: the lede names the hospital’s rates after a pick and reverts on clear', async (page) => {
    await openStake(page);
    const lede = page.locator('.stake-head .lede');
    const national = await lede.innerHTML();
    has(national, 'national and unadjusted', 'national lede');
    await pickHospital(page, 'ohsu', '380009');
    has(await lede.textContent(), 'at Ohsu Hospital And Clinics’s rates: wage index, IME and DSH', 'hospital lede');
    await page.locator('[data-hpick-change]').click();
    await pickHospital(page, 'arizona spine', '030107');
    has(await lede.textContent(), 'at Arizona Spine And Joint Hospital’s rates: wage index (it gets no IME or DSH)', 'no add-on lede');
    eq(await page.locator('[data-fold="year"]').count(), 0, 'no per-year fold without add-ons');
    await page.locator('[data-hpick-clear]').click();
    await page.waitForFunction(() => !document.querySelector('.hsum'));
    eq(await lede.innerHTML(), national, 'lede back to the server’s words');
  });

  await check('hospital dark mode: folds, inputs and the add-on segment use the dark palette', async (page) => {
    await openStake(page, '?h=380009&q=32480');
    await page.waitForSelector('.hsum');
    await openFolds(page, '32480');
    const style = (selector, prop) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
    const bodyBg = await style('body', 'backgroundColor');
    eq(await style('[data-count="163:trad"]', 'backgroundColor'), bodyBg, 'input sits on the dark page');
    eq(await style('[data-count="163:trad"]', 'color'), await style('body', 'color'), 'input text is the page text');
    eq(await style('[data-stake-card="32480"] .sbar__add', 'backgroundColor'), 'rgb(116, 214, 195)', 'add-on segment uses the dark step');
    await page.mouse.move(0, 0);
    eq(await style('[data-fold="year"] > summary', 'color'), 'rgb(116, 214, 195)', 'fold summary in the brand ink');
  }, { colorScheme: 'dark' });

  await check('hospital forced colors: the add-on segment, the count boxes and the fold markers stay visible', async (page) => {
    await openStake(page, '?h=380009&q=32480');
    await page.waitForSelector('.hsum');
    await openFolds(page, '32480');
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const seg = await page.locator('[data-stake-card="32480"] .sbar__add').evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(seg !== canvas && seg !== 'rgba(0, 0, 0, 0)', `add-on segment ${seg} on ${canvas}`);
    const box = await page.locator('[data-count="163:trad"]').evaluate((el) => { const s = getComputedStyle(el); return { w: s.borderTopWidth, c: s.borderTopColor }; });
    assert(parseFloat(box.w) >= 1 && box.c !== canvas && box.c !== 'rgba(0, 0, 0, 0)', `count box border ${box.w} ${box.c}`);
    const marker = await page.locator('[data-fold="year"] > summary').evaluate((el) => { const s = getComputedStyle(el); return `${s.display} ${s.listStyleType}`; });
    eq(marker, 'list-item disclosure-open', 'native disclosure marker');
    const markerColor = await page.locator('[data-fold="year"] > summary').evaluate((el) => getComputedStyle(el, '::marker').color);
    assert(markerColor !== canvas, `marker color ${markerColor}`);
  }, { forcedColors: 'active' });

  for (const scheme of ['light', 'dark']) {
    await check(`hospital axe (${scheme}): folds open, a one-family and a two-family card`, async (page) => {
      const report = [];
      for (const code of ['32480', '19305']) {
        await openStake(page, `?h=380009&q=${code}`);
        await page.waitForSelector('.hsum');
        await openFolds(page, code);
        await page.evaluate(axeSource());
        const results = await page.evaluate(() => window.axe.run(document));
        for (const v of results.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
          report.push(`${code} [${v.impact}] ${v.id}: ${v.help}\n      ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n      ')}`);
        }
      }
      assert(report.length === 0, `${report.length} violations\n  ${report.join('\n  ')}`);
    }, { colorScheme: scheme });
  }

  // ---- the ASC patient-share line --------------------------------------------------------------
  await check('code page: the patient-share line and the link to see the card at your hospital', async (page) => {
    await open(page, '/code/32480/');
    const share = (await page.locator('.stake-block__share').textContent()).replace(/\s+/g, ' ');
    eq(share, 'Patient’s share, national: about $317 at a surgery center, $717 in the hospital outpatient department, plus the $292 Part B deductible in either. Most Medigap plans pay the share; Medicare Advantage plans set their own.', 'share line');
    const link = page.locator('.stake-block__more a', { hasText: 'See this at your hospital' });
    eq(await link.getAttribute('href'), '/revenue-at-stake/?q=32480', 'link');
    await link.click();
    await page.waitForSelector('[data-stake-card="32480"]');
    eq(await page.locator('#hp-q').count(), 1, 'lands on the picker');
    await open(page, '/code/0202T/');
    has(await page.locator('.stake-block__share').textContent(), 'more at a surgery center', 'ASC-higher line leads with it');
  });

  await check('lookup: a 2027 ASC addition gets the share line once it is off the list, loaded only then', async (page) => {
    const asked = [];
    page.on('request', (request) => { if (/\/data\/shares\./.test(request.url())) asked.push(request.url()); });
    await open(page, '/?q=32480');
    await page.waitForSelector('[data-results] .verdict');
    eq(await page.locator('.facts__share').count(), 0, 'no line while it is still on the list');
    await page.waitForTimeout(300);
    eq(asked.length, 0, 'no shares file before an answer needs it');
    await setDate(page, '2027-03-01');
    const line = await waitText(page.locator('[data-results] .facts__share dd'), (t) => t.startsWith('About'), 'share line');
    eq(line, 'About $317 at a surgery center, $717 in the hospital outpatient department, plus the $292 Part B deductible in either. Most Medigap plans pay the share; Medicare Advantage plans set their own.', 'lookup line');
    eq(asked.length, 1, 'one fetch');
    await page.fill('[data-q]', '27447');
    await waitText(page.locator('[data-results] .verdict__code'), (t) => t === '27447', 'another code');
    eq(await page.locator('.facts__share').count(), 0, 'no line for a code CMS did not add for 2027');
  });
}

// ---- accessibility ------------------------------------------------------------------------

// Read lazily so a missing node_modules gives this message, not a raw ENOENT at import time.
function axeSource() {
  if (!existsSync(AXE)) throw new Error('axe-core is not installed. Run: cd web && npm install');
  return readFileSync(AXE, 'utf8');
}
const axePaths = ['/?q=27447', ...(hasStake ? ['/revenue-at-stake/?tier=3', '/revenue-at-stake/?q=99213', '/revenue-at-stake/?q=qqqzzzx', '/revenue-at-stake/?h=380009&q=32480'] : []), '/code/27132/', '/history/', '/phase-out/', '/exemption/', '/methods/', '/group/spine/'];
for (const scheme of ['light', 'dark']) {
  await check(`axe (${scheme}): no serious or critical violations`, async (page) => {
    const report = [];
    for (const path of axePaths) {
      await open(page, path);
      if (path.startsWith('/revenue-at-stake/')) await page.waitForSelector(path.includes('h=') ? '.hsum' : '[data-results] [data-stake-card], [data-results] [data-outside], [data-results] [data-empty]');
      else if (path.includes('q=')) await page.waitForSelector('[data-results] .verdict');
      await page.evaluate(axeSource());   // evaluate, not addScriptTag: the live CSP forbids inline scripts
      const results = await page.evaluate(() => window.axe.run(document));
      for (const v of results.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        report.push(`${path} [${v.impact}] ${v.id}: ${v.help}\n      ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n      ')}`);
      }
    }
    assert(report.length === 0, `${report.length} violations\n  ${report.join('\n  ')}`);
  }, { colorScheme: scheme });
}

// ---- keyboard and 404 ---------------------------------------------------------------------

await check('keyboard: Tab reaches the skip link first and it moves focus into main', async (page) => {
  await open(page, '/');
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement.className + ' ' + document.activeElement.getAttribute('href'));
  has(first, 'skip', 'first focusable element');
  await page.keyboard.press('Enter');
  const where = await page.evaluate(() => {
    const el = document.activeElement;
    return { inMain: Boolean(el && el.closest('main')), tag: el ? `${el.tagName.toLowerCase()}#${el.id}` : 'none' };
  });
  assert(where.inMain, `focus after activating the skip link is ${where.tag}, not inside main`);
  eq(where.tag, 'span#content', 'skip link target');
});

await check('404: missing path returns the 404 page with a link home', async (page) => {
  ignore404 = true;
  try {
    const response = await page.goto(`${base}/no/such/page/`);
    eq(response.status(), 404, 'status');
    has(await page.locator('h1').textContent(), 'That page does not exist', 'h1');
    assert(await page.locator('main a[href="/"]').count() > 0, 'no link back to the lookup');
  } finally { ignore404 = false; }
});

await browser.close();
server?.close();
console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} skipped`);
if (failures.length) { console.log(`failed: ${failures.join('; ')}`); process.exit(1); }
