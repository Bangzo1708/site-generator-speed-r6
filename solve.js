// site-generator-speed-6: a fast drop-in for makefun-site 1.0.0.
//
// A single fused, allocation-light reimplementation of the reference build:
// front matter is scanned line by line without splitting the body, Markdown is
// rendered in one pass straight into output chunks (no lex tokens, no per-node
// objects, plain text runs are copied without an escaping pass), and templates
// are compiled once per case into flat jump-table ops run by a small
// interpreter with prototype-chained scopes (no scope objects per loop
// iteration, no string concatenation while rendering).
//
// Semantics follow makefun-site 1.0.0 exactly: the same front-matter refusals
// in the same order, the same slug/date rules, the same Markdown subset and
// the same template dialect, including every error string the report carries.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text ---

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `s` with & < > " ' escaped (fast path when there is nothing to escape). */
function escStr(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESC[c]);
}

/** `s[a..b)` escaped, appended to `parts`. */
function escInto(s, a, b, parts) {
  let last = a;
  ESC_RE.lastIndex = a;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(ESC[m[0]]);
    last = m.index + 1;
  }
  if (last < b) parts.push(s.slice(last, b));
  ESC_RE.lastIndex = 0;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text is already NFKD and holds no combining marks, so it skips
 * the normalise-and-strip step entirely.
 */
