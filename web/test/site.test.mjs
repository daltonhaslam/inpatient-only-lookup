// Static checks over the built docs/ tree.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const docs = join(repo, 'docs');
if (!existsSync(join(docs, 'index.html'))) {
  throw new Error('docs/ is not built. Run: cd web && BUILD_DATE=2026-11-11 node build.mjs');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}
const files = walk(docs);
const pages = files.filter((f) => f.endsWith('.html')).map((file) => ({
  file, rel: relative(docs, file), html: readFileSync(file, 'utf8'),
}));
const urlOf = (rel) => (rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? `/${rel.slice(0, -10)}` : `/${rel}`);
const exists = (path) => {
  const full = join(docs, path);
  if (!full.startsWith(docs)) return false;
  if (!existsSync(full)) return false;
  return statSync(full).isDirectory() ? existsSync(join(full, 'index.html')) : true;
};

const strip = (html) => html
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<head\b[\s\S]*?<\/head>/i, ' ');
const textOf = (html) => strip(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
const anchors = (html) => [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({
  attrs: m[1],
  href: ((/\bhref="([^"]*)"/.exec(m[1]) || [])[1] || '').replaceAll('&amp;', '&'),
  text: m[2].replace(/<span class="sr">[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, '').trim(),
}));

// Report the first N failures with the page they are on.
const collect = (fn) => {
  const bad = [];
  for (const page of pages) for (const message of fn(page) || []) bad.push(`${urlOf(page.rel)}  ${message}`);
  return bad;
};
const none = (bad, what) => assert.equal(bad.length, 0, `${bad.length} ${what}; first:\n${bad.slice(0, 15).join('\n')}`);

describe('page structure', () => {
  test('there are pages', () => assert.ok(pages.length > 1800, `only ${pages.length} pages`));

  test('one h1, title, description, canonical, lang', () => {
    none(collect(({ html }) => {
      const out = [];
      const h1 = (html.match(/<h1[\s>]/gi) || []).length;
      if (h1 !== 1) out.push(`${h1} h1 elements`);
      const title = /<title>([^<]*)<\/title>/i.exec(html);
      if (!title || !title[1].trim()) out.push('missing or empty <title>');
      const desc = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
      if (!desc || !desc[1].trim()) out.push('missing meta description');
      if (!/<link\s+rel="canonical"\s+href="https?:\/\/[^"]+"/i.test(html)) out.push('missing canonical');
      if (!/<html[^>]*\slang="[a-z-]+"/i.test(html)) out.push('missing lang');
      return out;
    }), 'pages with structural problems');
  });

  test('heading levels do not skip downward', () => {
    none(collect(({ html }) => {
      let prev = 0;
      for (const m of strip(html).matchAll(/<h([1-6])[\s>]/gi)) {
        const level = Number(m[1]);
        if (prev && level > prev + 1) return [`h${prev} followed by h${level}`];
        prev = level;
      }
    }), 'pages that skip a heading level');
  });

  test('no placeholder junk in visible text', () => {
    none(collect(({ html }) => {
      const text = textOf(html);
      return [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bnull\b/].filter((re) => re.test(text))
        .map((re) => `visible text matches ${re}: …${text.slice(Math.max(0, text.search(re) - 30), text.search(re) + 30).replace(/\s+/g, ' ')}…`);
    }), 'pages with placeholder text');
  });

  test('CSP: no inline script bodies, handlers or style elements', () => {
    none(collect(({ html }) => {
      const out = [];
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (m[2].trim() && !/type="application\/json"/i.test(m[1])) out.push(`inline script: ${m[2].trim().slice(0, 50)}`);
      }
      if (/<style[\s>]/i.test(html)) out.push('<style> element');
      const handler = /<[a-z][^>]*\s(on[a-z]+)\s*=/i.exec(html);
      if (handler) out.push(`event handler attribute ${handler[1]}`);
      return out;
    }), 'CSP violations');
  });
});

describe('links', () => {
  const ALLOWED_HOSTS = new Set(['www.govinfo.gov', 'www.ecfr.gov', 'www.cms.gov', 'docs.google.com', 'github.com', 'www.linkedin.com', 'paidandpenalized.org']);

  test('internal links resolve', () => {
    none(collect(({ html }) => {
      const out = [];
      const targets = [...anchors(html).map((a) => a.href),
        ...[...html.matchAll(/<link\b[^>]*\shref="([^"]*)"/gi)].map((m) => m[1]),
        ...[...html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1])];
      for (const href of targets) {
        if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/_vercel/')) continue;
        const path = decodeURIComponent(href.split(/[?#]/)[0]);
        if (!exists(path.slice(1))) out.push(`broken link ${href}`);
      }
      return out;
    }), 'broken internal links');
  });

  test('in-page #links have a matching id', () => {
    none(collect(({ html }) => {
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      return anchors(html).filter((a) => a.href.startsWith('#') && a.href.length > 1 && !ids.has(a.href.slice(1)))
        .map((a) => `no id for ${a.href}`);
    }), 'dangling #links');
  });

  test('external links: new tab, noopener noreferrer, allowed host', () => {
    none(collect(({ html }) => {
      const out = [];
      for (const a of anchors(html)) {
        if (a.href.startsWith('/') || a.href.startsWith('#')) {
          continue;
        }
        let host;
        try { host = new URL(a.href).host; } catch { out.push(`unparseable href ${a.href}`); continue; }
        if (!/^https:/.test(a.href)) out.push(`non-https link ${a.href}`);
        if (!ALLOWED_HOSTS.has(host)) out.push(`host ${host} not allowed (${a.href})`);
        if (!/\btarget="_blank"/.test(a.attrs)) out.push(`no target=_blank: ${a.href}`);
        const rel = (/\brel="([^"]*)"/.exec(a.attrs) || [])[1] || '';
        if (!/\bnoopener\b/.test(rel) || !/\bnoreferrer\b/.test(rel)) out.push(`rel="${rel}" lacks noopener noreferrer: ${a.href}`);
      }
      return out;
    }), 'external link problems');
  });

  test('Federal Register citations are backed by the pipeline', () => {
    const cites = JSON.parse(readFileSync(join(repo, 'pipeline', 'citations.json'), 'utf8')).citations;
    const rules = JSON.parse(readFileSync(join(repo, 'pipeline', 'rules.json'), 'utf8')).rules;
    const known = new Set(Object.values(cites).map((c) => c.cite));
    for (const rule of rules) {
      if (rule.fr) known.add(rule.fr);
      for (const v of Object.values(rule.event_cites || {})) known.add(v);
      const first = rule.table && /^(\d+ FR \d+)/.exec(rule.table.pages || '');
      if (first) known.add(first[1]);
    }
    const unbacked = new Map();
    let seen = 0;
    for (const page of pages) {
      for (const a of anchors(page.html)) {
        if (!/^\d+ FR \d+$/.test(a.text)) continue;
        seen += 1;
        if (!known.has(a.text)) (unbacked.get(a.text) || unbacked.set(a.text, []).get(a.text)).push(urlOf(page.rel));
      }
    }
    assert.ok(seen > 100, `only ${seen} FR citations found`);
    const lines = [...unbacked].map(([cite, where]) => `${cite}  (${where.length} pages, e.g. ${where[0]})`);
    assert.equal(lines.length, 0, `${lines.length} FR citations not in pipeline/citations.json or rules.json:\n${lines.join('\n')}`);
  });
});

describe('sitemap and robots', () => {
  test('sitemap lists every page except 404', () => {
    const xml = readFileSync(join(docs, 'sitemap.xml'), 'utf8');
    const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    assert.equal(new Set(listed).size, listed.length, 'duplicate sitemap entries');
    const want = pages.filter((p) => p.rel !== '404.html').map((p) => urlOf(p.rel));
    const have = new Set(listed);
    const missing = want.filter((u) => !have.has(u));
    const extra = listed.filter((u) => !want.includes(u));
    assert.deepEqual({ missing: missing.slice(0, 10), extra: extra.slice(0, 10) }, { missing: [], extra: [] });
    assert.ok(!have.has('/404.html'));
  });
  test('robots.txt points at the sitemap', () => {
    const robots = readFileSync(join(docs, 'robots.txt'), 'utf8');
    const loc = /^Sitemap:\s*(\S+)/m.exec(robots);
    assert.ok(loc, 'no Sitemap line');
    assert.equal(new URL(loc[1]).pathname, '/sitemap.xml');
  });
});

describe('privacy and leaks', () => {
  // Built from pieces so this file does not trip its own scan.
  const NEEDLES = [['/Users', '/'], ['@gmail', '.com'], ['scratch', 'pad'], ['claude', '-501']].map((p) => p.join(''));
  const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.csv', '.xml', '.txt', '.md', '.mjs', '.py', '.gitignore', '']);
  const scan = (list) => {
    const hits = [];
    for (const file of list) {
      if (!TEXT.has(extname(file))) continue;
      const text = readFileSync(file, 'utf8');
      for (const needle of NEEDLES) if (text.includes(needle)) hits.push(`${relative(repo, file)} contains ${needle}`);
    }
    return hits;
  };
  test('docs/ is clean', () => {
    const hits = scan(files);
    assert.equal(hits.length, 0, hits.slice(0, 15).join('\n'));
  });
  test('tracked text files are clean', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean)
      .map((f) => join(repo, f)).filter((f) => existsSync(f));
    assert.ok(tracked.length > 10, 'git ls-files returned almost nothing');
    const hits = scan(tracked);
    assert.equal(hits.length, 0, hits.slice(0, 15).join('\n'));
  });
});

describe('CSV download', () => {
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  test('inpatient-only-history.csv parses with 1,861 distinct codes', () => {
    const rows = parseCsv(readFileSync(join(docs, 'data', 'inpatient-only-history.csv'), 'utf8'));
    const [header, ...body] = rows;
    assert.deepEqual(header.slice(0, 5), ['code', 'label', 'body_system', 'procedure_family', 'date']);
    assert.ok(body.length > 1861);
    const width = header.length;
    const ragged = body.filter((r) => r.length !== width);
    assert.equal(ragged.length, 0, `${ragged.length} rows with the wrong column count, e.g. ${JSON.stringify(ragged[0])}`);
    assert.equal(new Set(body.map((r) => r[0])).size, 1861);
  });
});
