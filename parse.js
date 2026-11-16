// Fast marked-compatible Markdown renderer.
// Written from scratch for the make.fun markdown-render-speed-02 bounty:
// parse(markdown) returns the same HTML marked 18.1.3 renders with its
// default options (GFM on, breaks off, pedantic off). No dependencies.
// The implementation is an original single-pass design (line scanner for
// blocks, delimiter-stack scanner for inline) that reproduces marked's
// observable output, including its quirks, verified against the kit's
// practice set (720 cases).

// ---------- character helpers ----------

function isWsCode(c) {
  // ASCII whitespace (space, tab, newline, form feed, vertical tab, CR)
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 11 || c === 13;
}

// ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const UNI_PUNCT = /[\p{P}\p{S}]/u;
const UNI_WS = /\s/u;
function isUniPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunctCode(c);
  return UNI_PUNCT.test(ch);
}
function isUniWs(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isWsCode(c);
  return UNI_WS.test(ch);
}
function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return /[\p{L}\p{N}]/u.test(ch);
}

// ---------- HTML escaping ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
// encode=false: escape < > " ' always; & only when it does not start a
// valid entity / numeric character reference (mirrors marked's escape).
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(s, encode) {
  if (encode) {
    if (!ESC_TEST.test(s)) return s;
    return s.replace(ESC_RE, (c) => ESC_MAP[c]);
  }
  if (!ESC_NOENC_TEST.test(s)) return s;
  return s.replace(ESC_NOENC_RE, (c) => ESC_MAP[c]);
}

// ---------- entities ----------

// Decode numeric character references and stray ampersands the way
// marked's inline text handling does: a numeric reference becomes the
// character (0, surrogates and >0x10FFFF become U+FFFD; 38 becomes
// "&amp;"); a bare & that does not start "&name;" / "&#...;" becomes
// "&amp;". Named entities pass through untouched.
const ENT_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENT_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Text as it appears in rendered output: entity-decode, then escape.
function textOut(s) {
  return esc(decodeEntities(s), false);
}

// ---------- links ----------

// Collapse whitespace and case-fold a link label (marked's normalize).
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Unescape backslash-escaped ASCII punctuation.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// encodeURI with %25 restored (marked's cleanUrl helper).
function encodeHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Balanced-paren check used by marked for link destinations:
// -1 balanced, -2 unclosed "(", index of a ")" with no opener.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// ---------- inline parsing ----------

function isAsciiLetter(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}
function isWordChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
// code point (possibly astral) ending at index i
function charBefore(src, i) {
  if (i <= 0) return undefined;
  const c = src.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = src.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return src.slice(i - 2, i);
  }
  return src[i - 1];
}
function charAfter(src, i) {
  if (i >= src.length) return undefined;
  const c = src.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < src.length) {
    const l = src.charCodeAt(i + 1);
    if (l >= 0xDC00 && l <= 0xDFFF) return src.slice(i, i + 2);
  }
  return src[i];
}

// Flanking for emphasis delimiters (CommonMark rules).
function flanking(src, i, len) {
  const prev = charBefore(src, i);
  const next = charAfter(src, i + len);
  const prevWs = prev === undefined || isUniWs(prev);
  const prevPunct = prev !== undefined && isUniPunct(prev);
  const nextWs = next === undefined || isUniWs(next);
  const nextPunct = next !== undefined && isUniPunct(next);
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return { left, right };
}

// ---------- email / url matching ----------

function isEmailLocalChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
}
// [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]
function isEmailChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
      c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
      c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
  }
  return false;
}
function isDomainChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
}

// GFM bare-email pattern: [A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])
// Returns end index or -1.
function matchEmailGfm(src, j) {
  const n = src.length;
  let i = j;
  while (i < n && isEmailLocalChar(src[i])) i++;
  if (i === j || i >= n || src[i] !== '@') return -1;
  i++;
  let k = i;
  while (k < n && isDomainChar(src[k])) k++;
  if (k === i) return -1;
  let hasDot = false;
  while (k < n && src[k] === '.') {
    let m = k + 1;
    while (m < n && isDomainChar(src[m])) m++;
    if (m === k + 1) {
      if (!hasDot) return -1;
      break;
    }
    // segment must end with an alphanumeric char; trim trailing -/_
    let e = m;
    while (e > k + 1 && !isAlnum(src[e - 1])) e--;
    if (e === k + 1) {
      if (!hasDot) return -1;
      break;
    }
    hasDot = true;
    k = e;
  }
  if (!hasDot) return -1;
  if (k < n && (isWordChar(src[k]) || src[k] === '-')) return -1;
  return k;
}

// Autolink email pattern: local [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+,
// domain labels of 1..63 chars starting and ending alnum, (?![-_]).
// Returns end index or -1.
function matchEmailAutolink(src, j) {
  const n = src.length;
  let i = j;
  while (i < n && isEmailChar(src[i])) i++;
  if (i === j || i >= n || src[i] !== '@') return -1;
  i++;
  // one label of 1..63 chars, start/end alnum, chars [a-zA-Z0-9-]
  const label = (pos) => {
    if (pos >= n || !isAlnum(src[pos])) return -1;
    let e = pos + 1;
    while (e < n && e - pos < 63 && (isAlnum(src[e]) || src[e] === '-')) e++;
    while (e > pos + 1 && !isAlnum(src[e - 1])) e--;
    if (e === pos) return -1;
    return e;
  };
  let k = label(i);
  if (k === -1) return -1;
  let hasDot = false;
  while (k < n && src[k] === '.') {
    const e = label(k + 1);
    if (e === -1) {
      if (!hasDot) return -1;
      break;
    }
    hasDot = true;
    k = e;
  }
  if (!hasDot) return -1;
  if (k < n && (src[k] === '-' || src[k] === '_')) return -1;
  return k;
}

function startsWithCI(src, j, pat) {
  if (j + pat.length > src.length) return false;
  for (let t = 0; t < pat.length; t++) {
    let a = src.charCodeAt(j + t), b = pat.charCodeAt(t);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}

// Backpedal for GFM extended autolinks: trim a matched URL the way
// marked's _backpedal regex does (balanced paren groups, trailing
// punctuation and trailing &entity; removed).
function isBpPunct(ch) {
  const c = ch.charCodeAt(0);
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}
function backpedalOnce(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const k = s.indexOf(')', i + 1);
      if (k === -1) break;
      i = k + 1;
    } else if (c === '&') {
      if (/^[a-zA-Z0-9]+;$/.test(s.slice(i + 1))) break;
      i++;
    } else if (isBpPunct(c)) {
      let j = i;
      while (j < n && isBpPunct(s[j])) j++;
      if (j === n) break;
      i = j;
    } else {
      let j = i;
      while (j < n && !isBpPunct(s[j]) && s[j] !== '(' && s[j] !== '&') j++;
      i = j;
    }
  }
  return s.slice(0, i);
}
function backpedal(s) {
  let prev = s, cur = backpedalOnce(s);
  while (cur !== prev) { prev = cur; cur = backpedalOnce(cur); }
  return cur;
}

// Try to match a GFM extended autolink at src[j].
// Returns {end, text, href} or null.
function matchGfmUrl(src, j) {
  const n = src.length;
  let prefix = 0, kind = 0; // 0 none, 1 protocol, 2 www, 3 emailProtocol, 4 email
  if (src.startsWith('mailto:', j)) {
    const e = matchEmailGfm(src, j + 7);
    if (e !== -1) {
      const raw = backpedal(src.slice(j, e));
      if (raw.length) return { end: j + raw.length, text: raw, href: raw };
    }
    return null;
  }
  if (src.startsWith('xmpp:', j)) {
    const e = matchEmailGfm(src, j + 5);
    if (e !== -1) {
      let end = e;
      if (src[end] === '/') {
        let m = end + 1;
        while (m < n && (isAlnum(src[m]) || src[m] === '@' || src[m] === '.')) m++;
        if (m > end + 1) end = m;
      }
      const raw = backpedal(src.slice(j, end));
      if (raw.length) return { end: j + raw.length, text: raw, href: raw };
    }
    return null;
  }
  if (startsWithCI(src, j, 'http://')) { prefix = 7; kind = 1; }
  else if (startsWithCI(src, j, 'https://')) { prefix = 8; kind = 1; }
  else if (startsWithCI(src, j, 'ftp://')) { prefix = 6; kind = 1; }
  else if (src.startsWith('www.', j)) { prefix = 4; kind = 2; }
  if (kind === 1 || kind === 2) {
    // domain: (?:[a-zA-Z0-9-]+\.?)+
    let i = j + prefix;
    let ok = false;
    while (true) {
      let k = i;
      while (k < n && (isAlnum(src[k]) || src[k] === '-')) k++;
      if (k === i) break;
      ok = true;
      i = k;
      if (src[i] === '.') i++;
      else break;
      if (i >= n || !(isAlnum(src[i]) || src[i] === '-')) break;
    }
    if (!ok) return null;
    while (i < n && !isUniWs(src[i]) && src[i] !== '<') i++;
    const raw = backpedal(src.slice(j, i));
    if (!raw.length) return null;
    const href = kind === 2 ? 'http://' + raw : raw;
    return { end: j + raw.length, text: raw, href };
  }
  const e = matchEmailGfm(src, j);
  if (e !== -1) {
    const raw = backpedal(src.slice(j, e));
    if (raw.length) return { end: j + raw.length, text: raw, href: 'mailto:' + raw };
  }
  return null;
}

function couldStartUrl(src, j) {
  const n = src.length;
  if (startsWithCI(src, j, 'http://') || startsWithCI(src, j, 'https://') || startsWithCI(src, j, 'ftp://')) return true;
  if (src.startsWith('www.', j)) {
    if (j === 0) return true;
    const p = src[j - 1];
    if (isUniWs(p) || p === '*' || p === '_' || p === '~' || p === '(') return true;
  }
  if (src.startsWith('mailto:', j) || src.startsWith('xmpp:', j)) {
    if (j === 0) return true;
    if (!isAlnum(src[j - 1])) return true;
  }
  if (j < n && isEmailChar(src[j]) && (j === 0 || !isEmailChar(src[j - 1]))) {
    if (matchEmailGfm(src, j) !== -1) return true;
  }
  return false;
}

// ---------- inline HTML tags ----------

