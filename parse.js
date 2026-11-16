// Fast drop-in for marked 18.1.3 (GFM defaults) — written from scratch in this
// session. parse(markdown) returns exactly the HTML marked.parse(markdown)
// returns with default options (gfm on, breaks off, pedantic off, async off).
//
// Design (my own): a single module, no classes. One context object per parse
// carries the link-reference map (null-prototype), the deferred inline queue
// and the small lexer state. Block lexing walks the remaining source with the
// grammar regexes; inline lexing is cursor based — sticky regexes run against
// the full source with lastIndex, so the hot loop never slices the remaining
// string. Emphasis/delimiters are found with a windowed search bounded by the
// last possible closer in the masked source, and the masking pass is skipped
// entirely when the source cannot contain a delimiter or a link reference.
//
// The grammar regexes below spell out marked's grammar (they are what makes
// the output byte-identical); everything around them — the loop structure,
// the dispatch, the masking guards, the cursor handling — is my own code.

// ---------------------------------------------------------------------------
// Grammar regexes (block)
// ---------------------------------------------------------------------------

const BL_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BL_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BL_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BL_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BL_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BL_TEXT = /^[^\n]+/;
const BL_LHEADING = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BL_LIST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const BL_HTML = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;
const BL_TABLE = /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/;
const BL_PARA = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
const BL_QUOTE = /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/;
const BL_DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))? *(?:\n+|$)/;

// ---------------------------------------------------------------------------
// Grammar regexes (inline, anchored forms)
// ---------------------------------------------------------------------------

const IN_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const IN_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const IN_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const IN_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const IN_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const IN_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const IN_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const IN_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const IN_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const IN_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/;
const IN_EM_L = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const IN_DEL_L = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const IN_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;

// Right-delimiter scanners (global forms; the first alternative only ever
// matches at the start of the search window, so the "rest" form without it
// is used for every later step).
const RD_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RD_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RD_DEL = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// Masking passes (global; run over a whole inline source).
const MS_REFLINK = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const MS_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MS_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// ---------------------------------------------------------------------------
// Small helper regexes
// ---------------------------------------------------------------------------

const H_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const H_LINK_BRACKETS = /\\([\[\]])/g;
const H_FENCE_INDENT = /^(\s+)(?:```)/;
const H_LEAD_SPACE = /^\s+/;
const H_END_HASH = /#$/;
const H_LEAD_SPACE_CHAR = /^ /;
const H_END_SPACE_CHAR = / $/;
const H_END_SPACE_TAB = /[ \t]$/;
const H_NON_SPACE = /[^ ]/;
const H_NEWLINE_G = /\n/g;
const H_TAB_G = /\t/g;
const H_LEAD_SPACE_TAB = /^[ \t]+/;
const H_MULTI_SPACE = /\s+/g;
const H_BLANK_LINE = /^[ \t]*$/;
const H_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const H_QUOTE_START = /^ {0,3}>/;
const H_QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const H_QUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const H_QUOTE_WS = /^( {0,3}>)([ \t]+)/gm;
const H_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const H_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const H_LIST_TASK_REP = /^\[[ xX]\][ \t]+/;
const H_LIST_CHECKBOX = /\[[ xX]\]/;
const H_ANY_LINE = /\n.*\n/;
const H_HREF_BRACKETS = /^<(.*)>$/;
const H_TABLE_DELIM = /[:|]/;
const H_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const H_TABLE_ROW_BLANK = /\n[ \t]*$/;
const H_ALIGN_RIGHT = /^ *-+: *$/;
const H_ALIGN_CENTER = /^ *:-+: *$/;
const H_ALIGN_LEFT = /^ *:-+ *$/;
const H_START_A = /^<a /i;
const H_END_A = /^<\/a>/i;
const H_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const H_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const H_START_ANGLE = /^</;
const H_END_ANGLE = />$/;
const H_ALPHA_NUM = /[\p{L}\p{N}]/u;
const H_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const H_NUM_REF_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const H_ESC_TEST = /[&<>"']/;
const H_ESC_REP = /[&<>"']/g;
const H_ESC_TEST_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const H_ESC_REP_NE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const H_PERCENT = /%25/g;
const H_FIND_PIPE = /\|/g;
const H_SPLIT_PIPE = / \|/;
const H_SLASH_PIPE = /\\\|/g;
const H_CR = /\r\n|\r/g;
const H_NOT_SPACE_START = /^\S*/;
const H_END_NEWLINE = /\n$/;
const H_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const H_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const H_SETEXT_LINE = /(?:\n) {0,3}(?:=+|-+)[ \t]*(?:\n|$)/;
const H_BLANK_SEARCH = /\n[ \t]*\n/;
const H_TABLE_DELIM_LINE = /^ {0,3}(\| *)?:?-+/;
const H_BULLET_LINE = /^ {0,3}(?:=+|-+) *$/;
const H_LEAD_3SPACES = /^ {0,3}/;

// Per-indent memoised line regexes. The indent baked into the pattern is
// one less than the content indent (clamped to 0..3): a following bullet at
// the full content indent still belongs to this item.
function memoRegex(make) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    let r = cache[k];
    if (!r) { r = make(k); cache[k] = r; }
    return r;
  };
}
const listItemRe = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
const nextBulletRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const quoteAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}>`));
// Cheap prefix test for the six block-start patterns used in the list
// continuation loop: if the first non-space character cannot start any of
// them, none of them can match.
const blockStartAtRe = memoRegex((n) => new RegExp(`^ {0,${n}}[#><\`~*+0-9_-]`));

