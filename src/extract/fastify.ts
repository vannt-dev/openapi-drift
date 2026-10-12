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
import { joinPath, normalizePath } from '../openapi.ts';
import { resolveImport } from './express.ts';
import { inlineHandlerDetails, type HandlerDetails } from './handler.ts';
import { METHODS, type ExtractOptions, type HttpMethod, type Route } from '../types.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;
const ALL: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const STRING = `'[^']*'|"[^"]*"|\`[^\`]*\``;
/** How a Fastify handler sets the status: `reply.code(201)`, `reply.status(201)`. */
const STATUS_CALLS = ['code', 'status'];

/** A stretch of a file whose routes share their prefixes: the whole file, or one plugin function in it. */
interface Unit {
  file: string;
  start: number;
  end: number;
}

interface RawRoute {
  at: number;
  methods: readonly HttpMethod[];
  path: string;
  line: number;
  details: HandlerDetails;
}

type Target = { kind: 'range'; start: number; end: number } | { kind: 'name'; name: string } | { kind: 'file'; file: string };

interface Register {
  at: number;
  prefix: string;
  target: Target;
}

interface ParsedFile {
  src: string;
  routes: RawRoute[];
  registers: Register[];
  /** local name -> the file it is imported from, and the name it has there (absent for a default import) */
  imports: Map<string, { file: string; name?: string }>;
}

/**
 * The routes a Fastify source tree declares: `fastify.get('/x', ...)` and the other verbs, and
 * `fastify.route({ method, url })`, each under the prefixes of the plugins it sits in. A plugin is what
 * `register` is given: a function written in the call, a function of the same file, or an import
 * (`register(require('./users'), { prefix: '/users' })`, `register(import('./users.js'), ...)`); a plugin
 * registered inside a plugin carries both prefixes, and a plugin nobody registers keeps its own paths.
 *
 * Fastify answers HEAD wherever there is a GET (unless `exposeHeadRoutes: false`): those routes are returned
 * as `implicit`, so that a document describing them is right and one that does not is right too.
 *
 * Routes added by `@fastify/autoload` from the names of folders, and a prefix that is not written as text,
 * are not read: pass `prefix`.
 */