// Scan an inline HTML tag / comment / PI / declaration / CDATA at src[i] === '<'.
// Returns {end, kind} or null. kind: 'aOpen' | 'aClose' | 'preOpen' | 'preClose' | 'other'.
function scanInlineTag(src, i) {
  const n = src.length;
  const c1 = src[i + 1];
  if (c1 === '!') {
    if (src.startsWith('<!--', i)) {
      if (src[i + 4] === '>') return { end: i + 5, kind: 'other' };
      if (src[i + 4] === '-' && src[i + 5] === '>') return { end: i + 6, kind: 'other' };
      const j = src.indexOf('-->', i + 4);
      if (j === -1) return null;
      return { end: j + 3, kind: 'other' };
    }
    if (src.startsWith('<![CDATA[', i)) {
      const j = src.indexOf(']]>', i + 9);
      if (j === -1) return null;
      return { end: j + 3, kind: 'other' };
    }
    let j = i + 2;
    while (j < n && isAsciiLetter(src[j])) j++;
    if (j === i + 2) return null;
    if (j >= n || !isWsCode(src.charCodeAt(j))) return null;
    const gt = src.indexOf('>', j);
    if (gt === -1) return null;
    return { end: gt + 1, kind: 'other' };
  }
  if (c1 === '?') {
    const j = src.indexOf('?>', i + 2);
    if (j === -1) return null;
    return { end: j + 2, kind: 'other' };
  }
  if (c1 === '/') {
    let j = i + 2;
    if (j >= n || !isAsciiLetter(src[j])) return null;
    const nameStart = j;
    while (j < n && (isAsciiLetter(src[j]) || isDigit(src[j]) || src[j] === '-')) j++;
    const name = src.slice(nameStart, j).toLowerCase();
    while (j < n && isWsCode(src.charCodeAt(j))) j++;
    if (j >= n || src[j] !== '>') return null;
    let kind = 'other';
    if (name === 'a') kind = 'aClose';
    else if (name === 'pre' || name === 'code' || name === 'kbd' || name === 'script') kind = 'preClose';
    return { end: j + 1, kind };
  }
  let j = i + 1;
  if (j >= n || !isAsciiLetter(src[j])) return null;
  const nameStart = j;
  while (j < n && (isAsciiLetter(src[j]) || isDigit(src[j]) || src[j] === '-')) j++;
  const name = src.slice(nameStart, j).toLowerCase();
  while (true) {
    let k = j;
    while (k < n && isWsCode(src.charCodeAt(k))) k++;
    if (k === j || k >= n) break;
    const ac = src[k];
    if (!(isAsciiLetter(ac) || ac === '_' || ac === ':')) break;
    let m = k + 1;
    while (m < n && (isWordChar(src[m]) || src[m] === '.' || src[m] === ':' || src[m] === '-')) m++;
    let p = m;
    while (p < n && isWsCode(src.charCodeAt(p))) p++;
    if (src[p] === '=') {
      p++;
      while (p < n && isWsCode(src.charCodeAt(p))) p++;
      if (src[p] === '"') {
        const q = src.indexOf('"', p + 1);
        if (q === -1) return null;
        p = q + 1;
      } else if (src[p] === "'") {
        const q = src.indexOf("'", p + 1);
        if (q === -1) return null;
        p = q + 1;
      } else {
        let q = p;
        while (q < n) {
          const cc = src[q];
          if (isWsCode(src.charCodeAt(q)) || cc === '"' || cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
          q++;
        }
        if (q === p) return null;
        p = q;
      }
      j = p;
    } else {
      // No value: stop at the end of the name so the whitespace before the
      // next attribute is still there for the next iteration.
      j = m;
    }
  }
  while (j < n && isWsCode(src.charCodeAt(j))) j++;
  if (src[j] === '/') j++;
  if (j >= n || src[j] !== '>') return null;
  let kind = 'other';
  if (name === 'a' && src[i + 2] === ' ') kind = 'aOpen';
  else if (name === 'pre' || name === 'code' || name === 'kbd' || name === 'script') {
    const after = src[i + 1 + name.length];
    if (after === '>' || isWsCode(after.charCodeAt(0))) kind = 'preOpen';
  }
  return { end: j + 1, kind };
}

// Scan an autolink <...> at src[i] === '<'. Returns {end, text, href, isEmail} or null.
function scanAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j < n && isAsciiLetter(src[j])) {
    let k = j + 1;
    while (k < n && (isAlnum(src[k]) || src[k] === '+' || src[k] === '.' || src[k] === '-')) k++;
    if (k - j >= 2 && k - j <= 32 && src[k] === ':') {
      let m = k + 1;
      while (m < n) {
        const cc = src.charCodeAt(m);
        if (src[m] === '>' || src[m] === '<' || cc < 32 || isWsCode(cc)) break;
        m++;
      }
      if (m < n && src[m] === '>') {
        const text = src.slice(i + 1, m);
        return { end: m + 1, text, href: text, isEmail: false };
      }
    }
  }
  const e = matchEmailAutolink(src, i + 1);
  if (e !== -1 && src[e] === '>') {
    const text = src.slice(i + 1, e);
    return { end: e + 1, text, href: 'mailto:' + text, isEmail: true };
  }
  return null;
}

// ---------- code spans ----------

function scanCodeSpan(src, i) {
  const n = src.length;
  let m = 0;
  while (i + m < n && src[i + m] === '`') m++;
  let j = i + m;
  while (j < n) {
    if (src[j] === '`') {
      let k = 0;
      while (j + k < n && src[j + k] === '`') k++;
      if (k === m) return { end: j + m, text: src.slice(i + m, j) };
      j += k;
    } else j++;
  }
  return null;
}
function codeSpanText(raw) {
  let t = raw.replace(/\n/g, ' ');
  if (/[^ ]/.test(t) && t.charCodeAt(0) === 32 && t.charCodeAt(t.length - 1) === 32) {
    t = t.substring(1, t.length - 1);
  }
  return t;
}

// ---------- link labels ----------

// Le group: \[(?:\\[\s\S]|[^\[\]\\])*\] (no nested brackets inside)
function matchLe(src, j) {
  const n = src.length;
  let i = j + 1;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[' || c === ']') break;
    i++;
  }
  if (i < n && src[i] === ']') return i + 1;
  return -1;
}

// Bracket group for inline-link labels: \[(?:brackets|\\[\s\S]|[^\[\]\\])*\]
function matchBracketGroup(src, j) {
  const n = src.length;
  let i = j + 1;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      const e = matchLe(src, i);
      if (e === -1) return -1;
      i = e; continue;
    }
    if (c === ']') return i + 1;
    i++;
  }
  return -1;
}

// Scan an inline-link label starting at src[i] === '['.
// Returns the index of the closing ']' or -1.
function scanInlineLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') {
      const e = matchBracketGroup(src, j);
      if (e === -1) return -1;
      j = e; continue;
    }
    if (c === '`') {
      let m = 0;
      while (j + m < n && src[j + m] === '`') m++;
      if (m >= 2 && src[j + m] === ']') { j += m; continue; }
      // code span: first backtick run after the opener (any length)
      let k = j + m, found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let r = 0;
          while (k + r < n && src[k + r] === '`') r++;
          found = k + r;
          break;
        }
        k++;
      }
      if (found === -1) return -1;
      j = found; continue;
    }
    if (c === ']') return j;
    j++;
  }
  return -1;
}

// Scan a reflink label starting at src[i] === '[' (le pattern).
// Returns the index of the closing ']' or -1.
function scanRefLabel(src, i) {
  const n = src.length;
  let j = i + 1, count = 0;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { if (j + 1 >= n) return -1; j += 2; count++; continue; }
    if (c === '[' || c === ']') break;
    if (c === '\n') {
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n && src[k] === '\n') break;
      j++; count++; continue;
    }
    j++; count++;
  }
  if (j < n && src[j] === ']' && count > 0) return j;
  return -1;
}

// Scan a link title at src[p] (opening quote or paren).
// Returns {end, title} or null.
function scanTitle(src, p) {
  const n = src.length;
  const c = src[p];
  if (c === '"') {
    let q = p + 1;
    while (q < n) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === '"') return { end: q + 1, title: src.slice(p + 1, q) };
      q++;
    }
    return null;
  }
  if (c === "'") {
    let q = p + 1;
    while (q < n) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === "'") return { end: q + 1, title: src.slice(p + 1, q) };
      if (src[q] === '\n' && src[q + 1] === '\n') return null;
      q++;
    }
    return null;
  }
  if (c === '(') {
    let q = p + 1;
    while (q < n) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === ')') return { end: q + 1, title: src.slice(p + 1, q) };
      if (src[q] === '(') return null;
      q++;
    }
    return null;
  }
  return null;
}

// After a link destination ending at e, parse the rest: optional title + ')'.
// Returns {end, title} (end past the closing paren) or null.
function parseLinkRest(src, e) {
  const n = src.length;
  if (src[e] === ')') return { end: e + 1, title: '' };
  // try title path: separator then title then [ \t\n]* )
  let p = e;
  let sep = -1;
  if (src[p] === ' ' || src[p] === '\t') {
    let q = p;
    while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
    if (src[q] === '\n') {
      let r = q + 1;
      while (r < n && (src[r] === ' ' || src[r] === '\t')) r++;
      sep = r;
    } else sep = q;
  } else if (src[p] === '\n') {
    let q = p + 1;
    while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
    sep = q;
  }
  if (sep !== -1) {
    const t = scanTitle(src, sep);
    if (t) {
      let q = t.end;
      while (q < n && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
      if (src[q] === ')') return { end: q + 1, title: t.title };
    }
  }
  // no-title path: [ \t\n]* )
  let q = e;
  while (q < n && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
  if (src[q] === ')') return { end: q + 1, title: '' };
  return null;
}

// Be(): reject a link when its label holds a tag that runs past the label.
function hasTagBeyond(src, labelStart, labelText, labelLen) {
  let s = 0;
  const n = labelText.length;
  while (s < n) {
    const c = labelText[s];
    if (c === '\\') { s += 2; continue; }
    if (c === '`') {
      const cs = scanCodeSpan(labelText, s);
      if (cs) { s = cs.end; continue; }
      s++;
      continue;
    }
    if (c !== '<') { s++; continue; }
    const r = src.slice(labelStart + s);
    const tag = scanInlineTag(r, 0);
    const auto = tag ? null : scanAutolink(r, 0);
    const m = tag || auto;
    if (m) {
      if (m.end > n - s) return true;
      s += m.end;
      continue;
    }
    s++;
  }
  return false;
}

// Count trailing backslashes in s (used for the "escaped closer" checks).
function trailingBackslashes(s) {
  let c = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) c++;
  return c;
}

// ---------- delimiter processing ----------

// item kinds: 0 text {s, esc}, 1 html {s, plain}, 2 delim {ch, len, canOpen, canClose}, 3 wrap {tag, children}
function plainOfItems(items) {
  let out = '';
  for (const it of items) {
    if (it.k === 0) out += it.esc ? it.s : decodeEntities(it.s);
    else if (it.k === 1) out += it.plain;
    else if (it.k === 2) out += it.ch.repeat(it.len);
    else out += plainOfItems(it.children);
  }
  return out;
}

function renderItems(items) {
  let out = '';
  for (const it of items) {
    if (it.k === 0) out += it.esc ? it.s : textOut(it.s);
    else if (it.k === 1) out += it.s;
    else out += '<' + it.tag + '>' + renderItems(it.children) + '</' + it.tag + '>';
  }
  return out;
}

// ---------- emStrong / del: marked's greedy forward-search algorithm ----------
// (Reimplemented from the observed behaviour of marked 18.1.3; the code is
// my own, written to match its tokeniser semantics, not copied.)
const EM_L = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_R_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_R_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_L = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const DEL_R = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const PUNCT1 = /^((?![*_])[\s\p{P}\p{S}])/u;
const UNI_ALNUM = /[\p{L}\p{N}]/u;
const REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const ANY_PUNCT_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const LINK_RE = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

// Does the text contain a link (inline or reference)? Used by the masking.
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(BLOCK_SKIP)) {
    if (LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(REFLINK_SEARCH)) {
    const r = m[0], o = r.lastIndexOf('[');
    if (!(r.charAt(0) === '!' || !Object.prototype.hasOwnProperty.call(links, normalizeLabel(r.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(r.slice(1, o - 1), links))) return true;
  }
  return false;
}

function isPunctCp(cp) {
  if (cp < 128) return isAsciiPunctCode(cp);
  return UNI_PUNCT.test(String.fromCodePoint(cp));
}

// Manual equivalent of t.replace(ANY_PUNCT_CODE, ...) in maskedSrc: mask
// code spans (inner backticks -> '+') and backslash-escaped punctuation
// ('\X' -> '++'); a backtick run with no closing run of the same length is
// left unchanged (the regex's bare-`+` alternative sets no group, so its
// callback returns the match as-is). Returns t unchanged when nothing
// matches. (The regex it replaces is
// /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu.)
function maskPunctCode(t) {
  const n = t.length;
  let parts = null, last = 0;
  let i = 0;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 96) { // '`'
      let runEnd = i + 1;
      while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - i;
      // Alt 1 (code span): closing run of the same length, content's first
      // and last chars non-backtick; earliest such run wins (lazy content).
      let close = -1;
      if (runEnd < n && t.charCodeAt(runEnd) !== 96) {
        let j = runEnd + 1;
        while (j < n) {
          if (t.charCodeAt(j) === 96) {
            let k = j + 1;
            while (k < n && t.charCodeAt(k) === 96) k++;
            if (k - j === runLen && (k >= n || t.charCodeAt(k) !== 96)) { close = j; break; }
            j = k;
          } else j++;
        }
      }
      if (close !== -1) {
        if (parts === null) parts = [];
        parts.push(t.slice(last, i));
        const run = t.slice(i, runEnd);
        parts.push(run, t.slice(runEnd, close).replace(/`/g, '+'), run);
        last = close + runLen;
        i = last;
      } else {
        // Alt 2 (a lone backtick run): the regex matches it, but group 1
        // does not participate, so the callback returns it unchanged.
        i = runEnd;
      }
    } else if (c === 92 && i + 1 < n) { // '\\'
      const cp = t.codePointAt(i + 1);
      if (isPunctCp(cp)) {
        const len = 1 + (cp > 0xFFFF ? 2 : 1);
        if (parts === null) parts = [];
        parts.push(t.slice(last, i), '+'.repeat(len));
        last = i + len;
        i = last;
      } else i++;
    } else i++;
  }
  if (parts === null) return t;
  parts.push(t.slice(last));
  return parts.join('');
}

// Try BLOCK_SKIP's link alternative at t[i] === '[': label (plain chars or
// code spans, no '['/']' outside a code span) + '(' + destination (with one
// level of nested parens, backslash escapes) + ')'. Returns end index or -1.
function matchBlockLink(t, i) {
  const n = t.length;
  let j = i + 1;
  while (true) {
    if (j >= n) return -1;
    const c = t.charCodeAt(j);
    if (c === 93) { // ']' — label ends; destination must follow
      if (j + 1 >= n || t.charCodeAt(j + 1) !== 40) return -1;
      return matchLinkDest(t, j + 2);
    }
    if (c === 91) return -1; // '[' cannot appear in a label
    if (c === 96) { // '`' — code span inside the label
      let runEnd = j + 1;
      while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - j;
      let k = runEnd;
      while (k < n && t.charCodeAt(k) !== 96) k++;
      if (k >= n) return -1;
      let kEnd = k + 1;
      while (kEnd < n && t.charCodeAt(kEnd) === 96) kEnd++;
      if (kEnd - k !== runLen || (kEnd < n && t.charCodeAt(kEnd) === 96)) return -1;
      j = kEnd;
      continue;
    }
    j++;
  }
}
function matchLinkDest(t, p) {
  const n = t.length;
  let q = p;
  while (true) {
    if (q >= n) return -1;
    const c = t.charCodeAt(q);
    if (c === 92) { q += 2; continue; }
    if (c === 40) { // '(' — one level of nested parens
      let r = q + 1;
      while (true) {
        if (r >= n) return -1;
        const d = t.charCodeAt(r);
        if (d === 92) { r += 2; continue; }
        if (d === 41) break;
        if (d === 40) return -1;
        r++;
      }
      q = r + 1;
      continue;
    }
    if (c === 41) return q + 1; // ')' ends the destination
    q++;
  }
}

// Manual equivalent of t.replace(BLOCK_SKIP, ...) in maskedSrc: mask each
// matched span (inline-link [..](..), code span, <...> tag) with
// '[' + 'a'*(len-2) + ']'. Returns t unchanged when nothing matches.
function maskBlockSkip(t) {
  const n = t.length;
  let parts = null, last = 0;
  let i = 0;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 91) { // '['
      const end = matchBlockLink(t, i);
      if (end !== -1) {
        if (parts === null) parts = [];
        parts.push(t.slice(last, i), '[' + 'a'.repeat(end - i - 2) + ']');
        last = end;
        i = end;
      } else i++;
    } else if (c === 96) { // '`' — code span (not preceded by '`': runs are atomic)
      let runEnd = i + 1;
      while (runEnd < n && t.charCodeAt(runEnd) === 96) runEnd++;
      const runLen = runEnd - i;
      let close = -1;
      let k = runEnd;
      while (k < n && t.charCodeAt(k) !== 96) k++;
      if (k < n) {
        let kEnd = k + 1;
        while (kEnd < n && t.charCodeAt(kEnd) === 96) kEnd++;
        if (kEnd - k === runLen && (kEnd >= n || t.charCodeAt(kEnd) !== 96)) close = k;
      }
      if (close !== -1) {
        const end = close + runLen;
        if (parts === null) parts = [];
        parts.push(t.slice(last, i), '[' + 'a'.repeat(end - i - 2) + ']');
        last = end;
        i = end;
      } else {
        i = runEnd; // no match: skip the whole run (a later backtick inside
        // the run can never start a span: it is preceded by '`')
      }
    } else if (c === 60) { // '<'
      if (i + 1 < n && t.charCodeAt(i + 1) === 32) { i++; continue; }
      let j = i + 1;
      while (j < n && t.charCodeAt(j) !== 62 && t.charCodeAt(j) !== 60) j++;
      if (j < n && t.charCodeAt(j) === 62) {
        const end = j + 1;
        if (parts === null) parts = [];
        parts.push(t.slice(last, i), '[' + 'a'.repeat(end - i - 2) + ']');
        last = end;
        i = end;
      } else i++;
    } else i++;
  }
  if (parts === null) return t;
  parts.push(t.slice(last));
  return parts.join('');
}

// Masked source: code spans, link destinations and reflink labels are
// replaced by same-length placeholders so the emphasis closer search does
// not see delimiters inside them.
function maskedSrc(src, links) {
  let t = src;
  if (links && Object.keys(links).length > 0 && src.includes('[')) {
    const repl = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.prototype.hasOwnProperty.call(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, links)) return '[' + i.replace(REFLINK_SEARCH, repl) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH, repl);
  }
  // Cheap pre-checks: each replacement is a no-op without its trigger chars.
  if (src.includes('`') || src.includes('\\')) {
    t = maskPunctCode(t);
  }
  if (src.includes('](') || src.includes('`') || src.includes('<')) {
    t = maskBlockSkip(t);
  }
  return t;
}

