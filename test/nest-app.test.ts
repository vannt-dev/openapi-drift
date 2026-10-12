import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractNestRoutes, readNestApp } from '../src/extract/nestjs.ts';
import { extractRoutes } from '../src/extract/index.ts';
import { cli, fixture, tempDir } from './helpers.ts';

const keys = (routes: { method: string; path: string }[]): string[] => routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();

const CONTROLLER = "@Controller('cats')\nexport class C {\n  @Get()\n  list() {}\n\n  @Version('2')\n  @Get(':id')\n  one() {}\n}\n";

/** A scratch NestJS source tree: `main.ts` with the given bootstrap lines and one controller. */
function app(bootstrap: string, files: Record<string, string> = {}): string {
  const dir = tempDir();
  const all = {
    'main.ts': `async function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n${bootstrap}\n}\n`,
    ...files,
  };
  if (!Object.keys(all).some((name) => name.endsWith('controller.ts'))) Object.assign(all, { 'cats.controller.ts': CONTROLLER });
  for (const [name, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('NestJS: the global prefix, its excluded routes and URI versions are read from the code', () => {
  const src = fixture('nestjs-app', 'src');
  assert.deepEqual(keys(extractNestRoutes(src)), [
    'DELETE /api/v3/cats/{id}',
    'GET /api/cats/breeds',
    'GET /api/v1/cats',
    'GET /api/v2/cats/{id}',
    'GET /api/v2/dogs',
    'GET /api/v3/dogs',
    'GET /api/v4/dogs/legacy',
    'GET /health',
    'GET /v1/metrics',
    'POST /api/v1/cats',
    'POST /api/v1/metrics',
    'POST /api/v2/cats',
  ]);

  const read = readNestApp(src);
  assert.equal(read.prefix?.value, 'api');
  assert.deepEqual(read.prefix?.exclude, [{ path: 'health' }, { path: 'metrics', method: 'get' }]);
  assert.ok(read.prefix?.file.endsWith('main.ts'));
  assert.equal(read.prefix?.line, 9, 'the call that is not in a comment');
  assert.deepEqual({ prefix: read.versioning?.prefix, defaults: read.versioning?.defaults }, { prefix: 'v', defaults: ['1'] });
  assert.equal(read.versioning?.line, 12);
  assert.deepEqual(read.notes, []);

  const found = extractRoutes(src);
  assert.equal(found.framework, 'nestjs');
  assert.equal(found.prefix, '/api');
  assert.equal(found.app?.prefix?.value, 'api');
});

test('NestJS: a prefix that is given replaces everything the code says', () => {
  const src = fixture('nestjs-app', 'src');
  // as before this was read: the given prefix, no version, nothing excluded
  const given = keys(extractNestRoutes(src, { prefix: '/gateway' }));
  assert.ok(given.includes('GET /gateway/cats'));
  assert.ok(given.includes('GET /gateway/health'));
  assert.ok(!given.some((k) => /\/v\d/.test(k)), given.join(', '));
  const found = extractRoutes(src, { prefix: '/gateway' });
  assert.equal(found.prefix, '/gateway');
  assert.equal(found.app, undefined);
  // `/` says: no prefix, and read nothing
  assert.ok(keys(extractNestRoutes(src, { prefix: '/' })).includes('GET /cats'));
  // an empty prefix is no prefix given
  assert.ok(keys(extractNestRoutes(src, { prefix: '' })).includes('GET /api/v1/cats'));
});

test('NestJS: the forms of setGlobalPrefix', () => {
  assert.deepEqual(keys(extractNestRoutes(app("  app.setGlobalPrefix('/api/');"))), ['GET /api/cats', 'GET /api/cats/{id}']);
  assert.deepEqual(keys(extractNestRoutes(app('  app.setGlobalPrefix("v1/api");'))), ['GET /v1/api/cats', 'GET /v1/api/cats/{id}']);
  assert.deepEqual(keys(extractNestRoutes(app("const PREFIX = 'svc';\n  app.setGlobalPrefix(PREFIX);"))), [
    'GET /svc/cats',
    'GET /svc/cats/{id}',
  ]);
  // no prefix set at all
  const none = app('  await app.listen(3000);');
  assert.deepEqual(keys(extractNestRoutes(none)), ['GET /cats', 'GET /cats/{id}']);
  assert.deepEqual(readNestApp(none), { notes: [] });

  // a value the source does not show: said, and the routes are as if it were not set
  const hidden = app("  app.setGlobalPrefix(config.get('PREFIX'));");
  assert.deepEqual(keys(extractNestRoutes(hidden)), ['GET /cats', 'GET /cats/{id}']);
  const notes = readNestApp(hidden).notes;
  assert.equal(notes.length, 1);
  assert.ok(notes[0]?.file.endsWith('main.ts'));
  assert.equal(notes[0]?.line, 3);
  assert.match(notes[0]?.message ?? '', /setGlobalPrefix.*--prefix/);

  // excluded routes: a path pattern, a parameter, and a method that does not match
  const excluded = app("  app.setGlobalPrefix('api', { exclude: ['cats/:id', { path: 'cats', method: RequestMethod.POST }] });");
  assert.deepEqual(keys(extractNestRoutes(excluded)), ['GET /api/cats', 'GET /cats/{id}']);
  const wild = app("  app.setGlobalPrefix('api', { exclude: ['cats/(.*)'] });");
  assert.deepEqual(keys(extractNestRoutes(wild)), ['GET /api/cats', 'GET /cats/{id}']);
});

test('NestJS: several applications under one source tree', () => {
  const same = app("  app.setGlobalPrefix('api');", { 'worker/main.ts': "app.setGlobalPrefix('api');\n" });
  assert.deepEqual(keys(extractNestRoutes(same)), ['GET /api/cats', 'GET /api/cats/{id}']);
  assert.deepEqual(readNestApp(same).notes, []);

  const different = app("  app.setGlobalPrefix('api');", { 'admin/main.ts': "app.setGlobalPrefix('admin');\n" });
  assert.deepEqual(keys(extractNestRoutes(different)), ['GET /cats', 'GET /cats/{id}'], 'which one is not a guess to make');
  const read = readNestApp(different);
  assert.equal(read.prefix, undefined);
  assert.equal(read.notes.length, 1);
  assert.match(read.notes[0]?.message ?? '', /admin.*api|api.*admin/);
});

test('NestJS: the forms of enableVersioning', () => {
  // URI is the default type; without a default version only declared versions are in the path
  assert.deepEqual(keys(extractNestRoutes(app('  app.enableVersioning();'))), ['GET /cats', 'GET /v2/cats/{id}']);
  assert.deepEqual(keys(extractNestRoutes(app("  app.enableVersioning({ type: VersioningType.URI, prefix: 'ver' });"))), [
    'GET /cats',
    'GET /ver2/cats/{id}',
  ]);
  assert.deepEqual(keys(extractNestRoutes(app('  app.enableVersioning({ type: VersioningType.URI, prefix: false });'))), [
    'GET /2/cats/{id}',
    'GET /cats',
  ]);
  assert.deepEqual(keys(extractNestRoutes(app("  app.enableVersioning({ type: VersioningType.URI, defaultVersion: ['1', '3'] });"))), [
    'GET /v1/cats',
    'GET /v2/cats/{id}',
    'GET /v3/cats',
  ]);
  assert.deepEqual(keys(extractNestRoutes(app('  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_NEUTRAL });'))), [
    'GET /cats',
    'GET /v2/cats/{id}',
  ]);
  // the version after the global prefix
  const both = "  app.setGlobalPrefix('api');\n  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });";
  assert.deepEqual(keys(extractNestRoutes(app(both))), ['GET /api/v1/cats', 'GET /api/v2/cats/{id}']);
  // options without a type are not URI versioning when NestJS runs them either
  assert.deepEqual(keys(extractNestRoutes(app("  app.enableVersioning({ defaultVersion: '1' });"))), ['GET /cats', 'GET /cats/{id}']);
  // a version in a header, a media type or a custom extractor is not in the path
  for (const type of ['HEADER', 'MEDIA_TYPE', 'CUSTOM']) {
    const dir = app(`  app.enableVersioning({ type: VersioningType.${type}, defaultVersion: '1' });`);
    assert.deepEqual(keys(extractNestRoutes(dir)), ['GET /cats', 'GET /cats/{id}'], type);
    assert.equal(readNestApp(dir).versioning, undefined, type);
  }
  // @Version without enableVersioning does nothing in NestJS either
  assert.deepEqual(keys(extractNestRoutes(app('  await app.listen(3000);'))), ['GET /cats', 'GET /cats/{id}']);
  // options the source does not show
  const hidden = app('  app.enableVersioning(versioningOptions);');
  assert.deepEqual(keys(extractNestRoutes(hidden)), ['GET /cats', 'GET /cats/{id}']);
  assert.match(readNestApp(hidden).notes[0]?.message ?? '', /enableVersioning/);
});

test('check and routes: say what was read from the code, and a given --prefix turns the reading off', () => {
  const cwd = fixture('nestjs-app');
  const ok = cli(['check', '--spec', 'openapi.yaml', '--source', 'src'], cwd);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /No drift/);
  assert.match(ok.stdout, /src: 12 routes under \/api/);
  assert.match(ok.stdout, /read from the code: global prefix \/api \(src\/main\.ts:9, 2 routes left out of it\)/);
  assert.match(ok.stdout, /versions in the path as v<version>, 1 by default \(src\/main\.ts:12\)/);
  assert.equal(ok.stderr, '');

  // an empty --prefix, as the GitHub Action passes it when the input is not set, is no prefix given
  const empty = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', ''], cwd);
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);

  const md = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--format', 'markdown'], cwd);
  assert.match(md.stdout, /Read from the code: global prefix `\/api` \(`src\/main\.ts:9`, 2 routes left out of it\)/);

  const json = JSON.parse(cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--format', 'json'], cwd).stdout) as {
    prefix: string;
    app: { prefix: { value: string; file: string; line: number }; versioning: { prefix: string; defaults: string[]; file: string } };
  };
  assert.equal(json.prefix, '/api');
  assert.deepEqual(
    { value: json.app.prefix.value, file: json.app.prefix.file, line: json.app.prefix.line },
    { value: 'api', file: 'src/main.ts', line: 9 }
  );
  assert.deepEqual({ prefix: json.app.versioning.prefix, defaults: json.app.versioning.defaults }, { prefix: 'v', defaults: ['1'] });

  const given = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api'], cwd);
  assert.equal(given.status, 1);
  assert.doesNotMatch(given.stdout, /read from the code/);
  assert.match(given.stdout, /GET {5}\/api\/cats /);

  const routes = cli(['routes', '--source', 'src'], cwd);
  assert.equal(routes.status, 0);
  assert.match(routes.stdout, /src: 12 routes \(nestjs\)/);
  assert.match(routes.stdout, /read from the code: global prefix \/api/);
  assert.match(routes.stdout, /GET {5}\/v1\/metrics {2}src\/ops\.controller\.ts:13/);
  const routesJson = JSON.parse(cli(['routes', '--source', 'src', '--format', 'json'], cwd).stdout) as {
    prefix: string;
    app: { prefix: { file: string } };
  };
  assert.equal(routesJson.prefix, '/api');
  assert.equal(routesJson.app.prefix.file, 'src/main.ts');
});

test('check: a setting the source does not show is said on stderr, with what to do', () => {
  const dir = app("  app.setGlobalPrefix(process.env.PREFIX ?? 'api');");
  fs.writeFileSync(
    path.join(dir, 'openapi.yaml'),
    "openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n  /cats:\n    get:\n      responses:\n        '200': {description: ok}\n"
  );
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', '.', '--fail-on', 'none'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^openapi-drift: main\.ts:3: setGlobalPrefix/m);
  assert.match(r.stderr, /--prefix/);
  // given, there is nothing to say
  const given = cli(['check', '--spec', 'openapi.yaml', '--source', '.', '--prefix', '/api', '--fail-on', 'none'], dir);
  assert.equal(given.stderr, '');
});

test('NestJS: brackets inside a decorator do not cut its arguments short', () => {
  const dir = app('  await app.listen(3000);', {
    'items.controller.ts':
      "@Controller('items')\nexport class C {\n  @Get(':id(\\\\d+)')\n  one() {}\n\n  @UseGuards(RolesGuard('admin'))\n  @Post('bulk')\n  bulk() {}\n}\n",
  });
  assert.deepEqual(keys(extractNestRoutes(dir)), ['GET /items/{id}', 'POST /items/bulk']);
});