export function extractFastifyRoutes(dir: string, { prefix = '' }: ExtractOptions = {}): Route[] {
  const parsed = new Map<string, ParsedFile>();
  for (const file of sourceFiles(path.resolve(dir), ['.js', '.mjs', '.cjs', '.ts', '.mts']))
    parsed.set(path.normalize(file), parseFile(file));

  const key = (u: Unit): string => `${u.file}#${u.start}-${u.end}`;
  const wholeFile = (file: string): Unit => ({ file, start: 0, end: (parsed.get(file) as ParsedFile).src.length });

  // every plugin function that is a target, by file, so that a route finds the one it sits in
  const ranges = new Map<string, Unit[]>();
  const edges = new Map<string, { from: Unit; prefix: string }[]>();
  const resolved: { file: string; at: number; prefix: string; to: Unit }[] = [];
  for (const [file, info] of parsed) {
    for (const r of info.registers) {
      const to = unitOf(file, info, r.target, parsed, wholeFile);
      if (!to) continue;
      if (to.start !== 0 || to.end !== (parsed.get(to.file) as ParsedFile).src.length) {
        const list = ranges.get(to.file) ?? [];
        if (!list.some((u) => key(u) === key(to))) list.push(to);
        ranges.set(to.file, list);
      }
      resolved.push({ file, at: r.at, prefix: r.prefix, to });
    }
  }
  /** The plugin function a position sits in, the innermost one, or the file itself. */
  const around = (file: string, at: number): Unit => {
    const inside = (ranges.get(file) ?? []).filter((u) => u.start <= at && at < u.end);
    inside.sort((a, b) => a.end - a.start - (b.end - b.start));
    return inside[0] ?? wholeFile(file);
  };
  for (const r of resolved) {
    const list = edges.get(key(r.to)) ?? [];
    list.push({ from: around(r.file, r.at), prefix: r.prefix });
    edges.set(key(r.to), list);
  }

  const known = new Map<string, string[]>();
  const prefixesOf = (unit: Unit, seen: Set<string> = new Set()): string[] => {
    const k = key(unit);
    const done = known.get(k);
    if (done) return done;
    const incoming = edges.get(k);
    // nobody registers it, or it registers itself: its own paths
    if (!incoming || seen.has(k)) return [''];
    const out = new Set<string>();
    for (const edge of incoming) {
      for (const outer of prefixesOf(edge.from, new Set([...seen, k]))) out.add(joinPath(outer, edge.prefix));
    }
    const list = [...out];
    known.set(k, list);
    return list;
  };

  const out: Route[] = [];
  for (const [file, info] of parsed) {
    for (const r of info.routes) {
      for (const p of prefixesOf(around(file, r.at))) {
        for (const method of r.methods)
          out.push({ method, path: toTemplate(joinPath(prefix, p, r.path)), file, line: r.line, ...r.details });
      }
    }
  }
  if ([...parsed.values()].some((info) => /\bexposeHeadRoutes\s*:\s*false\b/.test(info.src))) return out;
  const heads = new Set(out.filter((r) => r.method === 'head').map((r) => normalizePath(r.path)));
  const implicit: Route[] = [];
  for (const r of out) {
    const p = normalizePath(r.path);
    if (r.method !== 'get' || heads.has(p)) continue;
    heads.add(p);
    implicit.push({ method: 'head', path: r.path, file: r.file, line: r.line, implicit: true });
  }
  return [...out, ...implicit];
}

/** The unit a `register` target names, or null when it is not a plugin of this source tree (a package). */
function unitOf(
  file: string,
  info: ParsedFile,
  target: Target,
  parsed: Map<string, ParsedFile>,
  wholeFile: (file: string) => Unit
): Unit | null {
  if (target.kind === 'range') return { file, start: target.start, end: target.end };
  if (target.kind === 'file') return parsed.has(target.file) ? wholeFile(target.file) : null;
  const local = functionRange(info.src, target.name);
  if (local) return { file, ...local };
  const imported = info.imports.get(target.name);
  if (!imported || !parsed.has(imported.file)) return null;
  // a named export is that function of the other file; a default import is the file
  const named = imported.name ? functionRange((parsed.get(imported.file) as ParsedFile).src, imported.name) : null;
  return named ? { file: imported.file, ...named } : wholeFile(imported.file);
}

/** Where a function called `name` is written in a source: `function name(...) {}` or `const name = (...) => {}`. */
function functionRange(src: string, name: string): { start: number; end: number } | null {
  const id = name.replace(/\$/g, '\\$');
  const declared = new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*${id}\\s*\\(`).exec(src);
  const assigned = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b[^(]*)?`).exec(src);
  const m = declared ?? assigned;
  if (!m) return null;
  const from = m.index + m[0].length - (declared ? 1 : 0);
  const body = bodyStart(src, from);
  return body < 0 ? null : { start: m.index, end: closingBracket(src, body) + 1 };
}

/** The opening brace of the body of the function whose parameters begin at or after `from`; -1 when there is none. */
function bodyStart(src: string, from: number): number {
  const arrow = src.indexOf('=>', from);
  const paren = src.indexOf('(', from);
  // `fastify => {`: no parenthesis before the arrow
  const afterParams = paren >= 0 && (arrow < 0 || paren < arrow) ? closingBracket(src, paren) + 1 : from;
  const brace = src.indexOf('{', afterParams);
  if (brace < 0) return -1;
  // between the parameters and the body: a return type, an arrow, nothing that ends a statement
  return /[;]/.test(src.slice(afterParams, brace)) ? -1 : brace;
}

