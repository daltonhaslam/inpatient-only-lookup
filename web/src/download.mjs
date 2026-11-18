// Save rows built in the browser as a CSV file: the lookup's bulk check (client.mjs) and the hospital
// CSV (hospital-picker.mjs). engine.mjs csv() makes the text, so every cell passes its formula guard.
import { csv } from './engine.mjs';

export function saveCsv(rows, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv' }));
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
