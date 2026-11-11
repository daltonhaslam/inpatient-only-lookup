import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDate, formatDate, addDays, dayNumber, fromDayNumber, clampDate, periodIndex, lookup, countsAt,
  buildIndex, search, extractCodes, expandOther,
} from '../src/engine.mjs';
import { verdict } from '../src/views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '..', '..', 'docs');
const derived = join(here, '..', '..', 'pipeline', 'derived');
const dataDir = join(docs, 'data');
if (!existsSync(dataDir)) {
  throw new Error('docs/ is not built. Run: cd web && BUILD_DATE=2026-11-11 node build.mjs');
}
const pick = (prefix) => {
  const name = readdirSync(dataDir).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!name) throw new Error(`docs/data/${prefix}*.json missing; build the site first`);
  return JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
};
const data = pick('ipo.');
const other = expandOther(pick('other.'));
const TODAY = '2026-11-11';

describe('date helpers', () => {
  test('formatDate', () => {
    assert.equal(formatDate('2021-03-03'), 'March 3, 2021');
    assert.equal(formatDate('2021-03-03', 'short'), 'Mar 3, 2021');
    assert.equal(formatDate('2026-12-31'), 'December 31, 2026');
  });
  test('addDays crosses month, year and leap day', () => {
    assert.equal(addDays('2021-02-28', 1), '2021-03-01');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2026-05-05', 0), '2026-05-05');
  });
  test('dayNumber / fromDayNumber round trip', () => {
    for (const d of ['1970-01-01', '2017-01-01', '2024-02-29', '2026-11-11', '2029-01-01']) {
      assert.equal(fromDayNumber(dayNumber(d)), d);
    }
    assert.equal(dayNumber('2026-01-02') - dayNumber('2026-01-01'), 1);
  });
  test('isDate', () => {
    assert.equal(isDate('2026-02-28'), true);
    assert.equal(isDate('2024-02-29'), true);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', 'junk', '', null, undefined, '2026-02-28x', '20260228']) {
      assert.equal(isDate(bad), false, `isDate(${JSON.stringify(bad)})`);
    }
  });
  test('clampDate', () => {
    assert.equal(clampDate(data, '1999-01-01'), data.dosMin);
    assert.equal(clampDate(data, '2999-01-01'), data.dosMax);
    assert.equal(clampDate(data, '2022-05-05'), '2022-05-05');
    assert.equal(clampDate(data, data.dosMin), data.dosMin);
    assert.equal(clampDate(data, data.dosMax), data.dosMax);
  });
});

describe('periodIndex', () => {
  test('boundaries', () => {
    const first = data.periods[0].d;
    assert.equal(periodIndex(data, addDays(first, -1)), -1);
    assert.equal(periodIndex(data, first), 0);
    for (let i = 1; i < data.periods.length; i += 1) {
      const start = data.periods[i].d;
      assert.equal(periodIndex(data, start), i, `start of period ${i}`);
      assert.equal(periodIndex(data, addDays(start, -1)), i - 1, `day before period ${i}`);
    }
    assert.equal(periodIndex(data, '2999-01-01'), data.periods.length - 1);
  });
});

describe('lookup known answers', () => {
  test('27447 removed 2018: off, exemption none', () => {
    const r = lookup(data, '27447', '2021-03-03', other);
    assert.equal(r.kind, 'listed');
    assert.equal(r.state, 'off');
    assert.equal(r.exemption.status, 'none');
    assert.equal(r.removed, '2018-01-01');
  });
  test('27130 two-year exemption', () => {
    const a = lookup(data, '27130', '2021-06-01', other);
    assert.equal(a.state, 'off');
    assert.equal(a.exemption.kind, 'two-year');
    assert.equal(a.exemption.status, 'active');
    assert.equal(lookup(data, '27130', '2022-01-01', other).exemption.status, 'ended');
  });
  test('22630 indefinite exemption and disputed window', () => {
    const a = lookup(data, '22630', '2024-06-01', other);
    assert.equal(a.state, 'off');
    assert.equal(a.exemption.kind, 'indefinite');
    assert.equal(a.exemption.status, 'active');
    assert.equal(a.exemption.disputed, true);
    const b = lookup(data, '22630', '2021-06-01', other);
    assert.equal(b.state, 'off', 'removed in 2021');
    assert.equal(b.exemption.status, 'active');
    assert.equal(b.exemption.disputed, false);
    assert.equal(lookup(data, '22630', '2026-06-01', other).exemption.disputed, false);
  });
  test('27132 goes off, back on, off again', () => {
    assert.equal(lookup(data, '27132', '2021-06-01', other).state, 'off');
    assert.equal(lookup(data, '27132', '2022-06-01', other).state, 'ipo');
    const r = lookup(data, '27132', '2026-02-01', other);
    assert.equal(r.state, 'off');
    assert.equal(r.removed, '2026-01-01');
  });
  test('a 2027-01-01 removal flips on the day', () => {
    assert.equal(lookup(data, '00176', '2026-12-31', other).state, 'ipo');
    const r = lookup(data, '00176', '2027-01-01', other);
    assert.equal(r.state, 'off');
    assert.equal(r.removed, '2027-01-01');
  });
  test('other, unknown, pending', () => {
    const o = lookup(data, '99213', TODAY, other);
    assert.equal(o.kind, 'other');
    assert.equal(o.state, 'off');
    assert.equal(lookup(data, '0000Z', TODAY, other).kind, 'unknown');
    assert.equal(lookup(data, '99213', TODAY, null).kind, 'pending');
    assert.equal(lookup(data, '0000Z', TODAY, null).kind, 'pending');
  });
});

