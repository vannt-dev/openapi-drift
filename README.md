# openapi-drift

[![npm](https://img.shields.io/npm/v/openapi-drift)](https://www.npmjs.com/package/openapi-drift)
[![CI](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Official vannt-dev build](https://vannt-dev.github.io/badges/official.svg)](https://vannt-dev.github.io/official.html)

Tiếng Việt: [README.vi.md](README.vi.md)

Keeps an OpenAPI document honest. `openapi-drift` reads the routes your **NestJS**, **Express**, **Fastify** or **Spring** code actually declares, compares them with the document, and reports the drift in both directions:

- routes the code serves that the document does not describe,
- operations the document describes that no route serves,
- and, as notes, path parameters named differently (`{id}` in the document, `:orderId` in the code), query parameters a handler reads that the document does not describe (or the other way round), and statuses the code answers with that the document does not describe.

Everything built on the document (generated tests, client SDKs, mocks, reviewers) is only as good as the document. Run this in CI and a pull request can no longer change the API without changing the document.

```
$ openapi-drift check --spec openapi.yaml --source src --prefix /api
openapi.yaml: 9 operations under /api
src: 12 routes under /api

In the code, not in the document (5):
  GET     /api/health (src/health.controller.ts:5)
  HEAD    /api/health (src/health.controller.ts:10)
  GET     /api/legacy/ping (src/health.controller.ts:18)
  DELETE  /api/users/{id} (src/users/users.controller.ts:27) — the path exists with GET, PATCH
  GET     /api/v0/ping (src/health.controller.ts:18)

In the document, not in the code (2):
  POST    /api/orders (createOrder) — the path exists with GET
  GET     /api/users/{id}/avatar (getAvatar)

Path parameters named differently (1, not a failure):
  GET     /api/orders/{id}/items: document {id}, code {orderId} (src/orders/orders.controller.ts:10)

7 drifts.
```

No AI, no network, no build of your project: the routes are read from the source text, so it runs in a second on any CI runner.

## Install

```bash
npm install -g openapi-drift      # or: npx openapi-drift check ...
```

Node.js 22.18 or newer.

## Use

```bash
openapi-drift check --spec openapi.yaml --source src            # exit 1 on drift
openapi-drift check --spec openapi.yaml --source src --prefix /api --fail-on spec --format markdown --output drift.md
openapi-drift routes --source src                                # just list what the code declares
openapi-drift lint --spec openapi.yaml                           # problems of the document itself
openapi-drift check --spec openapi.yaml --source src --ignore /health --ignore 'GET /internal/**'
openapi-drift check --spec openapi.yaml --source src --baseline openapi-drift.json   # fail on new drift only
```

| Option                 | Meaning                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <file>`        | The OpenAPI 3 document, YAML or JSON.                                                                                                                                                                                                                                                                                                           |
| `--source <dir>`       | The backend source tree (default `.`). `node_modules`, `dist`, `build`, tests and `.d.ts` files are skipped.                                                                                                                                                                                                                                    |
| `--framework`          | `nestjs`, `express`, `fastify`, `spring` or `auto` (default): NestJS when a `.ts` file declares `@Controller`, Fastify or Express when a source file imports it, Spring when a Java or Kotlin file has a controller.                                                                                                                            |
| `--prefix <path>`      | A prefix the code adds to every route and the source does not show: an Express mount built dynamically, a NestJS prefix that comes from the configuration. NestJS does not need it otherwise (see below). Given, it replaces what the code says; `/` means no prefix at all. The document's own base path (`servers[0].url`) is read by itself. |
| `--format`             | `text` (default), `markdown` or `json`.                                                                                                                                                                                                                                                                                                         |
| `--output <file>`      | Also write the report to a file.                                                                                                                                                                                                                                                                                                                |
| `--fail-on`            | `any` (default): drift in either direction fails; `spec`: only routes the document lacks; `code`: only operations the code lacks; `none`: report only.                                                                                                                                                                                          |
| `--ignore <pattern>`   | Leave out the drift on a path: `/health`, `'GET /internal/**'`. May be given more than once.                                                                                                                                                                                                                                                    |
| `--ignore-file <file>` | Ignore patterns from a file, one a line; `#` starts a comment.                                                                                                                                                                                                                                                                                  |
| `--baseline <file>`    | Drift that is known and accepted: it is reported and does not fail the run.                                                                                                                                                                                                                                                                     |
| `--update-baseline`    | Write the drift of this run to the `--baseline` file and exit `0`.                                                                                                                                                                                                                                                                              |
| `--strict`             | Query parameters and status codes that differ are always reported; with this they fail the run as well.                                                                                                                                                                                                                                         |

Exit codes: `0` no drift, `1` drift, `2` bad usage or a document with problems (`lint` lists them first).

### Routes left out on purpose, and drift you already have

Two things keep a first run in CI from being all red.

**Ignore patterns** are for what is not meant to be in the document: health probes, metrics, internal routes. A pattern is a path, optionally after a method; `*` stands for one segment (or a part of one), `**` for any number of segments. It is matched against the path as the report prints it, prefix included, with parameter names and case ignored, and it leaves out drift in both directions.

```
# .openapi-drift-ignore, passed with --ignore-file
/api/health            # every method
GET /api/internal/**   # GET only, at any depth
/api/v*/ping
```

**A baseline** is for drift that exists today and will be fixed later. Record it once and commit the file:

```bash
openapi-drift check --spec openapi.yaml --source src --baseline openapi-drift.json --update-baseline
```

Later runs with `--baseline openapi-drift.json` list that drift under "Accepted by the baseline" and fail only on drift that is not in the file. When an entry no longer drifts, the report names it under "No longer drifting", so the file can lose it (run `--update-baseline` again). Ignore patterns are applied before a baseline is written, so the file holds only drift that is meant to be fixed.

### What is read

**NestJS**: `@Controller('users')`, `@Controller({ path: 'users' })`, `@Controller(['a', 'b'])`, with `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All` and their path arguments, in `.ts` and `.js` files. `:id` becomes `{id}`.

What a NestJS application sets for all of its routes is read from the code too, and the report says where it was found:

- the global prefix, `app.setGlobalPrefix('api')`, also from a constant of the same file (`const globalPrefix = 'api'`), with the routes it leaves out (`{ exclude: ['health', { path: 'metrics', method: RequestMethod.GET }] }`);
- URI versioning, `app.enableVersioning({ type: VersioningType.URI })` with its `prefix` and `defaultVersion`, and the versions of `@Controller({ version: '1' })` and `@Version('2')`, lists and `VERSION_NEUTRAL` included. A version in a header or a media type is not in the path and changes nothing.

```
$ openapi-drift check --spec openapi.yaml --source src
openapi.yaml: 12 operations
src: 12 routes under /api
  read from the code: global prefix /api (src/main.ts:9, 2 routes left out of it); versions in the path as v<version>, 1 by default (src/main.ts:12)
```

A value the source does not show as text (`app.setGlobalPrefix(config.get(...))`) is not guessed: a line on stderr names the place, and `--prefix` gives the value. The same when one source tree holds several applications with different settings. A `--prefix` that is given turns the reading off, so a command line written for an earlier version keeps its meaning. Paths added by `RouterModule` are not read.

**Express**: `app.get('/x', ...)` and the other verbs, `router.get(...)`, `app.route('/x').get(...).post(...)`, `app.all(...)`, with routers mounted by `app.use('/prefix', router)` in the same file or imported from another file (`import users from './users.js'`, `const users = require('./users')`). A route whose path is not a string literal is skipped; a router that is never mounted keeps its own paths. Comments are ignored.

**Fastify**: `fastify.get('/x', ...)` and the other verbs, and `fastify.route({ method, url })`, each under the prefixes of the plugins it sits in. A plugin is what `register` is given: a function written in the call, a function of the same file, or an import (`register(usersRoutes, { prefix: '/users' })`, `register(require('./users'), ...)`, `register(import('./users.js'), ...)`). A plugin registered inside a plugin carries both prefixes, and one nobody registers keeps its own paths. Fastify answers `HEAD` wherever there is a `GET`: a document that describes those operations is right, and one that does not is right too. Routes that `@fastify/autoload` makes from the names of folders are not read.

**Spring** (Java and Kotlin): `@GetMapping("/x")`, `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping` and `@RequestMapping(path, method)` on the methods of a `@RestController` or `@Controller`, under the class's own `@RequestMapping`; several paths yield each route once per path, and `{id:\\d+}` is `{id}`. The context path is read from `application.properties` or `application.yml` (`server.servlet.context-path`) and the report says where; the settings of a profile and of the tests are not the application's. Test sources (`src/test`) are not read, and an interface with the same annotations (a Feign client, a generated API interface) is not a controller. A path kept in a constant is not guessed: the route is left out and a line on stderr names the place.

Paths are compared with parameter names and case ignored, so `/users/{id}` and `/Users/:userId` are the same path; the different names are reported as a note, not a failure.

### Beyond the path

For an operation both sides know, two more things are compared, from what the source shows of its handler:

```
Query parameters that differ (1, not a failure):
  GET     /users: in the code only: sort; in the document only: limit (src/users.controller.ts:3)

Status codes that differ (1, not a failure):
  POST    /users: the code answers 201; the document describes 200, 400 (src/users.controller.ts:6)
```

- **NestJS, query parameters**: the names of `@Query('page')` in the handler's signature. When every `@Query` has a name the list is whole, so a parameter the document describes and the handler does not read is reported too. `@Query() dto` and `@Req()` say nothing by name, and nothing is compared.
- **NestJS, status**: `@HttpCode(204)` or `@HttpCode(HttpStatus.NO_CONTENT)`, otherwise what NestJS answers by itself: 201 to a `@Post`, 200 to the rest. A handler that takes the response (`@Res()` without `passthrough`) or redirects is left alone.
- **Express**: what a handler written in place is seen to do, `req.query.page`, `req.query['page']`, `const { page } = req.query`, `res.status(201)`, `res.sendStatus(204)`. This is only what was seen where it was written as text: a handler may read more through a helper, so only parameters and statuses the document lacks are reported, never the other way round. A handler that lives elsewhere (`app.get('/x', listUsers)`) says nothing.
- **Fastify**: the same, with `request.query.page` and `reply.code(201)`.
- **Spring, query parameters**: `@RequestParam`, by `name`, `value` or the name of the parameter. The list is whole when every parameter of the handler says where it comes from (`@PathVariable`, `@RequestBody`, ...); an object the query is bound to, a `Pageable` or the request itself leaves it unknown.
- **Spring, status**: `@ResponseStatus(HttpStatus.CREATED)`, otherwise 200. A handler that returns a `ResponseEntity` builds its own: the statuses its body is seen to build (`ResponseEntity.status(HttpStatus.CREATED)`, `.ok()`, `.notFound()`, `.noContent()`) are compared, and only what the document lacks is reported.

A status is described when the document has it by number, by range (`2XX`) or under `default`. These differences are notes: the exit code stays `0` unless `--strict` is given. Ignore patterns leave them out like the rest; a baseline does not hold them. `openapi-drift routes` shows what was read of each handler (`?page&sort -> 200`).

## GitHub Action

```yaml
# .github/workflows/openapi-drift.yml
name: OpenAPI drift
on: [pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vannt-dev/openapi-drift@v0
        with:
          spec: openapi.yaml
          source: src
          prefix: /api # optional; a NestJS global prefix is read from the code
          fail-on: any # or spec, code, none
          ignore: | # optional, one pattern a line
            /api/health
            GET /api/internal/**
          baseline: openapi-drift.json # optional
          strict: 'true' # optional: query and status differences fail the job
```

The Markdown report goes to the job summary and to `openapi-drift.md` (the `report` input), and the `drifts` output carries the count, so a later step can post it as a pull request comment.

## As a library

```ts
import { loadSpec, extractRoutes, compare, markdownReport } from 'openapi-drift';

const doc = loadSpec('openapi.yaml');
// `prefix` is the one given, or the one read from a NestJS application; `app` says where it was read
const { routes, prefix, app } = extractRoutes('src', { framework: 'auto' });
const result = compare(doc, routes, { prefix });
console.log(markdownReport(result, { spec: 'openapi.yaml', source: 'src', root: process.cwd(), app }));
```

Types are included.

## Related

- [openapi-postman-test-generator](https://github.com/vannt-dev/openapi-postman-test-generator) generates Postman collections and API tests from the document that `openapi-drift` keeps honest.
- [AIWS](https://github.com/vannt-dev/aiws-factory) runs the same comparison in the review phase of its requirement workflow.

## Roadmap

Spring (`@RequestMapping`) and Fastify route extraction; comparing the document with a running server (status codes, response fields); `--fix` to propose the document changes as a patch.

## Development

```bash
npm ci
npm run check   # ESLint + type check + Prettier + tests (Node 22 type stripping runs the TypeScript tests directly)
```

## License

[MIT](LICENSE) © Van Nguyen