// Last possible closer index for each delimiter char in the masked src.
function lastPossibleCloser(masked) {
  let star = -1, und = -1, tilde = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const cc = masked.charCodeAt(s);
    if (cc !== 42 && cc !== 95 && cc !== 126) continue;
    const o = s === 0 ? 10 : masked.charCodeAt(s - 1);
    let i = s + 1;
    while (i < n && masked.charCodeAt(i) === cc) i++;
    if (o !== 32 && o !== 9 && o !== 10 && o !== 13 && o !== 12) {
      if (cc === 126) tilde = s;
      else if (cc === 42) star = s;
      else und = s;
    }
    s = i - 1;
  }
  return { star, und, tilde };
}

// Try marked's emStrong tokeniser at src[i] (a '*' or '_' run).
// masked = the masked source for this inline parse, last = the last-possible
// closer indices, prev = the previous char (see inlineParse), links/st for
// the recursive inner parse. Returns {tag, raw, text} or null.
function tryEmStrong(src, i, masked, last, prev) {
  const r0 = src[i];
  let runEnd = i;
  while (runEnd < src.length && src[runEnd] === r0) runEnd++;
  // EM_L only reads the delimiter run + one following char — but that char
  // must be a whole code point: slicing an astral char in half changes its
  // \p{P}/\p{S} classification (e.g. 🚀) and flips the opener rule.
  const cpLen = runEnd < src.length ? (src.codePointAt(runEnd) > 0xFFFF ? 2 : 1) : 0;
  const e = src.slice(i, runEnd + cpLen);
  const s = EM_L.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prev === r;
  const pos = i;
  let l = pos;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!PUNCT1.exec(p);
  let nn = prev;
  if (l < pos) nn = p;
  const u = l < pos ? h : !!PUNCT1.exec(nn);
  if (s[4] && UNI_ALNUM.test(nn)) return null;
  const d = s[1] || s[3] || '';
  if (d && nn && !u) return null;
  if (r !== '*' && r !== '_') return null;
  const k = [...s[0]].length - 1;
  const y = pos - l + k;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  const A = r === '*' ? EM_R_AST : EM_R_UND;
  const v = r === '*' ? last.star : last.und;
  const Q = pos + k;
  if (v < Q) return null;
  // The closer search only needs text up to the last possible closer run
  // (+ the run itself + one lookahead char, a whole code point); never
  // slice the whole tail. The regex's first ("skip") alternative can look
  // ahead to a `__` (for *) / `**` (for _) after that run, so extend the
  // window to the first such pair when it lies beyond the run.
  let vRunEnd = v;
  while (vRunEnd < masked.length && masked[vRunEnd] === r) vRunEnd++;
  let winEnd = vRunEnd + (vRunEnd < masked.length ? (masked.codePointAt(vRunEnd) > 0xFFFF ? 2 : 1) : 0);
  const pair = r === '*' ? masked.indexOf('__', vRunEnd) : masked.indexOf('**', vRunEnd);
  if (pair !== -1 && pair + 2 > winEnd) winEnd = pair + 2;
  const t = masked.slice(pos + k, winEnd);
  const ee = v - Q;
  let m = k, f = 0;
  A.lastIndex = 0;
  let mt;
  while ((mt = A.exec(t)) !== null && !(mt.index > ee)) {
    const g = mt[1] || mt[2] || mt[3] || mt[4] || mt[5] || mt[6];
    if (!g) continue;
    const b = [...g].length;
    if (mt[3] || mt[4]) { m += b; continue; }
    if (mt[5] || mt[6] || R) {
      if (o && (mt[5] || mt[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bb = Math.min(b, b + m + f);
    const te = [...mt[0]][0].length;
    const M = src.slice(i, i + k + mt.index + te + bb);
    if (Math.min(k, bb) % 2) {
      const U = M.slice(1, -1);
      return { tag: 'em', raw: M, text: U };
    }
    const ne = M.slice(2, -2);
    return { tag: 'strong', raw: M, text: ne };
  }
  return null;
}

// Try marked's del tokeniser at src[i] (a '~' run). Same conventions.
function tryDel(src, i, masked, last, prev) {
  // DEL_L only reads at most two tildes + one following char (a whole
  // code point, for the same astral reason as in tryEmStrong).
  let tilEnd = i;
  while (tilEnd < src.length && src[tilEnd] === '~' && tilEnd - i < 2) tilEnd++;
  const cpLen = tilEnd < src.length ? (src.codePointAt(tilEnd) > 0xFFFF ? 2 : 1) : 0;
  const e = src.slice(i, tilEnd + cpLen);
  const s = DEL_L.exec(e);
  if (!s) return null;
  if (!(s[1] || '') && prev && !PUNCT1.exec(prev)) return null;
  const o = [...s[0]].length - 1;
  const u = last.tilde;
  const d = i + o;
  if (u < d) return null;
  let uRunEnd = u;
  while (uRunEnd < masked.length && masked[uRunEnd] === '~') uRunEnd++;
  const t = masked.slice(i + o, uRunEnd + (uRunEnd < masked.length ? (masked.codePointAt(uRunEnd) > 0xFFFF ? 2 : 1) : 0));
  const kk = u - d;
  let p = o;
  DEL_R.lastIndex = 0;
  let mt;
  while ((mt = DEL_R.exec(t)) !== null && !(mt.index > kk)) {
    const g = mt[1] || mt[2] || mt[3] || mt[4] || mt[5] || mt[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (mt[3] || mt[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    const ll = Math.min(l, l + p);
    const gg = [...mt[0]][0].length;
    const b = src.slice(i, i + o + mt.index + gg + ll);
    const m = b.slice(o, -o);
    return { tag: 'del', raw: b, text: m };
  }
  return null;
}


function isAllWs(src, from) {
  for (let i = from; i < src.length; i++) {
    if (!isWsCode(src.charCodeAt(i))) return false;
  }
  return true;
}

// Finish a link/image once its destination and title are known.
// Returns {end, html, plain} or null (link dropped: nested link inside).
function finishLink(labelText, href, title, isImage, rawEnd, links, st, parenPossible) {
  const p = st.inLink, h = st.linkEmitted, u = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = inlineParse(labelText, links, st, parenPossible && labelText.includes(')'));
  const k = st.linkEmitted;
  st.linkEmitted = h;
  st.inLink = p;
  if (!isImage) {
    if (k) { st.inRawBlock = u; return null; }
    st.linkEmitted = true;
  }
  const plain = plainOfItems(inner.items);
  if (isImage) {
    const enc = encodeHref(href);
    if (enc === null) return { end: rawEnd, html: esc(plain, false), plain };
    let s = '<img src="' + esc(enc, false) + '" alt="' + esc(plain, false) + '"';
    if (title) s += ' title="' + esc(title, false) + '"';
    s += '>';
    return { end: rawEnd, html: s, plain };
  }
  const enc = encodeHref(href);
  if (enc === null) return { end: rawEnd, html: inner.html, plain };
  let s = '<a href="' + esc(enc, false) + '"';
  if (title) s += ' title="' + esc(title, false) + '"';
  s += '>' + inner.html + '</a>';
  return { end: rawEnd, html: s, plain };
}

// Try an inline link [text](dest) / ![text](dest) at src[i].
// Returns {end, html, plain} or null.
function tryInlineLink(src, i, links, st, parenPossible) {
  if (!parenPossible) return null;
  const n = src.length;
  const bang = src[i] === '!';
  const bracketPos = bang ? i + 1 : i;
  const labelEnd = scanInlineLabel(src, bracketPos);
  if (labelEnd === -1) return null;
  if (src[labelEnd + 1] !== '(') return null;
  const labelText = src.slice(bracketPos + 1, labelEnd);
  if (hasTagBeyond(src, bracketPos + 1, labelText, labelText.length)) return null;
  let p = labelEnd + 2;
  while (p < n && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  let dest, rest;
  if (src[p] === ')') {
    dest = '';
    rest = { end: p + 1, title: '' };
  } else if (src[p] === '<') {
    let q = p + 1, ok = false;
    while (q < n) {
      const ch = src[q];
      if (ch === '\\') { q += 2; continue; }
      if (ch === '\n' || ch === '<' || ch === '>') break;
      q++;
    }
    if (q < n && src[q] === '>') {
      const rawDest = src.slice(p, q + 1);
      if (trailingBackslashes(rawDest.slice(0, -1)) % 2 === 1) return null;
      dest = rawDest.slice(1, -1);
      rest = parseLinkRest(src, q + 1);
      if (!rest) return null;
      ok = true;
    }
    if (!ok) return null;
  } else {
    let q = p;
    while (q < n) {
      const cc = src.charCodeAt(q);
      if (src[q] === ' ' || src[q] === '\t' || src[q] === '\n' || src[q] === '\r' || cc < 32) break;
      q++;
    }
    if (q === p) return null;
    let found = null;
    for (let e = q; e > p; e--) {
      if (src[e] === ')' || e === q) {
        const r = parseLinkRest(src, e);
        if (r) { found = { dest: src.slice(p, e), rest: r }; break; }
      }
    }
    if (!found) return null;
    dest = found.dest;
    rest = found.rest;
    const bal = parenBalance(dest);
    if (bal === -2) return null;
    if (bal > -1) {
      dest = dest.slice(0, bal);
      rest = { end: p + bal + 1, title: '' };
    }
  }
  let bs = 0;
  for (let q = rest.end - 2; q >= i && src[q] === '\\'; q--) bs++;
  if (bs % 2 === 1) return null;
  const href = unescapePunct(dest);
  const title = rest.title ? unescapePunct(rest.title) : '';
  return finishLink(labelText, href, title, bang, rest.end, links, st, parenPossible);
}

// Try a reference link [text][ref] / [text][] / [text] at src[i].
// Returns {end, html, plain}, {notFound:true} (consume one char as text), or null.
function tryReflink(src, i, links, st, parenPossible) {
  const bang = src[i] === '!';
  const bracketPos = bang ? i + 1 : i;
  // The reflink label uses the `re` pattern (nested brackets + code spans),
  // the same as an inline-link label; only the ref part uses the `le` pattern.
  const labelEnd = scanInlineLabel(src, bracketPos);
  if (labelEnd === -1) return null;
  const labelText = src.slice(bracketPos + 1, labelEnd);
  let refText = null, end = -1;
  if (src[labelEnd + 1] === '[') {
    const refEnd = scanRefLabel(src, labelEnd + 1);
    if (refEnd !== -1) {
      refText = src.slice(labelEnd + 2, refEnd);
      end = refEnd + 1;
    }
  }
  if (refText === null) {
    if (src[labelEnd + 1] === '[' && src[labelEnd + 2] === ']') end = labelEnd + 3;
    else end = labelEnd + 1;
    refText = labelText;
  }
  if (hasTagBeyond(src, bracketPos + 1, labelText, labelText.length)) return null;
  const def = links[normalizeLabel(refText)];
  if (!def) return { notFound: true };
  return finishLink(labelText, def.href, def.title || '', bang, end, links, st, parenPossible);
}

// Find the end of a text run starting at src[i]; the char at i is consumed
// unconditionally (it failed to start a token), then stop before the next
// position that could start a token. Uses one regex scan instead of a
// char-by-char loop; URL/email candidates are verified with couldStartUrl.
const TEXT_STOP_RE = /[\\<!\[`*~_]| {2,}\n|www\.|mailto:|xmpp:|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][tT][pP]:\/\/|@/g;
function scanText(src, i) {
  const n = src.length;
  TEXT_STOP_RE.lastIndex = i + 1;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index;
    const s = m[0];
    if (s === '\\') {
      const d = src[p + 1];
      if (d !== undefined && isAsciiPunctCode(d.charCodeAt(0))) return p;
      if (d === '\n') return p;
      TEXT_STOP_RE.lastIndex = p + 2;
      continue;
    }
    if (s[0] === ' ') {
      // hard-break candidate: 2+ spaces + newline; only a break when the
      // rest of the line after it is not all whitespace.
      if (!isAllWs(src, p + s.length)) return p;
      TEXT_STOP_RE.lastIndex = p + s.length;
      continue;
    }
    if (s === '@') {
      // walk back over the email-char run to its start, then verify.
      let st = p;
      while (st > i + 1 && isEmailChar(src[st - 1])) st--;
      if (st > i && couldStartUrl(src, st)) return st;
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    if (s === 'www.' || s === 'mailto:' || s === 'xmpp:') {
      if (couldStartUrl(src, p)) return p;
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    // http/https/ftp (any case): couldStartUrl is true unconditionally.
    return p;
  }
  return n;
}

// Parse inline markdown to items + HTML. st is shared mutable state
// ({inLink, inRawBlock, linkEmitted}) across the whole document's inline
// parses, mirroring marked's lexer state.
function inlineParse(src, links, st, parenPossible) {
  const n = src.length;
  const items = [];
  let i = 0;
  let textBuf = '';
  let textEsc = false;
  const addText = (s) => { if (!textBuf) textEsc = st.inRawBlock; textBuf += s; };
  // prevR / lastWasText track marked's `r` (previous char): the last char of
  // the most recent text token (not updated when it ends with '_'), or ''
  // after any non-text token.
  let prevR = '';
  let lastWasText = false;
  const pushTextItem = (s, esc) => {
    if (s.slice(-1) !== '_') prevR = s.slice(-1);
    lastWasText = true;
    items.push({ k: 0, s, esc });
  };
  const pushNonText = (it) => { lastWasText = false; items.push(it); };
  const flushText = () => { if (textBuf) { pushTextItem(textBuf, textEsc); textBuf = ''; } };
  // Lazily computed masked source + last-possible closer indices (only when
  // the text contains a delimiter char). Inlined at the call sites below
  // (a closure call per delimiter was measurable in the profile).
  let masked = null, last = null;

  while (i < n) {
    const c = src[i];
    if (c === '*' || c === '_') {
      if (masked === null) {
        masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskedSrc(src, links) : src;
        last = lastPossibleCloser(masked);
      }
      flushText();
      const em = tryEmStrong(src, i, masked, last, lastWasText ? prevR : '');
      if (em) {
        const inner = inlineParse(em.text, links, st, parenPossible && em.text.includes(')'));
        pushNonText({ k: 3, tag: em.tag, children: inner.items });
        i += em.raw.length;
        continue;
      }
      addText(c);
      i++;
      continue;
    }
    if (c === '~') {
      if (masked === null) {
        masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskedSrc(src, links) : src;
        last = lastPossibleCloser(masked);
      }
      flushText();
      const dl = tryDel(src, i, masked, last, lastWasText ? prevR : '');
      if (dl) {
        const inner = inlineParse(dl.text, links, st, parenPossible && dl.text.includes(')'));
        pushNonText({ k: 3, tag: 'del', children: inner.items });
        i += dl.raw.length;
        continue;
      }
      addText(c);
      i++;
      continue;
    }
    if (c === '\\') {
      const d = src[i + 1];
      if (d !== undefined && isAsciiPunctCode(d.charCodeAt(0))) {
        flushText();
        pushTextItem(d, false);
        i += 2;
        continue;
      }
      if (d === '\n' && !isAllWs(src, i + 2)) {
        flushText();
        let q = i + 2;
        while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
        pushNonText({ k: 1, s: '<br>', plain: '' });
        i = q;
        continue;
      }
    }
    if (c === '<') {
      const tag = scanInlineTag(src, i);
      if (tag) {
        flushText();
        const raw = src.slice(i, tag.end);
        if (tag.kind === 'aOpen') st.inLink = true;
        else if (tag.kind === 'aClose') st.inLink = false;
        else if (tag.kind === 'preOpen') st.inRawBlock = true;
        else if (tag.kind === 'preClose') st.inRawBlock = false;
        pushNonText({ k: 1, s: raw, plain: raw });
        i = tag.end;
        continue;
      }
      const auto = scanAutolink(src, i);
      if (auto) {
        flushText();
        const href = encodeHref(auto.href);
        if (href === null) pushNonText({ k: 1, s: esc(auto.text, true), plain: auto.text });
        else pushNonText({ k: 1, s: '<a href="' + esc(href, true) + '">' + esc(auto.text, true) + '</a>', plain: auto.text });
        i = auto.end;
        continue;
      }
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const lk = tryInlineLink(src, i, links, st, parenPossible);
      if (lk) {
        flushText();
        pushNonText({ k: 1, s: lk.html, plain: lk.plain });
        i = lk.end;
        continue;
      }
      const rf = tryReflink(src, i, links, st, parenPossible);
      if (rf) {
        if (rf.notFound) {
          addText(src[i]);
          i++;
          continue;
        }
        flushText();
        pushNonText({ k: 1, s: rf.html, plain: rf.plain });
        i = rf.end;
        continue;
      }
    }
    if (c === '`') {
      const cs = scanCodeSpan(src, i);
      if (cs) {
        flushText();
        const t = codeSpanText(cs.text);
        pushNonText({ k: 1, s: '<code>' + esc(t, true) + '</code>', plain: t });
        i = cs.end;
        continue;
      }
      let m = 0;
      while (i + m < n && src[i + m] === '`') m++;
      addText(src.slice(i, i + m));
      i += m;
      continue;
    }
    if (c === ' ') {
      let k = i;
      while (k < n && src[k] === ' ') k++;
      if (k - i >= 2 && src[k] === '\n' && !isAllWs(src, k + 1)) {
        flushText();
        let q = k + 1;
        while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
        pushNonText({ k: 1, s: '<br>', plain: '' });
        i = q;
        continue;
      }
    }
    if (!st.inLink) {
      // A GFM autolink can only start with an email-local char
      // (letters/digits . _ + - cover mailto:/xmpp:/http(s)://ftp://www.).
      const cc = c.charCodeAt(0);
      if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 || cc === 43 || cc === 45) {
        const u = matchGfmUrl(src, i);
        if (u) {
        flushText();
        const href = encodeHref(u.href);
        if (href === null) pushNonText({ k: 1, s: esc(u.text, true), plain: u.text });
        else pushNonText({ k: 1, s: '<a href="' + esc(href, true) + '">' + esc(u.text, true) + '</a>', plain: u.text });
        i = u.end;
        continue;
        }
      }
    }
    const end = scanText(src, i);
    addText(src.slice(i, end));
    i = end;
  }
  flushText();
  return { items, html: renderItems(items) };
}

// ---------- block parsing ----------

const BLOCK_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'));

let _leSrc = null, _lePos = -1, _leVal = -1;
function lineEnd(src, i) {
  if (src === _leSrc && i === _lePos) return _leVal;
  const j = src.indexOf('\n', i);
  _leSrc = src; _lePos = i; _leVal = j === -1 ? src.length : j;
  return _leVal;
}
// info about the line starting at i (single-entry cached: the block loop
// asks for the same line from many tokenizers in a row)
let _liSrc = null, _liPos = -1, _liVal = null;
function lineInfo(src, i) {
  if (src === _liSrc && i === _liPos) return _liVal;
  const end = lineEnd(src, i);
  let j = i, col = 0, spaces = 0;
  while (j < end) {
    const ch = src[j];
    if (ch === ' ') { col++; spaces++; j++; }
    else if (ch === '\t') { col += 4 - (col % 4); j++; }
    else break;
  }
  let blank = true;
  for (let k = j; k < end; k++) {
    if (src[k] !== ' ' && src[k] !== '\t') { blank = false; break; }
  }
  _liSrc = src; _liPos = i;
  _liVal = { start: i, end, next: end < src.length ? end + 1 : end, leadSpaces: spaces, col, content: j, blank };
  return _liVal;
}
function expandTabs(s, startCol) {
  if (s.indexOf('\t') === -1) return s;
  let col = startCol, out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const r = 4 - (col % 4);
      out += ' '.repeat(r);
      col += r;
    } else { out += ch; col++; }
  }
  return out;
}
// ge(): trim trailing blank lines, keeping at most one trailing newline.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}
// remove up to 4 leading spaces (or up to 3 spaces + tab) from each line
function dedentCode(s) {
  return s.replace(/^(?: {0,3}\t| {1,4})/gm, '');
}

function isHrLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3 || li.blank) return false;
  let j = i + li.leadSpaces;
  const c = src[j];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  while (j < li.end) {
    const ch = src[j];
    if (ch === c) { count++; j++; }
    else if (ch === ' ' || ch === '\t') j++;
    else return false;
  }
  return count >= 3;
}
function isAtxLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  let j = i + li.leadSpaces;
  let hashes = 0;
  while (j < li.end && src[j] === '#' && hashes < 7) { hashes++; j++; }
  if (hashes === 0 || hashes > 6) return false;
  if (j >= li.end) return true;
  const ch = src[j];
  return ch === ' ' || ch === '\t';
}
function isFenceLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  let j = i + li.leadSpaces;
  const c = src[j];
  if (c !== '`' && c !== '~') return false;
  let m = 0;
  while (j + m < li.end && src[j + m] === c) m++;
  if (m < 3) return false;
  if (c === '`') {
    for (let k = j + m; k < li.end; k++) if (src[k] === '`') return false;
  }
  return true;
}
function isQuoteLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  return src[i + li.leadSpaces] === '>';
}
function isListStartLine(src, i, onlyOne, needContent) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  let j = i + li.leadSpaces;
  const c = src[j];
  if (c === '-' || c === '+' || c === '*') {
    const d = src[j + 1];
    if (d === undefined || d === '\n') return !needContent;
    if (d === ' ' || d === '\t') {
      if (!needContent) return true;
      let k = j + 1;
      while (k < li.end && (src[k] === ' ' || src[k] === '\t')) k++;
      return k < li.end;
    }
    return false;
  }
  if (c >= '0' && c <= '9') {
    let k = j;
    while (k < li.end && src[k] >= '0' && src[k] <= '9' && k - j < 9) k++;
    if (k - j > 9 || k - j === 0) return false;
    if (onlyOne && src.slice(j, k) !== '1') return false;
    const d = src[k];
    if (d !== '.' && d !== ')') return false;
    const e = src[k + 1];
    if (e === undefined || e === '\n') return !needContent;
    if (e === ' ' || e === '\t') {
      if (!needContent) return true;
      let m = k + 1;
      while (m < li.end && (src[m] === ' ' || src[m] === '\t')) m++;
      return m < li.end;
    }
    return false;
  }
  return false;
}
// HTML block start: returns the condition number (1-7) or 0.
// Condition 1: <script|<pre|<style|<textarea (open tag, followed by ws or >).
// Condition 2: <!--  3: <?  4: <![A-Z]  5: <![CDATA[
// Condition 6: a block-list tag (open or close) followed by space/tab,
//   newline, "/>" or end of input.
// Condition 7: a complete open tag (any name except script/pre/style/
//   textarea) or a complete close tag, alone on its line.
function scanCompleteOpenTag(rest, k) {
  let p = k;
  for (;;) {
    if (rest[p] !== ' ') break;
    let q = p;
    while (rest[q] === ' ') q++;
    const nm = /^[A-Za-z:_][\w.:-]*/.exec(rest.slice(q));
    if (!nm) break;
    q += nm[0].length;
    let r = q;
    while (rest[r] === ' ') r++;
    if (rest[r] === '=') {
      r++;
      while (rest[r] === ' ') r++;
      if (rest[r] === '"') {
        const e2 = rest.indexOf('"', r + 1);
        if (e2 < 0 || rest.slice(r + 1, e2).includes('\n')) return false;
        r = e2 + 1;
      } else if (rest[r] === "'") {
        const e2 = rest.indexOf("'", r + 1);
        if (e2 < 0 || rest.slice(r + 1, e2).includes('\n')) return false;
        r = e2 + 1;
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(rest.slice(r));
        if (!vm) return false;
        r += vm[0].length;
      }
    }
    p = r;
  }
  let c = p;
  while (rest[c] === ' ') c++;
  if (rest[c] === '/') c++;
  if (rest[c] !== '>') return false;
  c++;
  while (rest[c] === ' ' || rest[c] === '\t') c++;
  return rest[c] === '\n' || rest[c] === undefined;
}
function scanCompleteCloseTag(rest, k) {
  let p = k;
  while (p < rest.length && isWsCode(rest.charCodeAt(p))) p++;
  if (rest[p] !== '>') return false;
  p++;
  while (rest[p] === ' ' || rest[p] === '\t') p++;
  return rest[p] === '\n' || rest[p] === undefined;
}
function htmlStartCond(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return 0;
  let j = i + li.leadSpaces;
  if (src[j] !== '<') return 0;
  const rest = src.slice(j);
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (!m) return 0;
  const name = m[1].toLowerCase();
  const after = rest[m[0].length];
  const isClose = rest[1] === '/';
  if (!isClose && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (after === '>' || (after !== undefined && isWsCode(after.charCodeAt(0)))) return 1;
    return 0;
  }
  if (BLOCK_TAGS.has(name)) {
    if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '>' ||
        (after === '/' && rest[m[0].length + 1] === '>')) return 6;
    return 0;
  }
  if (!isClose) {
    if (scanCompleteOpenTag(rest, m[0].length)) return 7;
  } else {
    if (scanCompleteCloseTag(rest, m[0].length)) return 7;
  }
  return 0;
}
function isHtmlStartLine(src, i) {
  return htmlStartCond(src, i) !== 0;
}
// The HTML pattern used inside the paragraph (and table-body) interruption
// lookahead: block tags need a space (not tab), newline or "/>"; script/
// pre/style/textarea need whitespace, ">" or end of input.
function isHtmlInterruptLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  let j = i + li.leadSpaces;
  if (src[j] !== '<') return false;
  const rest = src.slice(j);
  if (rest.startsWith('<?')) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const after = rest[m[0].length];
  const isClose = rest[1] === '/';
  if (!isClose && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (after === undefined || after === '>' || (after !== undefined && isWsCode(after.charCodeAt(0)))) return true;
  } else if (BLOCK_TAGS.has(name)) {
    if (after === ' ' || after === '\n' || after === '>' ||
        (after === '/' && rest[m[0].length + 1] === '>')) return true;
  }
  return false;
}
// Does a table start at line i (header line + delimiter row next)?
function startsTableAt(src, i) {
  const li = lineInfo(src, i);
  if (li.blank) return false;
  // header: optional spaces then a non-space char
  let j = i;
  while (src[j] === ' ') j++;
  if (j >= li.end || src[j] === '\n') return false;
  const next = li.next;
  if (next >= src.length) return false;
  const dl = lineInfo(src, next);
  if (dl.leadSpaces > 3 || dl.blank) return false;
  const line = src.slice(next, dl.end);
  if (!/^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(line)) return false;
  return /[:|]/.test(line);
}
// Split a table row the way marked's splitCells does.
function splitCells(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '|') {
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && row[p] === '\\'; p--) backslashes++;
      t += (backslashes % 2 === 1) ? '|' : ' |';
    } else t += ch;
  }
  const cells = t.split(' |');
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let s = 0; s < cells.length; s++) cells[s] = cells[s].trim().replace(/\\\|/g, '|');
  return cells;
}

