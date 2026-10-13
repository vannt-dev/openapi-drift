import path from 'node:path';
import {
  sourceFiles,
  readText,
  stripComments,
  lineOf,
  stringLiterals,
  toTemplate,
  closingBracket,
  splitTopLevel,
  wholeLiteral,
} from '../files.ts';
import { joinPath } from '../openapi.ts';
import { NEUTRAL, excludes, readNestApp, versionsOf } from './nest-app.ts';
import { blocksOf, decoratorsOf, type Decorator } from './decorators.ts';
import { HTTP_STATUS, detailsOf, type HandlerDetails } from './handler.ts';
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
      const handler = handlerOf(src, block);
      for (const cp of controller.paths) {
        for (const sp of subPaths) {
          for (const method of methods) {
            // the prefix leaves a route out by its own path, the version not counted
            const prefix = scope.excluded(joinPath(cp, sp), method) ? '' : scope.prefix;
            // NestJS answers 201 to a POST and 200 to anything else; `@All()` is not a POST to it
            const details = detailsOf({
              query: handler.query,
              statuses: handler.statuses === 'default' ? [method === 'post' && d.name !== 'All' ? 201 : 200] : handler.statuses,
            });
            for (const segment of segments) {
              out.push({ method, path: toTemplate(joinPath(prefix, segment, cp, sp)), file, line, ...details });
            }
          }
        }
      }
    }
  }
  return out;
}

/** What a handler's decorators and signature show; `'default'` is the status NestJS gives when none is set. */
interface NestHandler {
  query: HandlerDetails['query'];
  statuses: number[] | 'default' | undefined;
}

/**
 * The query parameters and the status of the handler a block of decorators belongs to.
 *
 * The query is known when every `@Query` of the signature has a name; `@Query() dto` and `@Req()` leave it
 * unknown. The status is `@HttpCode`'s, or the default; a handler that takes the response (`@Res()` without
 * `passthrough`) or redirects writes its own, and a status that is not a number or an `HttpStatus` name is unknown.
 */
function handlerOf(src: string, block: Decorator[]): NestHandler {
  const end = (block[block.length - 1] as Decorator).end;
  const open = src.indexOf('(', end);
  // between the decorators and the signature: modifiers and the name of the method, nothing else
  const header = open < 0 ? '' : src.slice(end, open);
  if (!/^\s*(?:(?:public|private|protected|static|async|override)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*$/.test(header)) {
    return { query: undefined, statuses: undefined };
  }
  const params = decoratorsOf(src.slice(open + 1, closingBracket(src, open)));
  const takes = (...names: string[]): Decorator[] => params.filter((p) => names.includes(p.name));

  let query: HandlerDetails['query'];
  if (!takes('Req', 'Request').length) {
    const names = takes('Query').map((q) => wholeLiteral(splitTopLevel(q.args)[0] ?? ''));
    if (names.every((n) => n !== undefined)) query = { names: [...new Set(names)], complete: true };
  }

  const ownResponse = takes('Res', 'Response').some((r) => !/\bpassthrough\s*:\s*true\b/.test(r.args));
  if (ownResponse || block.some((d) => d.name === 'Redirect')) return { query, statuses: undefined };
  const code = block.find((d) => d.name === 'HttpCode');
  if (!code) return { query, statuses: 'default' };
  const given = code.args.trim();
  const status = /^\d{3}$/.test(given) ? Number(given) : HTTP_STATUS[/^(?:\w+\.)?HttpStatus\.(\w+)$/.exec(given)?.[1] ?? ''];
  return { query, statuses: status === undefined ? undefined : [status] };
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
