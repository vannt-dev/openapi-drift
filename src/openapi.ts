import fs from 'node:fs';
import YAML, { LineCounter, isMap, isScalar } from 'yaml';
import { METHODS, type OpenApiDocument, type Operation, type OperationObject, type Parameter, type PathItem } from './types.ts';

/** Reads an OpenAPI document, YAML or JSON. Throws with the file name when it cannot be read. */
export function loadSpec(file: string): OpenApiDocument {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${file}: cannot read the file`, { cause: e });
  }
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid YAML or JSON: ${(e as Error).message.split('\n')[0]}`, { cause: e });
  }
  if (!doc || typeof doc !== 'object') throw new Error(`${file}: not an OpenAPI document (not an object)`);
  return doc as OpenApiDocument;
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
      if (o.requestBody && !(o.requestBody.content && typeof o.requestBody.content === 'object'))
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
