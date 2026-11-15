import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { basePath, joinPath, lintOpenApi, loadSpec, normalizePath, operations, pathParams, specVersion } from '../src/openapi.ts';
import { fixture, tempDir } from './helpers.ts';

test('loadSpec reads YAML and JSON, and names the file in its errors', () => {
  assert.equal(loadSpec(fixture('nestjs', 'openapi.yaml')).openapi, '3.0.3');
  assert.equal(loadSpec(fixture('express', 'openapi.json')).openapi, '3.1.0');
  assert.throws(() => loadSpec(fixture('nope.yaml')), /nope\.yaml: cannot read/);
});

test('lintOpenApi lists the problems of a document a person would see', () => {
  const problems = lintOpenApi(loadSpec(fixture('bad', 'openapi.yaml')));
  assert.deepEqual(problems, [
    "not a supported version (openapi: 2): 'openapi' must be 3.x, or 'swagger' must be \"2.0\"",
    "path 'users' must start with /",
    'GET users has no responses',
    'GET /things/{id}: path parameter {id} is not declared (parameters: - {name: id, in: path, required: true})',
    "path '/empty' has no operation (get, post, put, ...)",
    "$ref '#/components/schemas/Missing' points to nothing in the document",
  ]);
  assert.deepEqual(lintOpenApi(loadSpec(fixture('nestjs', 'openapi.yaml'))), []);
  assert.deepEqual(lintOpenApi(null), ['not an object']);
});

test('basePath comes from the first server URL', () => {
  assert.equal(basePath({ servers: [{ url: 'https://api.example.com/v1/' }] }), '/v1');
  assert.equal(basePath({ servers: [{ url: '/api' }] }), '/api');
  assert.equal(basePath({ servers: [{ url: 'api' }] }), '/api');
  assert.equal(basePath({ servers: [{ url: 'https://api.example.com' }] }), '');
  assert.equal(basePath({ servers: [{ url: '/' }] }), '');
  assert.equal(basePath({}), '');
});

test('basePath reads the path of a templated or protocol-relative server URL', () => {
  assert.equal(basePath({ servers: [{ url: '{scheme}://api.example.com/v1' }] }), '/v1');
  assert.equal(basePath({ servers: [{ url: '//api.example.com/v1/' }] }), '/v1');
  assert.equal(basePath({ servers: [{ url: '//api.example.com' }] }), '');
  assert.equal(basePath({ servers: [{ url: 'https://{host}/{basePath}' }] }), '/{basePath}');
  assert.equal(basePath({ servers: [{ url: '{basePath}' }] }), '/{basePath}');
});

test('operations, pathParams, normalizePath and joinPath', () => {
  const ops = operations(loadSpec(fixture('nestjs', 'openapi.yaml')));
  assert.equal(ops.length, 9);
  assert.deepEqual(ops[0], { method: 'get', path: '/users', params: [], query: [], responses: ['200'], operationId: 'listUsers' });
  assert.deepEqual(pathParams('/users/{id}/posts/{postId}'), ['id', 'postId']);
  assert.equal(normalizePath('/Users/{id}/'), '/users/{}');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
  assert.equal(joinPath('/api', 'users/', '/:id'), '/api/users/:id');
  assert.equal(joinPath('', 'users', ''), '/users');
  assert.equal(joinPath(), '/');
});

test('a split document is read through the files its path items and parameters refer to', () => {
  const doc = loadSpec(fixture('split', 'openapi.yaml'));
  assert.deepEqual(operations(doc), [
    { method: 'get', path: '/users', params: [], query: ['limit'], responses: ['200'], operationId: 'listUsers' },
    { method: 'post', path: '/users', params: [], query: [], responses: ['201'], operationId: 'createUser' },
    { method: 'get', path: '/users/{id}', params: ['id'], query: [], responses: ['200', '404'], operationId: 'getUser' },
    { method: 'get', path: '/health', params: [], query: ['verbose'], responses: ['200'] },
  ]);
  // references inside another file point into that file, not into the main document
  assert.deepEqual(lintOpenApi(doc), []);
});