function parseFile(file: string): ParsedFile {
  const src = stripComments(readText(file));
  const dir = path.dirname(file);
  const info: ParsedFile = { src, routes: [], registers: [], imports: new Map() };

  const imported = (local: string, spec: string, name?: string): void => {
    const f = resolveImport(dir, spec);
    if (f) info.imports.set(local, name ? { file: f, name } : { file: f });
  };
  for (const m of src.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s+(['"])([^'"]+)\2/g))
    imported(m[1] as string, m[3] as string);
  for (const m of src.matchAll(/\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s+(['"])([^'"]+)\2/g)) {
    for (const [local, name] of namedBindings(m[1] as string, /\s+as\s+/)) imported(local, m[3] as string, name);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g)) {
    imported(m[1] as string, m[3] as string);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g)) {
    for (const [local, name] of namedBindings(m[1] as string, /\s*:\s*/)) imported(local, m[3] as string, name);
  }

  // fastify.get('/x', ...): a path, so that `cache.get('key')` is not a route
  const verbRe = new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(${VERBS.join('|')})\\s*\\(\\s*(['"\`])([/*][^'"\`]*)\\2`, 'g');
  for (const m of src.matchAll(verbRe)) {
    const open = src.indexOf('(', m.index);
    const details = inlineHandlerDetails(src.slice(open + 1, closingBracket(src, open)), STATUS_CALLS);
    const verb = m[1] as (typeof VERBS)[number];
    info.routes.push({ at: m.index, methods: verb === 'all' ? ALL : [verb], path: m[3] as string, line: lineOf(src, m.index), details });
  }

  // fastify.route({ method: 'GET', url: '/x', handler })
  for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\s*\.\s*route\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const body = src.slice(open, closingBracket(src, open) + 1);
    const url = new RegExp(`\\b(?:url|path)\\s*:\\s*(${STRING})`).exec(body);
    const method = new RegExp(`\\bmethod\\s*:\\s*(\\[[^\\]]*\\]|${STRING})`).exec(body);
    if (!url || !method) continue;
    const methods = stringLiterals(method[1] as string)
      .map((x) => x.toLowerCase())
      .filter((x): x is HttpMethod => (METHODS as readonly string[]).includes(x));
    if (!methods.length) continue;
    info.routes.push({
      at: m.index,
      methods,
      path: wholeLiteral(url[1] as string) ?? '',
      line: lineOf(src, m.index),
      details: inlineHandlerDetails(body, STATUS_CALLS),
    });
  }

  // fastify.register(plugin, { prefix: '/x' })
  for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\s*\.\s*register\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const inner = src.slice(open + 1, closingBracket(src, open));
    const [first = '', options = ''] = splitTopLevel(inner);
    const target = targetOf(first, open + 1 + inner.indexOf(first), dir);
    if (!target) continue;
    const given = new RegExp(`\\bprefix\\s*:\\s*(${STRING})`).exec(options);
    info.registers.push({ at: m.index, prefix: given ? (wholeLiteral(given[1] as string) ?? '') : '', target });
  }
  return info;
}

/** `{ a, b as c }` (or `{ a, b: c }`) -> [local name, name in the other file]. */
function namedBindings(list: string, as: RegExp): [string, string][] {
  const out: [string, string][] = [];
  for (const part of list.split(',')) {
    const [name, local] = part.trim().split(as);
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.push([(local ?? name).trim(), name]);
  }
  return out;
}

/** What `register` is given first: a function written there, a name, or another file. */
function targetOf(first: string, at: number, dir: string): Target | null {
  const file = /^(?:await\s+)?(?:require|import)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(first);
  if (file) {
    const f = resolveImport(dir, file[2] as string);
    return f ? { kind: 'file', file: f } : null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(first)) return { kind: 'name', name: first };
  if (/^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(first)) return { kind: 'range', start: at, end: at + first.length };
  return null;
}
