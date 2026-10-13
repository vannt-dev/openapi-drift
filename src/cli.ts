import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec, lintOpenApi } from './openapi.ts';
import { extractRoutes } from './extract/index.ts';
import { compare, hasDrift } from './compare.ts';
import { applyBaseline, applyIgnore, baselineOf, loadBaseline, readIgnoreFile } from './filter.ts';
import { textReport, markdownReport, jsonReport, readFromCode, appJson } from './report.ts';
import { FAIL_ON, FORMATS, FRAMEWORKS, type AppSettings, type FailOn, type Format, type Framework, type OpenApiDocument } from './types.ts';

const HELP = `openapi-drift: keeps an OpenAPI document honest against the routes in the code

usage:
  openapi-drift check --spec <openapi.yaml> --source <dir> [options]
  openapi-drift routes --source <dir> [--framework nestjs|express] [--prefix /api]
  openapi-drift lint --spec <openapi.yaml>

options:
  --spec <file>          the OpenAPI 3 document (YAML or JSON)
  --source <dir>         the source tree of the backend (default: .)
  --framework <name>     ${FRAMEWORKS.join(', ')} or auto (default: auto)
  --prefix <path>        a prefix the code adds to every route and the source does not show (an Express
                         mount built dynamically, a NestJS prefix from the configuration). For NestJS it
                         is not needed otherwise: setGlobalPrefix and URI versioning are read from the
                         code. Given, it replaces what the code says (/ for no prefix at all). The
                         document's own base path (servers[0].url) is read by itself
  --format <name>        ${FORMATS.join(', ')} (default: text)
  --output <file>        write the report there as well as to stdout
  --fail-on <what>       any (default): exit 1 on drift in either direction; spec: only routes the
                         document lacks; code: only operations the code lacks; none: always exit 0
  --ignore <pattern>     leave out the drift on a path: /health, 'GET /internal/**' (* is one segment,
                         ** any number); may be given more than once
  --ignore-file <file>   ignore patterns from a file, one a line, # starts a comment
  --baseline <file>      drift that is known and accepted: it is reported and does not fail the run
  --update-baseline      write the drift of this run to the --baseline file and exit 0
  --version, --help

exit codes: 0 no drift (or --fail-on none), 1 drift, 2 bad usage or an unreadable document`;

const VALUE_FLAGS = ['spec', 'source', 'framework', 'prefix', 'format', 'output', 'fail-on', 'ignore-file', 'baseline'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export interface Options extends Partial<Record<ValueFlag, string>> {
  _: string[];
  /** Every `--ignore`, in the order given. */
  ignore?: string[];
  'update-baseline'?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const isValueFlag = (s: string): s is ValueFlag => (VALUE_FLAGS as readonly string[]).includes(s);

export function parseArgs(argv: string[]): Options {
  const opts: Options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--ignore' || a.startsWith('--ignore=')) {
      // the one option that adds up; a pattern may hold a space ('GET /health'), so it is taken whole
      const v = a === '--ignore' ? argv[++i] : a.slice('--ignore='.length);
      if (v === undefined || v.startsWith('--')) throw new Error('--ignore needs a value');
      (opts.ignore ??= []).push(v);
    } else if (a === '--update-baseline') opts['update-baseline'] = true;
    else if (a.startsWith('--') && isValueFlag(a.slice(2))) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a.slice(2) as ValueFlag] = v;
      i++;
    } else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      const k = a.slice(2, eq);
      if (!isValueFlag(k)) throw new Error(`unknown option --${k}`);
      opts[k] = a.slice(eq + 1);
    } else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

export function version(): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
}

const stdio: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

/** Runs the CLI and returns the exit code. `io` lets tests capture the output. */
export function main(argv: string[], io: Io = stdio): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.err(`openapi-drift: ${(e as Error).message}\n`);
    return 2;
  }
  if (opts.version) {
    io.out(`${version()}\n`);
    return 0;
  }
  const cmd = opts._[0];
  if (opts.help || !cmd) {
    io.out(`${HELP}\n`);
    return opts.help ? 0 : 2;
  }
  try {
    switch (cmd) {
      case 'lint':
        return lint(opts, io);
      case 'routes':
        return routes(opts, io);
      case 'check':
        return check(opts, io);
      default:
        io.err(`openapi-drift: unknown command '${cmd}'\n\n${HELP}\n`);
        return 2;
    }
  } catch (e) {
    io.err(`openapi-drift: ${(e as Error).message}\n`);
    return 2;
  }
}