test('a split document names the reference that cannot be followed', () => {
  assert.throws(
    () => loadSpec(fixture('split-bad', 'missing.yaml')),
    /missing\.yaml: \$ref '\.\/paths\/nope\.yaml': .*nope\.yaml: cannot read/
  );
  assert.throws(() => loadSpec(fixture('split-bad', 'loop.yaml')), /loop\.yaml: \$ref '\.\/loop\.yaml#\/x' refers back to itself/);
});

test('a $ref with a Windows drive letter is a file, not a URL', () => {
  const file = path.join(tempDir(), 'openapi.yaml');
  const spec = (ref: string): string =>
    ['openapi: 3.0.3', "info: { title: t, version: '1' }", 'paths:', '  /users:', `    $ref: '${ref}'`, ''].join('\n');
  writeFileSync(file, spec('Z:/no-such-dir/users.yaml'));
  assert.throws(() => loadSpec(file), /\$ref 'Z:\/no-such-dir\/users\.yaml': .*cannot read/);
  writeFileSync(file, spec('Z:\\no-such-dir\\users.yaml'));
  assert.throws(() => loadSpec(file), /\$ref 'Z:\\no-such-dir\\users\.yaml': .*cannot read/);
  // an absolute path: `C:/...` on Windows
  writeFileSync(file, spec(fixture('split', 'paths', 'users.yaml').replaceAll('\\', '/')));
  assert.deepEqual(
    operations(loadSpec(file)).map((op) => `${op.method} ${op.path}`),
    ['get /users', 'post /users']
  );
});

test('specVersion tells OpenAPI 3.x and Swagger 2.0 apart, and lint names both for anything else', () => {
  assert.equal(specVersion({ openapi: '3.0.3' }), '3.x');
  assert.equal(specVersion({ openapi: 3.1 }), '3.x');
  assert.equal(specVersion({ swagger: '2.0' }), '2.0');
  // `swagger: 2.0` without the quotes is the number 2 in YAML
  assert.equal(specVersion({ swagger: 2 }), '2.0');
  assert.equal(specVersion({ swagger: '1.2' }), undefined);
  assert.equal(specVersion({ openapi: '4.0.0' }), undefined);
  assert.equal(specVersion({ openapi: '2.0' }), undefined);
  assert.equal(specVersion({}), undefined);
  assert.equal(specVersion(null), undefined);

  const versions = `'openapi' must be 3.x, or 'swagger' must be "2.0"`;
  assert.deepEqual(lintOpenApi({ swagger: '1.2', paths: {} }), [`not a supported version (swagger: 1.2): ${versions}`]);
  assert.deepEqual(lintOpenApi({ openapi: '4.0.0', paths: {} }), [`not a supported version (openapi: 4.0.0): ${versions}`]);
  assert.deepEqual(lintOpenApi({ paths: {} }), [`not a supported version: ${versions}`]);
  assert.deepEqual(lintOpenApi({ swagger: '2.0', paths: {} }), []);
});

test('basePath of a Swagger 2.0 document is its basePath; host and schemes are left out', () => {
  const swagger = (extra: object): Record<string, unknown> => ({ swagger: '2.0', host: 'api.example.com', schemes: ['https'], ...extra });
  assert.equal(basePath(swagger({ basePath: '/' })), '');
  assert.equal(basePath(swagger({ basePath: '/api' })), '/api');
  assert.equal(basePath(swagger({ basePath: '/api/' })), '/api');
  assert.equal(basePath(swagger({})), '');
  assert.equal(basePath(swagger({ basePath: 'api/v1' })), '/api/v1');
  assert.equal(basePath(swagger({ basePath: '  ' })), '');
  // each version reads its own key
  assert.equal(basePath(swagger({ servers: [{ url: '/v3' }] })), '');
  assert.equal(basePath({ openapi: '3.0.3', basePath: '/v2' }), '');
});

