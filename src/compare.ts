import { basePath, operations, normalizePath, pathParams, joinPath } from './openapi.ts';
import type {
  DriftResult,
  FailOn,
  MissingInCode,
  MissingInSpec,
  OpenApiDocument,
  ParamMismatch,
  QueryMismatch,
  Route,
  StatusMismatch,
} from './types.ts';

/**
 * The drift between an OpenAPI document and the routes found in the code:
 *
 *   missingInSpec   routes the code serves that the document does not describe
 *   missingInCode   operations the document describes that no route serves
 *   paramMismatch   same operation, but the path parameters are named differently
 *   queryMismatch   same operation, but the query parameters the handler reads are not the ones described
 *   statusMismatch  same operation, but the code answers with a status the document does not describe
 *
 * The last two compare only what the source shows of a handler; where it shows nothing, nothing is said.
 *
 * The document's paths are read under its first server's base path (`servers[0].url`), the code's routes under
 * `prefix`; paths are compared with parameter names and case ignored.
 */
export function compare(doc: OpenApiDocument, routes: Route[], { prefix = '' }: { prefix?: string } = {}): DriftResult {
  const base = basePath(doc);
  const specOps = operations(doc).map((op) => {
    const full = joinPath(base, op.path);
    return { ...op, full, key: `${op.method} ${normalizePath(full)}` };
  });
  const codeRoutes = routes.map((r) => ({ ...r, key: `${r.method} ${normalizePath(r.path)}` }));

  const specByKey = new Map(specOps.map((op) => [op.key, op]));
  const codeByKey = new Map<string, (typeof codeRoutes)[number]>();
  for (const r of codeRoutes) if (!codeByKey.has(r.key)) codeByKey.set(r.key, r);

  const missingInSpec: MissingInSpec[] = [];
  const seen = new Set<string>();
  for (const r of codeRoutes) {
    if (specByKey.has(r.key) || seen.has(r.key)) continue;
    seen.add(r.key);
    missingInSpec.push({ method: r.method, path: r.path, file: r.file, line: r.line, hint: otherMethods(specByKey, r.key) });
  }

  const missingInCode: MissingInCode[] = [];
  for (const op of specOps) {
    if (codeByKey.has(op.key)) continue;
    const entry: MissingInCode = { method: op.method, path: op.full, specPath: op.path, hint: otherMethods(codeByKey, op.key) };
    if (op.operationId !== undefined) entry.operationId = op.operationId;
    missingInCode.push(entry);
  }

  const paramMismatch: ParamMismatch[] = [];
  for (const op of specOps) {
    const r = codeByKey.get(op.key);
    if (!r) continue;
    const a = pathParams(op.full);
    const b = pathParams(r.path);
    if (a.length === b.length && a.some((n, i) => n !== b[i])) {
      paramMismatch.push({ method: op.method, path: op.full, specParams: a, codeParams: b, file: r.file, line: r.line });
    }
  }

  const queryMismatch: QueryMismatch[] = [];
  const statusMismatch: StatusMismatch[] = [];
  for (const op of specOps) {
    const r = codeByKey.get(op.key);
    if (!r) continue;
    const at = { method: op.method, path: op.full, file: r.file, line: r.line };
    if (r.query) {
      const read = r.query.names;
      const codeOnly = read.filter((n) => !op.query.includes(n));
      const specOnly = r.query.complete ? op.query.filter((n) => !read.includes(n)) : [];
      if (codeOnly.length || specOnly.length)
        queryMismatch.push({ method: at.method, path: at.path, codeOnly, specOnly, file: at.file, line: at.line });
    }
    if (r.statuses?.length && op.responses.length) {
      const codeStatuses = r.statuses.filter((s) => !describes(op.responses, s));
      if (codeStatuses.length) {
        statusMismatch.push({ method: at.method, path: at.path, codeStatuses, specResponses: op.responses, file: at.file, line: at.line });
      }
    }
  }

  // a stable order for reports and diffs: by path, then method
  const byPath = (a: { path: string; method: string }, b: { path: string; method: string }): number =>
    normalizePath(a.path).localeCompare(normalizePath(b.path)) || a.method.localeCompare(b.method);
  missingInSpec.sort(byPath);
  missingInCode.sort(byPath);
  paramMismatch.sort(byPath);
  queryMismatch.sort(byPath);
  statusMismatch.sort(byPath);
  return {
    base,
    prefix,
    counts: { spec: specOps.length, code: codeByKey.size },
    missingInSpec,
    missingInCode,
    paramMismatch,
    queryMismatch,
    statusMismatch,
  };
}

/** Whether a document's responses describe a status: by its number, by its range (`2XX`) or by `default`. */
function describes(responses: string[], status: number): boolean {
  const range = `${Math.floor(status / 100)}xx`;
  return responses.some((key) => {
    const k = key.toLowerCase();
    return k === String(status) || k === range || k === 'default';
  });
}

/** 'the path exists with GET, POST' when the other side knows the same path with other methods. */
function otherMethods(map: Map<string, unknown>, key: string): string {
  const p = key.slice(key.indexOf(' ') + 1);
  const methods = [...map.keys()].filter((k) => k.slice(k.indexOf(' ') + 1) === p).map((k) => k.slice(0, k.indexOf(' ')).toUpperCase());
  return methods.length ? `the path exists with ${methods.join(', ')}` : '';
}

/**
 * Whether a result fails the run under a `--fail-on` policy. Under `strict`, differences in query parameters
 * and status codes fail it too, whatever the policy but `none`.
 */
export function hasDrift(result: DriftResult, failOn: FailOn = 'any', { strict = false }: { strict?: boolean } = {}): boolean {
  if (failOn !== 'none' && strict && (result.queryMismatch.length > 0 || result.statusMismatch.length > 0)) return true;
  switch (failOn) {
    case 'none':
      return false;
    case 'spec':
      return result.missingInSpec.length > 0;
    case 'code':
      return result.missingInCode.length > 0;
    default:
      return result.missingInSpec.length > 0 || result.missingInCode.length > 0;
  }
}