function needSpec(opts: Options): { file: string; doc: OpenApiDocument; problems: string[] } {
  if (!opts.spec) throw new Error('--spec <file> is required');
  const doc = loadSpec(opts.spec);
  return { file: opts.spec, doc, problems: lintOpenApi(doc) };
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${name} ${value}: ${allowed.join(', ')}`);
}

/** Settings of the application that are in the code and could not be read, on stderr. */
function say(app: AppSettings | undefined, io: Io): void {
  for (const n of app?.notes ?? []) {
    io.err(`openapi-drift: ${path.relative(process.cwd(), n.file).replace(/\\/g, '/')}:${n.line}: ${n.message}\n`);
  }
}

function lint(opts: Options, io: Io): number {
  const { file, problems } = needSpec(opts);
  if (!problems.length) {
    io.out(`${file}: no problems\n`);
    return 0;
  }
  io.out(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const p of problems) io.out(`  ${p}\n`);
  return 1;
}

function routes(opts: Options, io: Io): number {
  const source = opts.source ?? '.';
  const framework = oneOf<Framework | 'auto'>('framework', opts.framework, [...FRAMEWORKS, 'auto'], 'auto');
  const found = extractRoutes(source, { framework, prefix: opts.prefix ?? '' });
  const relFile = (f: string): string => path.relative(process.cwd(), f).replace(/\\/g, '/');
  say(found.app, io);
  if (opts.format === 'json') {
    const shown = {
      framework: found.framework,
      prefix: found.prefix,
      ...(found.app ? { app: appJson(found.app, process.cwd()) } : {}),
      routes: found.routes.map((r) => ({ ...r, file: relFile(r.file) })),
    };
    io.out(JSON.stringify(shown, null, 2) + '\n');
    return 0;
  }
  io.out(`${source}: ${found.routes.length} routes (${found.framework})\n`);
  const read = readFromCode(found.app, process.cwd());
  if (read) io.out(`  read from the code: ${read}\n`);
  for (const r of found.routes) io.out(`  ${r.method.toUpperCase().padEnd(7)} ${r.path}  ${relFile(r.file)}:${r.line}\n`);
  return 0;
}

function check(opts: Options, io: Io): number {
  const { file, doc, problems } = needSpec(opts);
  if (problems.length) {
    io.err(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'}; fix the document first (openapi-drift lint)\n`);
    for (const p of problems) io.err(`  ${p}\n`);
    return 2;
  }
  const source = opts.source ?? '.';
  if (!fs.existsSync(source)) throw new Error(`--source ${source}: no such directory`);
  const format = oneOf<Format>('format', opts.format, FORMATS, 'text');
  const failOn = oneOf<FailOn>('fail-on', opts['fail-on'], FAIL_ON, 'any');
  const framework = oneOf<Framework | 'auto'>('framework', opts.framework, [...FRAMEWORKS, 'auto'], 'auto');

  const found = extractRoutes(source, { framework, prefix: opts.prefix ?? '' });
  say(found.app, io);
  const prefix = found.prefix;
  if (!found.routes.length) {
    io.err(
      `openapi-drift: no routes found in ${source} (${found.framework}); every operation of the document will be reported as missing\n`
    );
  }
  const ignore = [...(opts['ignore-file'] ? readIgnoreFile(opts['ignore-file']) : []), ...(opts.ignore ?? [])];
  const compared = compare(doc, found.routes, { prefix });
  if (opts['update-baseline']) {
    if (!opts.baseline) throw new Error('--update-baseline needs --baseline <file>');
    // what is ignored is not drift to accept: the patterns say so on every run
    const baseline = baselineOf(applyIgnore(compared, ignore));
    fs.mkdirSync(path.dirname(path.resolve(opts.baseline)), { recursive: true });
    fs.writeFileSync(opts.baseline, JSON.stringify(baseline, null, 2) + '\n');
    const n = baseline.missingInSpec.length + baseline.missingInCode.length;
    io.out(`${opts.baseline}: ${n} drift${n === 1 ? '' : 's'} recorded as the baseline\n`);
    return 0;
  }
  const result = applyIgnore(opts.baseline ? applyBaseline(compared, loadBaseline(opts.baseline)) : compared, ignore);
  const ctx = { spec: file, source, root: process.cwd(), ...(found.app ? { app: found.app } : {}) };
  const report =
    format === 'json' ? jsonReport(result, ctx) + '\n' : format === 'markdown' ? markdownReport(result, ctx) : textReport(result, ctx);
  io.out(report);
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, report);
  }
  return hasDrift(result, failOn) ? 1 : 0;
}
