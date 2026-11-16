// Driver for the markdown-render-speed-02 entry (final version).
//
// The grading harness executes `node /bot/main.ts` (Node 22) with the
// cases mounted at /input/cases.json and expects the rendered HTML at
// /output/html.json. Each case is an object {id, markdown}; the output is
// a JSON array of HTML strings in exactly the cases' order, one per case.
//
// Outside the grading container the same paths can be overridden through
// the environment: MAKEFUN_INPUT_DIR replaces /input and
// MAKEFUN_OUTPUT_DIR replaces /output. Rendering itself lives entirely
// in ./parse.js (dependency-free, no network, no WASM); this file only
// moves data in and out.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(rawCases) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(cases.length);
for (let index = 0; index < cases.length; index++) {
  rendered[index] = parse(cases[index].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