function slugify(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is JavaScript whitespace (the `\s` class). */
function isWSCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F ||
    c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

/** JavaScript's `\s` class as a table over code units (astral halves are never whitespace). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200A; c++) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { count++; inWord = true; }
  }
  return count;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens on a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// ------------------------------------------------------------ front matter ---

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const err = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return err;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return err;
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return err;
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prev = 0; // 0 = start, 1 = alnum, 2 = dash
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const al = (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
        if (al) prev = 1;
        else if (c === 45 && prev === 1) prev = 2;
        else ok = false;
      }
      if (prev !== 1) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned with
 * indexOf, so the body is a single slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing line, exactly "---".
  let closeStart = -1;
  let closeEnd = -1;
  let closeLine = -1; // 0-based line index of the closing line
  let p = firstEnd + 1;
  let lineNo = 1;
  while (p <= text.length) {
    const e = text.indexOf('\n', p);
    const lend = e === -1 ? text.length : e;
    if (text.slice(p, lend) === '---') { closeStart = p; closeEnd = lend; closeLine = lineNo; break; }
    if (e === -1) break;
    p = e + 1;
    lineNo++;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = firstEnd + 1;
  for (let ln = 1; ln < closeLine; ln++) {
    const e = text.indexOf('\n', p);
    const lend = e === -1 ? text.length : e;
    const line = text.slice(p, lend);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const cc = line.charCodeAt(k);
        if ((cc >= 97 && cc <= 122) || cc === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${ln + 1} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${ln + 1} is not "key: value"` };
      let re = raw.length;
      while (re > 0 && (raw.charCodeAt(re - 1) === 32 || raw.charCodeAt(re - 1) === 9)) re--;
      raw = raw.slice(0, re);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = lend + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown ---

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  if (k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(k));
  return text === '' ? null : { depth: k, text };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHr(line) {
  const h = line.slice(0, 3);
  if (h !== '---' && h !== '***') return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. Dispatched on the first character, so plain text lines cost one check. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  return false;
}

/**
 * A list line's kind: { ordered, start, text } for `- `, `* ` or `N. `, else
 * null. `ordered`/`start` come from the line that started the list.
 */
function listMatch(line, ordered) {
  if (!ordered) {
    const c = line.charCodeAt(0);
    if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
    return null;
  }
  let d = 0;
  while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d >= line.length) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { text: line.slice(d + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWSCode(line.charCodeAt(i));
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside an escape, or -1.
 * Found with native indexOf: a candidate is escaped exactly when an odd run of
 * backslashes stands right before it (backslashes pair up left to right from
 * `from`, and the run cannot start before `from` — the character there is the
 * opening marker, never a backslash).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) { j = s.indexOf('*', j + 1); continue; } // escaped star: skip just it
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; } // a ** pair: skip both
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** The next inline special from `from`: \ ` * [ & < > " '. A shared regex, so its lastIndex is set before every exec (recursive inline calls cannot disturb the scan). */
const SPEC_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `parts`. The scan is a native regex exec, so
 * plain runs are copied as-is: no per-character loop and no separate escaping
 * pass over plain text. `env.link(target)` resolves a link's href.
 */
function inline(s, env, parts) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    SPEC_RE.lastIndex = i;
    const m = SPEC_RE.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) parts.push(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d !== undefined && ESCAPABLE.has(d)) { parts.push(ESC[d] ?? d); i += 2; }
      else { parts.push('\\'); i++; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        parts.push('<code>');
        escInto(s, i + 1, k, parts);
        parts.push('</code>');
        i = k + 1;
      } else { parts.push('`'); i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          parts.push('<strong>');
          inline(s.slice(i + 2, k), env, parts);
          parts.push('</strong>');
          i = k + 2;
        } else { parts.push('**'); i += 2; }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        parts.push('<em>');
        inline(s.slice(i + 1, k), env, parts);
        parts.push('</em>');
        i = k + 1;
      } else { parts.push('*'); i++; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        parts.push('<a href="');
        const href = env.link(target);
        escInto(href, 0, href.length, parts);
        parts.push('">');
        inline(s.slice(i + 1, k), env, parts);
        parts.push('</a>');
        i = m2 + 1;
        continue;
      }
      parts.push('[');
      i++;
      continue;
    }
    parts.push(ESC[c]);
    i++;
  }
  SPEC_RE.lastIndex = 0;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Blocks append straight into one
 * chunk array, joined once at the end; only a heading's HTML (for the toc) and
 * the first paragraph (for the excerpt) are joined out separately.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Blank line (or an indented line that is all spaces/tabs): skip.
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
    } else if (line.length === 0) { i++; continue; }
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        parts.push('<pre><code');
        if (lang !== '') { parts.push(' class="language-'); escInto(lang, 0, lang.length, parts); parts.push('"'); }
        parts.push('>');
        while (i < n && !isFenceClose(lines[i])) {
          escInto(lines[i], 0, lines[i].length, parts);
          parts.push('\n');
          i++;
        }
        i++;
        parts.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        parts.push(`<h${hd.depth} id="${id}">`);
        const hStart = parts.length;
        inline(hd.text, env, parts);
        const html = parts.slice(hStart).join('');
        parts.push(`</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) { parts.push('<hr>\n'); i++; continue; }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inline(kept.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const firstBullet = (c0 === 45 || c0 === 42) ? listMatch(line, false) : null;
    const firstOrdered = firstBullet === null && c0 >= 48 && c0 <= 57 ? listMatch(line, true) : null;
    if (firstBullet !== null || firstOrdered !== null) {
      const ordered = firstOrdered !== null;
      const items = [];
      let cur = null;
      let start = 1;
      if (ordered) {
        let d = 0;
        while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
        start = Number(line.slice(0, d));
      }
      while (i < n) {
        const m = listMatch(lines[i], ordered);
        if (m !== null) { cur = [trimLine(m.text)]; items.push(cur); i++; }
        else if (isContinued(lines[i])) { cur.push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      parts.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const it of items) {
        parts.push('<li>');
        inline(it.join('\n'), env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    parts.push('<p>');
    const pStart = parts.length;
    inline(body.join('\n'), env, parts);
    if (excerpt === null) excerpt = parts.slice(pStart).join('');
    parts.push('</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates ---

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` compiled into flat ops with jump targets (a TemplateError when it does
 * not parse), then into a JavaScript function run by the engine itself:
 * `fn(T, scope, out, depth)`, where T carries the compiled templates and the
 * value helpers. Ops: text, var, raw, if (elsePc/endPc), else (endPc), endif,
 * for (end), endfor, include.
 */
function compileTemplate(name, src) {
  const ops = [];
  const stack = [];
  const uses = [];
  const includes = [];
  const boundNames = [];
  const boundNow = () => (boundNames.length === 0 ? [] : [...boundNames, 'loop']);
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') ops.push({ op: 'text', s: tok.text });
    else if (tok.t === 'var') { uses.push({ name: tok.path[0], bound: boundNow() }); ops.push({ op: 'var', path: tok.path }); }
    else if (tok.t === 'raw') { uses.push({ name: tok.path[0], bound: boundNow() }); ops.push({ op: 'raw', path: tok.path }); }
    else {
      const tag = tok.tag;
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        uses.push({ name: pathOf(name, m[2])[0], bound: boundNow() });
        const idx = ops.length;
        ops.push({ op: 'for', name: m[1], path: pathOf(name, m[2]), end: -1 });
        stack.push({ kind: 'for', idx });
        boundNames.push(m[1]);
      } else if ((m = IF_RE.exec(tag)) !== null) {
        uses.push({ name: pathOf(name, m[2])[0], bound: boundNow() });
        const idx = ops.length;
        ops.push({ op: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), elsePc: -1, endPc: -1 });
        stack.push({ kind: 'if', idx, elseIdx: -1 });
      } else if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (top === undefined || top.kind !== 'if' || top.elseIdx !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
        ops[top.idx].elsePc = ops.length;
        top.elseIdx = ops.length;
        ops.push({ op: 'else', endPc: -1 });
      } else if (tag === 'endfor' || tag === 'endif') {
        const top = stack[stack.length - 1];
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top === undefined || top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        if (want === 'for') boundNames.pop();
        const endIdx = ops.length;
        ops.push({ op: tag });
        if (want === 'for') ops[top.idx].end = endIdx;
        else {
          ops[top.idx].endPc = endIdx;
          if (top.elseIdx !== -1) ops[top.elseIdx].endPc = endIdx;
        }
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) { includes.push({ name: m[1], bound: boundNow() }); ops.push({ op: 'include', name: m[1] }); }
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return { ops, uses, includes };
}

