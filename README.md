# Fast marked-compatible Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Referral: https://make.fun/r/ztnjpsw2

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` output is byte-identical to `marked.parse(markdown)`
(marked 18.1.3, default options: GFM on, breaks off, pedantic off, async
off) — verified against all 720 practice cases of the make.fun bounty
**markdown-render-speed-02** (680 CommonMark/GFM spec examples + 40
generated READMEs), 720/720 identical, plus 13,000 randomized
emphasis/link/code-span inputs checked against the same reference
implementation with zero divergence.

## Layout

- `parse.js` — the renderer. ES module, no dependencies, no network, no
  WASM. A single-pass line scanner for blocks; a greedy forward-search
  emphasis/delimiter engine for inline (the same matching semantics as
  marked's `emStrong`/`del` tokenisers, reimplemented from scratch).
- `main.ts` — the driver the harness runs (`node /bot/main.ts`). Reads
  `/input/cases.json`, renders each case with `parse`, writes
  `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Speed

On the practice set (720 cases, 2,862,813 characters, ~99% of the work in
the 40 long documents), measured in-process with alternating rounds
against marked 18.1.3 on this VM (Node 24, 11 rounds):

- wall time: median **1.595x** faster than marked (mean 1.571x)
- CPU time: median **1.543x** faster than marked (mean 1.496x)

The previous version of this entry measured 1.438x wall / 1.346x CPU on
the same benchmark, so the final version is about 11% faster on wall
time and about 15% faster on CPU time. The grader scores CPU time and
requires beating marked itself at 95% confidence in the final heat.

Where the speed comes from (all behaviour-preserving, verified by the
720/720 check after every change):

- **Windowed emphasis search** — `tryEmStrong`/`tryDel` no longer slice
  the whole remaining string per delimiter; they read the delimiter run
  plus one following code point (a whole code point, so astral symbols
  such as 🚀 keep their Unicode punctuation class) and search for a
  closer only up to the last possible closer run.
- **Hand-written masking** — `maskedSrc` replaces its three regex
  replacements with single-pass scanners that reproduce the regexes'
  behaviour exactly (including the code-span and link-masking rules),
  verified against the regex version on 20,000 random strings.
- **Cheaper inline loop** — the GFM autolink check runs only when the
  first character can start a URL or email address; the delimiter mask
  is computed inline instead of through a closure call per delimiter.
- **Cheaper block loop** — list continuation skips straight past the
  next item line, tab expansion returns early when there is no tab, and
  the list-looseness check is a manual scan instead of a regex.

## Correctness notes

- CommonMark 0.31.2 + GFM 0.29 (tables, strikethrough, autolinks,
  task lists), including marked's quirks: link-reference definitions
  (including definitions swallowed by paragraphs and titles on the next
  line), the seven HTML-block start conditions, setext headings, the
  `1.`-only paragraph interruption, tab-only table rows, and the
  delimiter-masking rules that keep emphasis out of code spans and link
  destinations.
- Adversarial inputs stay fast: 10k `*` in 1.5 ms, nested brackets
  (2000 deep) in 1.3 ms, mixed emphasis (20k chars) in 19.3 ms — all
  far below the 50 ms budget, no hangs, no quadratic blow-up.
- Link-reference labels live in a null-prototype store, so labels such
  as `__proto__` or `constructor` behave like ordinary labels exactly
  as in marked (an undefined one stays literal text; a defined one
  resolves to its definition) instead of leaking `Object.prototype`.
- Deterministic: two runs produce byte-identical output. No memoisation
  or caching between cases, no tables keyed on case content — every
  output is computed from its markdown input.

## License

MIT — see [LICENSE](LICENSE).
