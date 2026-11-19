// The Revenue at stake hospital view: everything drawn after a hospital is picked. The build bundles
// this file on its own (assets/hospital.*.js) and the page imports it on first use, with the hospital
// list and the hospital's file, so the national page never loads it.
// Pure: strings in, HTML strings out. Every string from data goes through esc(), the hospital's name
// included (it comes from CMS's file, but is treated as untrusted).
import { esc } from './views.mjs';
import { num } from './engine.mjs';
import { card, money } from './stake-card.mjs';
import { hospitalContext, hospitalItem, summary as summarize, teaching } from './hospital-math.mjs';
import { fractionWord, pct, addOnsOf, addOnNames, addOnsSpelled, series } from './hospital-words.mjs';
import { shortName, TEACHING_LABEL } from './hospital-pick.mjs';
import { foldsHtml, yearUpdate } from './hospital-folds.mjs';
import { hospitalCsvRows, hospitalCsvName } from './hospital-csv.mjs';

/**
 * "Teaching · IME 31.1% · DSH 7.0% · wage index 1.19". IME and DSH are CMS's operating factors
 * (TCHOP, DSHOPP); the capital ones apply too, and the summary's note says so.
 */
export function facts(h) {
  const kind = teaching(h);
  const teach = kind === 'teaching' ? `${TEACHING_LABEL.teaching} · IME ${pct(h.tchop)}` : TEACHING_LABEL[kind];
  const dsh = h.dshopp > 0 ? `DSH ${pct(h.dshopp)}` : h.dshcpp > 0 ? 'Capital DSH only' : 'No DSH';
  return `${teach} · ${dsh} · wage index ${h.wi.toFixed(2)}`;
}

/**
 * The summary in plain words, from hospital-math summary(): {lead, tiles: [[value, label]]}, or null
 * when there is nothing to compare. h: the hospital's record (its factors), so the words name only the
 * add-ons it gets. A hospital with no IME or DSH is told so in words, never "$0".
 */
function summaryText(s, name, h) {
  if (!s || s.state === 'empty') return null;
  const loss = [money(s.medianGap), 'typical loss per case if billed outpatient (median, against the lowest DRG in the family)'];
  const below = [`${num(s.below)} of ${num(s.codes)}`, `removed procedures pay ${name} less outpatient than even the lowest DRG`];
  if (s.state === 'no-gap') {
    return {
      lead: `At ${name}, a typical removed procedure pays at least as much outpatient as the lowest DRG in its family.`,
      tiles: [[money(Math.abs(s.medianGap)), `typical ${s.medianGap < 0 ? 'gain' : 'difference'} per case if billed outpatient (median, against the lowest DRG in the family)`], below],
    };
  }
  if (s.state === 'no-addons') {
    return { lead: `${name} gets ${addOnsSpelled(h)}, so what a removed procedure loses when billed outpatient is base payment only.`, tiles: [loss, below] };
  }
  return {
    lead: `At ${name}, ${fractionWord(s.ratio)} of what a removed procedure loses when billed outpatient is ${addOnsSpelled(h)}.`,
    tiles: [loss, [money(s.medianAddOn), `typical ${series(addOnNames(h))} in that lowest DRG (median)`], below],
  };
}

/** "The IME and DSH percentages above are CMS’s operating factors; …" for the factors the facts line shows as a percentage. */
function factorNote(h) {
  const shown = addOnsOf(h).filter((a) => !a.capitalOnly).map((a) => a.name);
  if (!shown.length) return '';
  const one = shown.length === 1;
  return ` The ${series(shown)} ${one ? 'percentage above is CMS’s operating factor; the capital one is' : 'percentages above are CMS’s operating factors; the capital ones are'} applied too.`;
}

/** The summary strip: the lead sentence, its numbers and what they leave out. '' with nothing to compare. h: as summaryText(). */
export function summaryHtml(s, name, h) {
  const text = summaryText(s, name, h);
  if (!text) return '';
  return `<div class="hsum">
<p class="hsum__lead">${esc(text.lead)}</p>
<dl class="hsum__nums">${text.tiles.map(([value, label]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
<p class="hsum__note">Medians over the ${num(s.codes)} removed procedures with a comparison.${esc(factorNote(h))} Uncompensated care, outliers and quality adjustments are left out (<a href="/revenue-at-stake/methods/">Methods</a>).</p>
</div>`;
}

/**
 * The words in the server's lede (stake.mjs mainPage) that a pick replaces. The national page's HTML must
 * stay byte-identical, so the lede has no element of its own to swap; stake.test.mjs fails if the built
 * lede stops containing this phrase exactly once.
 */
export const LEDE_NATIONAL = 'national and unadjusted';

/**
 * The page's lede after a pick: LEDE_NATIONAL becomes LEDE_HOSPITAL. About the same length, so the lede
 * keeps its lines and nothing below it moves (the hospital's name and factors are in the bar just below).
 * html: the lede as the server wrote it.
 */
export const LEDE_HOSPITAL = 'at this hospital’s rates';
export const hospitalLede = (html) => html.replace(LEDE_NATIONAL, LEDE_HOSPITAL);

/**
 * The words a hospital's card says around its figures (stake-card.mjs NATIONAL_CARD has the national
 * ones): whose rates, the national rate beside the wage-adjusted one, the surgery center kept national
 * (ASC wage rules differ), the add-ons it gets by name, and a link to the code page's national work in
 * place of Show the work. names: addOnNames() of the hospital.
 */
