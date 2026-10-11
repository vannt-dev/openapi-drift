import fs from 'node:fs';
import path from 'node:path';
import { sourceFiles, readText, stripComments, lineOf, toTemplate, closingParen } from '../files.ts';
import { joinPath } from '../openapi.ts';
import type { ExtractOptions, HttpMethod, Route } from '../types.ts';

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;
type Verb = (typeof VERBS)[number];
const ALL: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const VERB_RE = VERBS.join('|');

interface RawRoute {
  receiver: string;
  verb: Verb;
  path: string;
  line: number;
}

interface Mount {
  receiver: string;
  prefix: string;
  target: string;
}

interface ParsedFile {
  routes: RawRoute[];
  mounts: Mount[];
  /** variable -> resolved file, for `import x from './y'` and `const x = require('./y')` */
  imports: Map<string, string>;
  /** variables holding `Router()` */
  routers: Set<string>;
  /** variables the file exports as its default / module.exports */
  exported: Set<string>;
}

/**
 * The routes an Express source tree declares: `app.get('/x', ...)`, `router.post('/y', ...)`,
 * `app.route('/z').get(...).post(...)`, with routers mounted by `app.use('/prefix', router)` in the same file
 * or imported from another file. A route whose path is not a string literal is skipped; a router that is never
 * mounted keeps its own paths. Anything the code builds dynamically needs `prefix`.
 */
export function extractExpressRoutes(dir: string, { prefix = '' }: ExtractOptions = {}): Route[] {
  const parsed = new Map<string, ParsedFile>();
  // absolute paths, so that a mount's import resolves to the same key as the walk
  for (const file of sourceFiles(path.resolve(dir), ['.js', '.mjs', '.cjs', '.ts', '.mts']))
    parsed.set(path.normalize(file), parseFile(file));

  // Which prefixes each file's exported router is mounted under, following imports from the mounting file.
  const mountPrefixes = new Map<string, string[]>();
  for (const info of parsed.values()) {
    for (const m of info.mounts) {
      const target = info.imports.get(m.target);
      if (target && parsed.has(target)) mountPrefixes.set(target, [...(mountPrefixes.get(target) ?? []), m.prefix]);
    }
  }

  const out: Route[] = [];
  for (const [file, info] of parsed) {
    for (const r of info.routes) {
      const local = info.mounts.filter((m) => m.target === r.receiver).map((m) => m.prefix);
      const external = mountPrefixes.get(file) ?? [];
      const exportedRouter = info.routers.has(r.receiver) || info.exported.has(r.receiver);
      const prefixes = [...new Set(local.length ? local : external.length && exportedRouter ? external : [''])];
      const methods: readonly HttpMethod[] = r.verb === 'all' ? ALL : [r.verb];
      for (const p of prefixes) {
        for (const method of methods) out.push({ method, path: toTemplate(joinPath(prefix, p, r.path)), file, line: r.line });
      }
    }
  }
  return out;
}

function parseFile(file: string): ParsedFile {
  const src = stripComments(readText(file));
  const dir = path.dirname(file);
  const info: ParsedFile = { routes: [], mounts: [], imports: new Map(), routers: new Set(), exported: new Set() };

  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\s*\(/g)) info.routers.add(m[1] as string);
  for (const m of src.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/g)) info.exported.add(m[1] as string);
  for (const m of src.matchAll(/\bmodule\.exports\s*=\s*([A-Za-z_$][\w$]*)\b/g)) info.exported.add(m[1] as string);

  for (const m of src.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const f = resolveImport(dir, m[3] as string);
    if (f) info.imports.set(m[1] as string, f);
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g)) {
    const f = resolveImport(dir, m[3] as string);
    if (f) info.imports.set(m[1] as string, f);
  }

  // app.use('/prefix', router)
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.use\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    info.mounts.push({ receiver: m[1] as string, prefix: m[3] as string, target: m[4] as string });
  }

  // app.get('/x', ...), router.post('/y', ...)
  const verbRe = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${VERB_RE})\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`, 'g');
  for (const m of src.matchAll(verbRe)) {
    info.routes.push({ receiver: m[1] as string, verb: m[2] as Verb, path: m[4] as string, line: lineOf(src, m.index) });
  }

  // app.route('/x').get(...).post(...)
  const chainLink = new RegExp(`^\\s*\\.(${VERB_RE})\\s*\\(`);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*(['"`])([^'"`]+)\2\s*\)/g)) {
    const receiver = m[1] as string;
    const routePath = m[3] as string;
    const line = lineOf(src, m.index);
    let i = m.index + m[0].length;
    for (;;) {
      const link = src.slice(i).match(chainLink);
      if (!link) break;
      info.routes.push({ receiver, verb: link[1] as Verb, path: routePath, line });
      i = closingParen(src, i + link[0].length - 1) + 1;
    }
  }
  return info;
}

function resolveImport(dir: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(dir, spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.mts`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];
  // `./users.js` written for the ESM build of `./users.ts`
  if (/\.m?js$/.test(spec)) candidates.push(base.replace(/\.m?js$/, '.ts'), base.replace(/\.mjs$/, '.mts'));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return path.normalize(c);
    } catch {
      // next candidate
    }
  }
  return null;
}
