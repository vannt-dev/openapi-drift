# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Sections are written by
release-please from the commit messages; what a release means for users is
added by hand below its heading.

## [0.4.0](https://github.com/vannt-dev/openapi-drift/compare/v0.3.0...v0.4.0) (2026-10-27)

A document split into files (the Redocly layout, `/users: {$ref: ./paths/users.yaml}`)
is now read through them. Before, every route of such a document was reported as
missing from it.


### Features

* read a document split into files ([4c77d7a](https://github.com/vannt-dev/openapi-drift/commit/4c77d7a14d3d5a30e0d25c28cf3b47ef501fffca))

## [0.3.0](https://github.com/vannt-dev/openapi-drift/compare/v0.2.0...v0.3.0) (2026-10-20)


### Features

* write SARIF and annotate drift on the pull request ([2ebe1bd](https://github.com/vannt-dev/openapi-drift/commit/2ebe1bdcfd012b13345eae8c3f9f3c888db518df))
* write SARIF and annotate drift on the pull request ([48d4f90](https://github.com/vannt-dev/openapi-drift/commit/48d4f901c6ce411206cf4eee36cbc01f2132f57f))

## [0.2.0](https://github.com/vannt-dev/openapi-drift/compare/v0.1.0...v0.2.0) (2026-10-13)


### Features

* compare query parameters and status codes, with --strict to fail on them ([#6](https://github.com/vannt-dev/openapi-drift/issues/6)) ([9947c63](https://github.com/vannt-dev/openapi-drift/commit/9947c634e4038f7060a801ecea835b835dad517c))
* ignore patterns and a baseline of accepted drift ([#3](https://github.com/vannt-dev/openapi-drift/issues/3)) ([52088ba](https://github.com/vannt-dev/openapi-drift/commit/52088ba9a4412361cbd74da3c3240d916b0670ff))
* read the routes of Fastify and Spring applications ([#7](https://github.com/vannt-dev/openapi-drift/issues/7)) ([6aa7078](https://github.com/vannt-dev/openapi-drift/commit/6aa70786aa6ab5e6bed73c3b28acc85cefdafc8c))

## 0.1.0 (2026-10-11)

The first release: a CLI, a library and a GitHub Action that compare an
OpenAPI 3 document with the routes a NestJS or Express source tree declares.

- `openapi-drift check` reports the drift in both directions (routes the code
  serves that the document does not describe, operations the document
  describes that no route serves) and, as a note, path parameters named
  differently; `text`, `markdown` and `json` reports, `--output`, `--prefix`
  for a global prefix the code does not show, `--fail-on any|spec|code|none`.
- `openapi-drift routes` lists the routes the code declares, with file and
  line; `openapi-drift lint` lists the problems of the document itself
  (version, paths, undeclared path parameters, dangling `$ref`).
- NestJS: `@Controller` with a string, an options object or a list of
  prefixes; `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`,
  `@All`; comments and test files ignored.
- Express: app and router verbs, `app.route(...)` chains, `app.all`, routers
  mounted in the same file or through `import`/`require` from another file.
- The composite action `vannt-dev/openapi-drift@v0` writes the Markdown report
  to the job summary and exposes the number of drifts.

### Features

* compare an OpenAPI document with NestJS and Express routes ([7a9f374](https://github.com/vannt-dev/openapi-drift/commit/7a9f3742c9e6113d5d1571826f9c87c4237abe3a))


### Bug Fixes

* **action:** install the dev dependencies the build needs ([e99160f](https://github.com/vannt-dev/openapi-drift/commit/e99160f5e23dbecba93d01c78beb874bc10c2d8f))