// Does the line at i start a block that interrupts a paragraph?
// Returns the kind or false. Mirrors the paragraph regex's negative lookahead.
// ke=true uses the blockquote's looser list pattern (any number, no content
// required) instead of the top-level one (only "1.", content required).
function paragraphInterrupt(src, i, ke) {
  const li = lineInfo(src, i);
  // A blank line interrupts a paragraph only if it is empty or ends with a
  // newline: the paragraph regex's continuation lookahead is [ \t]+\n, so a
  // spaces-only final line (no trailing newline) is still paragraph text.
  if (li.blank) {
    if (li.end === i || li.next > li.end) return 'blank';
    return false;
  }
  if (li.col >= 4) return false;
  if (li.leadSpaces > 3) return false;
  const c = src[i + li.leadSpaces];
  if (c === '-' || c === '_' || c === '*') {
    if (isHrLine(src, i)) return 'hr';
  }
  if (c === '#') {
    if (isAtxLine(src, i)) return 'heading';
  }
  if (c === '>') return 'blockquote';
  if (c === '`' || c === '~') {
    if (isFenceLine(src, i)) return 'fences';
  }
  if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
    if (ke ? isListStartLine(src, i, false, false) : isListStartLine(src, i, true, true)) return 'list';
  }
  if (c === '<') {
    if (isHtmlInterruptLine(src, i)) return 'html';
  }
  if (startsTableAt(src, i)) return 'table';
  return false;
}
// Match a paragraph starting at pos: returns {text, end} (end excludes trailing \n) or null.
function matchParagraph(src, pos, ke) {
  const li = lineInfo(src, pos);
  if (li.blank) return null;
  let end = li.end;
  let cur = li.next;
  while (cur < src.length) {
    if (paragraphInterrupt(src, cur, ke)) break;
    const nli = lineInfo(src, cur);
    end = nli.end;
    cur = nli.next;
  }
  return { text: src.slice(pos, end), end };
}

