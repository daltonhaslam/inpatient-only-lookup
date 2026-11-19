// The hospital view's words and round figures (hospital-words.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY, fractionWord, roughMoney, series, addOnsOf, addOnNames, addOnsSpelled } from '../src/hospital-words.mjs';

describe('fractionWord: the nearest named fraction, cutoffs at the midpoints', () => {
  const cases = [
    [0, 'a small part'], [0.19, 'a small part'], [0.2, 'about a quarter'], [0.29, 'about a quarter'], [0.3, 'about a third'],
    [0.41, 'about a third'], [0.42, 'about half'], [0.492, 'about half'], [0.58, 'about half'], [0.59, 'about two thirds'],
    [0.7, 'about two thirds'], [0.71, 'about three quarters'], [0.87, 'about three quarters'], [0.875, 'nearly all'],
    [0.99, 'nearly all'], [1, 'all'], [1.4, 'all'],
  ];
  for (const [ratio, word] of cases) test(`${ratio} -> ${word}`, () => assert.equal(fractionWord(ratio), word));
  test('no ratio (summary state no-addons, no-gap or empty): null', () => {
    assert.equal(fractionWord(null), null);
    assert.equal(fractionWord(NaN), null);
  });
});

describe('roughMoney: the per-year fold headline', () => {
  for (const [n, text] of [[1_134_000, '$1.1 million'], [2_000_000, '$2 million'], [60_670.69, '$61,000'], [9_499, '$9,500'], [480, '$480'], [0, '$0']]) {
    test(`${n} -> ${text}`, () => assert.equal(roughMoney(n), text));
  }
  test('no total (null): null, not "$0"', () => {
    assert.equal(roughMoney(null), null);
    assert.equal(roughMoney(undefined), null);
  });
});

test('EMPTY labels the two reasons a count cell is empty', () => {
  assert.deepEqual(Object.keys(EMPTY).sort(), ['no-ma-ratio', 'suppressed']);
  assert.equal(EMPTY.suppressed, 'under 11 or none');
});

describe('the add-ons a hospital gets, in words (K1, one place builds them)', () => {
  const both = { tchop: 0.3, tchcp: 0.1, dshopp: 0.07, dshcpp: 0.05 };
  const dsh = { tchop: 0, tchcp: 0, dshopp: 0.035, dshcpp: 0 };
  const ime = { tchop: 0.2, tchcp: 0.1, dshopp: 0, dshcpp: 0 };
  const capitalIme = { tchop: 0, tchcp: 0.05, dshopp: 0.04, dshcpp: 0.02 };
  const none = { tchop: 0, tchcp: 0, dshopp: 0, dshcpp: 0 };
  test('series joins a list for prose', () => {
    assert.equal(series([]), '');
    assert.equal(series(['DSH']), 'DSH');
    assert.equal(series(['IME', 'DSH']), 'IME and DSH');
    assert.equal(series(['IME', 'DSH'], 'or'), 'IME or DSH');
    assert.equal(series(['wage index', 'IME', 'DSH']), 'wage index, IME and DSH');
  });
  test('names from the hospital’s own factors; a capital factor alone counts', () => {
    assert.deepEqual(addOnNames(both), ['IME', 'DSH']);
    assert.deepEqual(addOnNames(dsh), ['DSH']);
    assert.deepEqual(addOnNames(ime), ['IME']);
    assert.deepEqual(addOnNames(capitalIme), ['IME', 'DSH']);
    assert.deepEqual(addOnNames(none), []);
    assert.deepEqual(addOnsOf(capitalIme).map((a) => a.capitalOnly), [true, false]);
  });
  test('spelled out for the lead: plain word first, acronym in parentheses, singular for one', () => {
    assert.equal(addOnsSpelled(both), 'teaching (IME) and safety-net (DSH) add-ons');
    assert.equal(addOnsSpelled(dsh), 'a safety-net (DSH) add-on');
    assert.equal(addOnsSpelled(ime), 'a teaching (IME) add-on');
    assert.equal(addOnsSpelled(none), 'no teaching (IME) or safety-net (DSH) add-ons');
  });
});
