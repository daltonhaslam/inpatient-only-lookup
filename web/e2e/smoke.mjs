// End-to-end smoke test: node e2e/smoke.mjs   (exits non-zero if any check fails)
// Serves docs/ locally and drives the cached Chromium. No test framework.
// BASE_URL=https://example.com node e2e/smoke.mjs   runs the same checks against a deployed site instead.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { launch } from './browser.mjs';
import { serve } from './serve.mjs';

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
    await page.locator('#sf-sort').selectOption('gap');
    await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'gap');
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

  await check('stake: with JavaScript off the table is still there', async (page) => {
    await page.goto(`${base}/revenue-at-stake/`);
    assert(await page.locator('tr[data-code="32480"]').count() === 1, 'table row for 32480');
    eq(await page.locator('[data-stake-app] *').count(), 0, 'app is empty without JS');
  }, { javaScriptEnabled: false });
}

// ---- accessibility ------------------------------------------------------------------------

// Read lazily so a missing node_modules gives this message, not a raw ENOENT at import time.
function axeSource() {
  if (!existsSync(AXE)) throw new Error('axe-core is not installed. Run: cd web && npm install');
  return readFileSync(AXE, 'utf8');
}
const axePaths = ['/?q=27447', ...(hasStake ? ['/revenue-at-stake/?tier=3', '/revenue-at-stake/?q=99213'] : []), '/code/27132/', '/history/', '/phase-out/', '/exemption/', '/methods/', '/group/spine/'];
for (const scheme of ['light', 'dark']) {
  await check(`axe (${scheme}): no serious or critical violations`, async (page) => {
    const report = [];
    for (const path of axePaths) {
      await open(page, path);
      if (path.startsWith('/revenue-at-stake/')) await page.waitForSelector('[data-results] [data-stake-card], [data-results] [data-outside]');
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
