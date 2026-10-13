import path from 'node:path';
import YAML from 'yaml';
import { sourceFiles, readText, stripComments, lineOf, closingBracket, splitTopLevel, wholeLiteral } from '../files.ts';
import { joinPath } from '../openapi.ts';
import { blocksOf, decoratorsOf, type Decorator } from './decorators.ts';
import { HTTP_STATUS, detailsOf, type HandlerDetails } from './handler.ts';
import { METHODS, type AppNote, type AppSettings, type ExtractOptions, type HttpMethod, type Route } from '../types.ts';

const ALL: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
/** The mapping annotations and their method; `@RequestMapping` takes it from its `method`, or serves them all. */
const MAPPINGS: Readonly<Record<string, readonly HttpMethod[] | null>> = {
  GetMapping: ['get'],
  PostMapping: ['post'],
  PutMapping: ['put'],
  PatchMapping: ['patch'],
  DeleteMapping: ['delete'],
  RequestMapping: null,
};
/** Annotations that say where a parameter comes from, when it is not the query. */
const BINDINGS = new Set([
  'PathVariable',
  'RequestBody',
  'RequestHeader',
  'CookieValue',
  'RequestPart',
  'RequestAttribute',
  'SessionAttribute',
  'MatrixVariable',
  'AuthenticationPrincipal',
]);
/** `ResponseEntity.ok()` and its like. */
const BUILDERS: Readonly<Record<string, number>> = {
  ok: 200,
  created: 201,
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  notFound: 404,
  unprocessableEntity: 422,
  internalServerError: 500,
};

export interface SpringExtract {
  routes: Route[];
  /** The prefix the routes are under: the one given, or the application's context path. */
  prefix: string;
  /** What was read from the application's settings, and what could not be read of its mappings. */
  app?: AppSettings;
}

/**
 * The routes a Spring MVC or WebFlux source tree declares, in Java and Kotlin: the `@GetMapping("/x")` family
 * and `@RequestMapping(path, method)` on the methods of a class that is a `@RestController` or a `@Controller`,
 * under the class's own `@RequestMapping`. Several paths yield each route once per path; `{id:\\d+}` is `{id}`.
 * Test sources (`src/test`) and build output are not read, and an interface with the same annotations (a Feign
 * client, a generated API interface) is not a controller.
 *
 * Without a `prefix`, the context path is read from `application.properties` or `application.yml`
 * (`server.servlet.context-path`). A path that is not written as text (a constant) is not guessed: the route is
 * left out and a note says where.
 */
export function extractSpring(dir: string, { prefix = '' }: ExtractOptions = {}): SpringExtract {
  const root = path.resolve(dir);
  const given = prefix.trim() !== '';
  const notes: AppNote[] = [];
  const context = given ? undefined : contextPath(root, notes);
  const applied = given ? prefix : (context?.value ?? '');
  const routes: Route[] = [];
  for (const file of sourceFiles(root, ['.java', '.kt'])) {
    if (ofTests(root, file)) continue;
    const src = stripComments(readText(file));
    if (!/@(?:Rest)?Controller\b/.test(src)) continue;
    routes.push(...routesOfFile(src, path.normalize(file), applied, notes));
  }
  if (given) return { routes, prefix, ...(notes.length ? { app: { notes } } : {}) };
  const app: AppSettings = { ...(context ? { prefix: { ...context, exclude: [] } } : {}), notes };
  return { routes, prefix: applied === '' ? '' : joinPath(applied), app };
}

export function extractSpringRoutes(dir: string, options: ExtractOptions = {}): Route[] {
  return extractSpring(dir, options).routes;
}

/** Whether a file of a Spring source tree has a controller in it; test sources do not count. */
export function hasSpringController(dir: string): boolean {
  const root = path.resolve(dir);
  return sourceFiles(root, ['.java', '.kt']).some(
    (file) => !ofTests(root, file) && /@RestController\b|@Controller\b[\s\S]*Mapping\b/.test(readText(file))
  );
}

/** Test sources and build output of a Maven or Gradle project, wherever the tree was entered. */
function ofTests(root: string, file: string): boolean {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  return /(?:^|\/)src\/test\//.test(rel) || /^test\/(?:java|kotlin|resources)\//.test(rel) || /(?:^|\/)target\//.test(rel);
}

