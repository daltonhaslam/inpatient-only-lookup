// The sentences shown beside the date field, and text echoed back from the address or the search box.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { outsideRangeNote, unreadDateNote, printable } from '../src/engine.mjs';

describe('date notes', () => {
  const data = { dosMin: '2020-01-01', dosMax: '2027-12-31' };

  test('a date outside the range names the range and the date shown', () => {
    assert.equal(outsideRangeNote(data, '2019-03-03', '2020-01-01'),
      'March 3, 2019 is outside the dates this site covers, January 1, 2020 to December 31, 2027. Showing January 1, 2020.');
  });

  test('a link date that is not a date is echoed back short and without control or format characters', () => {
    assert.equal(unreadDateNote('not-a-date', '2026-11-11'), 'The date in this link, “not-a-date”, is not a date. Showing November 11, 2026.');
    // U+202E (right-to-left override) would reverse the rest of the sentence on screen.
    assert.equal(unreadDateNote('\u202eetad-a-ton', '2026-11-11'), 'The date in this link, “etad-a-ton”, is not a date. Showing November 11, 2026.');
    assert.equal(unreadDateNote('x'.repeat(40), '2026-11-11').match(/“(x+)”/)[1].length, 24);
  });

  test('printable() drops control and format characters and keeps the rest', () => {
    assert.equal(printable('hip\u202e replace\u200bment\u0007'), 'hip replacement');
    assert.equal(printable('knee “TKA” 27447'), 'knee “TKA” 27447');
  });
});
