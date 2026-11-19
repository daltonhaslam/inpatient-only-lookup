// The hospital picker's empty state, the only part of the hospital view in the national page's
// bundle: the labeled text box. hospital-picker.mjs (loaded on first use) makes it work.
import { esc } from './views.mjs';

// Where a reader first meets IME and DSH on this page, so they are spelled out here (and in the summary's
// lead after a pick); everywhere else the hospital view uses the bare acronyms.
const LABEL = 'Pick a hospital to apply its wage index and its teaching (IME) and safety-net (DSH) add-ons.';

/**
 * The page's national download links (stake.mjs downloads()) while a hospital is picked, or an ?h= landing
 * is about to show one: "Download Excel" becomes "Download national Excel", so they are not taken for the
 * hospital's (its CSV is in the bar). text: the link's text as the server wrote it. stake-client.mjs
 * switches them.
 */
export const nationalDownload = (text) => text.replace(/^Download /, 'Download national ');

/** The mount's two parts: the swapped body, and one polite status line that stays put so it is heard. */
export const SHELL = '<div data-hpick-body></div><p class="sr" role="status" data-hpick-status></p>';

/** The combobox (ARIA 1.2: a text box that owns a listbox). cancel: the picked hospital's name, while changing it. */
export const field = (cancel) => `<div class="hpick__find">
<div class="hpick__box"><label class="field hpick__field" for="hp-q"><span>${LABEL}</span>
<input id="hp-q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="hp-list" aria-describedby="hp-note" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="Hospital name, state or CCN"></label>
<div class="hpick__pop" hidden><ul class="hpick__list" id="hp-list" role="listbox" aria-label="Hospitals"></ul></div></div>
<p class="hpick__note" id="hp-note"></p>
${cancel ? `<p class="hpick__acts"><button type="button" class="hpick__btn" data-hpick-cancel>Keep ${esc(cancel)}</button></p>` : ''}
</div>`;
