# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Sections are written by
release-please from the commit messages; what a release means for users is
added by hand below its heading.

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
