import fs from 'node:fs';
import { normalizePath } from './openapi.ts';
import { METHODS, type Baseline, type DriftResult } from './types.ts';

type Entry = { method: string; path: string };
type Matcher = (method: string, path: string) => boolean;

const isMethod = (s: string): boolean => (METHODS as readonly string[]).includes(s.toLowerCase());

/**
 * One ignore pattern as a test of a method and a path: `/health`, `GET /internal/**`, `* /metrics`.
 *
 * A pattern is a path, optionally after a method. `*` stands for one segment or a part of one, `**` for any number of
 * segments, none included. Like the comparison itself, it reads the path with parameter names and case ignored.
 */
export function parseIgnore(pattern: string): Matcher {
  const text = pattern.trim();
  if (!text) throw new Error('ignore: an empty pattern');
  const parts = text.split(/\s+/);
  const first = parts[0] as string;
  const hasMethod = parts.length === 2 && (first === '*' || isMethod(first));
  const glob = hasMethod ? (parts[1] as string) : text;
  if ((parts.length > 1 && !hasMethod) || !glob.startsWith('/')) {
    throw new Error(`ignore '${text}': a path starts with /, optionally after a method (GET /health)`);
  }
  const method = hasMethod && first !== '*' ? first.toLowerCase() : null;
  let source = '';
  for (const segment of normalizePath(glob).split('/').slice(1)) {
    if (segment === '**') source += '(?:/.*)?';
    else if (segment === '*') source += '/[^/]+';
    else source += '/' + segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  }
  const paths = new RegExp(`^${source}$`);
  return (m, p) => (method === null || method === m.toLowerCase()) && paths.test(normalizePath(p));
}

/** The patterns of an ignore file: one a line, `#` starts a comment, blank lines are skipped. */
export function readIgnoreFile(file: string): string[] {
  if (!fs.existsSync(file)) throw new Error(`--ignore-file ${file}: no such file`);
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * The result without the drift that `patterns` name, in both directions; the notes on those paths go with it. How
 * much was left out is kept in `ignored`, so that a report can say so.
 *
 * With a baseline as well, apply the baseline first: what is ignored is then taken out of what it accepted and of what
 * it calls resolved, where the other order would report an ignored entry of the baseline as resolved.
 */
export function applyIgnore(result: DriftResult, patterns: string[]): DriftResult {
  if (!patterns.length) return result;
  const rules = patterns.map(parseIgnore);
  const named = (x: Entry): boolean => rules.some((rule) => rule(x.method, x.path));
  const kept = <T extends Entry>(list: T[]): T[] => list.filter((x) => !named(x));
  const missingInSpec = kept(result.missingInSpec);
  const missingInCode = kept(result.missingInCode);
  const accepted = result.accepted && {
    missingInSpec: kept(result.accepted.missingInSpec),
    missingInCode: kept(result.accepted.missingInCode),
  };
  const dropped = (before: Entry[], after: Entry[], acceptedBefore: Entry[] = [], acceptedAfter: Entry[] = []): number =>
    before.length - after.length + acceptedBefore.length - acceptedAfter.length;
  return {
    ...result,
    missingInSpec,
    missingInCode,
    paramMismatch: kept(result.paramMismatch),
    ...(accepted ? { accepted } : {}),
    ...(result.resolved ? { resolved: result.resolved.filter((entry) => !named(parsed(entry))) } : {}),
    ignored: {
      missingInSpec:
        (result.ignored?.missingInSpec ?? 0) +
        dropped(result.missingInSpec, missingInSpec, result.accepted?.missingInSpec, accepted?.missingInSpec),
      missingInCode:
        (result.ignored?.missingInCode ?? 0) +
        dropped(result.missingInCode, missingInCode, result.accepted?.missingInCode, accepted?.missingInCode),
    },
  };
}

const written = (x: Entry): string => `${x.method.toUpperCase()} ${x.path}`;

/** A written entry (`GET /api/health`) as a method and a path. */
function parsed(entry: string): Entry {
  const text = entry.trim();
  const space = text.search(/\s/);
  return space < 0 ? { method: '', path: text } : { method: text.slice(0, space), path: text.slice(space).trim() };
}

/** What two entries have in common when they are the same drift: the method and the path as the comparison reads it. */
function keyOf(entry: string): string {
  const { method, path } = parsed(entry);
  return `${method.toLowerCase()} ${normalizePath(path)}`;
}

/** The drift of a result as a baseline: what a later run accepts instead of failing on. */
export function baselineOf(result: DriftResult): Baseline {
  return { version: 1, missingInSpec: result.missingInSpec.map(written), missingInCode: result.missingInCode.map(written) };
}

/** Reads a baseline file written by `--update-baseline`. */
export function loadBaseline(file: string): Baseline {
  if (!fs.existsSync(file)) throw new Error(`--baseline ${file}: no such file; --update-baseline writes it`);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--baseline ${file}: not JSON (${(e as Error).message})`, { cause: e });
  }
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const b = data as Partial<Baseline> | null;
  if (!b || typeof b !== 'object' || b.version !== 1 || !strings(b.missingInSpec) || !strings(b.missingInCode)) {
    throw new Error(`--baseline ${file}: expected {"version": 1, "missingInSpec": [...], "missingInCode": [...]}`);
  }
  return { version: 1, missingInSpec: b.missingInSpec, missingInCode: b.missingInCode };
}

/**
 * The result with the drift a baseline lists moved to `accepted`: still reported, no longer a failure. `resolved`
 * names the entries of the baseline that drift no more, so that the baseline can lose them.
 */
export function applyBaseline(result: DriftResult, baseline: Baseline): DriftResult {
  const split = <T extends Entry>(list: T[], entries: string[]): { fresh: T[]; accepted: T[]; resolved: string[] } => {
    const known = new Set(entries.map(keyOf));
    const met = new Set<string>();
    const fresh: T[] = [];
    const accepted: T[] = [];
    for (const x of list) {
      const key = keyOf(written(x));
      if (known.has(key)) {
        met.add(key);
        accepted.push(x);
      } else fresh.push(x);
    }
    return { fresh, accepted, resolved: entries.filter((entry) => !met.has(keyOf(entry))) };
  };
  const spec = split(result.missingInSpec, baseline.missingInSpec);
  const code = split(result.missingInCode, baseline.missingInCode);
  return {
    ...result,
    missingInSpec: spec.fresh,
    missingInCode: code.fresh,
    accepted: { missingInSpec: spec.accepted, missingInCode: code.accepted },
    resolved: [...spec.resolved, ...code.resolved],
  };
}
