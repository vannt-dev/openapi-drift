import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractHono, extractHonoRoutes } from '../src/extract/hono.ts';
import { detectFramework, extractRoutes } from '../src/extract/index.ts';
import type { Route } from '../src/types.ts';
import { cli, fixture, tempDir } from './helpers.ts';

const keys = (routes: { method: string; path: string }[]): string[] => routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
/** The routes that are written, without the HEAD that Hono answers by itself. */
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

test('Hono: verbs, on(), chains, basePath and apps grouped by route() across files', () => {
  const all = extractHonoRoutes(fixture('hono', 'src'));
  assert.deepEqual(keys(written(all)), [
    'DELETE /api/items/{id}',
    'DELETE /api/users/{id}',
    'GET /api/admin/stats',
    'GET /api/health',
    'GET /api/orders',
    'GET /api/orders/{orderId}/items/{wildcard}',
    'GET /api/users',
    'GET /api/users/{id}',
    'GET /api/v2/reports/{day}',
    'PATCH /api/users/{id}',
    'POST /api/admin/reindex',
    'POST /api/users',
    'PUT /api/items/{id}',
    'PUT /api/orders/{orderId}',
  ]);
  const remove = all.find((r) => r.method === 'delete' && r.path === '/api/users/{id}');
  assert.ok(remove?.file.endsWith('users.ts'));
  // middleware, a Map and the context's own get() are not routes
  assert.ok(!keys(all).some((k) => /not-a-route|admin\/\{wildcard\}|user$|legacy|cache|commented/.test(k)));
  // Hono answers HEAD wherever there is a GET: there, and not written
  const implicit = keys(all.filter((r) => r.implicit));
  assert.equal(implicit.length, 7);
  assert.ok(implicit.every((k) => k.startsWith('HEAD ')));
  assert.ok(implicit.includes('HEAD /api/health'));
  // a prefix that is given goes in front of everything
  assert.ok(keys(extractHonoRoutes(fixture('hono', 'src'), { prefix: '/gw' })).includes('GET /gw/api/users'));
});

test('Hono: what is in the code and cannot be read is a note, not a guess', () => {
  const { app } = extractHono(fixture('hono', 'src'));
  const notes = (app?.notes ?? []).map((n) => `${path.basename(n.file)}:${n.line}: ${n.message}`);
  assert.equal(notes.length, 3, notes.join('\n'));
  assert.match(notes.find((n) => n.startsWith('admin.ts')) ?? '', /admin\.ts:12: .*not written as text/);
  assert.ok(notes.some((n) => /index\.ts:\d+: .*PURGE/.test(n)));
  assert.ok(notes.some((n) => /index\.ts:\d+: .*mount/.test(n)));
});

test('Hono: what a handler written in place is seen to read and to answer with', () => {
  const routes = byKey(extractHonoRoutes(fixture('hono', 'src')));
  assert.deepEqual(routes['GET /api/users']?.query, { names: ['page', 'limit'], complete: false });
  assert.deepEqual(routes['POST /api/users']?.statuses, [201]);
  assert.deepEqual(routes['DELETE /api/users/{id}']?.statuses, [204]);
  assert.deepEqual(routes['POST /api/admin/reindex']?.statuses, [202]);
  // c.get('user') is not a query parameter, and a handler that lives elsewhere says nothing
  assert.equal(routes['GET /api/users/{id}']?.query, undefined);
  assert.equal(routes['GET /api/orders/{orderId}/items/{wildcard}']?.statuses, undefined);
  assert.equal(routes['GET /api/health']?.statuses, undefined);
});

test('Hono: path parameters with a pattern or optional become OpenAPI templates', () => {
  const dir = tree({
    'app.ts': [
      "import { Hono } from 'hono';",
      'const app = new Hono();',
      "app.get('/posts/:id{[0-9]+}', (c) => c.text('a'));",
      "app.get('/files/:name{.+\\\\.png}', (c) => c.text('b'));",
      "app.get('/animals/:type?', (c) => c.text('c'));",
      "app.get('/dates/:d{\\\\d{4}}/:slug', (c) => c.text('d'));",
      "app.get('*', (c) => c.text('e'));",
      '',
    ].join('\n'),
  });
  assert.deepEqual(keys(written(extractHonoRoutes(dir))), [
    'GET /animals/{type}',
    'GET /dates/{d}/{slug}',
    'GET /files/{name}',
    'GET /posts/{id}',
    'GET /{wildcard}',
  ]);
});