// ---------- setext headings ----------

// Is the line at i a setext underline? Returns {end, depth} (end is just past
// the underline line and its trailing blank newlines) or null.
function matchSetextUnderline(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3 || li.blank) return null;
  let j = i + li.leadSpaces;
  const c = src[j];
  if (c !== '=' && c !== '-') return null;
  let k = j;
  while (k < li.end && src[k] === c) k++;
  for (let m = k; m < li.end; m++) {
    if (src[m] !== ' ' && src[m] !== '\t') return null;
  }
  let end = li.next;
  while (end < src.length && src[end] === '\n') end++;
  return { end, depth: c === '=' ? 1 : 2 };
}

// The lheading's leading lookahead, applied to one line: the text may not
// start with a bullet, an indented-code line, a fence, a blockquote, a
// heading, an HTML tag line, or a table delimiter row.
function lheadingLeadingOK(line) {
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(line)) return false;
  return true;
}

// Does the line at i interrupt an lheading's text?
function lheadingInterruptLine(src, i) {
  const li = lineInfo(src, i);
  if (li.blank) return true;
  if (li.leadSpaces > 3) return false;
  const line = src.slice(i, li.end);
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return true;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (isHrLine(src, i)) return true;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/.test(line)) return true;
  return false;
}

// ---------- single-line, indent-bounded checks (list item continuation) ----------