function cardVariant(item, name, names) {
  return {
    gapLead: `If billed outpatient, ${name} is paid`,
    ascLabel: 'Surgery center (ASC), national',
    rateNote: item.op.national !== undefined ? `With its wage index; national rate ${money(item.op.national)}` : '',
    opNote: item.addOn ? `No ${series(names, 'or')} add-on in either outpatient setting.` : '',
    fine: item.addOn ? `${name} rates: ${series(['wage index', ...names])} (operating and capital).` : `${name} rates: wage index. This hospital gets no IME or DSH.`,
    addOns: series(names),
    workLink: `Show the national work for ${item.code}`,
  };
}

/** The one-line "Rates for <name> (<CCN>) · facts" bar with Change, Back to national and the hospital CSV. */
function bar(name, ccn, h) {
  return `<div class="hpick__on">
<p class="hpick__who"><span class="hpick__label">Rates for</span> <strong class="hpick__name">${esc(name)} <span class="nw">(${esc(ccn)})</span></strong> <span class="hpick__facts">${facts(h).split(' · ').map((part) => `<span class="nw">${esc(part)}</span>`).join(' · ')}</span></p>
<p class="hpick__acts"><button type="button" class="hpick__btn" data-hpick-change>Change hospital</button><button type="button" class="hpick__btn" data-hpick-clear>Back to national</button><button type="button" class="hpick__btn" data-hpick-csv>Download for ${esc(name)} (CSV)</button></p>
</div>`;
}

/**
 * One picked hospital, computed once: the cards' items rewritten for it (data: prepare()'s data with
 * those items, same search index), the summary, and the HTML the page swaps in. list: the shipped
 * hospital list; record: the hospital's file; meta: the browser model's meta (years) for card().
 * The view also keeps what someone does to its cards' folds, so a redraw (a filter change) keeps it:
 * the counts typed into each card's per-year table and which folds are open. Picking another hospital
 * (a new view) starts clean; nothing is saved.
 */
export function createView({ list, record, ccn, data, meta }) {
  // year: the counts' data year, for the per-year fold and the CSV (hospital-data.mjs hospitalList).
  const year = list.meta.volume_year;
  if (!Number.isInteger(year)) throw new Error('the hospital list has no meta.volume_year');
  const ctx = { ...hospitalContext({ hospital: record, volume: record.v, meta: list.meta }), year };
  const name = shortName({ ccn, name: record.name });
  const names = addOnNames(record);
  const items = data.items.map((item) => hospitalItem(item, ctx));
  const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
  const s = summarize(data.items, ctx);
  const sev = list.meta.drg_sev || {};
  const edits = new Map();   // code -> {DRG: {trad, ma}}: the text typed
  const open = new Set();    // "<code>:split" and "<code>:year"
  const folds = (item) => foldsHtml(item, ctx, { name, sev, edits: edits.get(item.code), open: (kind) => open.has(`${item.code}:${kind}`) });
  // Each card's HTML, drawn once and kept until its counts or folds change: a search keystroke redraws
  // up to 50 cards, and their folds need not be rebuilt each time.
  const drawn = new Map();
  const draw = (item) => card(item, meta, { detail: false, variant: cardVariant(item, name, names), folds: folds(item) });
  return {
    ccn, name, ctx, summary: s,
    data: { ...data, items, byCode },
    summaryHtml: summaryHtml(s, name, record),
    barHtml: bar(name, ccn, record),
    // Said once, through the picker's polite status line.
    announce: [`Showing rates for ${name}.`, summaryText(s, name, record)?.lead].filter(Boolean).join(' '),
    csvName: hospitalCsvName(ccn),
    /** The hospital CSV's rows (hospital-csv.mjs), with every count typed so far. */
    csvRows: () => hospitalCsvRows({ items: data.items, ctx, ccn, name, edits }),
    card(item) {
      if (!drawn.has(item.code)) drawn.set(item.code, draw(item));
      return drawn.get(item.code);
    },
    /**
     * A count typed into a card's per-year table. key: "<DRG>:trad" or "<DRG>:ma"; raw: the box's text.
     * Returns yearUpdate() for that card only (never the summary or another card), or null for a key
     * the card does not have.
     */
    count(code, key, raw) {
      const item = byCode[code];
      if (!item || item.kind !== 'compare' || !ctx.addOns) return null;
      const [drg, payer] = String(key).split(':');
      const inCard = item.ip.families.some((f) => f.drgs.some((d) => d.drg === drg));
      if (!inCard || !(payer === 'trad' || (payer === 'ma' && ctx.teaching === 'teaching'))) return null;
      const typed = { ...edits.get(code), [drg]: { ...edits.get(code)?.[drg], [payer]: String(raw) } };
      edits.set(code, typed);
      drawn.delete(code);
      return yearUpdate(item, ctx, typed);
    },
    /**
     * Remember whether a card's fold (kind 'split' or 'year') is open, for the next redraw. A redrawn card
     * whose fold was already open fires a toggle too; that one changes nothing and keeps the drawn card.
     * Returns whether anything changed.
     */
    toggle(code, kind, isOpen) {
      const key = `${code}:${kind}`;
      if (open.has(key) === isOpen) return false;
      if (isOpen) open.add(key); else open.delete(key);
      drawn.delete(code);
      return true;
    },
  };
}
