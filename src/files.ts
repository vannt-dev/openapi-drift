import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '.git', '.next', 'out']);

/** Source files under a directory (depth-first, sorted), without build output, dependencies, tests and declarations. */
export function sourceFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(file);
      } else if (exts.some((x) => e.name.endsWith(x)) && !/\.(spec|test|d)\.[cm]?[jt]sx?$/.test(e.name)) {
        out.push(file);
      }
    }
  };
  walk(dir);
  return out;
}

export function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Source without comments, so that a route in a comment is not a route; strings and line numbers are kept. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const skipped = end < 0 ? src.slice(i) : src.slice(i, end + 2);
      out += skipped.replace(/[^\n]/g, ' ');
      i += skipped.length;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 1-based line of an offset. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/** The string literals of an argument list: `'a', "b"` -> ['a', 'b']; template literals without `${}` too. */
export function stringLiterals(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g)) {
    out.push((m[1] ?? m[2] ?? m[3]) as string);
  }
  return out;
}

/** Express/Nest `:id`, `:id(\\d+)` and `:id?` -> `{id}`; `*` -> `{wildcard}`. */
export function toTemplate(p: string): string {
  return p.replace(/:([A-Za-z_$][\w$]*)(\([^)]*\))?\??/g, '{$1}').replace(/\*/g, '{wildcard}');
}

/** The end of a balanced `(...)` whose opening parenthesis is at `open`; strings are skipped. */
export function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      i = j;
    }
  }
  return src.length;
}

/** The end of a balanced `(...)`, `[...]` or `{...}` whose opening bracket is at `open`; strings are skipped. */
export function closingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      i = j;
    }
  }
  return src.length;
}

/** An argument list or the inside of an array, cut at its top-level commas: `'a', { b: [1, 2] }` -> two parts. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{' || c === "'" || c === '"' || c === '`') i = closingBracketOrQuote(text, i);
    else if (c === ',') {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function closingBracketOrQuote(text: string, at: number): number {
  const c = text[at];
  if (c !== "'" && c !== '"' && c !== '`') return closingBracket(text, at);
  let j = at + 1;
  while (j < text.length && text[j] !== c) {
    if (text[j] === '\\') j++;
    j++;
  }
  return j;
}

/** The text of an expression that is one string literal and nothing else (`'api'`), otherwise undefined. */
export function wholeLiteral(text: string): string | undefined {
  const t = text.trim();
  const found = stringLiterals(t);
  return found.length === 1 && t.length === (found[0] as string).length + 2 ? found[0] : undefined;
}