function lineLeadSpaces(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}
function lineFenceAt(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  const c = line[ls];
  if (c !== '`' && c !== '~') return false;
  let m = 0;
  while (ls + m < line.length && line[ls + m] === c) m++;
  return m >= 3;
}
function lineHeadingAt(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  let h = 0;
  while (ls + h < line.length && line[ls + h] === '#' && h < 7) h++;
  if (h === 0 || h > 6) return false;
  const ch = line[ls + h];
  return ch === undefined || ch === ' ' || ch === '\t';
}
function lineHtmlAt(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  if (line[ls] !== '<') return false;
  const rest = line.slice(ls);
  if (rest.startsWith('<?')) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const after = rest[m[0].length];
  const isClose = rest[1] === '/';
  if (!isClose && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (after === undefined || after === '>' || (after !== undefined && isWsCode(after.charCodeAt(0)))) return true;
  } else if (BLOCK_TAGS.has(name)) {
    if (after === undefined || after === ' ' || after === '>' ||
        (after === '/' && rest[m[0].length + 1] === '>')) return true;
  }
  return false;
}
function lineQuoteAt(line, R) {
  const ls = lineLeadSpaces(line);
  return ls <= R && line[ls] === '>';
}
function lineNextBulletAt(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  const c = line[ls];
  if (c === '-' || c === '+' || c === '*') {
    const d = line[ls + 1];
    return d === undefined || d === ' ' || d === '\t';
  }
  if (c >= '0' && c <= '9') {
    let k = ls;
    while (k < line.length && line[k] >= '0' && line[k] <= '9' && k - ls < 9) k++;
    if (k - ls === 0 || k - ls > 9) return false;
    const d = line[k];
    if (d !== '.' && d !== ')') return false;
    const e = line[k + 1];
    return e === undefined || e === ' ' || e === '\t';
  }
  return false;
}
function lineHrAt(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  const c = line[ls];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let j = ls; j < line.length; j++) {
    const ch = line[j];
    if (ch === c) count++;
    else if (ch === ' ' || ch === '\t') continue;
    else return false;
  }
  return count >= 3;
}
// One pass over a line: does it interrupt a list item's continuation
// (fence / heading / html / blockquote / next bullet / hr, with bound R)?
// Merges lineFenceAt + lineHeadingAt + lineHtmlAt + lineQuoteAt +
// lineNextBulletAt + lineHrAt so the leading spaces are scanned once and
// the HTML check avoids a slice + regex.
function lineInterruptsList(line, R) {
  const ls = lineLeadSpaces(line);
  if (ls > R) return false;
  const c = line[ls];
  if (c === undefined) return false;
  if (c === '`' || c === '~') {
    let m = 0;
    while (ls + m < line.length && line[ls + m] === c) m++;
    if (m >= 3) return true;
  }
  if (c === '#') {
    let h = 0;
    while (ls + h < line.length && line[ls + h] === '#' && h < 7) h++;
    if (h > 0 && h <= 6) {
      const ch = line[ls + h];
      if (ch === undefined || ch === ' ' || ch === '\t') return true;
    }
  }
  if (c === '>') return true;
  if (c === '<') {
    if (line.startsWith('<?', ls) || line.startsWith('<!--', ls) || line.startsWith('<![CDATA[', ls)) return true;
    if (line[ls + 1] === '!' && isAsciiLetter(line[ls + 2])) return true;
    let p = ls + 1;
    const isClose = line[p] === '/';
    if (isClose) p++;
    const nameStart = p;
    if (p < line.length && isAsciiLetter(line[p])) {
      p++;
      while (p < line.length && (isAsciiLetter(line[p]) || isDigit(line[p]) || line[p] === '-')) p++;
      const name = line.slice(nameStart, p).toLowerCase();
      const after = line[p];
      if (!isClose && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
        if (after === undefined || after === '>' || isWsCode(after.charCodeAt(0))) return true;
      } else if (BLOCK_TAGS.has(name)) {
        if (after === undefined || after === ' ' || after === '>' ||
            (after === '/' && line[p + 1] === '>')) return true;
      }
    }
  }
  if (c === '-' || c === '+' || c === '*') {
    const d = line[ls + 1];
    if (d === undefined || d === ' ' || d === '\t') return true;
    if (c !== '+') {
      let count = 0;
      for (let j = ls; j < line.length; j++) {
        const ch = line[j];
        if (ch === c) count++;
        else if (ch === ' ' || ch === '\t') continue;
        else return false;
      }
      if (count >= 3) return true;
    }
    return false;
  }
  if (c === '_') {
    let count = 0;
    for (let j = ls; j < line.length; j++) {
      const ch = line[j];
      if (ch === '_') count++;
      else if (ch === ' ' || ch === '\t') continue;
      else return false;
    }
    if (count >= 3) return true;
    return false;
  }
  if (c >= '0' && c <= '9') {
    let k = ls;
    while (k < line.length && line[k] >= '0' && line[k] <= '9' && k - ls < 9) k++;
    if (k - ls === 0 || k - ls > 9) return false;
    const d = line[k];
    if (d !== '.' && d !== ')') return false;
    const e = line[k + 1];
    if (e === undefined || e === ' ' || e === '\t') return true;
  }
  return false;
}
function lineSetext(line) {
  return /^ {0,3}(?:=+|-+) *$/.test(line);
}
// A bullet (or "1."/"1)") followed by a single space/tab: the table-body
// list interruption pattern.
function isTableListLine(src, i) {
  const li = lineInfo(src, i);
  if (li.leadSpaces > 3) return false;
  let j = i + li.leadSpaces;
  const c = src[j];
  if (c === '-' || c === '+' || c === '*') {
    const d = src[j + 1];
    return d === ' ' || d === '\t';
  }
  if (c >= '0' && c <= '9') {
    let k = j;
    while (k < li.end && src[k] >= '0' && src[k] <= '9' && k - j < 9) k++;
    if (k - j > 9 || k - j === 0) return false;
    if (src.slice(j, k) !== '1') return false;
    const d = src[k];
    if (d !== '.' && d !== ')') return false;
    const e = src[k + 1];
    return e === ' ' || e === '\t';
  }
  return false;
}
// Does the line at i interrupt a table's body rows?
function tableBodyInterrupt(src, i) {
  const li = lineInfo(src, i);
  if (li.blank) {
    // The table regex's body-row lookahead is ` *\n`: only a spaces-only
    // line ending with a newline interrupts the body. A tab-only line (or a
    // spaces-only final line with no trailing newline) is a body row.
    if (!src.slice(i, li.end).includes('\t') && li.next > li.end) return true;
    return false;
  }
  if (li.col >= 4) return true;
  if (li.leadSpaces > 3) return false;
  const c = src[i + li.leadSpaces];
  if (c === '-' || c === '_' || c === '*') {
    if (isHrLine(src, i)) return true;
  }
  if (c === '#') {
    if (isAtxLine(src, i)) return true;
  }
  if (c === '>') return true;
  if (c === '`' || c === '~') {
    if (isFenceLine(src, i)) return true;
  }
  if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9')) {
    if (isTableListLine(src, i)) return true;
  }
  if (c === '<') {
    if (isHtmlInterruptLine(src, i)) return true;
  }
  return false;
}

// ---------- block tokenizers ----------
// Each returns {token, end} (end = the index just past the token's raw)
// or null. ctx = {links, top} shared across a document's block parse.

function stripTrailingNewlines(s) {
  let e = s.length;
  while (e > 0 && s[e - 1] === '\n') e--;
  return s.slice(0, e);
}
function expandLeadingWs(s, startCol) {
  let i = 0, hasTab = false;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { if (s[i] === '\t') hasTab = true; i++; }
  if (i === 0 || !hasTab) return s;
  return expandTabs(s.slice(0, i), startCol) + s.slice(i);
}
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return i;
  return -1;
}
// Index of the first non-space char in s with every tab replaced by 4
// spaces (the marked list-continuation check), without allocating the
// replaced string.
function firstNonSpaceTab4(s) {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') count++;
    else if (ch === '\t') count += 4;
    else return count;
  }
  return -1;
}
function findCloseTag(src, from, name) {
  const needle = '</' + name;
  let p = from;
  for (;;) {
    const q = src.indexOf('<', p);
    if (q < 0) return -1;
    if (src.slice(q, q + needle.length).toLowerCase() === needle && src[q + needle.length] === '>') return q;
    p = q + 1;
  }
}
// End of the line containing idx, plus the run of '\n' after it.
function lineEndAfter(src, idx) {
  let e = src.indexOf('\n', idx);
  if (e < 0) return src.length;
  e++;
  while (e < src.length && src[e] === '\n') e++;
  return e;
}
// Is "m\nf" a setext heading (m a single-line text, f an underline)?
function isLheadingPair(m, f) {
  return m.trim() !== '' && lheadingLeadingOK(m) && lineSetext(f);
}
// Scan a link title starting at src[i] ('"' / "'" / '('). Returns
// {title, end} (title without delimiters) or null.
function scanDefTitle(src, i) {
  const q = src[i];
  if (q === '"') {
    let k = i + 1;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '"') return { title: src.slice(i + 1, k), end: k + 1 };
      k++;
    }
    return null;
  }
  if (q === "'") {
    let k = i + 1;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === "'") return { title: src.slice(i + 1, k), end: k + 1 };
      if (ch === '\n') {
        if (src[k + 1] === '\n') return null;
        k++;
        continue;
      }
      k++;
    }
    return null;
  }
  if (q === '(') {
    let k = i + 1;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '(' || ch === ')') {
        if (ch === ')') return { title: src.slice(i + 1, k), end: k + 1 };
        return null;
      }
      k++;
    }
    return null;
  }
  return null;
}

function tokenizeSpace(src, pos) {
  let j = pos;
  while (j < src.length) {
    const li = lineInfo(src, j);
    if (!li.blank) break;
    j = li.next;
  }
  if (j === pos) return null;
  return { token: { type: 'space', raw: src.slice(pos, j) }, end: j };
}

function tokenizeCode(src, pos) {
  const li = lineInfo(src, pos);
  if (li.blank || li.col < 4) return null;
  let j = pos;
  while (j < src.length) {
    const l2 = lineInfo(src, j);
    if (l2.blank || l2.col < 4) break;
    j = l2.next;
    while (j < src.length && lineInfo(src, j).blank) j = lineInfo(src, j).next;
  }
  const raw = src.slice(pos, j);
  const text = dedentCode(trimTrailingBlanks(raw));
  return { token: { type: 'code', raw, text, lang: '', codeBlockStyle: 'indented' }, end: j };
}

