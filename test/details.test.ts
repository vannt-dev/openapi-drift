import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractNestRoutes } from '../src/extract/nestjs.ts';
import { extractExpressRoutes } from '../src/extract/express.ts';
import { compare, hasDrift } from '../src/compare.ts';
import { applyIgnore } from '../src/filter.ts';
import { operations } from '../src/openapi.ts';
import type { OpenApiDocument, Route } from '../src/types.ts';
import { cli, tempDir } from './helpers.ts';

/** A scratch directory holding the given files. */
function tree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const byKey = (routes: Route[]): Record<string, Route> => Object.fromEntries(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r]));

const NEST = `import { Controller, Get, Post, Put, Delete, Patch, Query, Req, Res, Body, Param, HttpCode, HttpStatus, Redirect } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  list(@Query('page') page: string, @Query('limit', ParseIntPipe) limit: number) {}

  @Get('search')
  search(@Query() query: SearchDto) {}

  @Get('raw')
  raw(@Req() req: Request) {}

  @Get(':id')
  one(@Param('id') id: string) {}

  @Post()
  create(@Body() body: unknown) {}

  @Post('import')
  @HttpCode(202)
  bulk(@Body() body: unknown, @Query('dryRun') dryRun: string) {}

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {}

  @Put(':id')
  @HttpCode(SOME_STATUS)
  replace(@Param('id') id: string) {}

  @Patch(':id')
  update(@Param('id') id: string, @Res() res: Response) {}

  @Get('export')
  download(@Res({ passthrough: true }) res: Response, @Query('format') format: string) {}

  @Get('old')
  @Redirect('/users')
  old() {}
}
`;

test('NestJS: the query parameters a handler names and the status it answers with', () => {
  const routes = byKey(extractNestRoutes(tree({ 'users.controller.ts': NEST })));
  // every @Query has a name: that is the whole list
  assert.deepEqual(routes['GET /users']?.query, { names: ['page', 'limit'], complete: true });
  assert.deepEqual(routes['GET /users/{id}']?.query, { names: [], complete: true });
  assert.deepEqual(routes['POST /users/import']?.query, { names: ['dryRun'], complete: true });
  assert.deepEqual(routes['GET /users/export']?.query, { names: ['format'], complete: true });
  // an object of them, or the request itself: what the handler reads is not in its signature
  assert.equal(routes['GET /users/search']?.query, undefined);
  assert.equal(routes['GET /users/raw']?.query, undefined);

  // NestJS answers 201 to a POST and 200 to the rest, unless @HttpCode says otherwise
  assert.deepEqual(routes['GET /users']?.statuses, [200]);
  assert.deepEqual(routes['POST /users']?.statuses, [201]);
  assert.deepEqual(routes['POST /users/import']?.statuses, [202]);
  assert.deepEqual(routes['DELETE /users/{id}']?.statuses, [204]);
  assert.deepEqual(routes['GET /users/export']?.statuses, [200], '@Res({ passthrough: true }) leaves the status to NestJS');
  // a status the source does not show, a response the handler writes itself, a redirect
  assert.equal(routes['PUT /users/{id}']?.statuses, undefined);
  assert.equal(routes['PATCH /users/{id}']?.statuses, undefined);
  assert.equal(routes['GET /users/old']?.statuses, undefined);
});

const EXPRESS = `const app = require('express')();
const { list } = require('./handlers');

app.get('/items', (req, res) => {
  const { page, size = 20, sort: order } = req.query;
  if (!req.query.q && req.query['include-archived']) return res.status(400).json({});
  res.json([]);
});
app.post('/items', (req, res) => res.status(201).json(req.body));
app.delete('/items/:id', (req, res) => {
  res.sendStatus(204);
});
app.get('/elsewhere', list);
app.route('/things').get((req, res) => res.json(req.query.kind)).post((req, res) => res.status(202).end());
`;

