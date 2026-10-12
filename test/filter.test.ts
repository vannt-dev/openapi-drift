import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, hasDrift } from '../src/compare.ts';
import { loadSpec } from '../src/openapi.ts';
import { extractNestRoutes } from '../src/extract/nestjs.ts';
import { applyBaseline, applyIgnore, baselineOf, parseIgnore } from '../src/filter.ts';
import { jsonReport, markdownReport, textReport } from '../src/report.ts';
import type { DriftResult, Route } from '../src/types.ts';
import { fixture, ROOT } from './helpers.ts';

const key = (r: { method: string; path: string }): string => `${r.method.toUpperCase()} ${r.path}`;
const routesOf = (): Route[] => extractNestRoutes(fixture('nestjs', 'src'), { prefix: '/api' });
const nest = (routes: Route[] = routesOf()): DriftResult =>
  compare(loadSpec(fixture('nestjs', 'openapi.yaml')), routes, { prefix: '/api' });
const ctx = { spec: 'openapi.yaml', source: 'src', root: ROOT };

test('ignore: a path leaves out every method, a method narrows it, in both directions', () => {
  const result = applyIgnore(nest(), ['/api/health', 'GET /api/legacy/**', '/api/v0/*', 'post /api/orders']);
  assert.deepEqual(result.missingInSpec.map(key), ['DELETE /api/users/{id}']);
  assert.deepEqual(result.missingInCode.map(key), ['GET /api/users/{id}/avatar']);
  assert.deepEqual(result.ignored, { missingInSpec: 4, missingInCode: 1 });
  assert.equal(hasDrift(result), true);

  const headOnly = applyIgnore(nest(), ['HEAD /api/health']);
  assert.ok(headOnly.missingInSpec.some((r) => key(r) === 'GET /api/health'));
  assert.ok(!headOnly.missingInSpec.some((r) => key(r) === 'HEAD /api/health'));

  const all = applyIgnore(nest(), ['/**']);
  assert.equal(hasDrift(all), false);
  assert.deepEqual(all.paramMismatch, [], 'a note on an ignored path is left out too');
  assert.deepEqual(all.ignored, { missingInSpec: 5, missingInCode: 2 });
});

