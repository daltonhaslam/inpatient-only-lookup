// One polite status line per page part: what a screen reader hears after something changes. A burst of
// changes (typing, a count being edited) is said once, when it settles.

/** How long a status waits for typing to settle before it is said. */
const SETTLE_MS = 400;

/** say(text) sets region's text once changes settle; say.now(text) sets it at once (and drops a pending one). */
export function announcer(region) {
  let timer = 0;
  const say = (text) => {
    clearTimeout(timer);
    timer = setTimeout(() => { region.textContent = text; }, SETTLE_MS);
  };
  say.now = (text) => {
    clearTimeout(timer);
    region.textContent = text;
  };
  return say;
}
