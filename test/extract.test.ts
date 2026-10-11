import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNestRoutes } from '../src/extract/nestjs.ts';
import { extractExpressRoutes } from '../src/extract/express.ts';
import { detectFramework, extractRoutes } from '../src/extract/index.ts';
import { stripComments, toTemplate } from '../src/files.ts';
import { fixture } from './helpers.ts';

const keys = (routes: { method: string; path: string }[]): string[] => routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();

test('NestJS: controller prefixes, method decorators, :id templates, comments and spec files ignored', () => {
  const routes = extractNestRoutes(fixture('nestjs', 'src'));
  assert.deepEqual(keys(routes), [
    'DELETE /users/{id}',
    'GET /health',
    'GET /legacy/ping',
    'GET /orders',
    'GET /orders/{orderId}/items',
    'GET /users',
    'GET /users/{id}',
    'GET /v0/ping',
    'HEAD /health',
    'PATCH /users/{id}',
    'POST /users',
    'PUT /orders/{orderId}',
  ]);
  const remove = routes.find((r) => r.method === 'delete');
  assert.ok(remove?.file.endsWith('users.controller.ts'));
  assert.equal(remove?.line, 27);
  // the global prefix is given, not read from the code
  assert.ok(keys(extractNestRoutes(fixture('nestjs', 'src'), { prefix: '/api' })).includes('GET /api/users'));
});

test('Express: app and router verbs, mounts in the same file and across imports, route chains, all()', () => {
  const routes = extractExpressRoutes(fixture('express', 'src'));
  assert.deepEqual(keys(routes), [
    'DELETE /api/echo',
    'DELETE /api/users/{id}',
    'GET /admin/stats',
    'GET /api/echo',
    'GET /api/items',
    'GET /api/orders',
    'GET /api/users',
    'GET /api/users/{id}',
    'GET /health',
    'HEAD /api/echo',
    'OPTIONS /api/echo',
    'PATCH /api/echo',
    'POST /admin/reindex',
    'POST /api/echo',
    'POST /api/items',
    'POST /api/users',
    'PUT /api/echo',
    'PUT /api/orders/{orderId}',
  ]);
  const items = routes.filter((r) => r.path === '/api/items');
  assert.equal(items[0]?.line, items[1]?.line, 'a route chain reports the line of .route()');
});

test('detectFramework and extractRoutes', () => {
  assert.equal(detectFramework(fixture('nestjs', 'src')), 'nestjs');
  assert.equal(detectFramework(fixture('express', 'src')), 'express');
  assert.equal(extractRoutes(fixture('express', 'src')).framework, 'express');
  assert.equal(extractRoutes(fixture('nestjs', 'src'), { framework: 'nestjs' }).routes.length, 12);
  assert.throws(() => extractRoutes(fixture('nestjs', 'src'), { framework: 'koa' as never }), /unknown framework 'koa'/);
});

test('stripComments keeps strings and line numbers; toTemplate converts Express parameters', () => {
  const src = "a // x\n/* b\nc */ '//not a comment' `/*nor*/`";
  const out = stripComments(src);
  assert.equal(out.split('\n').length, 3);
  assert.ok(out.includes("'//not a comment'") && out.includes('`/*nor*/`') && !out.includes('// x') && !out.includes('b'));
  assert.equal(toTemplate('/users/:id(\\d+)/posts/:postId?/*'), '/users/{id}/posts/{postId}/{wildcard}');
});
