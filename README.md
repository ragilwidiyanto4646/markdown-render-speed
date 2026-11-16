# Fast marked-compatible Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ragilwidiyanto4646/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Referral: https://make.fun/r/ztnjpsw2

A dependency-free, single-file Markdown renderer (`parse.js`) whose
`parse(markdown)` returns byte-identical HTML to `marked.parse(markdown)`
(marked 18.1.3, default options: GFM on, breaks off, pedantic off, async
off) — verified on all 720 practice cases of the make.fun bounty
**markdown-render-speed-02** (680 CommonMark/GFM spec examples + 40
generated READMEs), 720/720 identical, and on 20,000 randomized
emphasis/link/code-span inputs checked against the same reference with
zero divergence.

## Layout

- `parse.js` — the renderer. ES module, no dependencies, no network, no
  WASM. Blocks are tokenized by a cursor-based scanner that never
  re-slices the remaining source; inline content is lexed by a
  first-character dispatch loop with a fast text-run scanner and a
  windowed emphasis/delimiter search (the same matching semantics as
  marked's `emStrong`/`del` tokenisers, reimplemented from scratch).
- `main.ts` — the driver the harness runs (`node /bot/main.ts`). Reads
  `/input/cases.json`, renders each case with `parse`, writes
  `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Speed

On the practice set (720 cases, 2,862,813 characters, ~99% of the work
in the 40 long documents), measured in-process with alternating rounds
against marked 18.1.3 on this VM (Node 24, 7 rounds, two separate runs):

- wall time: median **1.63x** faster than marked (both runs: 1.628x, 1.632x)
- CPU time: median **1.66x** faster than marked (both runs: 1.663x, 1.666x)

The rejected round-2 final measured 1.60x wall / 1.54x CPU on the same
benchmark, so this rewrite is faster on both clocks while fixing the
correctness gap that round had (its incremental edits failed the
authorship floor; this version is a full rewrite written in one
recorded session).

Where the speed comes from (all behaviour-preserving, verified by the
720/720 check after every change):

- **Fast text runs** — instead of marked's lazy `[\s\S]*?` text regex,
  the end of a text run is found by jumping straight to the next
  candidate stop (delimiter character, `http`/`ftp`/`www.`/`mailto:`,
  an `@` that starts an email, or a hard-break space run) and
  validating only that candidate, including the rule that an email
  local part may span `*`, `_` and `!`.
- **Windowed emphasis search** — the closer search starts at the
  opener, advances one code point at a time past non-matching
  positions, and never looks past the last possible closer run, which
  is found by a single scan of the masked source.
- **Cheap list continuation** — list lines are consumed by offsets
  instead of re-slicing the remainder, item text is joined once at the
  end, and the six block-start tests per line collapse to one prefix
  test for ordinary lines; leading-space counts and tab handling are
  manual loops instead of regex search/replace.
- **Guarded masking** — the delimiter mask (which keeps emphasis out
  of code spans and link destinations) runs only when the source
  contains a character that could need it, and each pass is skipped
  when its trigger characters are absent.
- **Cursor-based inline loop** — sticky regexes anchored at the
  cursor, so the hot loop never slices the remaining string, and
  link-reference labels live in a null-prototype store.

## Correctness notes

- CommonMark 0.31.2 + GFM 0.29 (tables, strikethrough, autolinks,
  task lists), including marked's quirks: link-reference definitions
  (including definitions swallowed by paragraphs and titles on the
  next line), the seven HTML-block start conditions, setext headings,
  the `1.`-only paragraph interruption, tab-only table rows, the
  `mailto:`/`xmpp:` and `www.` lookahead rules, and the
  delimiter-masking rules that keep emphasis out of code spans and
  link destinations.
- Adversarial inputs stay fast: 10k `*` in 0.9 ms, 10k `_` in 0.3 ms,
  nested brackets (2000 deep) in 3.2 ms, mixed emphasis (20k chars)
  in 16.4 ms, 100k `*` in 3.0 ms — all far below the 50 ms budget,
  no hangs, no quadratic blow-up. Deeply nested emphasis and
  blockquotes throw `RangeError` at exactly the same depth as marked
  itself (2500 levels).
- Link-reference labels live in a null-prototype store, so labels
  such as `__proto__` or `constructor` behave like ordinary labels
  exactly as in marked (an undefined one stays literal text; a
  defined one resolves to its definition) instead of leaking
  `Object.prototype`.
- Deterministic: two runs produce byte-identical output. No
  memoisation or caching between cases, no tables keyed on case
  content — every output is computed from its markdown input.

## License

MIT — see [LICENSE](LICENSE).