describe('cross-check against the Python pipeline', () => {
  const history = JSON.parse(readFileSync(join(derived, 'ipo-history.json'), 'utf8'));
  const periods = JSON.parse(readFileSync(join(derived, 'periods.json'), 'utf8'));
  const first = periods[0].date;

  test('period lists agree', () => {
    assert.deepEqual(data.periods.map((p) => p.d), periods.map((p) => p.date));
  });
  test('same code set', () => {
    assert.deepEqual(Object.keys(data.codes).sort(), Object.keys(history).sort());
  });

  test('every code x every period start (and the day before)', () => {
    const dates = new Set();
    for (const p of periods) {
      dates.add(p.date);
      const before = addDays(p.date, -1);
      if (before >= first) dates.add(before);
    }
    const bad = [];
    let checks = 0;
    for (const [code, rec] of Object.entries(history)) {
      for (const date of dates) {
        let span = null;
        for (const s of rec.spans) if (s.from <= date) span = s; else break;
        const got = lookup(data, code, date, null);
        checks += 1;
        const want = span ? span : null;
        const wantState = want ? want.state : 'gone';
        const wantRemoved = want ? want.removed : null;
        const wantEx = want ? want.exemption : null;
        const gotEx = got.exemption;
        const problems = [];
        if (got.state !== wantState) problems.push(`state ${got.state} != ${wantState}`);
        if (got.removed !== wantRemoved) problems.push(`removed ${got.removed} != ${wantRemoved}`);
        if ((gotEx === null) !== (wantEx === null)) problems.push(`exemption null mismatch (${gotEx && gotEx.kind} vs ${wantEx && wantEx.kind})`);
        else if (gotEx) {
          if (gotEx.kind !== wantEx.kind) problems.push(`kind ${gotEx.kind} != ${wantEx.kind}`);
          if (gotEx.through !== wantEx.through) problems.push(`through ${gotEx.through} != ${wantEx.through}`);
        }
        if (problems.length) bad.push(`${code} ${date}: ${problems.join('; ')}`);
      }
    }
    assert.ok(checks > 50000, `only ${checks} comparisons`);
    assert.equal(bad.length, 0, `${bad.length} mismatches of ${checks}; first:\n${bad.slice(0, 15).join('\n')}`);
  });
});

describe('countsAt', () => {
  const total = (iso) => countsAt(data, periodIndex(data, iso)).total;
  test('known totals', () => {
    assert.equal(total('2021-01-01'), 1438);
    assert.equal(total('2022-01-01'), 1728);
    assert.equal(total('2026-01-01'), 1438);
    assert.equal(total('2027-01-01'), 813);
    assert.equal(total('2020-10-01'), 1740);
  });
  test('group counts sum to total', () => {
    const c = countsAt(data, periodIndex(data, '2022-01-01'));
    assert.equal(c.groups.reduce((a, b) => a + b, 0), c.total);
  });
});