test('ignore: * is one segment, ** any number, parameter names and case do not matter', () => {
  const matches = (pattern: string, method: string, path: string): boolean => parseIgnore(pattern)(method, path);
  assert.equal(matches('/api/*', 'get', '/api/health'), true);
  assert.equal(matches('/api/*', 'get', '/api/users/{id}'), false);
  assert.equal(matches('/api/**', 'get', '/api/users/{id}'), true);
  assert.equal(matches('/api/**', 'get', '/api'), true, '** also stands for nothing');
  assert.equal(matches('/api/users/{userId}', 'delete', '/api/users/{id}'), true);
  assert.equal(matches('/api/users/*', 'delete', '/api/users/{id}'), true);
  assert.equal(matches('/API/Health/', 'get', '/api/health'), true);
  assert.equal(matches('/api/v*/ping', 'get', '/api/v0/ping'), true);
  assert.equal(matches('/api/health', 'get', '/api/healthz'), false);
  assert.equal(matches('* /api/health', 'head', '/api/health'), true);
  assert.equal(matches('GET /api/health', 'head', '/api/health'), false);

  assert.throws(() => parseIgnore('health'), /ignore 'health': a path starts with \//);
  assert.throws(() => parseIgnore('FETCH /health'), /ignore 'FETCH \/health': a path starts with \//);
  assert.throws(() => parseIgnore('  '), /an empty pattern/);
});

test('baseline: accepted drift is reported and does not fail; new drift does; resolved entries are named', () => {
  const baseline = baselineOf(nest());
  assert.deepEqual(baseline, {
    version: 1,
    missingInSpec: ['GET /api/health', 'HEAD /api/health', 'GET /api/legacy/ping', 'DELETE /api/users/{id}', 'GET /api/v0/ping'],
    missingInCode: ['POST /api/orders', 'GET /api/users/{id}/avatar'],
  });

  const accepted = applyBaseline(nest(), baseline);
  assert.equal(hasDrift(accepted), false);
  assert.deepEqual(accepted.missingInSpec, []);
  assert.equal(accepted.accepted?.missingInSpec.length, 5);
  assert.equal(accepted.accepted?.missingInCode.length, 2);
  assert.deepEqual(accepted.resolved, []);

  // a route nobody accepted, and a baseline that still lists drift that is gone
  const routes = routesOf();
  routes.push({ method: 'get', path: '/api/reports/{reportId}', file: routes[0]!.file, line: 1 });
  const stale = { ...baseline, missingInSpec: [...baseline.missingInSpec, 'GET /api/gone'], missingInCode: ['POST /api/orders'] };
  const next = applyBaseline(nest(routes), stale);
  assert.deepEqual(next.missingInSpec.map(key), ['GET /api/reports/{reportId}']);
  assert.deepEqual(next.missingInCode.map(key), ['GET /api/users/{id}/avatar']);
  assert.deepEqual(next.resolved, ['GET /api/gone']);
  assert.equal(hasDrift(next), true);

  // an entry is the method and the path; the names of its parameters and its case do not matter
  const renamed = applyBaseline(nest(), { version: 1, missingInSpec: ['delete /API/users/{userId}'], missingInCode: [] });
  assert.ok(!renamed.missingInSpec.some((r) => key(r) === 'DELETE /api/users/{id}'));
});

test('reports: what was accepted, ignored and resolved is said, apart from the drift that fails', () => {
  const baseline = baselineOf(nest());
  baseline.missingInSpec = baseline.missingInSpec.filter((k) => k !== 'GET /api/v0/ping').concat('GET /api/gone');
  // the baseline first: an entry of it that is ignored is neither accepted nor resolved
  const result = applyIgnore(applyBaseline(nest(), baseline), ['/api/health']);

  const text = textReport(result, ctx);
  assert.match(text, /In the code, not in the document \(1\):\n {2}GET {5}\/api\/v0\/ping/);
  assert.match(
    text,
    /Accepted by the baseline \(4, not a failure\):\n {2}GET {5}\/api\/legacy\/ping \(.*\) — in the code, not in the document/
  );
  assert.match(text, / {2}POST {4}\/api\/orders \(createOrder\) — in the document, not in the code/);
  assert.match(text, /Left out by the ignore patterns: 2\./);
  assert.match(text, /No longer drifting, to take out of the baseline \(1\):\n {2}GET \/api\/gone/);
  assert.match(text, /\n1 drift, and 4 accepted by the baseline\.\n$/);

  const md = markdownReport(result, ctx);
  assert.match(md, /^## OpenAPI drift: 1 drift\n/);
  assert.match(md, /### Accepted by the baseline, not a failure \(4\)/);
  assert.match(md, /Left out by the ignore patterns: 2\./);
  assert.match(md, /### No longer drifting, to take out of the baseline \(1\)/);

  const json = JSON.parse(jsonReport(result, ctx)) as DriftResult;
  assert.equal(json.missingInSpec.length, 1);
  assert.deepEqual(json.ignored, { missingInSpec: 2, missingInCode: 0 });
  assert.equal(json.accepted?.missingInSpec.length, 2);
  assert.equal(json.accepted?.missingInCode.length, 2);
  assert.deepEqual(json.resolved, ['GET /api/gone']);

  // nothing changes for a run without them
  const plain = textReport(nest(), ctx);
  assert.doesNotMatch(plain, /baseline|ignore/);
  assert.match(plain, /\n7 drifts\.\n$/);
  assert.match(textReport(applyBaseline(nest(), baselineOf(nest())), ctx), /\nNo new drift: 7 accepted by the baseline\.\n$/);
});