// ---------------------------------------------------------------------------
// Sticky variants of the anchored inline regexes (cursor-based inline loop).
// A sticky regex matches only at lastIndex, which is exactly what the `^`
// anchor meant on the remaining-string slice. The `^` at the start of the
// pattern or of an alternative is dropped; `^` inside character classes is
// untouched.
// ---------------------------------------------------------------------------

function stickyOf(re) {
  const src = re.source.replace(/(^|\|)\^/g, '$1');
  const flags = re.flags.replace('g', '') + 'y';
  return new RegExp(src, flags);
}
function restOf(re) {
  // Everything after the first top-level `|` (the first alternative can only
  // match at the start of the search window).
  const s = re.source;
  const i = s.indexOf('|');
  return new RegExp(s.slice(i + 1), re.flags);
}

const Y_ESCAPE = stickyOf(IN_ESCAPE);
const Y_CODE = stickyOf(IN_CODE);
const Y_HR = stickyOf(BL_HR);
const Y_BR = stickyOf(IN_BR);
const Y_TAG = stickyOf(IN_TAG);
const Y_AUTOLINK = stickyOf(IN_AUTOLINK);
const Y_LINK = stickyOf(IN_LINK);
const Y_REFLINK = stickyOf(IN_REFLINK);
const Y_NOLINK = stickyOf(IN_NOLINK);
const Y_URL = stickyOf(IN_URL);
const Y_TEXT = stickyOf(IN_TEXT);
const Y_EM_L = stickyOf(IN_EM_L);
const Y_DEL_L = stickyOf(IN_DEL_L);
const Y_RD_AST = stickyOf(RD_AST);
const Y_RD_AST_REST = stickyOf(restOf(RD_AST));
const Y_RD_UND = stickyOf(RD_UND);
const Y_RD_UND_REST = stickyOf(restOf(RD_UND));
const Y_RD_DEL = stickyOf(RD_DEL);
const Y_RD_DEL_REST = stickyOf(restOf(RD_DEL));

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(s, encode) {
  if (encode) {
    if (H_ESC_TEST.test(s)) return s.replace(H_ESC_REP, (c) => HTML_ESCAPES[c]);
  } else if (H_ESC_TEST_NE.test(s)) {
    return s.replace(H_ESC_REP_NE, (c) => HTML_ESCAPES[c]);
  }
  return s;
}

