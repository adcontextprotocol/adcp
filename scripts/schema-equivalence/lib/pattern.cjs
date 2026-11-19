'use strict';

/**
 * Canonical spelling of an ECMAScript regex `pattern`, as Ajv compiles it
 * (`new RegExp(pattern, "u")`). Two rewrites, both exact:
 *
 *   - `\d` is `[0-9]` (ECMAScript `\d` is ASCII digits in every mode);
 *   - a bracket class is a set of characters: its literal characters and
 *     ranges become sorted, merged code-point intervals, and its class
 *     escapes (`\w`, `\s`, `\p{...}`, ...) a sorted list.
 *
 * Anything the tokenizer does not fully understand (`\c`, unbalanced
 * brackets, an empty class) leaves the pattern unchanged, so a canonical
 * spelling is only produced when it denotes the same language.
 */

const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/', '-']);
const SINGLE_ESCAPES = { n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, f: 0x0c, 0: 0x00 };

class Bail extends Error {}

/** Reads one escape at s[i] === '\\'. Returns { cp } for a character, { cls } for a class escape, and the next index. */
function readEscape(s, i, inClass) {
  const c = s[i + 1];
  if (c === undefined) throw new Bail();
  if ('dDwWsS'.includes(c)) return { cls: `\\${c}`, next: i + 2 };
  if (c === 'p' || c === 'P') {
    const end = s.indexOf('}', i);
    if (s[i + 2] !== '{' || end < 0) throw new Bail();
    return { cls: s.slice(i, end + 1), next: end + 1 };
  }
  if (c === 'x') {
    const hex = s.slice(i + 2, i + 4);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Bail();
    return { cp: parseInt(hex, 16), next: i + 4 };
  }
  if (c === 'u') {
    if (s[i + 2] === '{') {
      const end = s.indexOf('}', i);
      const hex = s.slice(i + 3, end);
      if (end < 0 || !/^[0-9A-Fa-f]{1,6}$/.test(hex)) throw new Bail();
      return { cp: parseInt(hex, 16), next: end + 1 };
    }
    const hex = s.slice(i + 2, i + 6);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Bail();
    return { cp: parseInt(hex, 16), next: i + 6 };
  }
  if (Object.prototype.hasOwnProperty.call(SINGLE_ESCAPES, c) && !(c === '0' && /[0-9]/.test(s[i + 2] || ''))) {
    return { cp: SINGLE_ESCAPES[c], next: i + 2 };
  }
  if (inClass && c === 'b') return { cp: 0x08, next: i + 2 };
  if (SYNTAX.has(c)) return { cp: c.codePointAt(0), next: i + 2 };
  // \c, back-references, \B, \k<...> and anything else: not handled here.
  throw new Bail();
}

function renderChar(cp) {
  const ch = String.fromCodePoint(cp);
  if (SYNTAX.has(ch)) return `\\${ch}`;
  if (cp >= 0x21 && cp <= 0x7e) return ch;
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

/** Parses a class body starting after '[' at index i. Returns { text, next }. */
function readClass(s, i) {
  let negated = false;
  if (s[i] === '^') {
    negated = true;
    i++;
  }
  const atoms = []; // { cp } | { cls } | { dash: true }
  while (i < s.length && s[i] !== ']') {
    if (s[i] === '\\') {
      const e = readEscape(s, i, true);
      if (e.cls === '\\d') atoms.push({ range: [0x30, 0x39] });
      else atoms.push(e.cls ? { cls: e.cls } : { cp: e.cp });
      i = e.next;
    } else if (s[i] === '[') {
      throw new Bail(); // nested '[' is literal in u-mode only when escaped
    } else {
      const cp = s.codePointAt(i);
      atoms.push(s[i] === '-' ? { dash: true, cp } : { cp });
      i += cp > 0xffff ? 2 : 1;
    }
  }
  if (s[i] !== ']') throw new Bail();
  if (atoms.length === 0) throw new Bail(); // [] and [^] have special meanings
  const intervals = [];
  const classes = [];
  for (let k = 0; k < atoms.length; k++) {
    const a = atoms[k];
    const b = atoms[k + 1];
    const c = atoms[k + 2];
    if (a.range) {
      if (b && b.dash && c) throw new Bail(); // [\d-x] is a syntax error in u-mode
      intervals.push(a.range);
    } else if (b && b.dash && c && (a.range || c.range)) {
      throw new Bail();
    } else if (b && b.dash && c && a.cls === undefined && c.cls === undefined && !a.dash && !c.dash) {
      if (a.cp > c.cp) throw new Bail();
      intervals.push([a.cp, c.cp]);
      k += 2;
    } else if (b && b.dash && c && (a.cls !== undefined || c.cls !== undefined)) {
      throw new Bail(); // [\w-a] is a syntax error in u-mode
    } else if (a.cls !== undefined) {
      classes.push(a.cls);
    } else {
      intervals.push([a.cp, a.cp]);
    }
  }
  intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  const body = merged.map(([lo, hi]) => (lo === hi ? renderChar(lo) : hi === lo + 1 ? renderChar(lo) + renderChar(hi) : `${renderChar(lo)}-${renderChar(hi)}`)).join('')
    + [...new Set(classes)].sort().join('');
  return { text: `[${negated ? '^' : ''}${body}]`, next: i + 1 };
}

function canonicalPattern(pattern) {
  if (typeof pattern !== 'string') return pattern;
  try {
    let out = '';
    let i = 0;
    while (i < pattern.length) {
      const ch = pattern[i];
      if (ch === '\\') {
        const c = pattern[i + 1];
        if (c === 'd') {
          out += '[0-9]';
          i += 2;
        } else {
          // Keep other escapes verbatim outside classes; only check that the escape is well formed.
          if (c === undefined) throw new Bail();
          let next = i + 2;
          if ((c === 'u' && pattern[i + 2] === '{') || c === 'p' || c === 'P' || (c === 'k' && pattern[i + 2] === '<')) {
            const end = pattern.indexOf(c === 'k' ? '>' : '}', i);
            if (end < 0) throw new Bail();
            next = end + 1;
          }
          out += pattern.slice(i, next);
          i = next;
        }
      } else if (ch === '[') {
        const cls = readClass(pattern, i + 1);
        out += cls.text;
        i = cls.next;
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  } catch (err) {
    if (err instanceof Bail) return pattern;
    throw err;
  }
}

module.exports = { canonicalPattern };
