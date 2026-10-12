import path from 'node:path';
import { sourceFiles, readText, stripComments, lineOf, stringLiterals, closingBracket, splitTopLevel, wholeLiteral } from '../files.ts';
import { joinPath } from '../openapi.ts';
import { METHODS, type AppNote, type AppSettings, type ExcludedRoute, type HttpMethod } from '../types.ts';

/** `VERSION_NEUTRAL` in a list of versions: the route is served without a version in its path. */
export const NEUTRAL = '';

const EXTS = ['.ts', '.js', '.mts', '.mjs'];
const STRING = `'[^']*'|"[^"]*"|\`[^\`]*\``;

interface Found<T> {
  value: T;
  file: string;
  line: number;
}
type Prefix = { value: string; exclude: ExcludedRoute[] };
/** null: versioning that is not in the path (a header, a media type, a custom extractor). */
type Versioning = { prefix: string; defaults: string[] } | null;

/**
 * What a NestJS application sets for all of its routes, read from the source under `dir`:
 * `app.setGlobalPrefix('api', { exclude: [...] })` and `app.enableVersioning({ type: VersioningType.URI, ... })`.
 *
 * A setting whose value the source does not show as text (a variable from the configuration) is not guessed:
 * it comes back as a note and the routes are as if it were not set. The same when the tree holds several
 * applications that set different values.
 */
export function readNestApp(dir: string): AppSettings {
  const prefixes: Found<Prefix>[] = [];
  const versionings: Found<Versioning>[] = [];
  const notes: AppNote[] = [];
  for (const file of sourceFiles(path.resolve(dir), EXTS)) {
    const src = stripComments(readText(file));
    for (const call of calls(src, 'setGlobalPrefix')) {
      const at = { file: path.normalize(file), line: call.line };
      const [first = '', options = ''] = splitTopLevel(call.args);
      const value = wholeLiteral(first) ?? constant(src, first);
      if (value === undefined) {
        notes.push({ ...at, message: 'setGlobalPrefix is given a value the source does not show as text; pass --prefix' });
      } else prefixes.push({ value: { value, exclude: excluded(options) }, ...at });
    }
    for (const call of calls(src, 'enableVersioning')) {
      const at = { file: path.normalize(file), line: call.line };
      const value = versioning(call.args);
      if (typeof value === 'string') notes.push({ ...at, message: value });
      else versionings.push({ value, ...at });
    }
  }

  const out: AppSettings = { notes };
  const prefix = one(prefixes, 'setGlobalPrefix', (p) => p.value, notes);
  if (prefix) out.prefix = { ...prefix.value, file: prefix.file, line: prefix.line };
  const version = one(versionings, 'enableVersioning', (v) => (v ? `${v.prefix}<version>` : 'not in the path'), notes);
  if (version?.value) out.versioning = { ...version.value, file: version.file, line: version.line };
  return out;
}

/** The one value all the calls agree on; several different ones are a note and none. */
function one<T>(found: Found<T>[], name: string, show: (value: T) => string, notes: AppNote[]): Found<T> | undefined {
  const first = found[0];
  if (!first) return undefined;
  const different = new Map(found.map((f) => [JSON.stringify(f.value), f]));
  if (different.size === 1) return first;
  const values = [...different.values()].map((f) => show(f.value)).sort();
  notes.push({
    file: first.file,
    line: first.line,
    message: `${name} is called with different settings in this source tree (${values.join(', ')}), so none is applied: point --source at one application, or pass --prefix`,
  });
  return undefined;
}

