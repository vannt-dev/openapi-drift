# openapi-drift

[![npm](https://img.shields.io/npm/v/openapi-drift)](https://www.npmjs.com/package/openapi-drift)
[![CI](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tiếng Việt: [README.vi.md](README.vi.md)

Keeps an OpenAPI document honest. `openapi-drift` reads the routes your **NestJS** or **Express** code actually declares, compares them with the document, and reports the drift in both directions:

- routes the code serves that the document does not describe,
- operations the document describes that no route serves,
- and, as a note, path parameters named differently (`{id}` in the document, `:orderId` in the code).

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
```

| Option | Meaning |
| --- | --- |
| `--spec <file>` | The OpenAPI 3 document, YAML or JSON. |
| `--source <dir>` | The backend source tree (default `.`). `node_modules`, `dist`, `build`, tests and `.d.ts` files are skipped. |
| `--framework` | `nestjs`, `express` or `auto` (default): NestJS when a `.ts` file declares `@Controller`. |
| `--prefix <path>` | A prefix the code adds to every route and the source does not show: NestJS `app.setGlobalPrefix('api')`, an Express mount built dynamically. The document's own base path (`servers[0].url`) is read by itself. |
| `--format` | `text` (default), `markdown` or `json`. |
| `--output <file>` | Also write the report to a file. |
| `--fail-on` | `any` (default): drift in either direction fails; `spec`: only routes the document lacks; `code`: only operations the code lacks; `none`: report only. |

Exit codes: `0` no drift, `1` drift, `2` bad usage or a document with problems (`lint` lists them first).

### What is read

**NestJS**: `@Controller('users')`, `@Controller({ path: 'users' })`, `@Controller(['a', 'b'])`, with `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All` and their path arguments, in `.ts` and `.js` files. `:id` becomes `{id}`. The global prefix and URI versioning are not read from the code: pass `--prefix`.

**Express**: `app.get('/x', ...)` and the other verbs, `router.get(...)`, `app.route('/x').get(...).post(...)`, `app.all(...)`, with routers mounted by `app.use('/prefix', router)` in the same file or imported from another file (`import users from './users.js'`, `const users = require('./users')`). A route whose path is not a string literal is skipped; a router that is never mounted keeps its own paths. Comments are ignored.

Paths are compared with parameter names and case ignored, so `/users/{id}` and `/Users/:userId` are the same path; the different names are reported as a note, not a failure.

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
          prefix: /api # optional
          fail-on: any # or spec, code, none
```

The Markdown report goes to the job summary and to `openapi-drift.md` (the `report` input), and the `drifts` output carries the count, so a later step can post it as a pull request comment.

## As a library

```ts
import { loadSpec, extractRoutes, compare, markdownReport } from 'openapi-drift';

const doc = loadSpec('openapi.yaml');
const { routes } = extractRoutes('src', { framework: 'auto', prefix: '/api' });
const result = compare(doc, routes, { prefix: '/api' });
console.log(markdownReport(result, { spec: 'openapi.yaml', source: 'src', root: process.cwd() }));
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