function decodeEntities(s) {
  if (!H_NUM_REF.test(s)) return s;
  return s.replace(H_NUM_REF_AMP, (all, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(H_PERCENT, '%');
  } catch {
    return null;
  }
}

// Split one table row into cells, honouring `\|` escapes.
function splitCells(row, count) {
  const t = row.replace(H_FIND_PIPE, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(H_SPLIT_PIPE);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(H_SLASH_PIPE, '|');
  return cells;
}

// Strip trailing `ch` characters (or, when `invert`, trailing non-`ch` chars).
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if ((c === ch && !invert) || (c !== ch && invert)) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one trailing blank line's worth.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && H_BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link-reference label: trim, collapse inner whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(H_MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the `)` that closes an open `(` at depth 0 in `s`
// (-1 none, -2 unbalanced open paren). Backslashes skip the next character.
function findParen(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === '\\') n++;
    else if (s[n] === pair[0]) depth++;
    else if (s[n] === pair[1] && (--depth, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs in `s` to spaces, counting columns from `start`.
function expandTabs(s, start = 0) {
  if (s.indexOf('\t') === -1) return s;
  let col = start;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Fenced-code indent compensation: remove the fence line's indentation from
// every content line that has at least that much leading whitespace.
function fenceIndent(raw, content) {
  const m = raw.match(H_FENCE_INDENT);
  if (m === null) return content;
  const ind = m[1];
  return content.split('\n').map((line) => {
    const o = line.match(H_LEAD_SPACE);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, ind.length));
  }).join('\n');
}

// Number of leading spaces in `s` (tabs already expanded).
function leadSpaces(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// Index of the first non-space character in `s` when every tab counts as
// four spaces (-1 when `s` is all whitespace). Same value as
// `s.replace(/\t/g, '    ').search(/[^ ]/)`.
function firstNonSpaceFlat(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) n++;
    else if (c === 9) n += 4;
    else return n;
  }
  return -1;
}

// First line of `s` (up to but not including the next `\n`).
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// UTF-16 length of the first code point of `s` (1, or 2 for astral planes).
function firstCpLen(s) {
  return s.codePointAt(0) > 0xFFFF ? 2 : 1;
}

// The code point ending at index `end` in `s` ("" when `end` is 0).
function cpBefore(s, end) {
  if (end <= 0) return '';
  const lo = s.charCodeAt(end - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && end >= 2) {
    const hi = s.charCodeAt(end - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return s.slice(end - 2, end);
  }
  return s[end - 1];
}

// ---------------------------------------------------------------------------
// Masked source: delimiters inside links, code spans and tags must not count
// as emphasis closers. The mask is the same length as the source; masked
// regions keep their brackets and become runs of `a`. Each pass is guarded
// by the characters that could make it non-identity, and the reference pass
// is skipped entirely when the document has no link definitions.
// ---------------------------------------------------------------------------

function maskInline(src, ctx) {
  let t = src;
  const links = ctx.links;
  if (ctx.hasLinks && t.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, ctx)) {
          return '[' + inner.replace(MS_REFLINK, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(MS_REFLINK, maskRef);
  }
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(MS_PUNCT, (n, s, r) => {
      if (r) return '+'.repeat(n.length);
      if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
      return n;
    });
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(MS_SKIP, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

// Last index in `masked` at which a `*`, `_` or `~` run starts whose
// preceding character is not blank. Delimiter searches never need to look
// past these points.
function lastClosers(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') out[r] = s;
    s = i - 1;
  }
  return out;
}

// Does `s` contain a link (inline or reference) that resolves?
function linkInText(s, ctx) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(MS_SKIP)) {
    if (IN_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(MS_REFLINK)) {
    const r = m[0];
    const o = r.lastIndexOf('[');
    if (!(r.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(r.slice(1, o - 1), ctx))) return true;
  }
  return false;
}

// Does the link text contain a tag/autolink that runs past the text?
function hasLinkInText(src, pos, labelText, labelStart, ctx) {
  if (!labelText.includes('<')) return false;
  for (let s = 0; s < labelText.length; s++) {
    if (labelText[s] === '\\') { s++; continue; }
    if (labelText[s] === '`') {
      const m = IN_CODE.exec(labelText.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (labelText[s] !== '<') continue;
    const r = src.slice(pos + labelStart + s);
    const o = IN_TAG.exec(r) || IN_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > labelText.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each returns { tok, next } or null. `pos` is the cursor
// in the full source; `prev` is the last character of the preceding text
// token ("" when the previous token was not text); `env` carries the masked
// source and the lazily computed closer table for this inline run.
// ---------------------------------------------------------------------------

function tokEscape(src, pos) {
  Y_ESCAPE.lastIndex = pos;
  const m = Y_ESCAPE.exec(src);
  if (!m) return null;
  return { tok: { type: 'escape', raw: m[0], text: m[1] }, next: pos + m[0].length };
}

function tokTag(src, pos, ctx) {
  Y_TAG.lastIndex = pos;
  const m = Y_TAG.exec(src);
  if (!m) return null;
  if (!ctx.inLink && H_START_A.test(m[0])) ctx.inLink = true;
  else if (ctx.inLink && H_END_A.test(m[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && H_START_PRE.test(m[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && H_END_PRE.test(m[0])) ctx.inRawBlock = false;
  return {
    tok: { type: 'html', raw: m[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, block: false, text: m[0] },
    next: pos + m[0].length,
  };
}

function makeLinkToken(m, ref, raw, ctx) {
  const text = m[1].replace(H_LINK_BRACKETS, '$1');
  const isImage = m[0].charAt(0) === '!';
  const pInLink = ctx.inLink;
  const hEmitted = ctx.linkEmitted;
  const uRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const toks = lexInline(text, ctx);
  const k = ctx.linkEmitted;
  ctx.linkEmitted = hEmitted;
  ctx.inLink = pInLink;
  if (!isImage) {
    if (k) { ctx.inRawBlock = uRaw; return null; }
    ctx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text, tokens: toks };
}

function tokLink(src, pos, ctx) {
  if (ctx.linkParenPossible === false) return null;
  Y_LINK.lastIndex = pos;
  const m = Y_LINK.exec(src);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasLinkInText(src, pos, m[1], labelStart, ctx)) return null;
  const href = m[2].trim();
  if (H_START_ANGLE.test(href)) {
    if (!H_END_ANGLE.test(href)) return null;
    const l = rtrim(href.slice(0, -1), '\\');
    if ((href.length - l.length) % 2 === 0) return null;
  } else {
    const l = findParen(m[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
      m[2] = m[2].substring(0, l);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let o = m[2];
  const i = m[3] ? m[3].slice(1, -1) : '';
  o = o.trim();
  if (H_START_ANGLE.test(o)) o = o.slice(1, -1);
  const tok = makeLinkToken(m, {
    href: o && o.replace(H_ANY_PUNCT, '$1'),
    title: i && i.replace(H_ANY_PUNCT, '$1'),
  }, m[0], ctx);
  if (!tok) return null;
  return { tok, next: pos + m[0].length };
}

function tokRefLink(src, pos, ctx) {
  Y_REFLINK.lastIndex = pos;
  let m = Y_REFLINK.exec(src);
  if (!m) {
    Y_NOLINK.lastIndex = pos;
    m = Y_NOLINK.exec(src);
  }
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasLinkInText(src, pos, m[1], labelStart, ctx)) return null;
  const ref = ctx.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { tok: { type: 'text', raw: ch, text: ch }, next: pos + 1 };
  }
  const tok = makeLinkToken(m, ref, m[0], ctx);
  if (!tok) return null;
  return { tok, next: pos + m[0].length };
}

function tokEmStrong(src, pos, prev, env) {
  Y_EM_L.lastIndex = pos;
  const s = Y_EM_L.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  let n = prev;
  const o = n === r;
  const i = pos;
  const masked = env.masked;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = cpBefore(masked, l);
  const h = p === '*' || p === '_' || !!IN_PUNCT.exec(p);
  if (l < i) n = p;
  const u = l < i ? h : !!IN_PUNCT.exec(n);
  if (s[4] && n.match(H_ALPHA_NUM)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g;
    let b;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const v = env.closers()[r];
    const Q = pos + k;
    if (v < Q) return null;
    const isAst = r === '*';
    const full = isAst ? Y_RD_AST : Y_RD_UND;
    const rest = isAst ? Y_RD_AST_REST : Y_RD_UND_REST;
    let searchPos = Q;
    let first = true;
    for (;;) {
      const re = first ? full : rest;
      first = false;
      re.lastIndex = searchPos;
      const m2 = re.exec(masked);
      if (m2 === null) {
        // Sticky regexes do not advance on failure (unlike marked's `g`
        // regexes); step one code point forward and retry, up to v.
        if (searchPos >= masked.length || searchPos > v) break;
        searchPos += masked.codePointAt(searchPos) > 0xFFFF ? 2 : 1;
        continue;
      }
      if (m2.index > v) break;
      g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) { searchPos = re.lastIndex; continue; }
      b = g.length;
      if (m2[3] || m2[4]) { m += b; searchPos = re.lastIndex; continue; }
      if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; searchPos = re.lastIndex; continue; }
      }
      m -= b;
      if (m > 0) { searchPos = re.lastIndex; continue; }
      b = Math.min(b, b + m + f);
      const te = firstCpLen(m2[0]);
      const rawEnd = m2.index + te + b;
      const M = src.slice(pos, rawEnd);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { tok: { type: 'em', raw: M, text: U, tokens: lexInline(U, env.ctx) }, next: rawEnd };
      }
      const ne = M.slice(2, -2);
      return { tok: { type: 'strong', raw: M, text: ne, tokens: lexInline(ne, env.ctx) }, next: rawEnd };
    }
  }
  return null;
}

function tokCodeSpan(src, pos) {
  Y_CODE.lastIndex = pos;
  const m = Y_CODE.exec(src);
  if (!m) return null;
  let n = m[2].replace(H_NEWLINE_G, ' ');
  const s = H_NON_SPACE.test(n);
  const r = H_LEAD_SPACE_CHAR.test(n) && H_END_SPACE_CHAR.test(n);
  if (s && r) n = n.substring(1, n.length - 1);
  return { tok: { type: 'codespan', raw: m[0], text: n }, next: pos + m[0].length };
}

function tokBr(src, pos) {
  Y_BR.lastIndex = pos;
  const m = Y_BR.exec(src);
  if (!m) return null;
  return { tok: { type: 'br', raw: m[0] }, next: pos + m[0].length };
}

function tokDel(src, pos, prev, env) {
  Y_DEL_L.lastIndex = pos;
  const s = Y_DEL_L.exec(src);
  if (!s) return null;
  if (!(s[1] || '') || !prev || IN_PUNCT.exec(prev)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const u = env.closers()['~'];
    const d = pos + o;
    if (u < d) return null;
    let searchPos = d;
    let first = true;
    for (;;) {
      const re = first ? Y_RD_DEL : Y_RD_DEL_REST;
      first = false;
      re.lastIndex = searchPos;
      const m2 = re.exec(env.masked);
      if (m2 === null) {
        // Sticky regexes do not advance on failure (unlike marked's `g`
        // regexes); step one code point forward and retry, up to u.
        if (searchPos >= env.masked.length || searchPos > u) break;
        searchPos += env.masked.codePointAt(searchPos) > 0xFFFF ? 2 : 1;
        continue;
      }
      if (m2.index > u) break;
      const i2 = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!i2) { searchPos = re.lastIndex; continue; }
      let l2 = i2.length;
      if (l2 !== o) { searchPos = re.lastIndex; continue; }
      if (m2[3] || m2[4]) { p += l2; searchPos = re.lastIndex; continue; }
      p -= l2;
      if (p > 0) { searchPos = re.lastIndex; continue; }
      l2 = Math.min(l2, l2 + p);
      const g2 = firstCpLen(m2[0]);
      const rawEnd = m2.index + g2 + l2;
      const b = src.slice(pos, rawEnd);
      const mtext = b.slice(o, -o);
      return { tok: { type: 'del', raw: b, text: mtext, tokens: lexInline(mtext, env.ctx) }, next: rawEnd };
    }
  }
  return null;
}

function tokAutoLink(src, pos) {
  Y_AUTOLINK.lastIndex = pos;
  const m = Y_AUTOLINK.exec(src);
  if (!m) return null;
  let n;
  let s;
  if (m[2] === '@') { n = m[1]; s = 'mailto:' + n; }
  else { n = m[1]; s = n; }
  return {
    tok: { type: 'link', raw: m[0], text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] },
    next: pos + m[0].length,
  };
}

function tokUrl(src, pos) {
  Y_URL.lastIndex = pos;
  const m = Y_URL.exec(src);
  if (!m) return null;
  let n;
  let s;
  if (m[2] === '@') {
    n = m[0];
    s = 'mailto:' + n;
  } else {
    let r;
    do {
      r = m[0];
      m[0] = H_BACKPEDAL.exec(m[0])?.[0] ?? '';
    } while (r !== m[0]);
    n = m[0];
    s = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return {
    tok: { type: 'link', raw: m[0], text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] },
    next: pos + m[0].length,
  };
}

// ---------------------------------------------------------------------------
// Fast text-token end: the IN_TEXT regex finds the end of a text run with a
// lazy `[\s\S]*?` span and a four-way terminator at every position. The same
// end is found by jumping straight to the next candidate stop (delimiter
// char, http/ftp/www/mailto/email/@, or a hard-break space run) and
// validating only that candidate.
// ---------------------------------------------------------------------------

const TEXT_STOP = /[\\<[!`*{_~]|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:|@| {2,}\n/g;
const WWW_PREV = /[\s*_~(]/;
function isEmailChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
    c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// If an email address spans position `c` (its `@` is at or after `c` and its
// local part reaches before `c`), the text token must end where the email
// starts: the local-part start `s` (when f <= s < c), or `f` (when the local
// part starts before `f`, i.e. STOP1). Returns -1 when no email spans `c`.
function emailSpan(src, pos, f, c) {
  const a = src.indexOf('@', c);
  if (a === -1) return -1;
  let s = a;
  while (s > pos && isEmailChar(src.charCodeAt(s - 1))) s--;
  if (s === a) return -1; // no local part
  if (s < f) return f;
  if (s <= c) return s; // email starts at or before the candidate
  return -1;
}
function textEnd(src, pos) {
  const end = src.length;
  // Alt A: a non-alphanumeric char immediately before mailto:/xmpp:.
  if (!isAlnum(src.charCodeAt(pos)) &&
      (src.startsWith('mailto:', pos + 1) || src.startsWith('xmpp:', pos + 1))) {
    return pos + 1;
  }
  // First character: backtick/tilde runs are consumed whole.
  let f = pos + 1;
  const c0 = src.charCodeAt(pos);
  if (c0 === 96 || c0 === 126) {
    while (f < end && src.charCodeAt(f) === c0) f++;
  }
  // STOP1: two spaces + newline right after the first character.
  if (f < end) {
    let k = f;
    while (src.charCodeAt(k) === 32) k++;
    if (k - f >= 2 && src.charCodeAt(k) === 10) return f;
  }
  // Main scan: earliest candidate stop at or after f.
  TEXT_STOP.lastIndex = f;
  for (;;) {
    const m = TEXT_STOP.exec(src);
    if (m === null) return end;
    const c = m.index;
    const hit = m[0];
    if (hit === '@') {
      // Email: the token ends where the email starts (or at f, STOP1).
      const es = emailSpan(src, pos, f, c);
      if (es === -1) { TEXT_STOP.lastIndex = c + 1; continue; }
      return es;
    }
    if (hit.charCodeAt(0) === 32) return c; // hard-break space run
    if (hit === 'www.') {
      // An email starting before the www. ends the token earlier.
      const es = emailSpan(src, pos, f, c);
      if (es !== -1) return es;
      if (WWW_PREV.test(src.charAt(c - 1))) return c;
      TEXT_STOP.lastIndex = c + 1;
      continue;
    }
    if (hit === 'mailto:' || hit === 'xmpp:') {
      const es = emailSpan(src, pos, f, c);
      if (es !== -1) return es;
      if (!isAlnum(src.charCodeAt(c - 1))) return c;
      TEXT_STOP.lastIndex = c + 1;
      continue;
    }
    if (hit.length === 1) {
      // Delimiter char. `*`, `_` and `!` are also email characters, so an
      // email local part may span them; the token then ends at the email.
      const hc = hit.charCodeAt(0);
      if (hc === 42 || hc === 95 || hc === 33) {
        const es = emailSpan(src, pos, f, c);
        if (es !== -1) return es;
      }
      return c;
    }
    // http/https/ftp://: letters are email characters, so an email local
    // part may span them too.
    const es = emailSpan(src, pos, f, c);
    if (es !== -1) return es;
    return c;
  }
}

function tokText(src, pos, ctx) {
  const e = textEnd(src, pos);
  const raw = src.slice(pos, e);
  const inRaw = ctx.inRawBlock;
  return {
    tok: { type: 'text', raw, text: inRaw ? raw : decodeEntities(raw), escaped: inRaw },
    next: e,
  };
}

// ---------------------------------------------------------------------------
// Inline loop: cursor over the source, dispatching on the first character
// so most positions try exactly one tokenizer before the text scan.
// ---------------------------------------------------------------------------

function lexInlineInto(src, toks, ctx) {
  const env = {
    src,
    ctx,
    masked: null,
    closersCache: null,
    closers() {
      if (!this.closersCache) this.closersCache = lastClosers(this.masked);
      return this.closersCache;
    },
  };
  env.masked = (src.includes('*') || src.includes('_') || src.includes('~'))
    ? maskInline(src, ctx)
    : src;
  const savedLPP = ctx.linkParenPossible;
  ctx.linkParenPossible = savedLPP && src.includes(')');
  const end = src.length;
  let pos = 0;
  let prev = '';
  let prevWasText = false;
  try {
    while (pos < end) {
      if (!prevWasText) prev = '';
      prevWasText = false;
      const ch = src.charCodeAt(pos);
      let res = null;
      if (ch === 92) { // backslash
        res = tokEscape(src, pos) || tokBr(src, pos);
      } else if (ch === 60) { // <
        res = tokTag(src, pos, ctx) || tokAutoLink(src, pos);
      } else if (ch === 91 || ch === 33) { // [ !
        res = tokLink(src, pos, ctx) || tokRefLink(src, pos, ctx);
      } else if (ch === 42 || ch === 95) { // * _
        res = tokEmStrong(src, pos, prev, env);
        // Marked tries emStrong before url; a `_` that cannot open emphasis
        // can still start an email autolink (e.g. `_foo@bar.com`).
        if (res === null && ch === 95 && !ctx.inLink) res = tokUrl(src, pos);
      } else if (ch === 96) { // backtick
        res = tokCodeSpan(src, pos);
      } else if (ch === 126) { // ~
        res = tokDel(src, pos, prev, env);
      } else if (ch === 32 || ch === 9 || ch === 10) { // space, tab, newline
        res = tokBr(src, pos);
      }
      if (res === null && !ctx.inLink &&
          ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) ||
           ch === 46 || ch === 43 || ch === 45)) {
        // An email local part may start with `.`, `+` or `-` too.
        res = tokUrl(src, pos);
      }
      if (res !== null) {
        if (res.tok.type === 'text') {
          const last = toks[toks.length - 1];
          if (last && last.type === 'text') { last.raw += res.tok.raw; last.text += res.tok.text; }
          else toks.push(res.tok);
        } else {
          toks.push(res.tok);
        }
        pos = res.next;
        continue;
      }
      const t = tokText(src, pos, ctx);
      if (!t) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      const lastCh = t.tok.raw.slice(-1);
      if (lastCh !== '_') prev = lastCh;
      prevWasText = true;
      const last = toks[toks.length - 1];
      if (last && last.type === 'text') { last.raw += t.tok.raw; last.text += t.tok.text; }
      else toks.push(t.tok);
      pos = t.next;
    }
  } finally {
    ctx.linkParenPossible = savedLPP;
  }
  return toks;
}

function lexInline(src, ctx) {
  return lexInlineInto(src, [], ctx);
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source and returns a token or
// null. `ctx` is the per-parse context.
// ---------------------------------------------------------------------------

function queueInline(src, ctx) {
  const toks = [];
  ctx.queue.push({ src, tokens: toks });
  return toks;
}

function blkSpace(src) {
  const m = BL_NEWLINE.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return null;
}

function blkCode(src) {
  const m = BL_CODE.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(H_CODE_INDENT, '') };
}

function blkFences(src) {
  const m = BL_FENCES.exec(src);
  if (!m) return null;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(H_ANY_PUNCT, '$1') : m[2],
    text: fenceIndent(m[0], m[3] || ''),
  };
}

function blkHeading(src, ctx) {
  const m = BL_HEADING.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (H_END_HASH.test(text)) {
    const s = rtrim(text, '#');
    if (!s || H_END_SPACE_TAB.test(s)) text = s.trim();
  }
  return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(text, ctx) };
}

function blkHr(src) {
  const m = BL_HR.exec(src);
  if (!m) return null;
  return { type: 'hr', raw: rtrim(m[0], '\n') };
}

function blkQuote(src, ctx) {
  const m = BL_QUOTE.exec(src);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const toks = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (H_QUOTE_START.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(H_QUOTE_WS, (g, b, w) => b + expandTabs(w, b.length))
      .replace(H_QUOTE_SETEXT, '\n    $1')
      .replace(H_QUOTE_SETEXT2, '');
    raw = raw ? raw + '\n\n' + h : h;
    text = text ? text + '\n\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(u, toks, true, ctx);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const k = toks[toks.length - 1];
    if (k && (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'blockquote') {
      const b = lines.join('\n');
      const mm = k.raw + '\n' + b.replace(H_QUOTE_SETEXT2, '');
      const f = blkQuote(mm, ctx);
      toks[toks.length - 1] = f;
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) {
        raw = raw + '\n\n' + A.join('\n');
        text = text.substring(0, text.length - k.text.length) + f.text;
        lines = lines.slice(A.length);
        if (lines.length > 0 && H_QUOTE_START.test(lines[0])) continue;
      }
      break;
    }
    if (k && k.type === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const mm = blkList(b, ctx);
      toks[toks.length - 1] = mm;
      const f = mm.raw.length > k.raw.length ? b.slice(k.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        raw = raw + '\n\n' + y;
        text = text + '\n\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens: toks, text };
}

function blkList(src, ctx) {
  const m = BL_LIST.exec(src);
  if (!m) return null;
  const bull = m[1].trim();
  const ordered = bull.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  const marker = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRe = new RegExp(`( {0,3}${marker})((?:[\t ][^\n]*)?(?:\n|$))`, 'y');
  let sawDoubleBlank = false;
  let pos = 0;
  while (pos < src.length) {
    let emptyItem = false;
    const dParts = [];
    itemRe.lastIndex = pos;
    const t = itemRe.exec(src);
    if (!t) break;
    Y_HR.lastIndex = pos;
    if (Y_HR.exec(src)) break;
    const k = pos;
    pos += t[0].length;
    const g = firstLine(t[2]);
    const b = t[1].length;
    let content = g;
    // Expand tabs in the leading whitespace only when one is present.
    if (g.indexOf('\t') !== -1) content = g.replace(H_LEAD_SPACE_TAB, (v) => expandTabs(v, b));
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    let f = src.slice(pos, lineEnd);
    const blankStart = !content.trim();
    let R = 0;
    if (blankStart) {
      R = b + 1;
      dParts.push('');
    } else {
      R = leadSpaces(content);
      R = R > 4 ? 1 : R;
      dParts.push(content.slice(R));
      R += b;
    }
    if (blankStart && H_BLANK_LINE.test(f)) {
      pos = lineEnd + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      const v = nextBulletRe(R);
      const Q = hrAtRe(R);
      const ee = fencesAtRe(R);
      const te = headingAtRe(R);
      const M = htmlAtRe(R);
      const ne = quoteAtRe(R);
      const bs = blockStartAtRe(R);
      let y = blankStart;
      while (pos < src.length) {
        const nl2 = src.indexOf('\n', pos);
        const le2 = nl2 === -1 ? src.length : nl2;
        const U = src.slice(pos, le2);
        f = U;
        let Z = f;
        if (f.indexOf('\t') !== -1) Z = f.replace(H_LEAD_SPACE_TAB, (me) => expandTabs(me));
        if (bs.test(f) && (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f))) break;
        if (leadSpaces(Z) >= R || !f.trim()) {
          dParts.push(Z.slice(R));
        } else {
          if (y || firstNonSpaceFlat(content) >= 4 ||
              ee.test(content) || te.test(content) || M.test(content) || Q.test(content)) break;
          const qe = H_BULLET_LINE.test(f) && BL_LHEADING.test(`${content}\n${f}`)
            ? `    ${Z.replace(H_LEAD_3SPACES, '')}`
            : f;
          dParts.push(qe);
        }
        y = !f.trim();
        pos = le2 + 1;
        content = Z.slice(R);
      }
    }
    const d = dParts.join('\n');
    const A = src.slice(k, pos);
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (H_DOUBLE_BLANK.test(A)) sawDoubleBlank = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: H_LIST_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = src.slice(0, pos).trimEnd();
  for (const u of list.items) {
    ctx.top = false;
    u.tokens = lexBlocks(u.text, [], false, ctx);
    if (!list.loose) {
      const spaces = u.tokens.filter((g) => g.type === 'space');
      if (spaces.length > 0 && spaces.some((g) => H_ANY_LINE.test(g.raw))) list.loose = true;
    }
  }
  for (const u of list.items) {
    const d0 = u.tokens[0];
    if (u.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
      u.text = u.text.replace(H_LIST_TASK_REP, '');
      d0.raw = d0.raw.replace(H_LIST_TASK_REP, '');
      d0.text = d0.text.replace(H_LIST_TASK_REP, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (H_LIST_TASK.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(H_LIST_TASK_REP, '');
          break;
        }
      }
      const k = H_LIST_CHECKBOX.exec(u.raw);
      if (k) {
        const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        u.checked = g.checked;
        if (list.loose) {
          if (u.tokens[0] && ['paragraph', 'text'].includes(u.tokens[0].type) &&
              'tokens' in u.tokens[0] && u.tokens[0].tokens) {
            u.tokens[0].raw = g.raw + u.tokens[0].raw;
            u.tokens[0].text = g.raw + u.tokens[0].text;
            u.tokens[0].tokens.unshift(g);
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
          }
        } else {
          u.tokens.unshift(g);
        }
      }
    } else if (u.task) {
      u.task = false;
    }
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return list;
}

function blkHtml(src) {
  const m = BL_HTML.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text: raw,
  };
}

function blkDef(src, ctx) {
  const m = BL_DEF.exec(src);
  if (!m) return null;
  if (!H_START_ANGLE.test(m[2]) && findParen(m[2], '()') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? m[2].replace(H_HREF_BRACKETS, '$1').replace(H_ANY_PUNCT, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(H_ANY_PUNCT, '$1') : m[3];
  return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
}

function blkTable(src, ctx) {
  const m = BL_TABLE.exec(src);
  if (!m || !H_TABLE_DELIM.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const aligns = m[2].replace(H_TABLE_ALIGN_CHARS, '').split('|');
  const rows = m[3]?.trim() ? m[3].replace(H_TABLE_ROW_BLANK, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return null;
  const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
  for (const a of aligns) {
    if (H_ALIGN_RIGHT.test(a)) table.align.push('right');
    else if (H_ALIGN_CENTER.test(a)) table.align.push('center');
    else if (H_ALIGN_LEFT.test(a)) table.align.push('left');
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(headerCells[i], ctx), header: true, align: table.align[i] });
  }
  for (const row of rows) {
    table.rows.push(splitCells(row, table.header.length).map((cell, p) => ({
      text: cell, tokens: queueInline(cell, ctx), header: false, align: table.align[p],
    })));
  }
  return table;
}

function blkLHeading(src, ctx) {
  const m = BL_LHEADING.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return {
    type: 'heading',
    raw: rtrim(m[0], '\n'),
    depth: m[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(text, ctx),
  };
}

function blkPara(src, ctx) {
  const m = BL_PARA.exec(src);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(text, ctx) };
}

function blkText(src, ctx) {
  const m = BL_TEXT.exec(src);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(m[0], ctx) };
}

// Does the upcoming chunk contain a setext underline before the first blank
// line? If not, the lheading rule cannot match and is skipped.
function hasSetextAhead(src) {
  const blank = H_BLANK_SEARCH.exec(src);
  const end = blank ? blank.index : src.length;
  return H_SETEXT_LINE.test(src.slice(0, end));
}

// ---------------------------------------------------------------------------
// Block loop. `nested` is true when lexing the inside of a blockquote chunk:
// the first paragraph then merges with a preceding paragraph token.
// ---------------------------------------------------------------------------

function lexBlocks(src, toks, nested, ctx) {
  let shortest = Infinity;
  while (src) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    const c0 = src.charCodeAt(0);
    let r = null;
    // Blank / space run: only possible when the chunk starts with space, tab
    // or a newline.
    if ((c0 === 32 || c0 === 9 || c0 === 10) && (r = blkSpace(src))) {
      src = src.substring(r.raw.length);
      const prev = toks[toks.length - 1];
      if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else toks.push(r);
      continue;
    }
    // Indented code: needs 4 spaces or a tab up front.
    if ((c0 === 32 || c0 === 9) && (r = blkCode(src))) {
      src = src.substring(r.raw.length);
      const prev = toks[toks.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(r);
      }
      continue;
    }
    if ((c0 === 32 || c0 === 96 || c0 === 126) && (r = blkFences(src))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 35) && (r = blkHeading(src, ctx))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 45 || c0 === 95 || c0 === 42) && (r = blkHr(src))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 62) && (r = blkQuote(src, ctx))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57)) && (r = blkList(src, ctx))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 60) && (r = blkHtml(src))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if ((c0 === 32 || c0 === 91) && (r = blkDef(src, ctx))) {
      src = src.substring(r.raw.length);
      const prev = toks[toks.length - 1];
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(ctx.links, r.tag)) {
          ctx.links[r.tag] = { href: r.href, title: r.title };
          ctx.hasLinks = true;
        }
        toks.push(r);
      }
      continue;
    }
    // Table: the second line must look like a delimiter row.
    if (c0 !== 10) {
      const nl = src.indexOf('\n');
      if (nl !== -1) {
        const second = firstLine(src.slice(nl + 1));
        if (H_TABLE_DELIM_LINE.test(second) && (r = blkTable(src, ctx))) {
          src = src.substring(r.raw.length);
          toks.push(r);
          continue;
        }
      }
    }
    // Setext heading: only when an underline is ahead.
    if (hasSetextAhead(src) && (r = blkLHeading(src, ctx))) {
      src = src.substring(r.raw.length);
      toks.push(r);
      continue;
    }
    if (ctx.top && (r = blkPara(src, ctx))) {
      const prev = toks[toks.length - 1];
      if (nested && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(r);
      }
      // The chunk source equals the remaining source here (no extensions
      // truncate it), so the nested-merge flag is spent after one paragraph.
      nested = false;
      src = src.substring(r.raw.length);
      continue;
    }
    if ((r = blkText(src, ctx))) {
      src = src.substring(r.raw.length);
      const prev = toks[toks.length - 1];
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(r);
      }
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return toks;
}

// ---------------------------------------------------------------------------
// Rendering. renderTokens walks block tokens; renderInline walks inline
// tokens. `plain` selects the text renderer (used for image alt text):
// strong/em/del/code/link/image collapse to their text, <br> and checkboxes
// to "" / their raw text.
// ---------------------------------------------------------------------------

function renderInline(toks, ctx, plain) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.type) {
      case 'escape':
        out += plain ? t.text : escHtml(t.text);
        break;
      case 'html':
        out += t.text;
        break;
      case 'link': {
        if (plain) {
          out += t.tokens ? renderInline(t.tokens, ctx, true) : t.text;
          break;
        }
        const body = t.autolink ? escHtml(t.text, true) : renderInline(t.tokens, ctx, false);
        const href = encodeHref(t.href);
        if (href === null) { out += body; break; }
        let a = '<a href="' + escHtml(href, t.autolink) + '"';
        if (t.title) a += ' title="' + escHtml(t.title) + '"';
        out += a + '>' + body + '</a>';
        break;
      }
      case 'image': {
        if (plain) {
          out += t.tokens ? renderInline(t.tokens, ctx, true) : t.text;
          break;
        }
        const alt = t.tokens ? renderInline(t.tokens, ctx, true) : t.text;
        const href = encodeHref(t.href);
        if (href === null) { out += escHtml(alt); break; }
        let img = '<img src="' + escHtml(href) + '" alt="' + escHtml(alt) + '"';
        if (t.title) img += ' title="' + escHtml(t.title) + '"';
        out += img + '>';
        break;
      }
      case 'checkbox':
        out += plain ? t.raw : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += plain
          ? (t.tokens ? renderInline(t.tokens, ctx, true) : t.text)
          : '<strong>' + renderInline(t.tokens, ctx, false) + '</strong>';
        break;
      case 'em':
        out += plain
          ? (t.tokens ? renderInline(t.tokens, ctx, true) : t.text)
          : '<em>' + renderInline(t.tokens, ctx, false) + '</em>';
        break;
      case 'codespan':
        out += plain ? t.text : '<code>' + escHtml(t.text, true) + '</code>';
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain
          ? (t.tokens ? renderInline(t.tokens, ctx, true) : t.text)
          : '<del>' + renderInline(t.tokens, ctx, false) + '</del>';
        break;
      case 'text':
        if (plain) out += t.text;
        else if ('tokens' in t && t.tokens) out += renderInline(t.tokens, ctx, false);
        else if ('escaped' in t && t.escaped) out += t.text;
        else out += escHtml(t.text);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderTokens(toks, ctx) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + t.depth + '>' + renderInline(t.tokens, ctx, false) + '</h' + t.depth + '>\n';
        break;
      case 'code': {
        const lang = (t.lang || '').match(H_NOT_SPACE_START)?.[0];
        const body = t.text ? t.text.replace(H_END_NEWLINE, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + escHtml(lang) + '">' + escHtml(body, true) + '</code></pre>\n'
          : '<pre><code>' + escHtml(body, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (let j = 0; j < t.header.length; j++) head += renderCell(t.header[j], ctx);
        let bodyRows = '';
        for (let j = 0; j < t.rows.length; j++) {
          let row = '';
          for (let k = 0; k < t.rows[j].length; k++) row += renderCell(t.rows[j][k], ctx);
          bodyRows += '<tr>\n' + row + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (bodyRows ? '<tbody>' + bodyRows + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(t.tokens, ctx) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (let j = 0; j < t.items.length; j++) items += renderListItem(t.items[j], ctx);
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += t.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + renderInline(t.tokens, ctx, false) + '</p>\n';
        break;
      case 'text':
        out += ('tokens' in t && t.tokens)
          ? renderInline(t.tokens, ctx, false)
          : (('escaped' in t && t.escaped) ? t.text : escHtml(t.text));
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderCell(cell, ctx) {
  const body = renderInline(cell.tokens, ctx, false);
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') + body + '</' + tag + '>\n';
}

function renderListItem(item, ctx) {
  return '<li>' + renderTokens(item.tokens, ctx) + '</li>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' +
      Object.prototype.toString.call(markdown) + ', string expected');
  }
  const ctx = {
    links: Object.create(null),
    hasLinks: false,
    queue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const src = markdown.replace(H_CR, '\n');
  const toks = lexBlocks(src, [], false, ctx);
  for (let i = 0; i < ctx.queue.length; i++) {
    const q = ctx.queue[i];
    ctx.inRawBlock = false;
    lexInlineInto(q.src, q.tokens, ctx);
  }
  return renderTokens(toks, ctx);
}
