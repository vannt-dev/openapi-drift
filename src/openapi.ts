import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML, { LineCounter, isMap, isScalar } from 'yaml';
import { METHODS, type OpenApiDocument, type Operation, type OperationObject, type Parameter, type PathItem } from './types.ts';

/**
 * Reads an OpenAPI 3.x or Swagger 2.0 document, YAML or JSON. A document split into files (`/users: {$ref: ./paths/users.yaml}`) is
 * read through them: path items and parameters kept in another file are put in place. Throws with the file name
 * when it cannot be read.
 */
export function loadSpec(file: string): OpenApiDocument {
  const doc = readDocument(file) as OpenApiDocument;
  inlineSplit(doc, file);
  return doc;
}

function readDocument(file: string, shown = file): object {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${shown}: cannot read the file`, { cause: e });
  }
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error(`${shown}: not valid YAML or JSON: ${(e as Error).message.split('\n')[0]}`, { cause: e });
  }
  if (!doc || typeof doc !== 'object') throw new Error(`${shown}: not an OpenAPI document (not an object)`);
  return doc;
}

/** Marks what was read from another file: its `#/...` references point into that file, not this document. */
const FROM_FILE = Symbol('openapi-drift.fromFile');

/** Puts the path items and parameters that a split document keeps in other files in place. */
function inlineSplit(doc: OpenApiDocument, main: string): void {
  const files = new Map<string, object>([[path.resolve(main), doc]]);
  const shown = (f: string): string => (path.isAbsolute(f) ? path.relative(process.cwd(), f).replace(/\\/g, '/') || f : f);
  const read = (abs: string): object => {
    let d = files.get(abs);
    if (!d) files.set(abs, (d = readDocument(abs, shown(abs))));
    return d;
  };

  /** The object a `$ref` to another file leads to, with the file it is in; anything else as it is. */
  const follow = (node: unknown, file: string, seen = new Set<string>()): { value: unknown; file: string } => {
    if (!node || typeof node !== 'object' || typeof (node as { $ref?: unknown }).$ref !== 'string') return { value: node, file };
    const ref = (node as { $ref: string }).$ref;
    const hash = ref.indexOf('#');
    const target = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    // the main document's own references are followed where they are used
    if (!target && path.resolve(file) === path.resolve(main)) return { value: node, file };
    let abs: string | undefined;
    try {
      abs = target ? refFile(target, path.dirname(file)) : path.resolve(file);
    } catch (e) {
      throw new Error(`${shown(file)}: $ref '${ref}': ${(e as Error).message}`, { cause: e });
    }
    if (abs === undefined) return { value: node, file }; // a URL is not fetched
    const key = `${abs}#${pointer}`;
    if (seen.has(key)) throw new Error(`${shown(file)}: $ref '${ref}' refers back to itself`);
    seen.add(key);
    let root: object;
    try {
      root = read(abs);
    } catch (e) {
      throw new Error(`${shown(file)}: $ref '${ref}': ${(e as Error).message}`, { cause: e });
    }
    const value = pointer
      .split('/')
      .slice(1)
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
        root
      );
    if (value === undefined) throw new Error(`${shown(file)}: $ref '${ref}' points to nothing`);
    return follow(value, abs, seen);
  };

  const fromFile = <T extends object>(value: T, file: string): T => {
    if (path.resolve(file) === path.resolve(main)) return value;
    const copy = { ...value };
    Object.defineProperty(copy, FROM_FILE, { value: file });
    return copy;
  };
  const params = (list: unknown, file: string): unknown =>
    Array.isArray(list)
      ? list.map((p) => {
          const found = follow(p, file);
          return found.value && typeof found.value === 'object' ? fromFile(found.value, found.file) : found.value;
        })
      : list;

  for (const [p, given] of Object.entries(doc.paths ?? {})) {
    const { value, file } = follow(given, main);
    if (!value || typeof value !== 'object') continue;
    const item = fromFile(value as PathItem, file);
    if (item.parameters) item.parameters = params(item.parameters, file) as Parameter[];
    for (const m of METHODS) {
      const op = item[m];
      if (op && typeof op === 'object' && op.parameters)
        item[m] = fromFile({ ...op, parameters: params(op.parameters, file) as Parameter[] }, file);
    }
    if (item !== given) (doc.paths as Record<string, PathItem>)[p] = item;
  }
  // OpenAPI 3 keeps the shared parameters under `components`, Swagger 2.0 at the top of the document
  for (const shared of [doc.components?.parameters, doc.parameters]) {
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) continue;
    for (const [name, given] of Object.entries(shared)) shared[name] = (params([given], main) as Parameter[])[0];
  }
}

/**
 * The file the part of a `$ref` before `#` names, resolved against `dir`: a relative or absolute path (on Windows
 * also `C:\specs\x.yaml` and `C:/specs/x.yaml`, a drive letter not being a URL scheme) or a `file:` URL
 * (`file:///C:/specs/x.yaml`, `file:///srv/specs/x.yaml`). Undefined for any other URL, which is not fetched.
 * Throws when a `file:` URL is not a path on this system. `windows` picks the rules of the system, for tests.
 */