test('a Swagger 2.0 document: shared parameters, body and form fields, extensions', () => {
  const file = path.join(tempDir(), 'swagger.yaml');
  writeFileSync(
    file,
    [
      'swagger: 2.0',
      "info: { title: t, version: '1' }",
      'basePath: /v2',
      'paths:',
      '  x-internal: { get: { responses: {} } }',
      '  /pets:',
      '    x-owner: pets',
      "    parameters: [{ $ref: '#/parameters/limit' }]",
      '    get:',
      "      parameters: [{ name: tag, in: query, type: string }, { name: X-Trace, in: header, type: string }, { $ref: '#/parameters/limit' }]",
      "      responses: { '200': { description: ok, schema: { $ref: '#/definitions/Pet' } }, default: { description: error } }",
      '    post:',
      "      parameters: [{ name: body, in: body, schema: { $ref: '#/definitions/Pet' } }, { name: file, in: formData, type: file }]",
      "      responses: { '201': { description: created } }",
      '  /pets/{petId}:',
      "    parameters: [{ $ref: '#/parameters/petId' }]",
      "    delete: { responses: { '204': { description: gone } } }",
      'parameters:',
      '  limit: { name: limit, in: query, type: integer }',
      '  petId: { name: petId, in: path, required: true, type: string }',
      'definitions:',
      '  Pet: { type: object }',
      '',
    ].join('\n')
  );
  const doc = loadSpec(file);
  assert.equal(specVersion(doc), '2.0');
  assert.equal(basePath(doc), '/v2');
  assert.deepEqual(lintOpenApi(doc), []);
  assert.deepEqual(operations(doc), [
    { method: 'get', path: '/pets', params: [], query: ['limit', 'tag'], responses: ['200', 'default'] },
    { method: 'post', path: '/pets', params: [], query: ['limit'], responses: ['201'] },
    { method: 'delete', path: '/pets/{petId}', params: ['petId'], query: [], responses: ['204'] },
  ]);

  // what a reference points to is checked the same way
  writeFileSync(
    file,
    [
      "swagger: '2.0'",
      'paths:',
      '  /pets/{petId}:',
      "    parameters: [{ $ref: '#/parameters/nope' }]",
      "    get: { responses: { '200': { description: ok } } }",
      '',
    ].join('\n')
  );
  assert.deepEqual(lintOpenApi(loadSpec(file)), [
    'GET /pets/{petId}: path parameter {petId} is not declared (parameters: - {name: petId, in: path, required: true})',
    "$ref '#/parameters/nope' points to nothing in the document",
  ]);
});

test('a split Swagger 2.0 document is read through its files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'swagger.yaml');
  writeFileSync(
    file,
    [
      "swagger: '2.0'",
      'basePath: /api/',
      'paths:',
      '  /users:',
      '    $ref: ./users.yaml',
      'parameters:',
      '  limit:',
      '    $ref: ./limit.yaml',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(dir, 'users.yaml'),
    "get:\n  parameters: [{ $ref: './limit.yaml' }]\n  responses: { '200': { description: ok } }\n"
  );
  writeFileSync(path.join(dir, 'limit.yaml'), 'name: limit\nin: query\ntype: integer\n');
  const doc = loadSpec(file);
  assert.equal(basePath(doc), '/api');
  assert.deepEqual(lintOpenApi(doc), []);
  assert.deepEqual(operations(doc), [{ method: 'get', path: '/users', params: [], query: ['limit'], responses: ['200'] }]);
  assert.equal(doc.parameters?.limit?.name, 'limit');
});

test('lintOpenApi: a path parameter kept under components.parameters is declared (OpenAPI 3)', () => {
  const doc = {
    openapi: '3.0.3',
    paths: {
      'x-note': 'an extension',
      '/users/{id}': { parameters: [{ $ref: '#/components/parameters/id' }], get: { responses: { 200: { description: 'ok' } } } },
    },
    components: { parameters: { id: { name: 'id', in: 'path', required: true } } },
  };
  assert.deepEqual(lintOpenApi(doc), []);
});