test('Express: what a handler written in place is seen to read and to answer with', () => {
  const routes = byKey(
    extractExpressRoutes(tree({ 'app.js': EXPRESS, 'handlers.js': 'exports.list = (req, res) => res.json(req.query.x);\n' }))
  );
  // what was seen, which need not be all of it
  assert.deepEqual(routes['GET /items']?.query, { names: ['page', 'size', 'sort', 'q', 'include-archived'], complete: false });
  assert.deepEqual(routes['GET /items']?.statuses, [400]);
  assert.deepEqual(routes['POST /items']?.statuses, [201]);
  assert.equal(routes['POST /items']?.query, undefined);
  assert.deepEqual(routes['DELETE /items/{id}']?.statuses, [204]);
  // a handler that lives elsewhere says nothing here
  assert.equal(routes['GET /elsewhere']?.query, undefined);
  assert.equal(routes['GET /elsewhere']?.statuses, undefined);
  // each link of a route chain has its own handler
  assert.deepEqual(routes['GET /things']?.query, { names: ['kind'], complete: false });
  assert.equal(routes['GET /things']?.statuses, undefined);
  assert.deepEqual(routes['POST /things']?.statuses, [202]);
  assert.equal(routes['POST /things']?.query, undefined);
});

const DOC: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  components: { parameters: { Limit: { name: 'limit', in: 'query' } } },
  paths: {
    '/users': {
      parameters: [
        { name: 'tenant', in: 'query' },
        { name: 'x-trace', in: 'header' },
      ],
      get: {
        parameters: [{ name: 'page', in: 'query' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'ok' }, '400': { description: 'bad' } },
      },
      post: { responses: { '200': { description: 'ok' } } },
    },
    '/users/{id}': {
      get: { parameters: [{ name: 'id', in: 'path', required: true }], responses: { '2XX': { description: 'ok' } } },
      delete: { responses: { default: { description: 'anything' } } },
    },
  },
};

test('operations: the query parameters and the responses a document describes', () => {
  const ops = Object.fromEntries(operations(DOC).map((op) => [`${op.method.toUpperCase()} ${op.path}`, op]));
  // of the path and of the operation, references followed, other places left out
  assert.deepEqual(ops['GET /users']?.query, ['tenant', 'page', 'limit']);
  assert.deepEqual(ops['GET /users']?.responses, ['200', '400']);
  assert.deepEqual(ops['POST /users']?.query, ['tenant']);
  assert.deepEqual(ops['GET /users/{id}']?.query, []);
  assert.deepEqual(ops['DELETE /users/{id}']?.responses, ['default']);
});

const route = (method: Route['method'], p: string, more: Partial<Route> = {}): Route => ({
  method,
  path: p,
  file: 'src/users.ts',
  line: 7,
  ...more,
});

test('compare: query parameters and statuses that differ are reported apart, and fail only when asked', () => {
  const result = compare(DOC, [
    // reads `sort`, which is not described; `tenant` is described and not read
    route('get', '/users', { query: { names: ['page', 'limit', 'sort'], complete: true }, statuses: [200] }),
    // answers 201, the document describes 200
    route('post', '/users', { query: { names: ['tenant'], complete: true }, statuses: [201] }),
    // a range and `default` describe whatever falls in them
    route('get', '/users/{id}', { query: { names: [], complete: true }, statuses: [206] }),
    route('delete', '/users/{id}', { statuses: [204, 404] }),
  ]);
  assert.deepEqual(result.missingInSpec, []);
  assert.deepEqual(result.missingInCode, []);
  assert.deepEqual(result.queryMismatch, [
    { method: 'get', path: '/users', codeOnly: ['sort'], specOnly: ['tenant'], file: 'src/users.ts', line: 7 },
  ]);
  assert.deepEqual(result.statusMismatch, [
    { method: 'post', path: '/users', codeStatuses: [201], specResponses: ['200'], file: 'src/users.ts', line: 7 },
  ]);
  assert.equal(hasDrift(result), false);
  assert.equal(hasDrift(result, 'any', { strict: true }), true);
  assert.equal(hasDrift(result, 'none', { strict: true }), false);

  // a list that need not be whole says nothing about what the document has more
  const seen = compare(DOC, [route('get', '/users', { query: { names: ['page', 'sort'], complete: false } })]);
  assert.deepEqual(
    seen.queryMismatch.map((m) => [m.codeOnly, m.specOnly]),
    [[['sort'], []]]
  );
  // nothing known about the handler: nothing to compare
  const unknown = compare(DOC, [route('get', '/users'), route('post', '/users')]);
  assert.deepEqual([unknown.queryMismatch, unknown.statusMismatch], [[], []]);

  // an ignore pattern leaves these out as it does the drift
  const ignored = applyIgnore(result, ['POST /users']);
  assert.equal(ignored.statusMismatch.length, 0);
  assert.equal(ignored.queryMismatch.length, 1);
});

