import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basePath, joinPath, lintOpenApi, loadSpec, normalizePath, operations, pathParams } from '../src/openapi.ts';
import { fixture } from './helpers.ts';

test('loadSpec reads YAML and JSON, and names the file in its errors', () => {
  assert.equal(loadSpec(fixture('nestjs', 'openapi.yaml')).openapi, '3.0.3');
  assert.equal(loadSpec(fixture('express', 'openapi.json')).openapi, '3.1.0');
  assert.throws(() => loadSpec(fixture('nope.yaml')), /nope\.yaml: cannot read/);
});

test('lintOpenApi lists the problems of a document a person would see', () => {
  const problems = lintOpenApi(loadSpec(fixture('bad', 'openapi.yaml')));
  assert.deepEqual(problems, [
    "'openapi' must be a 3.x version",
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
