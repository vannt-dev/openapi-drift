import path from 'node:path';
import {
  sourceFiles,
  readText,
  stripComments,
  lineOf,
  toTemplate,
  closingBracket,
  splitTopLevel,
  stringLiterals,
  wholeLiteral,
} from '../files.ts';
import { joinPath } from '../openapi.ts';
import { resolveImport } from './express.ts';
import { withImplicitHead } from './fastify.ts';
import { honoHandlerDetails, type HandlerDetails } from './handler.ts';
import { METHODS, type AppNote, type AppSettings, type ExtractOptions, type HttpMethod, type Route } from '../types.ts';

const VERBS = new Set(['get', 'post', 'put', 'delete', 'options', 'patch', 'all']);
const ALL: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
/** What a Hono app returns itself from, so that a chain goes on past it. */
const SELF = new Set(['use', 'mount', 'notFound', 'onError']);
const ID = '[A-Za-z_$][\\w$]*';
/** A file that imports Hono: `from 'hono'`, `from 'hono/tiny'`, `require('hono')`. */
export const HONO_IMPORT = /\bfrom\s+['"]hono(?:\/[\w-]+)*['"]|\brequire\s*\(\s*['"]hono(?:\/[\w-]+)*['"]\s*\)/;
const KEYWORDS = new Set([
  'function',
  'class',
  'async',
  'await',
  'new',
  'typeof',
  'this',
  'return',
  'void',
  'null',
  'undefined',
  'true',
  'false',
]);

/**
 * An app as the source writes it, before the files are tied together: a `new Hono()` (by where it is written)
 * or a name, with the base paths written on the way (`app.basePath('/v2')`); `other` is a value that is not an
 * app (`new Map()`), and `unknown` one that may be (`createApp()`).
 */
type Expr =
  { kind: 'new'; key: string; base: string } | { kind: 'name'; name: string; base: string } | { kind: 'other' } | { kind: 'unknown' };

/** An app once the files are tied together: a `new Hono()`, or a name nothing defines (a parameter). */
interface Ref {
  app: string;
  base: string;
  known: boolean;
}

interface RawRoute {
  on: Expr;
  methods: readonly HttpMethod[];
  path: string;
  line: number;
  details: HandlerDetails;
}

/** `on.route(prefix, target)` */
interface Group {
  on: Expr;
  prefix: string;
  target: Expr;
  line: number;
}

/** A note to give when `on` turns out to be an app of this source tree, so that `map.get(key)` says nothing. */
interface Pending {
  on: Expr;
  line: number;
  message: string;
}

interface ParsedFile {
  routes: RawRoute[];
  groups: Group[];
  pending: Pending[];
  bindings: Map<string, Expr>;
  /** local name -> the file it is imported from, and the name it has there ('default' for a default import) */
  imports: Map<string, { file: string; name: string }>;
  exports: Map<string, Expr>;
}

export interface HonoExtract {
  routes: Route[];
  prefix: string;
  app?: AppSettings;
}

/**
 * The routes a Hono source tree declares: `app.get('/x', ...)` and the other verbs, `app.on(method, path, ...)`,
 * chains (`app.get('/x', a).post(b)`, `new Hono().get(...)`), under the base paths of `basePath('/api')` and the
 * prefixes of `app.route('/prefix', other)`, the other app in the same file or imported from another. An app
 * nobody groups keeps its own paths. Hono answers HEAD wherever there is a GET: those routes are `implicit`.
 *
 * What is in the code and cannot be read (a path kept in a constant, a method OpenAPI does not have,
 * `app.mount()`) is a note that names the place.
 */
export function extractHono(dir: string, { prefix = '' }: ExtractOptions = {}): HonoExtract {
  const parsed = new Map<string, ParsedFile>();
  for (const file of sourceFiles(path.resolve(dir), ['.js', '.mjs', '.cjs', '.ts', '.mts']))
    parsed.set(path.normalize(file), parseFile(file));

  const resolve = (file: string, expr: Expr, depth = 0): Ref | 'other' | null => {
    if (expr.kind === 'other') return 'other';
    if (expr.kind === 'unknown' || depth > 20) return null;
    if (expr.kind === 'new') return { app: expr.key, base: expr.base, known: true };
    const info = parsed.get(file) as ParsedFile;
    const bound = info.bindings.get(expr.name);
    const imported = info.imports.get(expr.name);
    let found: Ref | 'other' | null;
    if (bound) {
      found = bound.kind === 'unknown' ? { app: `${file}?${expr.name}`, base: '', known: false } : resolve(file, bound, depth + 1);
    } else if (imported) {
      const exported = parsed.get(imported.file)?.exports.get(imported.name);
      found = exported ? resolve(imported.file, exported, depth + 1) : null;
    } else found = { app: `${file}?${expr.name}`, base: '', known: false };
    return found && found !== 'other' ? { ...found, base: joinPath(found.base, expr.base) } : found;
  };

  const notes: AppNote[] = [];
  const edges = new Map<string, { from: string; prefix: string }[]>();
  for (const [file, info] of parsed) {
    for (const p of info.pending) {
      const on = resolve(file, p.on);
      if (on && on !== 'other' && on.known) notes.push({ file, line: p.line, message: p.message });
    }
    for (const g of info.groups) {
      const on = resolve(file, g.on);
      if (!on || on === 'other') continue;
      const target = resolve(file, g.target);
      if (!target || target === 'other') {
        notes.push({
          file,
          line: g.line,
          message: `route('${g.prefix}', ...): the app is not found in the source, so its routes are left out`,
        });
        continue;
      }
      edges.set(target.app, [...(edges.get(target.app) ?? []), { from: on.app, prefix: joinPath(on.base, g.prefix) }]);
    }
  }

  const known = new Map<string, string[]>();
  const prefixesOf = (app: string, seen: Set<string> = new Set()): string[] => {
    const done = known.get(app);
    if (done) return done;
    const incoming = edges.get(app);
    // nobody groups it, or it groups itself: its own paths
    if (!incoming || seen.has(app)) return [''];
    const out = new Set<string>();
    for (const edge of incoming) {
      for (const outer of prefixesOf(edge.from, new Set([...seen, app]))) out.add(joinPath(outer, edge.prefix));
    }
    const list = [...out];
    known.set(app, list);
    return list;
  };

  const out: Route[] = [];
  for (const [file, info] of parsed) {
    for (const r of info.routes) {
      const on = resolve(file, r.on);
      if (on === 'other') continue;
      const ref = on ?? { app: '', base: '', known: false };
      for (const p of prefixesOf(ref.app)) {
        for (const method of r.methods)
          out.push({ method, path: honoTemplate(joinPath(prefix, p, ref.base, r.path)), file, line: r.line, ...r.details });
      }
    }
  }
  return { routes: withImplicitHead(out), prefix, ...(notes.length ? { app: { notes } } : {}) };
}

export function extractHonoRoutes(dir: string, options: ExtractOptions = {}): Route[] {
  return extractHono(dir, options).routes;
}

/** Hono's `:id{[0-9]+}` and `:id?` -> `{id}`; `*` -> `{wildcard}`. */
export function honoTemplate(p: string): string {
  return toTemplate(p.replace(/:([A-Za-z_$][\w$]*)\{(?:[^{}]|\{[^{}]*\})*\}/g, ':$1'));
}

function parseFile(file: string): ParsedFile {
  const src = stripComments(readText(file));
  const dir = path.dirname(file);
  const info: ParsedFile = { routes: [], groups: [], pending: [], bindings: new Map(), imports: new Map(), exports: new Map() };
  const key = (at: number): string => `${file}#${at}`;

  const imported = (local: string, spec: string, name = 'default'): void => {
    const f = resolveImport(dir, spec);
    if (f) info.imports.set(local, { file: f, name });
  };
  for (const m of src.matchAll(new RegExp(`\\bimport\\s+(${ID})\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s+(['"])([^'"]+)\\2`, 'g')))
    imported(m[1] as string, m[3] as string);
  for (const m of src.matchAll(new RegExp(`\\bimport\\s+(?:${ID}\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s+(['"])([^'"]+)\\2`, 'g'))) {
    for (const [local, name] of bindingList(m[1] as string, /\s+as\s+/)) imported(local, m[3] as string, name);
  }
  for (const m of src.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*=\\s*require\\s*\\(\\s*(['"])([^'"]+)\\2\\s*\\)`, 'g')))
    imported(m[1] as string, m[3] as string);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g)) {
    for (const [local, name] of bindingList(m[1] as string, /\s*:\s*/)) imported(local, m[3] as string, name);
  }

  // const app = new Hono(), const api = app.basePath('/api'), export const users = new Hono().get(...)
  for (const m of src.matchAll(new RegExp(`\\b(export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=;]+?)?=(?![=>])\\s*`, 'g'))) {
    const name = m[2] as string;
    if (info.bindings.has(name) || info.imports.has(name)) continue;
    info.bindings.set(name, valueAt(src, m.index + m[0].length, key));
    if (m[1]) info.exports.set(name, { kind: 'name', name, base: '' });
  }
  // export default app, export default new Hono().get(...), module.exports = app
  for (const m of src.matchAll(/\bexport\s+default\s+|\bmodule\.exports\s*=\s*(?!\{)/g)) {
    const value = valueAt(src, m.index + m[0].length, key);
    if (value.kind === 'new' || value.kind === 'name') info.exports.set('default', value);
  }
  // export { a, b as c }, module.exports = { a, b: c }
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const [as, name] of bindingList(m[1] as string, /\s+as\s+/)) info.exports.set(as, { kind: 'name', name, base: '' });
  }
  for (const m of src.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] as string).split(',')) {
      const [as, name] = part.trim().split(/\s*:\s*/);
      if (as && /^[A-Za-z_$][\w$]*$/.test(as)) info.exports.set(as, { kind: 'name', name: (name ?? as).trim(), base: '' });
    }
  }

  // every chain: `app.get(...).post(...)`, `new Hono().basePath('/api').get(...)`; in a file that uses Hono, so that
  // the Express routes of a project moving to Hono are not taken for its own
  if (!HONO_IMPORT.test(src)) return info;
  for (const m of src.matchAll(new RegExp(`\\bnew\\s+Hono\\b|(?<![\\w$.])(?:this\\s*\\.\\s*)?(${ID})(?=\\s*\\.)`, 'g'))) {
    const head =
      m[1] === undefined ? newHono(src, m.index, key) : KEYWORDS.has(m[1]) ? null : { expr: name(m[1]), end: m.index + m[0].length };
    if (head) walk(src, head.end, head.expr, info, key);
  }
  return info;
}