/**
 * The value at `path` in the scope chain: its first name from the nearest
 * scope holding it (scopes are prototype-chained, so one property read walks
 * them), then own properties of the value so far.
 */
function getPath(scope, path) {
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}



/**
 * `ops` rendered in `scope` into `out`. `templates` maps names to compiled
 * ops; `depth` is the include depth. A for-loop reuses one child scope object
 * across its iterations (rendering is synchronous, so mutating it is safe).
 */
function renderOps(ops, scope, ctx, depth, out) {
  const templates = ctx.templates;
  let ctrl = null; // created on the first for-loop, so for-less templates pay nothing
  let cur = scope;
  let pc = 0;
  while (pc < ops.length) {
    const n = ops[pc];
    switch (n.op) {
      case "text":
        out.push(n.s);
        pc++;
        break;
      case "var":
        out.push(escStr(textOf(getPath(cur, n.path))));
        pc++;
        break;
      case "raw":
        out.push(textOf(getPath(cur, n.path)));
        pc++;
        break;
      case "if": {
        const v = truthy(getPath(cur, n.path));
        pc = v !== n.not ? pc + 1 : n.elsePc !== -1 ? n.elsePc + 1 : n.endPc + 1;
        break;
      }
      case "else":
        pc = n.endPc + 1;
        break;
      case "endif":
        pc++;
        break;
      case "for": {
        const xs = getPath(cur, n.path);
        if (!Array.isArray(xs) || xs.length === 0) { pc = n.end + 1; break; }
        if (ctrl === null) ctrl = [];
        const child = Object.create(cur);
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        child[n.name] = xs[0];
        child.loop = loop;
        ctrl.push({ forPc: pc, end: n.end, xs, k: 0, name: n.name, child, loop, parent: cur });
        cur = child;
        pc++;
        break;
      }
      case "endfor": {
        const f = ctrl[ctrl.length - 1];
        f.k++;
        if (f.k < f.xs.length) {
          f.loop.index = f.k + 1;
          f.loop.first = false;
          f.loop.last = f.k === f.xs.length - 1;
          f.child[f.name] = f.xs[f.k];
          f.child.loop = f.loop;
          cur = f.child;
          pc = f.forPc + 1;
        } else {
          ctrl.pop();
          cur = f.parent;
          pc++;
        }
        break;
      }
      case "include": {
        // A template whose render depends only on the case-level values
        // (site, tags, recent) is rendered once per case and reused here, when
        // the current scope still resolves those names to the case's own
        // objects and the include-depth cutoff cannot change the result.
        const hit = ctx.constCache.get(n.name);
        if (hit !== undefined && depth + hit.maxDepth < 7) {
          let same = true;
          for (const nm of hit.free) {
            if (cur[nm] !== ctx.root[nm]) { same = false; break; }
          }
          if (same) { out.push(hit.html); pc++; break; }
        }
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderOps(t.ops, cur, ctx, depth + 1, out);
        pc++;
        break;
      }
    }
  }
}

