import path from 'node:path';
import { sourceFiles, readText, stripComments, lineOf, stringLiterals, toTemplate, closingBracket } from '../files.ts';
import { joinPath } from '../openapi.ts';
import { NEUTRAL, excludes, readNestApp, versionsOf } from './nest-app.ts';
import type { AppSettings, ExtractOptions, HttpMethod, Route } from '../types.ts';

export { readNestApp } from './nest-app.ts';

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

export interface NestExtract {
  routes: Route[];
  /** The prefix the routes are under: the one given, or the one read from the code. */
  prefix: string;
  /** What was read from the application's source; absent when a prefix was given. */
  app?: AppSettings;
}

/**
 * The routes a NestJS source tree declares: every `@Get('x')` and friends under its `@Controller('prefix')`.
 * Paths are templated (`:id` -> `{id}`). A controller with several prefixes (`@Controller(['a', 'b'])`) yields
 * each route once per prefix.
 *
 * Without a `prefix`, what the application sets for all routes is read from the code: the global prefix
 * (`app.setGlobalPrefix`, with the routes it excludes) and URI versioning (`app.enableVersioning`, with the
 * versions of `@Controller({ version })` and `@Version()`). A `prefix` that is given replaces all of that.
 */
export function extractNest(dir: string, { prefix = '' }: ExtractOptions = {}): NestExtract {
  const given = prefix.trim() !== '';
  const app = given ? undefined : readNestApp(dir);
  const scope: Scope = {
    prefix: given ? prefix : (app?.prefix?.value ?? ''),
    excluded: excludes(app?.prefix?.exclude ?? []),
    versioning: app?.versioning,
  };
  const routes: Route[] = [];
  for (const file of sourceFiles(path.resolve(dir), ['.ts', '.js', '.mts', '.mjs'])) {
    const src = stripComments(readText(file));
    if (!src.includes('@Controller')) continue;
    routes.push(...routesOfFile(src, path.normalize(file), scope));
  }
  const applied = given ? prefix : scope.prefix === '' ? '' : joinPath(scope.prefix);
  return { routes, prefix: applied, ...(app ? { app } : {}) };
}

export function extractNestRoutes(dir: string, options: ExtractOptions = {}): Route[] {
  return extractNest(dir, options).routes;
}

/** What applies to every route of the tree. */
interface Scope {
  prefix: string;
  excluded: (ownPath: string, method: HttpMethod) => boolean;
  versioning: AppSettings['versioning'];
}

interface Decorator {
  name: string;
  args: string;
  start: number;
  end: number;
}

/** Every decorator of a source in order, arguments balanced; what is inside another's arguments is not one. */
function decoratorsOf(src: string): Decorator[] {
  const out: Decorator[] = [];
  const re = /@([A-Za-z_$][\w$]*)\s*(\()?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1] as string;
    if (!m[2]) {
      out.push({ name, args: '', start: m.index, end: m.index + m[0].length });
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = closingBracket(src, open);
    out.push({ name, args: src.slice(open + 1, close), start: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

/** The decorators of one class or member: those with nothing but white space between them. */
function blocksOf(src: string): Decorator[][] {
  const blocks: Decorator[][] = [];
  let previous: Decorator | undefined;
  for (const d of decoratorsOf(src)) {
    if (previous && src.slice(previous.end, d.start).trim() === '') (blocks[blocks.length - 1] as Decorator[]).push(d);
    else blocks.push([d]);
    previous = d;
  }
  return blocks;
}

function routesOfFile(src: string, file: string, scope: Scope): Route[] {
  const out: Route[] = [];
  // Blocks in source order; a @Controller opens the scope of the method decorators after it.
  let controller: { paths: string[]; versions: string[] | null } | null = null; // routes before any @Controller are ignored
  for (const block of blocksOf(src)) {
    const version = block.find((d) => d.name === 'Version');
    const ownVersions = version ? versionsOf(version.args) : null;
    for (const d of block) {
      if (d.name === 'Controller') {
        controller = { paths: controllerPaths(d.args), versions: controllerVersions(d.args) };
        continue;
      }
      const methods = METHOD_DECORATORS[d.name];
      if (!methods || !controller) continue;
      const subPaths = stringLiterals(d.args);
      if (!subPaths.length) subPaths.push('');
      const line = lineOf(src, d.start);
      const segments = versionSegments(scope, ownVersions ?? controller.versions);
      for (const cp of controller.paths) {
        for (const sp of subPaths) {
          for (const method of methods) {
            // the prefix leaves a route out by its own path, the version not counted
            const prefix = scope.excluded(joinPath(cp, sp), method) ? '' : scope.prefix;
            for (const segment of segments) out.push({ method, path: toTemplate(joinPath(prefix, segment, cp, sp)), file, line });
          }
        }
      }
    }
  }
  return out;
}

/**
 * The version segments of a route's path, `['']` for none. A version is in the path only under URI versioning;
 * a route that declares none takes the application's default versions, and `VERSION_NEUTRAL` is no segment.
 */
function versionSegments(scope: Scope, declared: string[] | null): string[] {
  const versioning = scope.versioning;
  if (!versioning) return [''];
  const versions = declared ?? versioning.defaults;
  if (!versions.length) return [''];
  return [...new Set(versions.map((v) => (v === NEUTRAL ? '' : `${versioning.prefix}${v}`)))];
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

/** `{ path: 'cats', version: '1' }` -> ['1']; `version: ['1', '2']` and `version: VERSION_NEUTRAL` too; none -> null. */
function controllerVersions(args: string): string[] | null {
  const text = args.trim();
  if (!text.startsWith('{')) return null;
  const m = text.match(/\bversion\s*:\s*(\[[^\]]*\]|VERSION_NEUTRAL\b|'[^']*'|"[^"]*"|`[^`]*`)/);
  return m ? versionsOf(m[1] as string) : null;
}