describe('search', () => {
  const index = buildIndex(data);
  test('exact code first', () => {
    const r = search(index, '27447');
    assert.equal(r.codes[0], '27447');
  });
  test('code prefix', () => {
    const r = search(index, '2713');
    assert.ok(r.codes.length > 1);
    assert.ok(r.codes.every((c) => c.startsWith('2713')));
    assert.deepEqual(r.codes, [...r.codes].sort());
    const all = Object.keys(data.codes).filter((c) => c.startsWith('2713'));
    assert.equal(r.total, all.length);
  });
  test('hip replacement finds 27130 near the top', () => {
    const r = search(index, 'hip replacement');
    assert.ok(r.codes.indexOf('27130') >= 0 && r.codes.indexOf('27130') < 5, r.codes.slice(0, 8).join());
  });
  test('keyword tka finds 27447', () => {
    assert.ok(search(index, 'tka').codes.includes('27447'));
  });
  test('CABG finds several', () => {
    assert.ok(search(index, 'CABG').total >= 3);
  });
  test('every word must match', () => {
    assert.ok(search(index, 'hip').total > 0);
    assert.deepEqual(search(index, 'hip zzzz'), { codes: [], total: 0 });
  });
  test('empty query', () => {
    for (const q of ['', '   ', null, undefined]) assert.deepEqual(search(index, q), { codes: [], total: 0 });
  });
  test('limit and total', () => {
    const r = search(index, 'a', 5);
    assert.equal(r.codes.length, 5);
    assert.ok(r.total > 5);
    assert.equal(search(index, 'a').codes.length, Math.min(60, search(index, 'a').total));
  });
  test('case and diacritics folded', () => {
    assert.deepEqual(search(index, 'HIP Replacement'), search(index, 'hip replacement'));
    assert.deepEqual(search(index, 'hîp répläcement'), search(index, 'hip replacement'));
    assert.equal(search(index, '27447').codes[0], search(index, ' 27447 ').codes[0]);
  });
});

describe('extractCodes', () => {
  test('messy text', () => {
    assert.deepEqual(extractCodes('27130, 27447;22630\n0075T G0412 and 123456 abc'), ['27130', '27447', '22630', '0075T', 'G0412']);
  });
  test('dedupes, folds case, ignores long runs and words', () => {
    assert.deepEqual(extractCodes('27130 27130 g0412 G0412'), ['27130', 'G0412']);
    assert.deepEqual(extractCodes('123456 ABCDE hello 1234567890'), []);
    assert.deepEqual(extractCodes(''), []);
    assert.deepEqual(extractCodes(null), []);
  });
});

describe('views.verdict', () => {
  const hostile = '<img src=x onerror=1>';
  const html = (code, date, o = other) => verdict(data, code, date, TODAY, o);
  const okHref = (h) => h.startsWith('/') || ['https://www.govinfo.gov/', 'https://www.ecfr.gov/', 'https://www.cms.gov/'].some((p) => h.startsWith(p));
  const hrefs = (s) => [...s.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

  test('answer sentences', () => {
    assert.match(html('27447', '2017-06-01'), /Inpatient only on June 1, 2017\./);
    assert.match(html('27447', '2021-03-03'), /Not inpatient only on March 3, 2021\./);
    assert.match(html('27132', '2022-06-01'), /Inpatient only on June 1, 2022\./);
    assert.match(html('99213', '2021-03-03'), /Not inpatient only on March 3, 2021\./);
    assert.match(html('99213', '2021-03-03'), /has not been on the inpatient-only list/);
    assert.match(html('0000Z', '2021-03-03'), /No record of 0000Z\./);
  });
  test('"Not in Medicare’s files on" for a code outside its file range', () => {
    const gone = Object.entries(other).find(([, [a]]) => a > 3);
    assert.ok(gone, 'fixture: an other code that starts after period 3');
    const date = data.periods[0].d;
    assert.match(html(gone[0], date), /Not in Medicare’s files on January 1, 2017\./);
  });
  test('pending placeholder', () => {
    assert.match(html('99213', '2021-03-03', null), /Checking 99213/);
  });
  test('hostile code is escaped everywhere', () => {
    for (const o of [other, null]) {
      const out = html(hostile, '2021-03-03', o);
      assert.ok(!out.includes('<img'), 'raw tag leaked');
      assert.ok(!out.replace(/&lt;img src=x onerror=1&gt;/g, '').includes('onerror=1'), 'unescaped fragment');
    }
    const out = html(hostile, '2021-03-03');
    assert.ok(out.includes('&lt;img src=x onerror=1&gt;'));
    assert.ok(!out.includes(hostile));
  });
  test('every href is on an allowed origin', () => {
    const cases = [['27447', '2021-03-03'], ['27130', '2021-06-01'], ['22630', '2024-06-01'], ['27132', '2026-02-01'], ['00176', '2027-01-01'], ['99213', '2021-03-03'], ['0000Z', TODAY], ['27447', '2017-06-01']];
    for (const [code, date] of cases) {
      const out = verdict(data, code, date, TODAY, other, { link: true });
      const links = hrefs(out);
      assert.ok(links.length > 0 || code === '0000Z');
      for (const h of links) assert.ok(okHref(h), `${code} ${date}: bad href ${h}`);
    }
  });
  test('answer for every listed code and period start is well-formed', () => {
    for (const code of Object.keys(data.codes).slice(0, 80)) {
      for (const p of data.periods.filter((_, i) => i % 4 === 0)) {
        const out = verdict(data, code, p.d, TODAY, other);
        assert.doesNotMatch(out, /undefined|NaN|\[object Object\]/, `${code} ${p.d}`);
      }
    }
  });
});
