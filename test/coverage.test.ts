import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { belowCoverage, coverage } from '../src/compare.ts';
import { loadSpec } from '../src/openapi.ts';
import { extractNestRoutes } from '../src/extract/nestjs.ts';
import type { OpenApiDocument, Route } from '../src/types.ts';
import { cli, fixture, tempDir } from './helpers.ts';

const nest = (): { doc: OpenApiDocument; routes: Route[] } => ({
  doc: loadSpec(fixture('nestjs', 'openapi.yaml')),
  routes: extractNestRoutes(fixture('nestjs', 'src'), { prefix: '/api' }),
});

test('coverage: the operations with a handler and the documented statuses the handlers answer', () => {
  const { doc, routes } = nest();
  const c = coverage(doc, routes);
  // 9 operations; POST /api/orders and GET /api/users/{id}/avatar have no handler
  assert.deepEqual(c.operations, { documented: 9, handled: 7, percent: 77.7 });
  assert.equal(c.ignored, undefined);
  assert.ok(c.statuses, 'NestJS handlers show the status they answer with');
  assert.equal(c.statuses.operations, 7);
  assert.ok(c.statuses.answered <= c.statuses.documented);
  assert.equal(belowCoverage(c, 77.7), false);
  assert.equal(belowCoverage(c, 77.8), true, 'compared exactly, not as rounded');
});

test('coverage: ignore patterns leave operations out; default is not a status; ranges are answered', () => {
  const doc: OpenApiDocument = {
    openapi: '3.0.0',
    paths: {
      '/a': { get: { responses: { '200': {}, '404': {}, default: {} } } },
      '/b': { get: { responses: { '2XX': {} } }, post: { responses: { '201': {} } } },
      '/internal/x': { get: { responses: { '200': {} } } },
    },
  };
  const routes: Route[] = [
    { method: 'get', path: '/a', file: 'a.js', line: 1, statuses: [200] },
    { method: 'get', path: '/b', file: 'a.js', line: 2, statuses: [204] },
    { method: 'post', path: '/b', file: 'a.js', line: 3 },
  ];
  const all = coverage(doc, routes);
  assert.deepEqual(all.operations, { documented: 4, handled: 3, percent: 75 });
  // /a: 200 of 200, 404; /b GET: 2XX answered by 204; POST /b shows no status and is not counted
  assert.deepEqual(all.statuses, { documented: 3, answered: 2, operations: 2, percent: 66.6 });

  const kept = coverage(doc, routes, { ignore: ['/internal/**'] });
  assert.deepEqual(kept.operations, { documented: 3, handled: 3, percent: 100 });
  assert.equal(kept.ignored, 1);

  const none = coverage({ openapi: '3.0.0', paths: {} }, []);
  assert.deepEqual(none.operations, { documented: 0, handled: 0, percent: 100 });
  assert.equal(none.statuses, undefined, 'no handler shows a status');
});

test('check --coverage: in the text, Markdown and JSON reports; the exit code stays that of the drift', () => {
  const cwd = fixture('nestjs');
  const base = ['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api'];

  const text = cli([...base, '--coverage', '--fail-on', 'none'], cwd);
  assert.equal(text.status, 0, text.stderr);
  assert.match(
    text.stdout,
    /\nCoverage: 7 of 9 operations have a handler \(77\.7%\); status codes: 7 of 7 described are answered \(100%\) by the 7 handlers that show their statuses\n/
  );

  const md = cli([...base, '--coverage', '--format', 'markdown'], cwd);
  assert.equal(md.status, 1);
  assert.match(md.stdout, /^## OpenAPI drift: 7 drifts\n/, 'the heading the Action reads is unchanged');
  assert.match(md.stdout, /\n\*\*Coverage\*\*: 7 of 9 operations have a handler \(\*\*77\.7%\*\*\)/);

  const json = JSON.parse(cli([...base, '--coverage', '--format', 'json'], cwd).stdout) as { coverage: { operations: unknown } };
  assert.deepEqual(json.coverage.operations, { documented: 9, handled: 7, percent: 77.7 });

  const plain = cli([...base, '--format', 'json'], cwd);
  assert.equal('coverage' in (JSON.parse(plain.stdout) as object), false, 'left out unless asked for');
  assert.doesNotMatch(cli(base, cwd).stdout, /Coverage/);
});

test('check --min-coverage: exit 1 below it whatever --fail-on says, 0 at or above it; bad values exit 2', () => {
  const cwd = fixture('nestjs');
  const base = ['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api', '--fail-on', 'none'];

  const below = cli([...base, '--min-coverage', '80'], cwd);
  assert.equal(below.status, 1, below.stderr);
  assert.match(below.stdout, /--min-coverage 80 not met/);
  assert.match(below.stdout, /Coverage 77\.7% is below --min-coverage 80: the run fails\.\n$/);

  const met = cli([...base, '--min-coverage=75%'], cwd);
  assert.equal(met.status, 0, met.stderr);
  assert.match(met.stdout, /--min-coverage 75 met/);
  assert.doesNotMatch(met.stdout, /the run fails/);

  const json = JSON.parse(cli([...base, '--min-coverage', '90', '--format', 'json'], cwd).stdout) as {
    coverage: { min: number; met: boolean };
  };
  assert.deepEqual([json.coverage.min, json.coverage.met], [90, false]);

  const out = path.join(tempDir(), 'drift.md');
  const md = cli([...base, '--min-coverage', '90', '--format', 'markdown', '--output', out], cwd);
  assert.equal(md.status, 1);
  assert.match(fs.readFileSync(out, 'utf8'), /Coverage 77\.7% is below `--min-coverage 90`: the run fails\./);

  // ignoring what has no handler brings the share up
  const ignored = cli([...base, '--min-coverage', '100', '--ignore', 'POST /api/orders', '--ignore', '/api/users/*/avatar'], cwd);
  assert.equal(ignored.status, 0, ignored.stdout);
  assert.match(ignored.stdout, /7 of 7 operations have a handler \(100%\), 2 left out by the ignore patterns/);

  for (const bad of ['abc', '101', '-5', '']) {
    const r = cli([...base, `--min-coverage=${bad}`], cwd);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--min-coverage .*: a percentage from 0 to 100/);
  }
});