test('Hono: the other forms of an app, a chain and route()', () => {
  const dir = tree({
    'main.ts': [
      "import { Hono } from 'hono';",
      "import v1 from './v1';",
      "const { pets } = require('./pets');",
      'const app = new Hono({ strict: false });',
      "app.route('/v1', v1);",
      "app.route('/pets', pets).get('/ready', (c) => c.text('ok'));",
      "app.all('/echo', (c) => c.text('echo'));",
      "app.on('GET', ['/a', '/b'], (c) => c.text('ab'));",
      "app.use('/hook', (c, next) => next()).post((c) => c.text('hook'));",
      'export default app;',
      '',
    ].join('\n'),
    // an app made of a chain and exported as it is, with an app grouped inside it
    'v1.ts': [
      "import { Hono } from 'hono';",
      "import { status } from './status';",
      "export default new Hono().get('/ping', (c) => c.text('pong')).route('/status', status);",
      '',
    ].join('\n'),
    // the RPC form: the chain kept in a constant, exported under another name
    'status.ts': [
      "import { Hono } from 'hono';",
      'const base = new Hono();',
      "const routes = base.get('/', (c) => c.json({})).delete('/cache', (c) => c.body(null, 204));",
      'export { routes as status };',
      'export type AppType = typeof routes;',
      '',
    ].join('\n'),
    'pets.js': [
      "const { Hono } = require('hono');",
      "const pets = new Hono().basePath('/all');",
      "pets.get('/', (c) => c.json([]));",
      'module.exports = { pets };',
      '',
    ].join('\n'),
    // an app nobody groups keeps its own paths; a function given the app reads like the app
    'orphan.ts': [
      "import { Hono } from 'hono';",
      "export function register(app: Hono) {\n  app.get('/registered', (c) => c.text('r'));\n}",
      "const lonely = new Hono();\nlonely.get('/lonely', (c) => c.text('l'));",
      '',
    ].join('\n'),
  });
  const all = written(extractHonoRoutes(dir));
  assert.deepEqual(
    keys(all).filter((k) => !k.includes('/echo')),
    [
      'DELETE /v1/status/cache',
      'GET /a',
      'GET /b',
      'GET /lonely',
      'GET /pets/all',
      'GET /ready',
      'GET /registered',
      'GET /v1/ping',
      'GET /v1/status',
      'POST /hook',
    ]
  );
  // all() is every method
  assert.equal(all.filter((r) => r.path === '/echo').length, 7);
});

test('Hono: detected by its import, ahead of Express in a mixed project; check runs on it', () => {
  assert.equal(detectFramework(fixture('hono', 'src')), 'hono');
  assert.equal(extractRoutes(fixture('hono', 'src')).framework, 'hono');
  // a project moving from Express to Hono: the Hono import decides, and --framework still reads the other
  const mixed = tree({
    'src/legacy/server.js': "const express = require('express');\nconst app = express();\napp.get('/old', (req, res) => res.json({}));\n",
    'src/app.ts':
      "import { Hono } from 'hono/tiny';\nconst app = new Hono();\napp.get('/new', (c) => c.text('new'));\nexport default app;\n",
  });
  assert.equal(detectFramework(path.join(mixed, 'src')), 'hono');
  assert.deepEqual(keys(written(extractRoutes(path.join(mixed, 'src')).routes)), ['GET /new']);
  assert.ok(keys(extractRoutes(path.join(mixed, 'src'), { framework: 'express' }).routes).includes('GET /old'));
  // Fastify keeps its place ahead of Hono; NestJS ahead of all
  assert.equal(detectFramework(tree({ 'a.ts': "import { Hono } from 'hono';\n", 'b.ts': "import Fastify from 'fastify';\n" })), 'fastify');
  assert.equal(detectFramework(fixture('express', 'src')), 'express');

  const cwd = fixture('hono');
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], cwd);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /src: 14 routes/);
  // one route the document lacks, one operation the code lacks
  assert.match(r.stdout, /In the code, not in the document \(1\):\n {2}POST {4}\/api\/admin\/reindex \(src\/routes\/admin\.ts:\d+\)/);
  assert.match(r.stdout, /In the document, not in the code \(1\):\n {2}GET {5}\/api\/users\/\{id\}\/avatar \(getAvatar\)/);
  assert.match(r.stdout, /2 drifts\./);
  // the notes are on stderr, with the place
  assert.match(r.stderr, /openapi-drift: src\/routes\/admin\.ts:12: /);
  const listed = cli(['routes', '--source', 'src'], cwd);
  assert.match(listed.stdout, /src: 14 routes \(hono\)/);
  assert.match(listed.stdout, /GET {5}\/api\/users {2}src\/routes\/users\.ts:\d+ {2}\?page&limit/);
});
