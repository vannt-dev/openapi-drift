import { basePath, operations, normalizePath, pathParams, joinPath } from './openapi.ts';
import type { DriftResult, FailOn, MissingInCode, MissingInSpec, OpenApiDocument, ParamMismatch, Route } from './types.ts';

/**
 * The drift between an OpenAPI document and the routes found in the code:
 *
 *   missingInSpec   routes the code serves that the document does not describe
 *   missingInCode   operations the document describes that no route serves
 *   paramMismatch   same operation, but the path parameters are named differently
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

  // a stable order for reports and diffs: by path, then method
  const byPath = (a: { path: string; method: string }, b: { path: string; method: string }): number =>
    normalizePath(a.path).localeCompare(normalizePath(b.path)) || a.method.localeCompare(b.method);
  missingInSpec.sort(byPath);
  missingInCode.sort(byPath);
  paramMismatch.sort(byPath);
  return { base, prefix, counts: { spec: specOps.length, code: codeByKey.size }, missingInSpec, missingInCode, paramMismatch };
}

/** 'the path exists with GET, POST' when the other side knows the same path with other methods. */
function otherMethods(map: Map<string, unknown>, key: string): string {
  const p = key.slice(key.indexOf(' ') + 1);
  const methods = [...map.keys()].filter((k) => k.slice(k.indexOf(' ') + 1) === p).map((k) => k.slice(0, k.indexOf(' ')).toUpperCase());
  return methods.length ? `the path exists with ${methods.join(', ')}` : '';
}

/** Whether a result fails the run under a `--fail-on` policy. */
export function hasDrift(result: DriftResult, failOn: FailOn = 'any'): boolean {
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
