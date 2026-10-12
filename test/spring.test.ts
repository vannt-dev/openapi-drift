import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractSpring, extractSpringRoutes } from '../src/extract/spring.ts';
import { detectFramework, extractRoutes } from '../src/extract/index.ts';
import type { Route } from '../src/types.ts';
import { cli, fixture, tempDir } from './helpers.ts';

const keys = (routes: { method: string; path: string }[]): string[] => routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort();
const byKey = (routes: Route[]): Record<string, Route> => Object.fromEntries(routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r]));

function tree(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/** A controller class with the given members, in a scratch tree. */
const controller = (members: string, head = '@RestController\n@RequestMapping("/api")'): string =>
  `package x;\n\n${head}\npublic class C {\n${members}\n}\n`;

test('Spring: class and method mappings in Java and Kotlin, under the context path of the application', () => {
  const found = extractSpring(fixture('spring'));
  assert.deepEqual(keys(found.routes), [
    'DELETE /shop/api/users/{id}',
    'GET /shop/api/orders',
    'GET /shop/api/orders/ping',
    'GET /shop/api/reports/daily',
    'GET /shop/api/users',
    'GET /shop/api/users/find',
    'GET /shop/api/users/search',
    'GET /shop/api/users/{id}',
    'GET /shop/files/{wildcard}',
    'POST /shop/api/reports/rebuild',
    'POST /shop/api/users',
    'POST /shop/api/users/find',
    'POST /shop/api/users/search',
    'PUT /shop/api/users/{id}',
  ]);
  const remove = found.routes.find((r) => r.method === 'delete');
  assert.ok(remove?.file.endsWith('UserController.java'));
  assert.equal(remove?.line, 39);

  // the context path, from the application's own settings
  assert.equal(found.prefix, '/shop');
  assert.equal(found.app?.prefix?.value, '/shop');
  assert.ok(found.app?.prefix?.file.endsWith('application.properties'));
  assert.equal(found.app?.prefix?.line, 3);
  // a path kept in a constant is not guessed: said, and the route left out
  assert.equal(found.app?.notes.length, 1);
  assert.ok(found.app?.notes[0]?.file.endsWith('UserController.java'));
  assert.equal(found.app?.notes[0]?.line, 53);
  assert.match(found.app?.notes[0]?.message ?? '', /@GetMapping.*not written as text/);

  // a prefix that is given replaces the context path
  const given = extractSpring(fixture('spring'), { prefix: '/gw' });
  assert.ok(keys(given.routes).includes('GET /gw/api/users'));
  // nothing is read of the settings then; what could not be read of the mappings is still said
  assert.equal(given.app?.prefix, undefined);
  assert.equal(given.app?.notes.length, 1);
  assert.ok(keys(extractSpringRoutes(fixture('spring'), { prefix: '/' })).includes('GET /api/users'));
});

test('Spring: the query parameters a handler names and the statuses it answers with', () => {
  const routes = byKey(extractSpringRoutes(fixture('spring')));
  // @RequestParam by the name of the parameter, by `name` and by `value`
  assert.deepEqual(routes['GET /shop/api/users']?.query, { names: ['page', 'size', 'q'], complete: true });
  assert.deepEqual(routes['GET /shop/api/users/{id}']?.query, { names: [], complete: true });
  assert.deepEqual(routes['GET /shop/api/reports/daily']?.query, { names: ['day', 'tz'], complete: true });
  // an object the query is bound to, a Pageable, the request itself: not in the signature by name
  assert.equal(routes['GET /shop/api/users/search']?.query, undefined);
  assert.equal(routes['GET /shop/api/orders']?.query, undefined);
  assert.equal(routes['GET /shop/files/{wildcard}']?.query, undefined);

  // 200 unless @ResponseStatus says otherwise
  assert.deepEqual(routes['GET /shop/api/users']?.statuses, [200]);
  assert.deepEqual(routes['POST /shop/api/users']?.statuses, [201]);
  assert.deepEqual(routes['POST /shop/api/reports/rebuild']?.statuses, [202]);
  // a ResponseEntity: the statuses its body is seen to build
  assert.deepEqual(routes['PUT /shop/api/users/{id}']?.statuses, [200]);
  assert.deepEqual(routes['DELETE /shop/api/users/{id}']?.statuses, [404, 204]);
});

test('Spring: the forms of a mapping', () => {
  const dir = tree({
    'src/main/java/x/C.java': controller(
      [
        '    @RequestMapping("/any")\n    public String any() { return ""; }',
        '    @RequestMapping(value = "/two", method = { RequestMethod.PUT, RequestMethod.PATCH }, produces = "application/json")\n    public String two() { return ""; }',
        '    @GetMapping({"/a", "/b/"})\n    public String ab() { return ""; }',
        '    @GetMapping(path = "/named", params = "version=2", headers = "X-Api=1")\n    public String named() { return ""; }',
        '    @PostMapping(value = "/made")\n    public ResponseEntity<String> made() { return ResponseEntity.status(HttpStatus.CREATED).body(""); }',
        '    @DeleteMapping\n    @ResponseStatus(code = HttpStatus.NO_CONTENT)\n    public void root() { }',
        '    @GetMapping("/typed/{id:\\\\d{3}}/files/**")\n    public String typed(@PathVariable String id, HttpServletResponse response) { return ""; }',
      ].join('\n\n')
    ),
  });
  const routes = extractSpringRoutes(dir);
  assert.deepEqual(keys(routes), [
    'DELETE /api',
    'DELETE /api/any',
    'GET /api/a',
    'GET /api/any',
    'GET /api/b',
    'GET /api/named',
    'GET /api/typed/{id}/files/{wildcard}',
    'HEAD /api/any',
    'OPTIONS /api/any',
    'PATCH /api/any',
    'PATCH /api/two',
    'POST /api/any',
    'POST /api/made',
    'PUT /api/any',
    'PUT /api/two',
  ]);
  const found = byKey(routes);
  assert.deepEqual(found['POST /api/made']?.statuses, [201]);
  assert.deepEqual(found['DELETE /api']?.statuses, [204]);
  // a handler that takes the response writes its own status
  assert.equal(found['GET /api/typed/{id}/files/{wildcard}']?.statuses, undefined);

  // several paths on the class, and a class without @RestController is not a controller
  const classes = tree({
    'A.java': controller('    @GetMapping("/x")\n    public String x() { return ""; }', '@RestController\n@RequestMapping({"/v1", "/v2"})'),
    'B.java': controller('    @GetMapping("/y")\n    public String y() { return ""; }', '@Service'),
    'D.java': controller('    @GetMapping("/z")\n    @ResponseBody\n    public String z() { return ""; }', '@Controller'),
  });
  assert.deepEqual(keys(extractSpringRoutes(classes)), ['GET /v1/x', 'GET /v2/x', 'GET /z']);
});

test('Spring: where the context path is read from', () => {
  const java = { 'src/main/java/x/C.java': controller('    @GetMapping("/x")\n    public String x() { return ""; }') };
  const yml = tree({
    ...java,
    'src/main/resources/application.yml':
      'spring:\n  application:\n    name: t\nserver:\n  port: 8080\n  servlet:\n    context-path: /svc\n',
  });
  const read = extractSpring(yml);
  assert.deepEqual(keys(read.routes), ['GET /svc/api/x']);
  assert.equal(read.app?.prefix?.line, 7);
  assert.ok(read.app?.prefix?.file.endsWith('application.yml'));

  const colon = tree({ ...java, 'src/main/resources/application.properties': '# settings\nserver.servlet.context-path : /colon\n' });
  assert.deepEqual(keys(extractSpringRoutes(colon)), ['GET /colon/api/x']);

  // none set, and the settings of a profile or of the tests are not the application's
  const none = tree({
    ...java,
    'src/main/resources/application.properties': 'server.port=8080\n',
    'src/main/resources/application-dev.properties': 'server.servlet.context-path=/dev\n',
    'src/test/resources/application.properties': 'server.servlet.context-path=/test\n',
  });
  assert.deepEqual(keys(extractSpringRoutes(none)), ['GET /api/x']);
  assert.deepEqual(extractSpring(none).app, { notes: [] });

  // a value that comes from the environment is not guessed
  const hidden = tree({ ...java, 'src/main/resources/application.properties': 'server.servlet.context-path=${CONTEXT_PATH:/api}\n' });
  const found = extractSpring(hidden);
  assert.deepEqual(keys(found.routes), ['GET /api/x']);
  assert.match(found.app?.notes[0]?.message ?? '', /context-path.*--prefix/);
});

test('detectFramework tells Spring, and check runs on it', () => {
  assert.equal(detectFramework(fixture('spring')), 'spring');
  assert.equal(extractRoutes(fixture('spring')).framework, 'spring');

  const cwd = fixture('spring');
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', '.'], cwd);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /openapi\.yaml: 14 operations under \/shop/);
  assert.match(
    r.stdout,
    /\.: 14 routes under \/shop\n {2}read from the code: global prefix \/shop \(src\/main\/resources\/application\.properties:3\)/
  );
  assert.match(
    r.stdout,
    /In the code, not in the document \(1\):\n {2}POST {4}\/shop\/api\/reports\/rebuild \(src\/main\/kotlin\/com\/example\/shop\/ReportController\.kt:18\)/
  );
  assert.match(r.stdout, /In the document, not in the code \(1\):\n {2}GET {5}\/shop\/api\/users\/\{id\}\/avatar \(getAvatar\)/);
  assert.doesNotMatch(r.stdout, /that differ/);
  assert.match(r.stdout, /2 drifts\./);
  // the path that could not be read is said, with its place
  assert.match(r.stderr, /^openapi-drift: src\/main\/java\/com\/example\/shop\/UserController\.java:53: @GetMapping/m);

  const routes = cli(['routes', '--source', '.', '--framework', 'spring'], cwd);
  assert.match(routes.stdout, /\.: 14 routes \(spring\)/);
  assert.match(
    routes.stdout,
    /GET {5}\/shop\/api\/users {2}src\/main\/java\/com\/example\/shop\/UserController\.java:16 {2}\?page&size&q -> 200/
  );
});