export function refFile(target: string, dir: string, windows = process.platform === 'win32'): string | undefined {
  const p = windows ? path.win32 : path.posix;
  if (/^file:/i.test(target)) return p.resolve(fileURLToPath(target, { windows }));
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return undefined;
  return p.resolve(dir, target);
}

/**
 * What a document declares itself to be: `3.x` for `openapi: 3.0.3`, `2.0` for `swagger: "2.0"` (also written
 * without the quotes, which YAML reads as the number 2), undefined for anything else.
 */
export function specVersion(doc: unknown): '3.x' | '2.0' | undefined {
  if (!doc || typeof doc !== 'object') return undefined;
  const d = doc as OpenApiDocument;
  if (/^3\./.test(versionText(d.openapi))) return '3.x';
  if (d.openapi === undefined && /^2(\.0)?$/.test(versionText(d.swagger))) return '2.0';
  return undefined;
}

const versionText = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Problems of an OpenAPI 3.x or Swagger 2.0 document, as a person would list them; empty when it is sound. */
export function lintOpenApi(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  const d = doc as OpenApiDocument;
  if (!specVersion(d)) {
    const found =
      d.openapi !== undefined ? `openapi: ${versionText(d.openapi)}` : d.swagger !== undefined ? `swagger: ${versionText(d.swagger)}` : '';
    problems.push(`not a supported version${found ? ` (${found})` : ''}: 'openapi' must be 3.x, or 'swagger' must be "2.0"`);
  }
  if (!d.paths || typeof d.paths !== 'object') {
    problems.push("'paths' must be a map");
    return problems;
  }
  for (const [p, item] of Object.entries(d.paths)) {
    if (p.startsWith('x-')) continue; // an extension, not a path
    if (!p.startsWith('/')) problems.push(`path '${p}' must start with /`);
    if (!item || typeof item !== 'object') {
      problems.push(`path '${p}' has no operations`);
      continue;
    }
    const ops = METHODS.filter((m) => item[m]);
    if (!ops.length) problems.push(`path '${p}' has no operation (get, post, put, ...)`);
    const templated = pathParams(p);
    for (const m of ops) {
      const op: unknown = item[m];
      const where = `${m.toUpperCase()} ${p}`;
      if (!op || typeof op !== 'object') {
        problems.push(`${where} is not an object`);
        continue;
      }
      const o = op as OperationObject;
      const responses = o.responses;
      if (!responses || typeof responses !== 'object' || !Object.keys(responses).length) problems.push(`${where} has no responses`);
      // a parameter kept under the shared ones (`$ref: '#/parameters/id'`) is declared as well
      const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(o.parameters) ? o.parameters : [])]
        .map((x) => parameter(d, x))
        .filter((x): x is Parameter => !!x && typeof x === 'object');
      for (const name of templated) {
        const declared = params.find((x) => x.name === name && x.in === 'path');
        if (!declared)
          problems.push(`${where}: path parameter {${name}} is not declared (parameters: - {name: ${name}, in: path, required: true})`);
        else if (declared.required !== true) problems.push(`${where}: path parameter {${name}} must be required: true`);
      }
      if (o.requestBody && !o.requestBody.$ref && !(o.requestBody.content && typeof o.requestBody.content === 'object'))
        problems.push(`${where}: requestBody needs a content map (application/json: {schema: ...})`);
    }
  }
  for (const ref of refs(doc)) {
    if (!ref.startsWith('#/')) continue; // a reference to another file is not checked here
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
        doc
      );
    if (target === undefined) problems.push(`$ref '${ref}' points to nothing in the document`);
  }
  return problems;
}