/** Every `.name(...)` call of a source, with its arguments as text. */
function calls(src: string, name: string): { args: string; line: number }[] {
  const out: { args: string; line: number }[] = [];
  for (const m of src.matchAll(new RegExp(`\\.${name}\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    out.push({ args: src.slice(open + 1, closingBracket(src, open)), line: lineOf(src, m.index) });
  }
  return out;
}

/** The text of `const NAME = 'text'` in the same file, for a prefix kept in a constant. */
function constant(src: string, name: string): string | undefined {
  const id = name.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return undefined;
  const m = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*(?::\\s*string\\s*)?=\\s*(${STRING})`).exec(src);
  return m ? wholeLiteral(m[1] as string) : undefined;
}

/** `{ exclude: ['health', { path: 'metrics', method: RequestMethod.GET }] }` -> the routes left out of the prefix. */
function excluded(options: string): ExcludedRoute[] {
  const m = /\bexclude\s*:\s*\[/.exec(options);
  if (!m) return [];
  const open = m.index + m[0].length - 1;
  const out: ExcludedRoute[] = [];
  for (const entry of splitTopLevel(options.slice(open + 1, closingBracket(options, open)))) {
    if (!entry.startsWith('{')) {
      const p = wholeLiteral(entry);
      if (p !== undefined) out.push({ path: p });
      continue;
    }
    const p = new RegExp(`\\bpath\\s*:\\s*(${STRING})`).exec(entry);
    if (!p) continue;
    const route: ExcludedRoute = { path: wholeLiteral(p[1] as string) ?? '' };
    const method = /\bmethod\s*:\s*RequestMethod\s*\.\s*(\w+)/.exec(entry)?.[1]?.toLowerCase();
    if (method && (METHODS as readonly string[]).includes(method)) route.method = method as HttpMethod;
    out.push(route);
  }
  return out;
}

/** The versioning a call sets up, null when it is not in the path, or a message when the source does not show it. */
function versioning(args: string): Versioning | string {
  const text = args.trim();
  // `enableVersioning()` is URI versioning
  if (!text) return { prefix: 'v', defaults: [] };
  const hidden = (what: string): string => `enableVersioning is given ${what} the source does not show as text; pass --prefix`;
  if (!text.startsWith('{')) return hidden('options');
  const type = /\btype\s*:\s*([\w$.\s]+?)\s*[,}]/.exec(text)?.[1]?.replace(/\s/g, '');
  if (type === undefined) return /\btype\b/.test(text) ? hidden('a type') : null;
  if (!/^(?:\w+\.)?VersioningType\.\w+$/.test(type)) return hidden('a type');
  if (!type.endsWith('.URI')) return null;

  let prefix = 'v';
  if (/\bprefix\s*:/.test(text)) {
    const m = new RegExp(`\\bprefix\\s*:\\s*(false\\b|${STRING})`).exec(text);
    if (!m) return hidden('a prefix');
    prefix = m[1] === 'false' ? '' : (wholeLiteral(m[1] as string) ?? '');
  }
  let defaults: string[] = [];
  if (/\bdefaultVersion\s*:/.test(text)) {
    const m = new RegExp(`\\bdefaultVersion\\s*:\\s*(\\[[^\\]]*\\]|VERSION_NEUTRAL\\b|${STRING})`).exec(text);
    const read = m ? versionsOf(m[1] as string) : null;
    if (!read) return hidden('a default version');
    defaults = read;
  }
  return { prefix, defaults };
}

/** `'1'` -> ['1']; `['1', '2']` -> ['1', '2']; `VERSION_NEUTRAL` -> [NEUTRAL]; anything else -> null. */
export function versionsOf(text: string): string[] | null {
  const out = stringLiterals(text);
  if (/\bVERSION_NEUTRAL\b/.test(text)) out.push(NEUTRAL);
  return out.length ? [...new Set(out)] : null;
}

/** Whether a route (its own path, without prefix and version) is one the global prefix leaves out. */
export function excludes(routes: readonly ExcludedRoute[]): (ownPath: string, method: HttpMethod) => boolean {
  const compiled = routes.map((r) => ({ method: r.method, re: pattern(r.path) }));
  return (ownPath, method) => compiled.some((r) => (!r.method || r.method === method) && r.re.test(ownPath));
}

/** `cats/:id` and `cats/(.*)` as NestJS reads them: a parameter is one segment, a wildcard any text. */
function pattern(p: string): RegExp {
  const body = joinPath(p)
    .split(/(\(\.\*\)|\*|:[A-Za-z_$][\w$]*)/)
    .map((part, i) => (i % 2 === 0 ? part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : part.startsWith(':') ? '[^/]+' : '.*'))
    .join('');
  return new RegExp(`^${body}/?$`, 'i');
}
