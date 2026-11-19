'use strict';

/**
 * Produces a few strings that match a regex `pattern`, for witness search.
 * Handles literals, escapes, classes, groups, alternation, and quantifiers;
 * returns [] for anything else (lookarounds, back-references). Every result
 * is checked with the real RegExp before it is returned.
 */

const CLASS_ESCAPES = { d: '0', w: 'a', s: ' ', D: 'x', W: '-', S: 'x' };

function parse(src) {
  let i = 0;
  function alternation() {
    const alts = [sequence()];
    while (src[i] === '|') {
      i++;
      alts.push(sequence());
    }
    return { alt: alts };
  }
  function sequence() {
    const items = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let atom = parseAtom();
      if (atom === null) continue;
      atom = quantifier(atom);
      items.push(atom);
    }
    return { seq: items };
  }
  function parseAtom() {
    const c = src[i];
    if (c === '^' || c === '$') {
      i++;
      return null;
    }
    if (c === '(') {
      i++;
      let lookaround = false;
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '=' || src[i + 1] === '!') {
          lookaround = true;
          i += 2;
        } else if (src[i + 1] === '<' && (src[i + 2] === '=' || src[i + 2] === '!')) {
          lookaround = true;
          i += 3;
        } else if (src[i + 1] === '<') {
          const end = src.indexOf('>', i);
          if (end < 0) throw new Error('unbalanced');
          i = end + 1; // named group
        } else throw new Error('unsupported group');
      }
      const inner = alternation();
      if (src[i] !== ')') throw new Error('unbalanced');
      i++;
      // A lookaround matches no characters; the final RegExp test enforces it.
      return lookaround ? null : inner;
    }
    if (c === '[') return parseClass();
    if (c === '.') {
      i++;
      return { lit: 'a' };
    }
    if (c === '\\') {
      const e = src[i + 1];
      i += 2;
      if (CLASS_ESCAPES[e]) return { lit: CLASS_ESCAPES[e], cls: e };
      if (e === 'x') {
        const h = src.slice(i, i + 2);
        i += 2;
        return { lit: String.fromCharCode(parseInt(h, 16)) };
      }
      if (e === 'u') {
        if (src[i] === '{') {
          const end = src.indexOf('}', i);
          const h = src.slice(i + 1, end);
          i = end + 1;
          return { lit: String.fromCodePoint(parseInt(h, 16)) };
        }
        const h = src.slice(i, i + 4);
        i += 4;
        return { lit: String.fromCharCode(parseInt(h, 16)) };
      }
      if (/[1-9bBk]/.test(e)) throw new Error('unsupported escape');
      return { lit: e === 'n' ? '\n' : e === 't' ? '\t' : e };
    }
    i++;
    return { lit: c };
  }
  function parseClass() {
    i++;
    let negated = false;
    if (src[i] === '^') {
      negated = true;
      i++;
    }
    const start = i;
    while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
    const body = src.slice(start, i);
    i++;
    const re = new RegExp(`[${negated ? '^' : ''}${body}]`, 'u');
    const pool = 'aA0zZ9_-.:/ x@#+bc12mn';
    const picks = [...pool].filter(ch => re.test(ch));
    if (picks.length === 0) {
      for (let cp = 0x20; cp < 0x7f; cp++) if (re.test(String.fromCharCode(cp))) picks.push(String.fromCharCode(cp));
    }
    if (picks.length === 0) throw new Error('empty class');
    return { lit: picks[0], alts: picks.slice(0, 3) };
  }
  function quantifier(atom) {
    const c = src[i];
    let min = 1;
    let max = 1;
    if (c === '?') { min = 0; max = 1; i++; }
    else if (c === '*') { min = 0; max = Infinity; i++; }
    else if (c === '+') { min = 1; max = Infinity; i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return atom;
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      i += m[0].length;
    } else return atom;
    if (src[i] === '?') i++;
    return { rep: atom, min, max };
  }
  const tree = alternation();
  if (i !== src.length) throw new Error('trailing input');
  return tree;
}

/**
 * variant 0: minimal; 1: one more repetition; 2: alternative picks; 3: every
 * optional part once, the `target`-th unbounded repetition 70 times; 4: only
 * the `target`-th optional part (a duration pattern gives "PT", "P0D", ...).
 */
function generate(node, variant, state = null) {
  if (node.lit !== undefined) return variant === 2 && node.alts && node.alts[1] ? node.alts[1] : node.lit;
  if (node.seq) return node.seq.map(n => generate(n, variant, state)).join('');
  if (node.alt) return generate(node.alt[variant === 2 && node.alt.length > 1 ? 1 : 0], variant, state);
  if (node.rep) {
    let n = node.min;
    if (variant === 1 && n < node.max) n = Math.max(1, n + 1);
    if (variant === 1 && n === 0 && node.max > 0) n = 1;
    // One long repetition finds length limits another constraint imposes
    // (a hostname label is at most 63 characters).
    if (variant === 3 && state) {
      if (node.max >= 70) n = state.seen++ === state.target ? Math.max(node.min, 70) : Math.max(node.min, 1);
      else if (node.min === 0) n = 1;
    }
    if (variant === 4 && state && node.min === 0 && node.max >= 1) {
      // Only the target-th optional part, once; the rest left out.
      n = state.seen++ === state.target ? 1 : 0;
    }
    return Array.from({ length: n }, () => generate(node.rep, variant, state)).join('');
  }
  return '';
}

function sampleRegex(pattern) {
  let re;
  let tree;
  try {
    re = new RegExp(pattern, 'u');
    tree = parse(pattern);
  } catch {
    return [];
  }
  const out = new Set();
  for (const v of [0, 1, 2]) {
    const s = generate(tree, v);
    if (re.test(s)) out.add(s);
  }
  for (let target = 0; target < 4; target++) {
    const s = generate(tree, 3, { target, seen: 0 });
    if (re.test(s)) out.add(s);
  }
  for (let target = 0; target < 12; target++) {
    const s = generate(tree, 4, { target, seen: 0 });
    if (re.test(s)) out.add(s);
  }
  return [...out];
}

module.exports = { sampleRegex };
