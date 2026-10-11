# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `openapi-drift check`: compares an OpenAPI 3 document with the routes a
  NestJS or Express source tree declares and reports the drift in both
  directions, plus path parameters named differently as a note; `text`,
  `markdown` and `json` reports, `--output`, `--prefix` for a global prefix the
  code does not show, `--fail-on any|spec|code|none`.
- `openapi-drift routes`: lists the routes the code declares, with file and
  line.
- `openapi-drift lint`: the problems of the document itself (version, paths,
  undeclared path parameters, dangling `$ref`).
- NestJS extraction: `@Controller` with a string, an options object or a list of
  prefixes; `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`,
  `@All`; comments and test files ignored.
- Express extraction: app and router verbs, `app.route(...)` chains, `app.all`,
  routers mounted in the same file or through `import`/`require` from another
  file.
- A composite GitHub Action (`vannt-dev/openapi-drift@v0`) that writes the
  Markdown report to the job summary and exposes the number of drifts.
- A library entry point with TypeScript types.

[Unreleased]: https://github.com/vannt-dev/openapi-drift/commits/main
