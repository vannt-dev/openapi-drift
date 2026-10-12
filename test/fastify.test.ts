import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractFastifyRoutes } from '../src/extract/fastify.ts';
import { detectFramework, extractRoutes } from '../src/extract/index.ts';
import type { Route } from '../src/types.ts';
import { cli, fixture, tempDir } from './helpers.ts';

const keys = (routes: { method: string; path: string }[]): string[] => routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
/** The routes that are written, without the HEAD that Fastify answers by itself. */
const written = (routes: Route[]): Route[] => routes.filter((r) => !r.implicit);
const byKey = (routes: Route[]): Record<string, Route> => Object.fromEntries(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r]));

function tree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('Fastify: verbs, route(), and plugins registered under a prefix, in the file and across files', () => {
  const all = extractFastifyRoutes(fixture('fastify', 'src'));
  const routes = all.filter((r) => !r.implicit);
  assert.deepEqual(keys(routes), [
    'DELETE /api/users/{id}',
    'GET /admin/stats',
    'GET /api/orders',
    'GET /api/orders/{orderId}/items',
    'GET /api/users',
    'GET /api/users/{id}',
    'GET /api/v2/reports/daily',
    'GET /files/{wildcard}',
    'GET /health',
    'HEAD /ping',
    'PATCH /api/users/{id}',
    'POST /admin/reindex',
    'POST /api/users',
    'PUT /api/orders/{orderId}',
  ]);
  const remove = routes.find((r) => r.method === 'delete');
  assert.ok(remove?.file.endsWith('users.js'));
  // a call that is not a route: no path in it
  assert.ok(!keys(routes).some((k) => k.includes('db.host') || k.includes('cache')));
  // Fastify answers HEAD wherever there is a GET: there, and not written
  const implicit = keys(all.filter((r) => r.implicit));
  assert.equal(implicit.length, 8);
  assert.ok(implicit.includes('HEAD /health') && implicit.includes('HEAD /api/users/{id}'));
  assert.ok(implicit.every((k) => k.startsWith('HEAD ')));
  // a prefix that is given goes in front of everything
  assert.ok(keys(extractFastifyRoutes(fixture('fastify', 'src'), { prefix: '/gw' })).includes('GET /gw/api/users'));
});

test('Fastify: what a handler written in place is seen to read and to answer with', () => {
  const routes = byKey(extractFastifyRoutes(fixture('fastify', 'src')));
  assert.deepEqual(routes['GET /api/users']?.query, { names: ['page', 'limit'], complete: false });
  assert.deepEqual(routes['POST /api/users']?.statuses, [201]);
  assert.deepEqual(routes['DELETE /api/users/{id}']?.statuses, [204]);
  // a handler that lives elsewhere says nothing
  assert.equal(routes['GET /api/orders']?.statuses, undefined);
});

test('Fastify: the forms of register and of route()', () => {
  const nested = tree({
    'app.js':
      "const fastify = require('fastify')();\nfastify.register(require('./v1'), { prefix: '/v1' });\nfastify.register(import('./plain.js'));\nfastify.listen({ port: 3000 });\n",
    'v1.js':
      "module.exports = async function (fastify) {\n  fastify.register(require('./pets'), { prefix: '/pets' });\n  fastify.get('/ping', async () => 'pong');\n};\n",
    'pets.js':
      "module.exports = async function (fastify) {\n  fastify.get('/', async () => []);\n  fastify.get('/:id', async () => ({}));\n};\n",
    'plain.js':
      "export default async function (app) {\n  app.route({ method: ['GET', 'POST'], url: '/both', handler: async () => ({}) });\n  app.route({\n    method: 'PUT',\n    path: '/one',\n    handler: async () => ({}),\n  });\n}\n",
  });
  // a plugin registered inside a plugin carries both prefixes
  assert.deepEqual(keys(written(extractFastifyRoutes(nested))), [
    'GET /both',
    'GET /v1/pets',
    'GET /v1/pets/{id}',
    'GET /v1/ping',
    'POST /both',
    'PUT /one',
  ]);

  // the same plugin under two prefixes is there twice; a plugin nobody registers keeps its own paths
  const twice = tree({
    'app.ts':
      "import Fastify from 'fastify';\nimport items from './items';\nconst app = Fastify();\napp.register(items, { prefix: '/a' });\napp.register(items, { prefix: '/b' });\n",
    'items.ts': "export default async function items(app) {\n  app.get('/items', async () => []);\n}\n",
    'orphan.ts': "export default async function (app) {\n  app.get('/orphan', async () => []);\n}\n",
  });
  assert.deepEqual(keys(written(extractFastifyRoutes(twice))), ['GET /a/items', 'GET /b/items', 'GET /orphan']);
});

test('Fastify: the HEAD it answers by itself matches a document that describes it, and is no drift when it does not', () => {
  const src = "import Fastify from 'fastify';\nconst app = Fastify();\napp.get('/a', async () => 1);\napp.get('/b', async () => 2);\n";
  const doc = (paths: string): string => `openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n${paths}`;
  const op = (method: string): string => `    ${method}:\n      responses:\n        '200': {description: ok}\n`;
  // the document describes HEAD /a and not HEAD /b: both are fine
  const dir = tree({ 'src/app.js': src, 'openapi.yaml': doc(`  /a:\n${op('get')}${op('head')}  /b:\n${op('get')}`) });
  const ok = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /src: 2 routes/);
  assert.match(ok.stdout, /No drift/);
  const listed = cli(['routes', '--source', 'src'], dir).stdout;
  assert.match(listed, /src: 2 routes \(fastify\)/);
  assert.doesNotMatch(listed, /HEAD/);

  // with the option off, a HEAD in the document has no route
  const off = tree({
    'src/app.js': src.replace('Fastify()', 'Fastify({ exposeHeadRoutes: false })'),
    'openapi.yaml': doc(`  /a:\n${op('get')}${op('head')}  /b:\n${op('get')}`),
  });
  const missing = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], off);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /In the document, not in the code \(1\):\n {2}HEAD {4}\/a — the path exists with GET/);
});

test('detectFramework tells Fastify from Express, and check runs on it', () => {
  assert.equal(detectFramework(fixture('fastify', 'src')), 'fastify');
  assert.equal(detectFramework(fixture('express', 'src')), 'express');
  assert.equal(detectFramework(fixture('nestjs', 'src')), 'nestjs');
  assert.equal(extractRoutes(fixture('fastify', 'src')).framework, 'fastify');

  const cwd = fixture('fastify');
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], cwd);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /src: 14 routes/);
  // one route the document lacks, one operation the code lacks
  assert.match(r.stdout, /In the code, not in the document \(1\):\n {2}POST {4}\/admin\/reindex \(src\/app\.js:\d+\)/);
  assert.match(r.stdout, /In the document, not in the code \(1\):\n {2}GET {5}\/api\/users\/\{id\}\/avatar \(getAvatar\)/);
  assert.match(r.stdout, /2 drifts\./);
  const explicit = cli(['routes', '--source', 'src', '--framework', 'fastify'], cwd);
  assert.match(explicit.stdout, /src: 14 routes \(fastify\)/);
});
