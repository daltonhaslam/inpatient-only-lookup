// The hospital view's tests' shared setup: the real derived tables, loaded the way the browser gets
// them (the shipped list, the browser model, each hospital's file). Not a test file itself
// (npm test runs test/*.test.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, clientModel } from '../src/stake-data.mjs';
import { prepare } from '../src/stake-engine.mjs';
import { hospitalList, hospitalRecord } from '../src/hospital-data.mjs';
import { createView } from '../src/hospital-view.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A repo file's JSON, freshly parsed (a test may change its copy). */
export const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
export const hospitals = read('pipeline/derived/hospitals.json');
export const volume = read('pipeline/derived/drg-volume.json');
export const model = normalize(read('pipeline/derived/crosswalk.json'));
// Round-tripped through JSON, as the browser receives them.
export const list = JSON.parse(JSON.stringify(hospitalList(hospitals, model, volume.meta)));
export const doc = JSON.parse(JSON.stringify(clientModel(model, [], [])));
export const data = prepare(doc);
/** One hospital's shipped file. */
export const recordOf = (ccn) => JSON.parse(JSON.stringify(hospitalRecord(hospitals.hospitals[ccn], volume.volume[ccn], volume.meta.drgs)));
/** A hospital's view, from its file (or a changed copy) and the list (or a changed copy). */
export const viewOf = (ccn, record = recordOf(ccn), from = list) => createView({ list: from, record, ccn, data, meta: doc.meta });
