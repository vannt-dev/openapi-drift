import fs from 'node:fs';
import path from 'node:path';
import YAML, { LineCounter, isMap, isScalar } from 'yaml';
import { METHODS, type OpenApiDocument, type Operation, type OperationObject, type Parameter, type PathItem } from './types.ts';

/**
 * Reads an OpenAPI document, YAML or JSON. A document split into files (`/users: {$ref: ./paths/users.yaml}`) is
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
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { value: node, file }; // a URL is not fetched
    const hash = ref.indexOf('#');
    const target = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? '' : ref.slice(hash + 1);
    // the main document's own references are followed where they are used
    if (!target && path.resolve(file) === path.resolve(main)) return { value: node, file };
    const abs = target ? path.resolve(path.dirname(file), target) : path.resolve(file);
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
  const shared = doc.components?.parameters;
  if (shared) for (const [name, given] of Object.entries(shared)) shared[name] = (params([given], main) as Parameter[])[0];
}

/** Problems of an OpenAPI 3 document, as a person would list them; empty when it is sound. */
export function lintOpenApi(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object') return ['not an object'];
  const d = doc as OpenApiDocument;
  const declared = typeof d.openapi === 'string' ? d.openapi : typeof d.openapi === 'number' ? String(d.openapi) : '';
  if (!/^3\./.test(declared)) problems.push("'openapi' must be a 3.x version");
  if (!d.paths || typeof d.paths !== 'object') {
    problems.push("'paths' must be a map");
    return problems;
  }
  for (const [p, item] of Object.entries(d.paths)) {
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
      const params = [...(item.parameters ?? []), ...(o.parameters ?? [])].filter((x): x is Parameter => !!x && typeof x === 'object');
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
 * The path part of the first server URL (`https://api.example.com/v1` -> `/v1`, `/api` -> `/api`), '' when there
 * is none or it is `/`. Server variables (`{basePath}`) are left as written.
 */
export function basePath(doc: OpenApiDocument): string {
  const url = doc.servers?.[0]?.url;
  if (typeof url !== 'string' || !url.trim()) return '';
  let p = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    const i = p.indexOf('/', p.indexOf('//') + 2);
    p = i < 0 ? '' : p.slice(i);
  }
  p = p.replace(/\/+$/, '');
  if (p === '' || p === '/') return '';
  return p.startsWith('/') ? p : `/${p}`;
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
    if (!item || typeof item !== 'object') continue;
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

/** A parameter, or the one of `components.parameters` it refers to. */
function parameter(doc: OpenApiDocument, p: Parameter | undefined, depth = 0): Parameter | undefined {
  if (!p || typeof p !== 'object' || typeof p.$ref !== 'string') return p;
  const m = /^#\/components\/parameters\/(.+)$/.exec(p.$ref);
  if (!m || depth > 8) return undefined;
  const name = (m[1] as string).replace(/~1/g, '/').replace(/~0/g, '~');
  return parameter(doc, doc.components?.parameters?.[name], depth + 1);
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
