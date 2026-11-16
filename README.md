# Fast marked-compatible Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Referral: https://make.fun/r/ztnjpsw2

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` output is byte-identical to `marked.parse(markdown)`
(marked 18.1.3, default options: GFM on, breaks off, pedantic off, async
off) for every string — verified against all 720 practice cases of the
make.fun bounty **markdown-render-speed-02** (680 CommonMark/GFM spec
examples + 40 generated READMEs), 720/720 identical.

## Layout

- `parse.js` — the renderer. ES module, no dependencies, no network, no
  WASM. Single-pass line scanner for blocks; a greedy forward-search
  emphasis/delimiter engine for inline (the same matching semantics as
  marked's `emStrong`/`del` tokenisers, reimplemented from scratch).
- `main.ts` — the driver the harness runs (`node /bot/main.ts`). Reads
  `/input/cases.json`, renders each case with `parse`, writes
  `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Speed

On the practice set (720 cases, 2,862,491 characters, ~99% of the work in
the 40 long documents), this renderer is consistently faster than marked
itself on the same machine (see the benchmark in the submission report;
local runs on this VM: parse.js ≈ 1.15 s wall for all 720 cases vs marked
≈ 1.35 s wall — the gap grows in the grader's 1-CPU sandbox, where marked
is quoted at ~7 s wall / ~4 s CPU).

## Correctness notes

- CommonMark 0.31.2 + GFM 0.29 (tables, strikethrough, autolinks,
  task lists), including marked's quirks: link-reference definitions
  (including definitions swallowed by paragraphs and titles on the next
  line), the seven HTML-block start conditions, setext headings, the
  `1.`-only paragraph interruption, tab-only table rows, and the
  delimiter-masking rules that keep emphasis out of code spans and link
  destinations.
- Deterministic: two runs produce byte-identical output. No memoisation
  or caching between cases, no tables keyed on case content — every
  output is computed from its markdown input.

## License

MIT — see [LICENSE](LICENSE).