const name = (n: string): Expr => ({ kind: 'name', name: n, base: '' });

/** `new Hono()`, `new Hono<Env>({ strict: false })` at `at`: the app, and where the expression ends. */
function newHono(src: string, at: number, key: (at: number) => string): { expr: Expr; end: number } | null {
  const m = /^new\s+Hono\s*/.exec(src.slice(at));
  if (!m) return null;
  let i = at + m[0].length;
  if (src[i] === '<') {
    // the type arguments, which may hold braces and arrows
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '<') depth++;
      else if (src[i] === '>' && src[i - 1] !== '=') depth--;
      if (depth === 0) break;
    }
    i++;
    while (/\s/.test(src[i] ?? '')) i++;
  }
  if (src[i] !== '(') return null;
  return { expr: { kind: 'new', key: key(at), base: '' }, end: closingBracket(src, i) + 1 };
}

/** The value of the expression that starts at `at`, without recording the routes of its chain. */
function valueAt(src: string, at: number, key: (at: number) => string): Expr {
  const rest = src.slice(at);
  let head: { expr: Expr; end: number } | null = null;
  if (/^new\s+Hono\b/.test(rest)) head = newHono(src, at, key);
  else if (/^new\b/.test(rest)) return { kind: 'other' };
  else {
    const id = new RegExp(`^${ID}`).exec(rest);
    if (id && !KEYWORDS.has(id[0])) head = { expr: name(id[0]), end: at + id[0].length };
  }
  if (!head) return { kind: 'unknown' };
  const { expr, end } = walk(src, head.end, head.expr);
  // `app.fetch`, `createApp()`, `c.get('user')`: not the app itself
  if (/^\s*[.([]/.test(src.slice(end))) return expr.kind === 'name' && end === head.end ? { kind: 'unknown' } : { kind: 'other' };
  return expr;
}

/**
 * Follows the calls chained on an app from `at`, which return the app: the verbs, `on`, `route`, `basePath`,
 * `use`. With `info`, what they declare is recorded. Returns the app the chain ends on and where it ends.
 */
function walk(src: string, at: number, start: Expr, info?: ParsedFile, key?: (at: number) => string): { expr: Expr; end: number } {
  let expr = start;
  let current: string | undefined;
  let i = at;
  const link = new RegExp(`^\\s*\\.\\s*(${ID})\\s*\\(`);
  for (;;) {
    const m = link.exec(src.slice(i));
    if (!m) break;
    const method = m[1] as string;
    const open = i + m[0].length - 1;
    const close = closingBracket(src, open);
    const inner = src.slice(open + 1, close);
    const args = splitTopLevel(inner);
    const line = lineOf(src, i + m[0].indexOf('.'));
    const note = (message: string): void => {
      info?.pending.push({ on: expr, line, message });
    };
    if (VERBS.has(method) || method === 'on') {
      const verbArgs = method === 'on' ? args.slice(1) : args;
      const methods = method === 'on' ? methodsOf(args[0] ?? '') : method === 'all' ? ALL : [method as HttpMethod];
      const first = verbArgs[0];
      const literal = first === undefined ? undefined : pathsOf(first);
      let paths: string[];
      let handlers = verbArgs.slice(1);
      if (literal) {
        // a string that is not a path: `c.get('user')`, `cache.get('key')`
        if (!literal.every((p) => /^[/*]/.test(p))) break;
        paths = literal;
      } else if (current !== undefined && first !== undefined && method !== 'on') {
        // a handler alone: the path of the call before it
        paths = [current];
        handlers = verbArgs;
      } else {
        if (first !== undefined && verbArgs.length > 1) {
          note(`${method}(${first}, ...): its path is not written as text, so the route is left out`);
        }
        break;
      }
      if (methods === null) {
        note(`on(${args[0] ?? ''}, ...): its method is not written as text, so the route is left out`);
        break;
      }
      const unknown =
        method === 'on' ? stringLiterals(args[0] ?? '').filter((x) => !(METHODS as readonly string[]).includes(x.toLowerCase())) : [];
      if (unknown.length) note(`on(${args[0]}, ...): ${unknown.join(', ')} is not a method OpenAPI has, so it is left out`);
      current = paths[paths.length - 1];
      if (info && methods.length) {
        const details = honoHandlerDetails(handlers.join(', '));
        for (const p of paths) info.routes.push({ on: expr, methods, path: p, line, details });
      }
    } else if (method === 'route') {
      const prefix = wholeLiteral(args[0] ?? '');
      const targetText = args[1] ?? '';
      const targetAt = open + 1 + inner.indexOf(targetText, inner.indexOf(args[0] ?? '') + (args[0] ?? '').length);
      const target = key ? valueAt(src, targetAt, key) : { kind: 'unknown' as const };
      if (prefix === undefined) note(`route(${args[0] ?? ''}, ...): its prefix is not written as text, so its routes are left out`);
      else if (target.kind === 'new' || target.kind === 'name') info?.groups.push({ on: expr, prefix, target, line });
      else note(`route('${prefix}', ${targetText}): the app is not a name or a new Hono(), so its routes are left out`);
    } else if (method === 'basePath') {
      const base = wholeLiteral(args[0] ?? '');
      if (base === undefined) {
        note(`basePath(${args[0] ?? ''}): the path is not written as text, so the routes under it are left out`);
        break;
      }
      if (expr.kind === 'new' || expr.kind === 'name') expr = { ...expr, base: joinPath(expr.base, base) };
      current = undefined;
    } else if (SELF.has(method)) {
      if (method === 'use') current = wholeLiteral(args[0] ?? '') ?? '*';
      if (method === 'mount') note(`mount(${args[0] ?? ''}, ...): the routes of an app mounted from another framework are not read`);
    } else break;
    i = close + 1;
  }
  return { expr, end: i };
}

/** `'GET'`, `['GET', 'POST']` -> the methods OpenAPI has; null when they are not written as text. */
function methodsOf(text: string): HttpMethod[] | null {
  const found = pathsOf(text);
  if (!found?.length) return null;
  return found.map((x) => x.toLowerCase()).filter((x): x is HttpMethod => (METHODS as readonly string[]).includes(x));
}

/** `'/x'`, `['/a', '/b']` -> the strings; undefined when they are not all written as text. */
function pathsOf(text: string): string[] | undefined {
  const t = text.trim();
  const one = wholeLiteral(t);
  if (one !== undefined) return [one];
  if (!/^\[[\s\S]*\]$/.test(t)) return undefined;
  const parts = splitTopLevel(t.slice(1, -1)).map((x) => wholeLiteral(x));
  const strings = parts.filter((x): x is string => x !== undefined);
  return strings.length && strings.length === parts.length ? strings : undefined;
}

/** `{ a, b as c }` (or `{ a, b: c }`) -> [local name, name in the other file]. */
function bindingList(list: string, as: RegExp): [string, string][] {
  const out: [string, string][] = [];
  for (const part of list.split(',')) {
    const [first, second] = part.trim().split(as);
    if (first && /^[A-Za-z_$][\w$]*$/.test(first)) out.push([(second ?? first).trim(), first]);
  }
  return out;
}