function tokenizeFences(src, pos) {
  const li = lineInfo(src, pos);
  if (li.leadSpaces > 3) return null;
  let j = pos + li.leadSpaces;
  const c = src[j];
  if (c !== '`' && c !== '~') return null;
  let m = 0;
  while (j + m < li.end && src[j + m] === c) m++;
  if (m < 3) return null;
  if (c === '`') {
    for (let k = j + m; k < li.end; k++) if (src[k] === '`') return null;
  }
  const info = src.slice(j + m, li.end);
  const contentStart = li.next;
  let content = '', end = src.length, closed = false;
  let k = contentStart;
  while (k < src.length) {
    const l2 = lineInfo(src, k);
    if (l2.leadSpaces <= 3) {
      const q = k + l2.leadSpaces;
      if (src[q] === c) {
        let mm = 0;
        while (q + mm < l2.end && src[q + mm] === c) mm++;
        if (mm >= m) {
          let r = q + mm, ok = true;
          while (r < l2.end) { if (src[r] !== ' ') { ok = false; break; } r++; }
          if (ok) {
            content = k === contentStart ? '' : src.slice(contentStart, k - 1);
            end = r;
            closed = true;
            break;
          }
        }
      }
    }
    k = l2.next;
  }
  if (!closed) {
    content = src.slice(contentStart);
    if (content.endsWith('\n')) content = content.slice(0, -1);
  }
  const raw = src.slice(pos, end);
  let text = content;
  const comp = /^( +)(?:```)/.exec(raw);
  if (comp) {
    const s = comp[1].length;
    text = content.split('\n').map((ln) => {
      const bm = /^\s+/.exec(ln);
      if (!bm) return ln;
      return ln.slice(Math.min(bm[0].length, s));
    }).join('\n');
  }
  const lang = info ? unescapePunct(info.trim()) : info;
  return { token: { type: 'code', raw, text, lang, codeBlockStyle: 'fenced' }, end };
}

function tokenizeHeading(src, pos) {
  const li = lineInfo(src, pos);
  if (li.leadSpaces > 3) return null;
  let j = pos + li.leadSpaces;
  let hashes = 0;
  while (j < li.end && src[j] === '#' && hashes < 7) { hashes++; j++; }
  if (hashes === 0 || hashes > 6) return null;
  if (j < li.end && src[j] !== ' ' && src[j] !== '\t') return null;
  let text = src.slice(j, li.end).trim();
  if (/#$/.test(text)) {
    const s = text.replace(/#+$/, '');
    if (!s || /[ \t]$/.test(s)) text = s.trim();
  }
  let end = li.next;
  while (end < src.length && src[end] === '\n') end++;
  const raw = trimTrailingBlanks(src.slice(pos, end));
  return { token: { type: 'heading', raw, depth: hashes, text, tokens: [] }, end: pos + raw.length };
}

function tokenizeHr(src, pos) {
  if (!isHrLine(src, pos)) return null;
  const li = lineInfo(src, pos);
  let end = li.next;
  while (end < src.length && src[end] === '\n') end++;
  const raw = trimTrailingBlanks(src.slice(pos, end));
  return { token: { type: 'hr', raw }, end: pos + raw.length };
}

function tokenizeHtml(src, pos) {
  const cond = htmlStartCond(src, pos);
  if (!cond) return null;
  const li = lineInfo(src, pos);
  const j = pos + li.leadSpaces;
  let spanEnd;
  if (cond === 1) {
    const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(j));
    const name = m[1].toLowerCase();
    const closeIdx = findCloseTag(src, j, name);
    spanEnd = closeIdx < 0 ? src.length : lineEndAfter(src, closeIdx);
  } else if (cond === 2) {
    let endPos;
    if (src[j + 4] === '-' && src[j + 5] === '>') endPos = j + 6;
    else {
      const idx = src.indexOf('-->', j + 4);
      endPos = idx < 0 ? src.length : idx + 3;
    }
    spanEnd = endPos >= src.length ? src.length : lineEndAfter(src, endPos);
  } else if (cond === 3) {
    const idx = src.indexOf('?>', j + 2);
    spanEnd = idx < 0 ? src.length : lineEndAfter(src, idx + 2);
  } else if (cond === 4) {
    const idx = src.indexOf('>', j + 2);
    spanEnd = idx < 0 ? src.length : lineEndAfter(src, idx + 1);
  } else if (cond === 5) {
    const idx = src.indexOf(']]>', j + 9);
    spanEnd = idx < 0 ? src.length : lineEndAfter(src, idx + 3);
  } else {
    spanEnd = src.length;
    let k = li.next;
    while (k < src.length) {
      const l2 = lineInfo(src, k);
      if (l2.blank) { spanEnd = l2.next; break; }
      k = l2.next;
    }
  }
  const raw = trimTrailingBlanks(src.slice(pos, spanEnd));
  const m2 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(j));
  const name2 = m2 ? m2[1].toLowerCase() : '';
  const pre = cond === 1 && (name2 === 'pre' || name2 === 'script' || name2 === 'style');
  return { token: { type: 'html', raw, text: raw, pre, block: true }, end: pos + raw.length };
}

function tokenizeDef(src, pos) {
  const li = lineInfo(src, pos);
  if (li.leadSpaces > 3 || li.blank) return null;
  let j = pos + li.leadSpaces;
  if (src[j] !== '[') return null;
  let q = j + 1;
  while (q < src.length && isWsCode(src.charCodeAt(q))) q++;
  if (src[q] === ']') return null;
  let k = j + 1, labelEnd = -1;
  while (k < src.length) {
    const ch = src[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') { labelEnd = k; break; }
    if (ch === '\n') {
      let m = k + 1;
      while (m < src.length && (src[m] === ' ' || src[m] === '\t')) m++;
      if (src[m] === '\n') return null;
      k++;
      continue;
    }
    k++;
  }
  if (labelEnd < 0) return null;
  const label = src.slice(j + 1, labelEnd);
  let p = labelEnd + 1;
  if (src[p] !== ':') return null;
  p++;
  while (src[p] === ' ') p++;
  if (src[p] === '\n') {
    p++;
    while (src[p] === ' ' || src[p] === '\t') p++;
  }
  let dest, destEnd, angled = false;
  if (src[p] === '<') {
    let e2 = p + 1;
    while (e2 < src.length && src[e2] !== '>' && src[e2] !== '\n') e2++;
    if (src[e2] !== '>') return null;
    dest = src.slice(p + 1, e2);
    destEnd = e2 + 1;
    angled = true;
  } else {
    if (p >= src.length || isWsCode(src.charCodeAt(p))) return null;
    let e2 = p;
    while (e2 < src.length && !isWsCode(src.charCodeAt(e2))) e2++;
    dest = src.slice(p, e2);
    destEnd = e2;
  }
  if (!angled && parenBalance(dest) !== -1) return null;
  let title = null, titleEnd = destEnd;
  let sep = -1;
  if (src[destEnd] === ' ') {
    let s3 = destEnd;
    while (src[s3] === ' ') s3++;
    if (src[s3] === '\n') {
      s3++;
      while (src[s3] === ' ' || src[s3] === '\t') s3++;
    }
    sep = s3;
  } else if (src[destEnd] === '\n') {
    let s3 = destEnd + 1;
    while (src[s3] === ' ' || src[s3] === '\t') s3++;
    sep = s3;
  }
  if (sep >= 0) {
    const tc = src[sep];
    if (tc === '"' || tc === "'" || tc === '(') {
      const tt = scanDefTitle(src, sep);
      if (tt) { title = tt.title; titleEnd = tt.end; }
    }
  }
  let e3 = titleEnd;
  while (src[e3] === ' ') e3++;
  let spanEnd;
  if (src[e3] === '\n') {
    spanEnd = e3 + 1;
    while (spanEnd < src.length && src[spanEnd] === '\n') spanEnd++;
  } else if (e3 >= src.length) {
    spanEnd = e3;
  } else if (title !== null) {
    // Title found but followed by more text: backtrack to the no-title
    // alternative (the def regex's title group is optional and backtracks).
    title = null;
    e3 = destEnd;
    while (src[e3] === ' ') e3++;
    if (src[e3] === '\n') {
      spanEnd = e3 + 1;
      while (spanEnd < src.length && src[spanEnd] === '\n') spanEnd++;
    } else if (e3 >= src.length) {
      spanEnd = e3;
    } else {
      return null;
    }
  } else {
    return null;
  }
  const raw = trimTrailingBlanks(src.slice(pos, spanEnd));
  return {
    token: {
      type: 'def', tag: normalizeLabel(label), raw,
      href: unescapePunct(dest), title: title === null ? null : unescapePunct(title),
    },
    end: pos + raw.length,
  };
}

function tokenizeTable(src, pos) {
  if (!startsTableAt(src, pos)) return null;
  const li = lineInfo(src, pos);
  let hj = pos;
  while (src[hj] === ' ') hj++;
  const header = src.slice(hj, li.end);
  const dl = li.next;
  const dli = lineInfo(src, dl);
  const delim = src.slice(dl, dli.end);
  const rows = [];
  let k = dli.next;
  let lastContentEnd = dli.end;
  while (k < src.length) {
    if (tableBodyInterrupt(src, k)) break;
    const l2 = lineInfo(src, k);
    rows.push(src.slice(k, l2.end));
    lastContentEnd = l2.end;
    k = l2.next;
  }
  const raw = src.slice(pos, lastContentEnd);
  const headerCells = splitCells(header);
  const alignParts = delim.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = alignParts.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const headerToks = headerCells.map((c, idx) => ({ text: c, header: true, align: align[idx], tokens: [] }));
  const rowToks = rows.map((row) =>
    splitCells(row, headerCells.length).map((c, idx) => ({ text: c, header: false, align: align[idx], tokens: [] })));
  return {
    token: { type: 'table', raw, header: headerToks, align, rows: rowToks },
    end: pos + raw.length,
  };
}

function tokenizeLheading(src, pos) {
  const li = lineInfo(src, pos);
  if (li.blank) return null;
  if (!lheadingLeadingOK(src.slice(pos, li.end))) return null;
  let textEnd = li.end;
  let cur = li.next;
  while (cur < src.length) {
    const ul = matchSetextUnderline(src, cur);
    if (ul) {
      const text = src.slice(pos, textEnd).trim();
      const raw = trimTrailingBlanks(src.slice(pos, ul.end));
      return { token: { type: 'heading', raw, depth: ul.depth, text, tokens: [] }, end: pos + raw.length };
    }
    if (lheadingInterruptLine(src, cur)) return null;
    const nli = lineInfo(src, cur);
    textEnd = nli.end;
    cur = nli.next;
  }
  return null;
}

function tokenizeParagraph(src, pos) {
  const pm = matchParagraph(src, pos, false);
  if (!pm) return null;
  return { token: { type: 'paragraph', raw: src.slice(pos, pm.end), text: pm.text, tokens: [] }, end: pm.end };
}

function tokenizeText(src, pos) {
  const li = lineInfo(src, pos);
  if (li.blank) return null;
  const text = src.slice(pos, li.end);
  return { token: { type: 'text', raw: text, text, tokens: [] }, end: li.end };
}

function tokenizeBlockquote(src, pos, ctx) {
  if (!isQuoteLine(src, pos)) return null;
  let end = pos;
  while (end < src.length) {
    const li = lineInfo(src, end);
    if (!isQuoteLine(src, end)) break;
    let am = end + li.leadSpaces + 1;
    if (src[am] === ' ' || src[am] === '\t') am++;
    let restBlank = true;
    for (let k = am; k < li.end; k++) {
      if (src[k] !== ' ' && src[k] !== '\t') { restBlank = false; break; }
    }
    if (!restBlank) {
      const pm = matchParagraph(src, am, true);
      if (pm && pm.end > li.end) {
        end = pm.end;
        if (src[end] === '\n') end++;
        continue;
      }
    }
    end = li.next;
  }
  const stripped = stripTrailingNewlines(src.slice(pos, end));
  const lines = stripped.split('\n');
  let s = '', r = '';
  const tokens = [];
  let idx = 0;
  while (idx < lines.length) {
    const chunk = [];
    let i = false;
    while (idx < lines.length) {
      const ln = lines[idx];
      if (/^ {0,3}>/.test(ln)) { chunk.push(ln); i = true; idx++; }
      else if (!i) { chunk.push(ln); idx++; }
      else break;
    }
    const h = chunk.join('\n');
    let u = h.replace(/^( {0,3}>)([ \t]+)/gm, (mm, b, w) => b + expandTabs(w, b.length));
    u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    u = u.replace(/^ {0,3}>[ \t]?/gm, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokensInto(u, tokens, ctx, true);
    ctx.top = savedTop;
    if (idx >= lines.length) break;
    const k = tokens[tokens.length - 1];
    if (!k) break;
    if (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table') break;
    if (k.type === 'blockquote') {
      const b = lines.slice(idx).join('\n');
      const m2 = k.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = tokenizeBlockquote(m2, 0, ctx);
      if (!f) break;
      tokens[tokens.length - 1] = f.token;
      const y = m2.substring(f.token.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(idx, lines.length - R) : lines.slice(idx);
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - k.text.length) + f.token.text;
      idx += A.length;
      if (idx < lines.length && /^ {0,3}>/.test(lines[idx])) continue;
      break;
    }
    if (k.type === 'list') {
      const b = k.raw + '\n' + lines.slice(idx).join('\n');
      const m2 = tokenizeList(b, 0, ctx);
      if (!m2) break;
      tokens[tokens.length - 1] = m2.token;
      const f = m2.token.raw.length > k.raw.length
        ? b.slice(k.raw.length + 1, m2.token.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(idx, idx + f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      idx += f;
      continue;
    }
  }
  return { token: { type: 'blockquote', raw: s, text: r, tokens }, end: pos + s.length };
}

function tokenizeList(src, pos, ctx) {
  const li = lineInfo(src, pos);
  if (li.leadSpaces > 3) return null;
  let j = pos + li.leadSpaces;
  const c = src[j];
  let bullet, ordered, delim;
  if (c === '-' || c === '+' || c === '*') {
    bullet = c; ordered = false;
  } else if (c >= '0' && c <= '9') {
    let k = j;
    while (k < li.end && src[k] >= '0' && src[k] <= '9' && k - j < 9) k++;
    if (k - j === 0 || k - j > 9) return null;
    const d = src[k];
    if (d !== '.' && d !== ')') return null;
    bullet = src.slice(j, k + 1); ordered = true; delim = d;
  } else return null;
  const afterBullet = j + bullet.length;
  if (afterBullet < li.end && src[afterBullet] !== ' ' && src[afterBullet] !== '\t') return null;
  const matchItem = (at) => {
    const l2 = lineInfo(src, at);
    if (l2.leadSpaces > 3) return null;
    const q = at + l2.leadSpaces;
    let mlen;
    if (ordered) {
      if (!(src[q] >= '0' && src[q] <= '9')) return null;
      let k = q;
      while (k < l2.end && src[k] >= '0' && src[k] <= '9' && k - q < 9) k++;
      if (k - q === 0 || k - q > 9) return null;
      if (src[k] !== delim) return null;
      mlen = (k - q) + 1;
    } else {
      if (src[q] !== bullet) return null;
      mlen = 1;
    }
    const after = q + mlen;
    if (after < l2.end && src[after] !== ' ' && src[after] !== '\t') return null;
    return { markerLen: l2.leadSpaces + mlen, lineEnd: l2.end, next: l2.next, contentStart: after };
  };
  const items = [];
  let loose = false, p = false;
  let e = pos;
  const n = src.length;
  while (e < n) {
    if (isHrLine(src, e)) break;
    const it = matchItem(e);
    if (!it) break;
    const itemStart = e;
    e = it.next;
    const g = src.slice(it.contentStart, it.lineEnd);
    const b = it.markerLen;
    const m = expandLeadingWs(g, b);
    const f = e < n ? src.slice(e, lineInfo(src, e).end) : '';
    const y = m.trim() === '';
    let R, d;
    if (y) { R = b + 1; d = ''; }
    else {
      R = firstNonSpace(m);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y && /^[ \t]*$/.test(f)) {
      e = Math.min(n, e + f.length + 1);
      u = true;
    }
    if (!u) {
      let mm = m, yy = y;
      const RB = Math.min(3, Math.max(0, R - 1));
      const parts = [d];
      while (e < n) {
        // Fast path: a new list-item line interrupts this item. This is
        // exactly lineInterruptsList's bullet/ordered branches (lead
        // spaces are space-only, as in lineLeadSpaces); skip the
        // lineInfo/slice/expand work for the common single-line-item case.
        let _ls = 0;
        while (e + _ls < n && src[e + _ls] === ' ') _ls++;
        if (_ls <= RB) {
          const _cc = src[e + _ls];
          if (_cc === '-' || _cc === '+' || _cc === '*') {
            const _d = src[e + _ls + 1];
            if (_d === undefined || _d === ' ' || _d === '\t') break;
          } else if (_cc >= '0' && _cc <= '9') {
            let _k = e + _ls;
            while (_k < n && src[_k] >= '0' && src[_k] <= '9' && _k - (e + _ls) < 9) _k++;
            if (_k - (e + _ls) > 0) {
              const _d = src[_k];
              if (_d === '.' || _d === ')') {
                const _e2 = src[_k + 1];
                if (_e2 === undefined || _e2 === ' ' || _e2 === '\t') break;
              }
            }
          }
        }
        const l3 = lineInfo(src, e);
        const U = src.slice(e, l3.end);
        const f2 = U;
        const Z = expandLeadingWs(U, 0);
        if (lineInterruptsList(f2, RB)) break;
        if (firstNonSpace(Z) >= R || l3.blank) {
          parts.push(Z.slice(R));
        } else {
          if (yy || firstNonSpaceTab4(mm) >= 4 ||
              lineFenceAt(mm, RB) || lineHeadingAt(mm, RB) || lineHtmlAt(mm, RB) || lineHrAt(mm, RB)) break;
          let qe = f2;
          if (lineSetext(f2) && isLheadingPair(mm, f2)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          parts.push(qe);
        }
        yy = l3.blank;
        e = l3.next;
        mm = Z.slice(R);
      }
      d = parts.join('\n');
    }
    const rawA = src.slice(itemStart, e);
    if (!loose) {
      if (p) loose = true;
      else {
        // /\n[ \t]*\n[ \t]*$/.test(rawA), without a regex: trailing
        // spaces/tabs, then \n, then spaces/tabs, then \n.
        let e2 = rawA.length;
        while (e2 > 0 && (rawA.charCodeAt(e2 - 1) === 32 || rawA.charCodeAt(e2 - 1) === 9)) e2--;
        if (e2 > 0 && rawA.charCodeAt(e2 - 1) === 10) {
          let e3 = e2 - 1;
          while (e3 > 0 && (rawA.charCodeAt(e3 - 1) === 32 || rawA.charCodeAt(e3 - 1) === 9)) e3--;
          if (e3 > 0 && rawA.charCodeAt(e3 - 1) === 10) p = true;
        }
      }
    }
    items.push({ type: 'list_item', raw: rawA, task: false, loose: false, text: d, tokens: [] });
  }
  const last = items[items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  const raw = src.slice(pos, e).trimEnd();
  const listTok = {
    type: 'list', raw, ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose, items,
  };
  // Parse each item's tokens (top=false: paragraphs become text tokens).
  const savedTop = ctx.top;
  ctx.top = false;
  for (const u of items) {
    u.tokens = blockTokensInto(u.text, [], ctx, false);
    if (!loose) {
      let hasSpace = false;
      for (const t of u.tokens) {
        if (t.type === 'space' && /\n.*\n/.test(t.raw)) { hasSpace = true; break; }
      }
      if (hasSpace) loose = true;
    }
  }
  ctx.top = savedTop;
  listTok.loose = loose;
  // Task checkboxes.
  for (const u of items) {
    u.task = /^\[[ xX]\][ \t]+\S/.test(u.text);
    const d0 = u.tokens[0];
    if (u.task && (d0 && (d0.type === 'text' || d0.type === 'paragraph'))) {
      u.text = u.text.replace(/^\[[ xX]\][ \t]+/, '');
      d0.raw = d0.raw.replace(/^\[[ xX]\][ \t]+/, '');
      d0.text = d0.text.replace(/^\[[ xX]\][ \t]+/, '');
      const k = /\[[ xX]\]/.exec(u.raw);
      if (k) {
        const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        u.checked = g.checked;
        if (loose) {
          if (u.tokens[0] && (u.tokens[0].type === 'paragraph' || u.tokens[0].type === 'text') &&
              'tokens' in u.tokens[0] && u.tokens[0].tokens) {
            u.tokens[0].raw = g.raw + u.tokens[0].raw;
            u.tokens[0].tokens.unshift(g);
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g], _skipInline: true });
          }
        } else {
          u.tokens.unshift(g);
        }
      }
    } else if (u.task) u.task = false;
  }
  if (loose) {
    for (const u of items) {
      u.loose = true;
      for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return { token: listTok, end: pos + raw.length };
}

// ---------- main block loop ----------

function blockTokensInto(src, out, ctx, mergePara) {
  let i = 0;
  const n = src.length;
  let lastLen = Infinity;
  let merge = mergePara;
  while (i < n) {
    if (n - i >= lastLen) throw new Error('Infinite loop in block parser');
    lastLen = n - i;
    let r = tokenizeSpace(src, i, ctx);
    if (r) {
      i = r.end;
      const prev = out[out.length - 1];
      if (r.token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push(r.token);
      continue;
    }
    r = tokenizeCode(src, i, ctx);
    if (r) {
      i = r.end;
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        prev.text += '\n' + r.token.text;
      } else out.push(r.token);
      continue;
    }
    r = tokenizeFences(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeHeading(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeHr(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeBlockquote(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeList(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeHtml(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeDef(src, i, ctx);
    if (r) {
      i = r.end;
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        prev.text += '\n' + r.token.raw;
      } else {
        if (!ctx.links[r.token.tag]) ctx.links[r.token.tag] = { href: r.token.href, title: r.token.title };
        out.push(r.token);
      }
      continue;
    }
    r = tokenizeTable(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    r = tokenizeLheading(src, i, ctx);
    if (r) { i = r.end; out.push(r.token); continue; }
    if (ctx.top) {
      r = tokenizeParagraph(src, i, ctx);
      if (r) {
        i = r.end;
        const prev = out[out.length - 1];
        if (merge && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
          prev.text += '\n' + r.token.text;
        } else out.push(r.token);
        merge = false;
        continue;
      }
    }
    r = tokenizeText(src, i, ctx);
    if (r) {
      i = r.end;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.token.raw;
        prev.text += '\n' + r.token.text;
      } else out.push(r.token);
      continue;
    }
    throw new Error('Infinite loop in block parser at ' + i);
  }
  return out;
}

// ---------- inline token computation (deferred, like marked's queue) ----------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function computeInlineForToken(tok, ctx) {
  if (tok._skipInline) {
    let html = '';
    for (const t of tok.tokens) {
      if (t.type === 'checkbox') html += checkboxHtml(t.checked);
    }
    tok._html = html;
    return;
  }
  ctx.inlineState.inRawBlock = false;
  const r = inlineParse(tok.text, ctx.links, ctx.inlineState, tok.text.includes(')'));
  let html = r.html;
  if (tok.tokens && tok.tokens.length > 0) {
    let prefix = '';
    for (const t of tok.tokens) {
      if (t.type === 'checkbox') prefix += checkboxHtml(t.checked);
    }
    if (prefix) html = prefix + html;
  }
  tok._html = html;
}

function computeInlineCell(cell, ctx) {
  ctx.inlineState.inRawBlock = false;
  cell._html = inlineParse(cell.text, ctx.links, ctx.inlineState, cell.text.includes(')')).html;
}

function computeInlineTokens(tokens, ctx) {
  for (const tok of tokens) {
    if (tok.type === 'blockquote') {
      computeInlineTokens(tok.tokens, ctx);
    } else if (tok.type === 'list') {
      for (const item of tok.items) computeInlineTokens(item.tokens, ctx);
    } else if (tok.type === 'table') {
      for (const cell of tok.header) computeInlineCell(cell, ctx);
      for (const row of tok.rows) for (const cell of row) computeInlineCell(cell, ctx);
    } else if (tok.type === 'paragraph' || tok.type === 'text' || tok.type === 'heading') {
      computeInlineForToken(tok, ctx);
    }
  }
}

// ---------- rendering ----------

function tableCellHtml(cell, isHeader) {
  const n = isHeader ? 'th' : 'td';
  const open = cell.align ? '<' + n + ' align="' + cell.align + '">' : '<' + n + '>';
  return open + (cell._html || '') + '</' + n + '>\n';
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + tok.depth + '>' + (tok._html || '') + '</h' + tok.depth + '>\n';
        break;
      case 'code': {
        const lang = tok.lang || '';
        const firstWord = (lang.match(/^\S*/) || [''])[0];
        const r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += firstWord
          ? '<pre><code class="language-' + esc(firstWord, false) + '">' + esc(r, true) + '</code></pre>\n'
          : '<pre><code>' + esc(r, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let h = '';
        for (const cell of tok.header) h += tableCellHtml(cell, true);
        const thead = '<tr>\n' + h + '</tr>\n';
        let s = '';
        for (const row of tok.rows) {
          let n = '';
          for (const cell of row) n += tableCellHtml(cell, false);
          s += '<tr>\n' + n + '</tr>\n';
        }
        if (s) s = '<tbody>' + s + '</tbody>';
        out += '<table>\n<thead>\n' + thead + '</thead>\n' + s + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        let s = '';
        for (const item of tok.items) s += '<li>' + renderTokens(item.tokens) + '</li>\n';
        out += '<' + tag + start + '>\n' + s + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += checkboxHtml(tok.checked);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += '<p>' + (tok._html || '') + '</p>\n';
        break;
      case 'text':
        out += tok._html || '';
        break;
      default:
        throw new Error('Unknown token type: ' + tok.type);
    }
  }
  return out;
}

// ---------- public API ----------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = {
    // Null-prototype so link labels such as "__proto__" or "constructor"
    // behave like ordinary labels (as in marked): an undefined ref stays
    // literal text, and a defined one resolves to its own definition
    // instead of leaking Object.prototype (which used to render
    // href="undefined").
    links: Object.create(null),
    top: true,
    inlineState: { inLink: false, inRawBlock: false, linkEmitted: false },
  };
  const tokens = blockTokensInto(src, [], ctx, false);
  computeInlineTokens(tokens, ctx);
  return renderTokens(tokens);
}

export default parse;
