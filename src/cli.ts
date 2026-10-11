import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec, lintOpenApi } from './openapi.ts';
import { extractRoutes } from './extract/index.ts';
import { compare, hasDrift } from './compare.ts';
import { textReport, markdownReport, jsonReport } from './report.ts';
import { FAIL_ON, FORMATS, FRAMEWORKS, type FailOn, type Format, type Framework, type OpenApiDocument } from './types.ts';

const HELP = `openapi-drift: keeps an OpenAPI document honest against the routes in the code

usage:
  openapi-drift check --spec <openapi.yaml> --source <dir> [options]
  openapi-drift routes --source <dir> [--framework nestjs|express] [--prefix /api]
  openapi-drift lint --spec <openapi.yaml>

options:
  --spec <file>          the OpenAPI 3 document (YAML or JSON)
  --source <dir>         the source tree of the backend (default: .)
  --framework <name>     ${FRAMEWORKS.join(', ')} or auto (default: auto)
  --prefix <path>        a prefix the code adds to every route and the source does not show (NestJS
                         setGlobalPrefix, an Express mount built dynamically); the document's own base
                         path (servers[0].url) is read by itself
  --format <name>        ${FORMATS.join(', ')} (default: text)
  --output <file>        write the report there as well as to stdout
  --fail-on <what>       any (default): exit 1 on drift in either direction; spec: only routes the
                         document lacks; code: only operations the code lacks; none: always exit 0
  --version, --help

exit codes: 0 no drift (or --fail-on none), 1 drift, 2 bad usage or an unreadable document`;

const VALUE_FLAGS = ['spec', 'source', 'framework', 'prefix', 'format', 'output', 'fail-on'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export interface Options extends Partial<Record<ValueFlag, string>> {
  _: string[];
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
    if (a.startsWith('--') && isValueFlag(a.slice(2))) {
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
  if (opts.format === 'json') {
    io.out(
      JSON.stringify({ framework: found.framework, routes: found.routes.map((r) => ({ ...r, file: relFile(r.file) })) }, null, 2) + '\n'
    );
    return 0;
  }
  io.out(`${source}: ${found.routes.length} routes (${found.framework})\n`);
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
  const prefix = opts.prefix ?? '';

  const found = extractRoutes(source, { framework, prefix });
  if (!found.routes.length) {
    io.err(
      `openapi-drift: no routes found in ${source} (${found.framework}); every operation of the document will be reported as missing\n`
    );
  }
  const result = compare(doc, found.routes, { prefix });
  const ctx = { spec: file, source, root: process.cwd() };
  const report =
    format === 'json' ? jsonReport(result, ctx) + '\n' : format === 'markdown' ? markdownReport(result, ctx) : textReport(result, ctx);
  io.out(report);
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, report);
  }
  return hasDrift(result, failOn) ? 1 : 0;
}