function routesOfFile(src: string, file: string, prefix: string, notes: AppNote[]): Route[] {
  const out: Route[] = [];
  // Blocks of annotations in source order; the one of a controller class opens the scope of the mappings after it.
  let base: string[] | null = null;
  for (const block of blocksOf(src)) {
    const last = block[block.length - 1] as Decorator;
    if (
      /^\s*(?:(?:public|protected|private|abstract|final|static|open|internal|sealed|data)\s+)*(?:class|interface|object|enum|record)\b/.test(
        src.slice(last.end, last.end + 160)
      )
    ) {
      base = null;
      if (!block.some((d) => d.name === 'RestController' || d.name === 'Controller')) continue;
      const mapping = block.find((d) => d.name === 'RequestMapping');
      const paths = mapping ? pathsOf(mapping.args) : [''];
      if (paths) base = paths;
      else {
        notes.push({
          file,
          line: lineOf(src, (mapping as Decorator).start),
          message: '@RequestMapping of the class: its path is not written as text, so the routes of the class are left out',
        });
      }
      continue;
    }
    if (!base) continue;
    for (const d of block) {
      if (!(d.name in MAPPINGS)) continue;
      const line = lineOf(src, d.start);
      const paths = pathsOf(d.args);
      if (!paths) {
        notes.push({ file, line, message: `@${d.name}: its path is not written as text, so the route is left out` });
        continue;
      }
      const methods = MAPPINGS[d.name] ?? requestMethods(d.args);
      const details = handlerOf(src, block);
      for (const bp of base) {
        for (const p of paths) {
          for (const method of methods) out.push({ method, path: template(joinPath(prefix, bp, p)), file, line, ...details });
        }
      }
    }
  }
  return out;
}

/** The value of an annotation's positional argument or of one of the named attributes, as written; undefined when absent. */
function attribute(args: string, names: readonly string[]): string | undefined {
  let value: string | undefined;
  for (const part of splitTopLevel(args)) {
    const named = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
    if (!named) value ??= part;
    else if (names.includes(named[1] as string)) value = named[2];
  }
  return value;
}

/** `("/a")`, `(value = "/a")`, `(path = {"/a", "/b"})`, `(["/a"])` -> the paths; none -> ['']; not text -> null. */
function pathsOf(args: string): string[] | null {
  const value = attribute(args, ['value', 'path']);
  if (value === undefined) return [''];
  const elements = splitTopLevel(value.trim().replace(/^[{[]|[}\]]$/g, ''));
  if (!elements.length) return [''];
  const paths = elements.map(wholeLiteral);
  return paths.every((p): p is string => p !== undefined) ? paths : null;
}

/** `method = RequestMethod.GET`, `method = {RequestMethod.GET, RequestMethod.POST}`; without one, every method. */
function requestMethods(args: string): readonly HttpMethod[] {
  const named = [...args.matchAll(/\bRequestMethod\s*\.\s*(\w+)/g)].map((m) => (m[1] as string).toLowerCase());
  const methods = named.filter((m): m is HttpMethod => (METHODS as readonly string[]).includes(m));
  return methods.length ? [...new Set(methods)] : ALL;
}

/** `/users/{id:[0-9]+}` -> `/users/{id}`, `/files/**` -> `/files/{wildcard}`; a pattern may hold braces of its own. */
function template(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== '{') {
      out += p[i];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < p.length; j++) {
      if (p[j] === '{') depth++;
      else if (p[j] === '}' && --depth === 0) break;
    }
    const name = (p.slice(i + 1, j).split(':')[0] ?? '').trim().replace(/^\*/, '');
    out += `{${name}}`;
    i = j;
  }
  return out.replace(/\*+/g, '{wildcard}');
}

