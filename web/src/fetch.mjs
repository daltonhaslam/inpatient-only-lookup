// The site's own JSON files, loaded after the page: one checked fetch, and a load-once wrapper. Used by
// the lookup (client.mjs), Revenue at stake (stake-client.mjs) and the hospital picker.

/** A same-origin JSON file; rejects on a non-2xx answer rather than parsing an error page. */
export const fetchJson = (url) => fetch(url).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`${response.status} ${url}`))));

/**
 * A JSON file loaded at most once. load() starts it (or returns the load under way) and never rejects;
 * when it settles, data holds the file or failed is true, and settled() runs (a redraw). retry: a later
 * load() after a failure tries again (failed goes back to false meanwhile); without it a failure stands
 * until the page reloads.
 */
export function lazyJson(url, { retry = false, settled = () => {} } = {}) {
  const file = {
    data: null,
    failed: false,
    pending: null,
    load() {
      if (!file.pending) {
        file.failed = false;
        file.pending = fetchJson(url)
          .then((data) => { file.data = data; }, () => { file.failed = true; if (retry) file.pending = null; })
          .then(settled)
          .catch(() => {});   // a throw while redrawing must not become an unhandled rejection
      }
      return file.pending;
    },
  };
  return file;
}
