// The help-review credit list: optional profile links on reviewer and tiebreaker names.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { credits, safeProfile } from '../src/stake-data.mjs';
import { creditList } from '../src/stake.mjs';

const model = { codes: { 11111: { map: { fp: 'aaaa1111' } } } };
const agree = (name, profile) => ({ code: '11111', fp: 'aaaa1111', verdict: 'agree', credential: 'CCS', date: '2026-11-12', name, profile });
const render = (reviews, resolutions = {}) => creditList({ items: [], credits: credits(reviews, model, resolutions) });

describe('credit links', () => {
  test('a https profile makes the name a new-tab link with nofollow ugc', () => {
    const html = render([agree('Jane Doe', 'https://www.linkedin.com/in/jane-doe')]);
    assert.match(html, /<li><a href="https:\/\/www\.linkedin\.com\/in\/jane-doe" target="_blank" rel="nofollow ugc noopener noreferrer">Jane Doe<span class="sr"> \(opens in a new tab\)<\/span><\/a>, CCS<\/li>/);
  });

  test('no profile, or an unusable one, leaves the plain name', () => {
    for (const bad of [null, undefined, '', 'http://example.org/x', 'javascript:alert(1)', 'https://u:p@example.org/', 'https://ex ample.org/', 'https://' + 'a'.repeat(200) + '.org']) {
      const html = render([agree('Jane Doe', bad)]);
      assert.ok(html.includes('<li>Jane Doe, CCS</li>'), String(bad));
      assert.ok(!html.includes('<a href="http') && !html.includes('javascript'), String(bad));
    }
  });

  test('names and URLs are escaped', () => {
    const html = render([agree('<b>"Jo" & Co</b>', 'https://example.org/a?x="1"&y=<2>')]);
    assert.ok(!html.includes('<b>'));
    assert.ok(html.includes('&lt;b&gt;&quot;Jo&quot; &amp; Co&lt;/b&gt;'));
    assert.ok(!html.includes('"1"') && !html.includes('<2>'));
  });

  test('a tiebreaker on the current mapping is credited, with the link, and a stale one is not', () => {
    const resolutions = { '11111:aaaa1111': { decision: 'kept', by: 'Sam Lee', by_profile: 'https://orcid.org/0000-0000-0000-0000', date: '2026-11-20' },
      '11111:oldoldol': { decision: 'kept', by: 'Stale Person', date: '2026-11-01' } };
    const html = render([], resolutions);
    assert.ok(html.includes('href="https://orcid.org/0000-0000-0000-0000"') && html.includes('Sam Lee'));
    assert.ok(!html.includes('Stale Person'));
  });

  test('shows the most recent credential; tiebreaker shown as written', () => {
    const later = { ...agree('Jane Doe', null), credential: 'CIC', date: '2026-12-01' };
    const html = render([later, agree('Jane Doe', null)], { '11111:aaaa1111': { by: 'Sam Lee, MD', date: '2026-11-20' } });
    assert.ok(html.includes('<li>Jane Doe, CIC</li>') && !html.includes('Jane Doe, CCS'));
    assert.ok(html.includes('<li>Sam Lee, MD</li>'));
  });

  test('safeProfile', () => {
    assert.equal(safeProfile('https://github.com/jane'), 'https://github.com/jane');
    assert.equal(safeProfile('HTTP://github.com/jane'), null);
    assert.equal(safeProfile(42), null);
  });
});
