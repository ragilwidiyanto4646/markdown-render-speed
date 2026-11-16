// Entry-point driver for the markdown-render-speed-02 submission.
//
// The grading harness runs `node /bot/main.ts` (Node 22, type stripping)
// with the case set mounted at /input/cases.json and collects the rendered
// HTML from /output/html.json. The two locations can be moved with
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR for local runs.
//
// The driver does no rendering of its own: it reads the cases, hands each
// markdown string to parse() from ./parse.js, and writes the HTML strings
// back out in exactly the cases' order. parse.js is dependency-free and
// does no I/O, so the only work here is moving data in and out.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const text = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(text) as Array<{ id: string; markdown: string }>;

  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
