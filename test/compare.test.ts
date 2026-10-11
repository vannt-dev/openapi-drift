import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, hasDrift } from '../src/compare.ts';
import { loadSpec } from '../src/openapi.ts';
import { extractNestRoutes } from '../src/extract/nestjs.ts';
import { extractExpressRoutes } from '../src/extract/express.ts';
import { markdownReport, textReport, jsonReport } from '../src/report.ts';
import { fixture, ROOT } from './helpers.ts';

const key = (r: { method: string; path: string }): string => `${r.method.toUpperCase()} ${r.path}`;

test('NestJS fixture: the seven deliberate drifts, both directions, and the parameter-name note', () => {
  const doc = loadSpec(fixture('nestjs', 'openapi.yaml'));
  const result = compare(doc, extractNestRoutes(fixture('nestjs', 'src'), { prefix: '/api' }), { prefix: '/api' });
  assert.equal(result.base, '/api');
  assert.deepEqual(result.counts, { spec: 9, code: 12 });
  assert.deepEqual(result.missingInSpec.map(key).sort(), [
    'DELETE /api/users/{id}',
    'GET /api/health',
    'GET /api/legacy/ping',
    'GET /api/v0/ping',
    'HEAD /api/health',
  ]);
  assert.equal(result.missingInSpec.find((r) => r.method === 'delete')?.hint, 'the path exists with GET, PATCH');
  assert.deepEqual(result.missingInCode.map(key), ['POST /api/orders', 'GET /api/users/{id}/avatar'], 'sorted by path, then method');
  assert.equal(result.missingInCode[0]?.hint, 'the path exists with GET');
  assert.equal(result.missingInCode[0]?.operationId, 'createOrder');
  assert.deepEqual(
    result.paramMismatch.map((r) => [key(r), r.specParams, r.codeParams]),
    [['GET /api/orders/{id}/items', ['id'], ['orderId']]]
  );
  assert.equal(hasDrift(result), true);
  assert.equal(hasDrift(result, 'none'), false);
  assert.equal(hasDrift(result, 'spec'), true);
  assert.equal(hasDrift(result, 'code'), true);
});

test('Express fixture: mounted routers under their prefixes, nothing invented', () => {
  const doc = loadSpec(fixture('express', 'openapi.json'));
  const result = compare(doc, extractExpressRoutes(fixture('express', 'src')));
  assert.equal(result.base, '');
  assert.deepEqual(
    result.missingInSpec.map(key).sort(),
    [
      'DELETE /api/echo',
      'GET /api/echo',
      'HEAD /api/echo',
      'OPTIONS /api/echo',
      'PATCH /api/echo',
      'POST /admin/reindex',
      'POST /api/echo',
      'PUT /api/echo',
    ].sort()
  );
  assert.deepEqual(result.missingInCode.map(key), ['GET /api/orders/{orderId}']);
  assert.deepEqual(result.paramMismatch, []);
});

test('an agreeing pair has no drift and the reports say so', () => {
  const doc = loadSpec(fixture('express', 'openapi.json'));
  const routes = extractExpressRoutes(fixture('express', 'src')).filter((r) => !r.path.includes('echo') && r.path !== '/admin/reindex');
  routes.push({ method: 'get', path: '/api/orders/{id}', file: 'x.js', line: 1 });
  const result = compare(doc, routes);
  assert.equal(hasDrift(result), false);
  const ctx = { spec: 'openapi.json', source: 'src', root: ROOT };
  assert.match(textReport(result, ctx), /No drift: the document and the code agree\./);
  assert.match(markdownReport(result, ctx), /^## OpenAPI drift: none/);
  assert.equal(result.paramMismatch.length, 1, 'orderId vs id is noted, not a drift');
});

test('reports: text, markdown tables and JSON with relative paths', () => {
  const doc = loadSpec(fixture('nestjs', 'openapi.yaml'));
  const result = compare(doc, extractNestRoutes(fixture('nestjs', 'src'), { prefix: '/api' }), { prefix: '/api' });
  const ctx = { spec: 'openapi.yaml', source: 'src', root: fixture('nestjs') };
  const text = textReport(result, ctx);
  assert.match(text, /openapi\.yaml: 9 operations under \/api\nsrc: 12 routes under \/api\n/);
  assert.match(
    text,
    /In the code, not in the document \(5\):\n {2}GET {5}\/api\/health \(src\/health\.controller\.ts:5\)\n(?:.*\n)*? {2}DELETE {2}\/api\/users\/\{id\} \(src\/users\/users\.controller\.ts:27\) — the path exists with GET, PATCH/
  );
  assert.match(
    text,
    /In the document, not in the code \(2\):\n {2}POST {4}\/api\/orders \(createOrder\) — the path exists with GET\n {2}GET {5}\/api\/users\/\{id\}\/avatar \(getAvatar\)\n/
  );
  assert.match(
    text,
    /Path parameters named differently \(1, not a failure\):\n {2}GET {5}\/api\/orders\/\{id\}\/items: document \{id\}, code \{orderId\}/
  );
  assert.match(text, /\n7 drifts\.\n$/);
  const md = markdownReport(result, ctx);
  assert.match(md, /^## OpenAPI drift: 7 drifts\n/);
  assert.match(
    md,
    /### In the code, not in the document \(5\)\n\n\| Route \| Where \| Note \|\n\| --- \| --- \| --- \|\n\| `GET \/api\/health` \| `src\/health\.controller\.ts:5` \| {2}\|\n(?:.*\n)*?\| `DELETE \/api\/users\/\{id\}` \| `src\/users\/users\.controller\.ts:27` \| the path exists with GET, PATCH \|/
  );
  const json = JSON.parse(jsonReport(result, ctx)) as { counts: unknown; missingInSpec: { file: string }[] };
  assert.deepEqual(json.counts, { spec: 9, code: 12 });
  assert.equal(json.missingInSpec[0]?.file, 'src/health.controller.ts');
});
