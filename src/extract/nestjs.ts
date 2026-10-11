import path from 'node:path';
import { sourceFiles, readText, stripComments, lineOf, stringLiterals, toTemplate } from '../files.ts';
import { joinPath } from '../openapi.ts';
import type { ExtractOptions, HttpMethod, Route } from '../types.ts';

const METHOD_DECORATORS: Record<string, readonly HttpMethod[]> = {
  Get: ['get'],
  Post: ['post'],
  Put: ['put'],
  Patch: ['patch'],
  Delete: ['delete'],
  Head: ['head'],
  Options: ['options'],
  All: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
};

/**
 * The routes a NestJS source tree declares: every `@Get('x')` and friends under its `@Controller('prefix')`.
 * Paths are templated (`:id` -> `{id}`). A controller with several prefixes (`@Controller(['a', 'b'])`) yields
 * each route once per prefix. The global prefix (`app.setGlobalPrefix`) and URI versioning are not read from
 * the code: pass them as `prefix`.
 */
export function extractNestRoutes(dir: string, { prefix = '' }: ExtractOptions = {}): Route[] {
  const routes: Route[] = [];
  for (const file of sourceFiles(path.resolve(dir), ['.ts', '.js', '.mts', '.mjs'])) {
    const src = stripComments(readText(file));
    if (!src.includes('@Controller')) continue;
    routes.push(...routesOfFile(src, path.normalize(file), prefix));
  }
  return routes;
}

function routesOfFile(src: string, file: string, prefix: string): Route[] {
  const out: Route[] = [];
  // Decorators in source order; a @Controller opens the scope of the method decorators after it.
  const re = /@(Controller|Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(([^)]*)\)/g;
  let prefixes: string[] | null = null; // method decorators before any @Controller are ignored
  for (const m of src.matchAll(re)) {
    const name = m[1] as string;
    const args = m[2] as string;
    if (name === 'Controller') {
      prefixes = controllerPaths(args);
      continue;
    }
    if (!prefixes) continue;
    const methods = METHOD_DECORATORS[name] ?? [];
    const subPaths = stringLiterals(args);
    if (!subPaths.length) subPaths.push('');
    const line = lineOf(src, m.index);
    for (const cp of prefixes) {
      for (const sp of subPaths) {
        for (const method of methods) out.push({ method, path: toTemplate(joinPath(prefix, cp, sp)), file, line });
      }
    }
  }
  return out;
}

/** `'users'` -> ['users']; `{ path: 'users', host: ... }` -> ['users']; `['a', 'b']` -> ['a', 'b']; `()` -> ['']. */
function controllerPaths(args: string): string[] {
  const text = args.trim();
  if (!text) return [''];
  if (text.startsWith('{')) {
    const m = text.match(/path\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/);
    if (!m) return [''];
    const lits = stringLiterals(m[1] as string);
    return lits.length ? lits : [''];
  }
  const lits = stringLiterals(text);
  return lits.length ? lits : [''];
}