test('check: the differences are in every report; --strict makes them fail the run', () => {
  const dir = tree({
    'src/users.controller.ts':
      "@Controller('users')\nexport class C {\n  @Get()\n  list(@Query('page') page: string, @Query('sort') sort: string) {}\n\n  @Post()\n  create(@Body() body: unknown) {}\n}\n",
    'openapi.yaml':
      "openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n  /users:\n    get:\n      parameters:\n        - {name: page, in: query}\n        - {name: limit, in: query}\n      responses:\n        '200': {description: ok}\n    post:\n      responses:\n        '200': {description: ok}\n        '400': {description: bad}\n",
  });
  const args = ['check', '--spec', 'openapi.yaml', '--source', 'src'];
  const text = cli(args, dir);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(
    text.stdout,
    /Query parameters that differ \(1, not a failure\):\n {2}GET {5}\/users: in the code only: sort; in the document only: limit \(src\/users\.controller\.ts:3\)/
  );
  assert.match(
    text.stdout,
    /Status codes that differ \(1, not a failure\):\n {2}POST {4}\/users: the code answers 201; the document describes 200, 400 \(src\/users\.controller\.ts:6\)/
  );
  assert.match(text.stdout, /No drift in the routes/);
  assert.doesNotMatch(text.stdout, /the document and the code agree/);

  const strict = cli([...args, '--strict'], dir);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /Query parameters that differ \(1\):/);
  assert.match(strict.stdout, /Status codes that differ \(1\):/);
  assert.match(strict.stdout, /2 differences fail the run \(--strict\)\./);
  assert.equal(cli([...args, '--strict', '--fail-on', 'none'], dir).status, 0);
  assert.equal(cli([...args, '--strict', '--ignore', '/users'], dir).status, 0);

  const md = cli([...args, '--format', 'markdown'], dir).stdout;
  assert.match(md, /### Query parameters that differ \(not a failure\) \(1\)/);
  assert.match(md, /\| `GET \/users` \| `sort` \| `limit` \|/);
  assert.match(md, /### Status codes that differ \(not a failure\) \(1\)/);
  assert.match(md, /\| `POST \/users` \| `201` \| `200`, `400` \|/);

  const json = JSON.parse(cli([...args, '--format', 'json'], dir).stdout) as {
    queryMismatch: { path: string; codeOnly: string[]; specOnly: string[]; file: string }[];
    statusMismatch: { path: string; codeStatuses: number[]; specResponses: string[] }[];
  };
  assert.deepEqual(json.queryMismatch, [
    { method: 'get', path: '/users', codeOnly: ['sort'], specOnly: ['limit'], file: 'src/users.controller.ts', line: 3 },
  ]);
  assert.deepEqual(json.statusMismatch[0]?.codeStatuses, [201]);

  // routes shows what was read of each handler
  const routes = cli(['routes', '--source', 'src'], dir).stdout;
  assert.match(routes, /GET {5}\/users {2}src\/users\.controller\.ts:3 {2}\?page&sort -> 200/);
  assert.match(routes, /POST {4}\/users {2}src\/users\.controller\.ts:6 {2}-> 201/);
});