/** A parameter list cut at its commas, those of generic types (`Map<String, String>`) left alone. */
function splitParams(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') i = closingBracket(text, i);
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j;
    } else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === ',' && angle === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * What the annotations and the signature of a handler show.
 *
 * The query is known when every parameter says where it comes from: `@RequestParam` names a query parameter (by
 * `name`, `value` or the parameter's own name), the other binding annotations name something else. A parameter
 * without one (an object the query is bound to, a `Pageable`, the request) leaves it unknown, and so does a
 * `@RequestParam Map`.
 *
 * The status is `@ResponseStatus`'s, or 200. A handler that returns a `ResponseEntity` builds its own: the
 * statuses its body is seen to build are what is known, and a handler that takes the response is left alone.
 */
function handlerOf(src: string, block: Decorator[]): HandlerDetails {
  const end = (block[block.length - 1] as Decorator).end;
  const open = src.indexOf('(', end);
  const header = open < 0 ? '' : src.slice(end, open);
  // between the annotations and the parameters: modifiers, a return type, the name; nothing that ends a member
  if (!/^[^;{}=()@]*[A-Za-z_$][\w$]*\s*$/.test(header)) return {};
  const close = closingBracket(src, open);
  const params = splitParams(src.slice(open + 1, close));

  const names: string[] = [];
  let complete = true;
  for (const param of params) {
    const annotations = decoratorsOf(param);
    // the parameter without its annotations: the type and the name
    let rest = param;
    for (const a of [...annotations].reverse()) rest = rest.slice(0, a.start) + rest.slice(a.end);
    const request = annotations.find((a) => a.name === 'RequestParam');
    if (!request) {
      if (annotations.some((a) => BINDINGS.has(a.name))) continue;
      complete = false;
      break;
    }
    const given = attribute(request.args, ['name', 'value']);
    const name = given === undefined ? variableName(rest) : wholeLiteral(given);
    if (name === undefined || /\bMap\s*</.test(rest)) {
      complete = false;
      break;
    }
    if (!names.includes(name)) names.push(name);
  }

  return detailsOf({ query: complete ? { names, complete: true } : undefined, statuses: statusesOf(src, block, header, params, close) });
}

/** The name of a parameter: before the colon in Kotlin (`page: Int`), the last word in Java (`int page`). */
function variableName(rest: string): string | undefined {
  const kotlin = /^\s*(?:vararg\s+)?([A-Za-z_][\w]*)\s*:/.exec(rest);
  if (kotlin) return kotlin[1];
  return /([A-Za-z_$][\w$]*)\s*$/.exec(rest)?.[1];
}

function statusesOf(src: string, block: Decorator[], header: string, params: string[], close: number): number[] | undefined {
  if (params.some((p) => /\b(?:HttpServletResponse|ServerHttpResponse)\b/.test(p))) return undefined;
  const fixed = block.find((d) => d.name === 'ResponseStatus');
  if (fixed) {
    const status = HTTP_STATUS[/\bHttpStatus\s*\.\s*(\w+)/.exec(fixed.args)?.[1] ?? ''];
    return status === undefined ? undefined : [status];
  }
  // the return type: before the name in Java, after the parameters in Kotlin
  const after = src.slice(close + 1, close + 120);
  if (!/\b(?:ResponseEntity|HttpEntity)\b/.test(header) && !/^\s*:\s*[\w.<]*\bResponseEntity\b/.test(after)) return [200];
  const brace = src.indexOf('{', close);
  if (brace < 0 || /[;=]/.test(src.slice(close + 1, brace))) return undefined;
  const body = src.slice(brace, closingBracket(src, brace) + 1);
  const seen: { at: number; status: number | undefined }[] = [];
  for (const m of body.matchAll(/\bResponseEntity\s*\.\s*(\w+)\s*\(\s*(?:HttpStatus\s*\.\s*(\w+)|(\d{3}))?/g)) {
    const how = m[1] as string;
    seen.push({ at: m.index, status: how === 'status' ? (m[3] ? Number(m[3]) : HTTP_STATUS[m[2] ?? '']) : BUILDERS[how] });
  }
  for (const m of body.matchAll(/\bnew\s+ResponseEntity\b[^;]*?\bHttpStatus\s*\.\s*(\w+)/g))
    seen.push({ at: m.index, status: HTTP_STATUS[m[1] as string] });
  const statuses = seen
    .sort((a, b) => a.at - b.at)
    .map((s) => s.status)
    .filter((s): s is number => s !== undefined);
  return statuses.length ? [...new Set(statuses)] : undefined;
}

interface Found {
  value: string;
  file: string;
  line: number;
}

/**
 * `server.servlet.context-path` of the application: from `application.properties`, `application.yml` or
 * `application.yaml`. The settings of a profile (`application-dev.yml`) and of the tests are not the application's.
 */
function contextPath(root: string, notes: AppNote[]): Found | undefined {
  const found: Found[] = [];
  for (const file of sourceFiles(root, ['.properties', '.yml', '.yaml'])) {
    if (ofTests(root, file) || !/^application\.(?:properties|ya?ml)$/.test(path.basename(file))) continue;
    const text = readText(file);
    const at = file.endsWith('.properties') ? fromProperties(text) : fromYaml(text);
    if (!at) continue;
    if (at.value.includes('${')) {
      notes.push({
        file: path.normalize(file),
        line: at.line,
        message: 'server.servlet.context-path takes its value from the environment, which the source does not show; pass --prefix',
      });
    } else found.push({ value: at.value, file: path.normalize(file), line: at.line });
  }
  const first = found[0];
  if (!first) return undefined;
  const values = [...new Set(found.map((f) => f.value))].sort();
  if (values.length === 1) return first;
  notes.push({
    file: first.file,
    line: first.line,
    message: `server.servlet.context-path is set to different values in this source tree (${values.join(', ')}), so none is applied: point --source at one application, or pass --prefix`,
  });
  return undefined;
}

const CONTEXT_PATH = /context[-_]?path/i;

function fromProperties(text: string): { value: string; line: number } | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^\\s*server\\.servlet\\.${CONTEXT_PATH.source}\\s*[=:]\\s*(.*?)\\s*$`, 'i').exec(lines[i] as string);
    if (m && m[1]) return { value: m[1], line: i + 1 };
  }
  return undefined;
}

function fromYaml(text: string): { value: string; line: number } | undefined {
  let value: unknown;
  try {
    for (const doc of YAML.parseAllDocuments(text)) {
      const data = doc.toJS() as Record<string, unknown> | null;
      const servlet = (data?.server as { servlet?: Record<string, unknown> } | undefined)?.servlet;
      value ??= servlet?.['context-path'] ?? servlet?.contextPath ?? data?.['server.servlet.context-path'];
    }
  } catch {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') return undefined;
  const line = text.split(/\r?\n/).findIndex((l) => new RegExp(`^\\s*(?:server\\.servlet\\.)?${CONTEXT_PATH.source}\\s*:`, 'i').test(l));
  return { value, line: line < 0 ? 1 : line + 1 };
}