// -------------------------------------------------------------------- build ---

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc, // already { level, id, html } objects, exactly what templates read
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
/**
 * Each template's free variables (root names its render may read from the
 * enclosing scope) and its longest include chain, by fixed point over the
 * include graph. A template is constant for a case when its free variables
 * lie in {site, tags, recent} and its include chain is acyclic.
 */
function analyseTemplates(templates) {
  const free = new Map();
  for (const name of templates.keys()) free.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, t] of templates) {
      const f = free.get(name);
      const before = f.size;
      for (const u of t.uses) if (!u.bound.includes(u.name)) f.add(u.name);
      for (const inc of t.includes) {
        const g = free.get(inc.name);
        if (g === undefined) continue;
        for (const v of g) if (!inc.bound.includes(v)) f.add(v);
      }
      if (f.size !== before) changed = true;
    }
  }
  const maxDepth = new Map();
  const visiting = new Set();
  const depthOf = (name) => {
    if (maxDepth.has(name)) return maxDepth.get(name);
    if (visiting.has(name)) return Infinity;
    visiting.add(name);
    let m = -1;
    const t = templates.get(name);
    if (t !== undefined) {
      for (const inc of t.includes) {
        const d = depthOf(inc.name);
        if (d === Infinity) { m = Infinity; break; }
        if (d + 1 > m) m = d + 1;
      }
    }
    visiting.delete(name);
    maxDepth.set(name, m);
    return m;
  };
  for (const name of templates.keys()) depthOf(name);
  return { free, maxDepth };
}

export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const { free, maxDepth } = analyseTemplates(templates);
  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  let pageCount = 0;
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.text = undefined;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    if (!s.post) pageCount++;
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of (p.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const rootScope = Object.create(null);
  rootScope.site = site;
  rootScope.tags = allTags;
  rootScope.recent = recent;
  // Templates that depend only on the case-level values are rendered once
  // here and reused at every include site (see renderOps).
  const constCache = new Map();
  const ctx = { templates, constCache, root: rootScope };
  for (const [name, t] of templates) {
    const f = free.get(name);
    if (f === undefined || maxDepth.get(name) === Infinity) continue;
    let constant = true;
    for (const v of f) if (v !== 'site' && v !== 'tags' && v !== 'recent') { constant = false; break; }
    if (!constant) continue;
    const out = [];
    renderOps(t.ops, rootScope, ctx, 0, out);
    constCache.set(name, { html: out.join(''), maxDepth: maxDepth.get(name), free: [...f] });
  }
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const scope = Object.create(rootScope);
    Object.assign(scope, vars);
    const out = [];
    renderOps(t.ops, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