function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === 'object') {
    if (FROM_FILE in node) return out; // its references point into the file it came from
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

/**
 * The prefix a document puts in front of its paths, '' when there is none or it is `/`. For Swagger 2.0 it is
 * `basePath` (`/api/` -> `/api`); `host` and `schemes` say where the API is, not what its routes are. For
 * OpenAPI 3 it is the path part of the first server URL (`https://api.example.com/v1` -> `/v1`, `/api` -> `/api`).
 * The host is dropped also when the scheme is a variable (`{scheme}://host/v1`) or left out (`//host/v1`).
 * Server variables are replaced by their `default` (`/{version}` with `version: {default: v1}` -> `/v1`); one
 * with no default is left as written (`/{version}`), so it matches only a route with a path parameter in that
 * place, and `serverNotes` names it.
 */
export function basePath(doc: OpenApiDocument): string {
  const swagger2 = specVersion(doc) === '2.0';
  const raw = swagger2 ? doc.basePath : doc.servers?.[0]?.url;
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let p = swagger2 ? raw.trim() : withDefaults(raw.trim(), doc.servers?.[0]?.variables);
  // `/{basePath}/api` is a path whatever the default is, also an empty one (`//api` is not a host)
  if (!swagger2 && !/^\/(?!\/)/.test(raw.trim()) && /^(?:[a-z][a-z0-9+.-]*:|\{[^/{}]*\}:)?\/\//i.test(p)) {
    const i = p.indexOf('/', p.indexOf('//') + 2);
    p = i < 0 ? '' : p.slice(i);
  }
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (p === '' || p === '/') return '';
  return p.startsWith('/') ? p : `/${p}`;
}

/** A server URL with each `{name}` replaced by the `default` of its variable; one with no default is left as written. */
function withDefaults(url: string, variables: unknown): string {
  const vars = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  return url.replace(/\{([^{}]*)\}/g, (whole, name: string) => {
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
    const d = v && typeof v === 'object' ? (v as { default?: unknown }).default : undefined;
    return typeof d === 'string' || typeof d === 'number' ? String(d) : whole;
  });
}

/**
 * What a person should know about the base path of a document: the server variables left in it because they have
 * no `default` (which OpenAPI requires), each a line. Empty when there is nothing to say.
 */
export function serverNotes(doc: OpenApiDocument): string[] {
  if (specVersion(doc) === '2.0') return [];
  const server = doc.servers?.[0];
  const url = server?.url;
  if (typeof url !== 'string') return [];
  const vars = server?.variables && typeof server.variables === 'object' ? (server.variables as Record<string, unknown>) : {};
  const base = basePath(doc);
  return [...new Set(pathParams(base))].map(
    (name) =>
      `servers[0].url '${url}': variable {${name}} ${Object.hasOwn(vars, name) ? 'has no default' : 'is not declared under servers[0].variables'}; ` +
      `the base path keeps it as written (${base}), so it matches only a route with a path parameter there`
  );
}

/**
 * The line of each operation's method key (`get:`) in the text of a document, YAML or JSON, keyed
 * `get /users/{id}` with the path as written under `paths`. Empty when the text cannot be read that way.
 */
export function operationLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  const counter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: counter });
  if (doc.errors.length) return lines;
  const paths = doc.get('paths', true);
  if (!isMap(paths)) return lines;
  for (const pair of paths.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isMap(pair.value)) continue;
    for (const op of pair.value.items) {
      const key = op.key;
      if (!isScalar(key) || typeof key.value !== 'string' || !(METHODS as readonly string[]).includes(key.value) || !key.range) continue;
      lines.set(`${key.value} ${pair.key.value}`, counter.linePos(key.range[0]).line);
    }
  }
  return lines;
}

/** The operations of a document, path as written (without the base path). */
export function operations(doc: OpenApiDocument): Operation[] {
  const out: Operation[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== 'object' || p.startsWith('x-')) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const entry: Operation = {
        method: m,
        path: p,
        params: pathParams(p),
        query: queryParams(doc, item, op),
        responses: op.responses && typeof op.responses === 'object' ? Object.keys(op.responses) : [],
      };
      if (typeof op.operationId === 'string') entry.operationId = op.operationId;
      out.push(entry);
    }
  }
  return out;
}

/** The names of an operation's `in: query` parameters: the path's, then its own; references are followed. */
function queryParams(doc: OpenApiDocument, item: PathItem, op: OperationObject): string[] {
  const names: string[] = [];
  const all = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
  for (const given of all) {
    const p = parameter(doc, given);
    if (p?.in === 'query' && typeof p.name === 'string' && !names.includes(p.name)) names.push(p.name);
  }
  return names;
}

/** A parameter, or the shared one it refers to: `#/components/parameters/x` (OpenAPI 3), `#/parameters/x` (Swagger 2.0). */
function parameter(doc: OpenApiDocument, p: Parameter | undefined, depth = 0): Parameter | undefined {
  if (!p || typeof p !== 'object' || typeof p.$ref !== 'string') return p;
  const m = /^#\/(components\/)?parameters\/(.+)$/.exec(p.$ref);
  if (!m || depth > 8) return undefined;
  const name = (m[2] as string).replace(/~1/g, '/').replace(/~0/g, '~');
  const shared = m[1] ? doc.components?.parameters : doc.parameters;
  return parameter(doc, shared && typeof shared === 'object' ? shared[name] : undefined, depth + 1);
}

/** The names of the templated parameters of a path, in order: `/users/{id}/posts/{postId}` -> ['id', 'postId']. */
export function pathParams(p: string): string[] {
  return [...p.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1] as string);
}

/** `/Users/{id}/` -> `/users/{}`: parameter names and case do not make two paths different. */
export function normalizePath(p: string): string {
  const s = p
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return s === '' ? '/' : s;
}

/** Joins URL segments with single slashes: joinPath('/api', 'users/', '/:id') -> '/api/users/:id'. */
export function joinPath(...parts: (string | undefined | null)[]): string {
  const s = parts
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim())
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  if (s === '') return '/';
  return s.startsWith('/') ? s : `/${s}`;
}
