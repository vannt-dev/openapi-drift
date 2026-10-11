import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, fixture, tempDir } from './helpers.ts';

test('check: exit 1 on drift with the text report, 0 with --fail-on none, markdown written to --output', () => {
  const cwd = fixture('nestjs');
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api'], cwd);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /7 drifts\./);
  assert.equal(r.stderr, '');

  const none = cli(['check', '--spec=openapi.yaml', '--source=src', '--prefix=/api', '--fail-on', 'none'], cwd);
  assert.equal(none.status, 0);

  const out = path.join(tempDir(), 'report', 'drift.md');
  const md = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api', '--format', 'markdown', '--output', out], cwd);
  assert.equal(md.status, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), md.stdout);
  assert.match(md.stdout, /^## OpenAPI drift: 7 drifts/);
});

test('check: an agreeing Express project exits 0; a document with problems exits 2 before any comparison', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "const app = require('express')();\napp.get('/ping', (q, s) => s.end());\n");
  fs.writeFileSync(
    path.join(dir, 'openapi.yaml'),
    "openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n  /ping:\n    get:\n      responses:\n        '200': {description: ok}\n"
  );
  const ok = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /No drift/);

  const bad = cli(['check', '--spec', fixture('bad', 'openapi.yaml'), '--source', 'src'], dir);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /6 problems; fix the document first/);
});

test('lint, routes, --version, --help and usage errors', () => {
  assert.equal(cli(['lint', '--spec', fixture('nestjs', 'openapi.yaml')]).status, 0);
  const bad = cli(['lint', '--spec', fixture('bad', 'openapi.yaml')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /6 problems\n {2}'openapi' must be a 3\.x version/);

  const routes = cli(['routes', '--source', 'src'], fixture('express'));
  assert.equal(routes.status, 0);
  assert.match(routes.stdout, /^src: 18 routes \(express\)\n/);
  assert.match(routes.stdout, /GET {5}\/api\/users\/\{id\} {2}src\/users\.js:6/);
  const json = JSON.parse(cli(['routes', '--source', 'src', '--format', 'json'], fixture('nestjs')).stdout) as {
    framework: string;
    routes: unknown[];
  };
  assert.equal(json.framework, 'nestjs');
  assert.equal(json.routes.length, 12);

  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match(cli(['--help']).stdout, /^openapi-drift: keeps an OpenAPI document honest/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['check']).status, 2);
  assert.match(cli(['check']).stderr, /--spec <file> is required/);
  assert.match(cli(['check', '--spec', fixture('nestjs', 'openapi.yaml'), '--source', 'nope']).stderr, /no such directory/);
  assert.match(
    cli(['check', '--spec', fixture('nestjs', 'openapi.yaml'), '--fail-on', 'maybe']).stderr,
    /--fail-on maybe: any, spec, code, none/
  );
  assert.match(cli(['frobnicate']).stderr, /unknown command 'frobnicate'/);
  assert.match(cli(['--bogus']).stderr, /unknown option --bogus/);
});
