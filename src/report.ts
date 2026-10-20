import path from 'node:path';
import { joinPath } from './openapi.ts';
import type { AppSettings, DriftResult, HttpMethod, MissingInCode, MissingInSpec, ReportContext } from './types.ts';

const rel = (file: string, root: string): string => path.relative(root, file).replace(/\\/g, '/');
const where = (x: { file?: string; line?: number }, root: string): string => (x.file ? ` (${rel(x.file, root)}:${x.line})` : '');
const verb = (m: string): string => m.toUpperCase().padEnd(7);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What was read from the code instead of being given, as one line: where the global prefix is set and how
 * versions are put in the path. Empty when nothing was read. `code` wraps what is code (Markdown backticks).
 */
export function readFromCode(app: AppSettings | undefined, root: string, code: (s: string) => string = (s) => s): string {
  const parts: string[] = [];
  if (app?.prefix) {
    const left = app.prefix.exclude.length ? `, ${plural(app.prefix.exclude.length, 'route')} left out of it` : '';
    parts.push(`global prefix ${code(joinPath(app.prefix.value))} (${code(`${rel(app.prefix.file, root)}:${app.prefix.line}`)}${left})`);
  }
  if (app?.versioning) {
    const v = app.versioning;
    const defaults = v.defaults.map((d) => (d === '' ? 'none' : code(d))).join(' and ');
    parts.push(
      `versions in the path as ${code(`${v.prefix}<version>`)}${defaults ? `, ${defaults} by default` : ''} (${code(`${rel(v.file, root)}:${v.line}`)})`
    );
  }
  return parts.join('; ');
}

const IN_CODE = 'in the code, not in the document';
const IN_SPEC = 'in the document, not in the code';

/** What a baseline and the ignore patterns took out of the drift that fails. */
function setAside(result: DriftResult): { accepted: number; ignored: number; resolved: string[] } {
  return {
    accepted: (result.accepted?.missingInSpec.length ?? 0) + (result.accepted?.missingInCode.length ?? 0),
    ignored: (result.ignored?.missingInSpec ?? 0) + (result.ignored?.missingInCode ?? 0),
    resolved: result.resolved ?? [],
  };
}

/** The result as plain text for a terminal. */
export function textReport(result: DriftResult, { spec, source, root, app, strict = false }: ReportContext): string {
  const lines: string[] = [];
  const total = result.missingInSpec.length + result.missingInCode.length;
  const details = result.queryMismatch.length + result.statusMismatch.length;
  const { accepted, ignored, resolved } = setAside(result);
  const read = readFromCode(app, root);
  lines.push(`${spec}: ${plural(result.counts.spec, 'operation')}${result.base ? ` under ${result.base}` : ''}`);
  lines.push(`${source}: ${plural(result.counts.code, 'route')}${result.prefix ? ` under ${result.prefix}` : ''}`);
  if (read) lines.push(`  read from the code: ${read}`);
  if (result.missingInSpec.length) {
    lines.push('', `In the code, not in the document (${result.missingInSpec.length}):`);
    for (const r of result.missingInSpec) lines.push(`  ${verb(r.method)} ${r.path}${where(r, root)}${r.hint ? ` — ${r.hint}` : ''}`);
  }
  if (result.missingInCode.length) {
    lines.push('', `In the document, not in the code (${result.missingInCode.length}):`);
    for (const r of result.missingInCode)
      lines.push(`  ${verb(r.method)} ${r.path}${r.operationId ? ` (${r.operationId})` : ''}${r.hint ? ` — ${r.hint}` : ''}`);
  }
  if (result.paramMismatch.length) {
    lines.push('', `Path parameters named differently (${result.paramMismatch.length}, not a failure):`);
    for (const r of result.paramMismatch) {
      lines.push(
        `  ${verb(r.method)} ${r.path}: document {${r.specParams.join(', ')}}, code {${r.codeParams.join(', ')}}${where(r, root)}`
      );
    }
  }
  const aside = strict ? '' : ', not a failure';
  if (result.queryMismatch.length) {
    lines.push('', `Query parameters that differ (${result.queryMismatch.length}${aside}):`);
    for (const r of result.queryMismatch) {
      const sides = [
        r.codeOnly.length ? `in the code only: ${r.codeOnly.join(', ')}` : '',
        r.specOnly.length ? `in the document only: ${r.specOnly.join(', ')}` : '',
      ];
      lines.push(`  ${verb(r.method)} ${r.path}: ${sides.filter(Boolean).join('; ')}${where(r, root)}`);
    }
  }
  if (result.statusMismatch.length) {
    lines.push('', `Status codes that differ (${result.statusMismatch.length}${aside}):`);
    for (const r of result.statusMismatch) {
      lines.push(
        `  ${verb(r.method)} ${r.path}: the code answers ${r.codeStatuses.join(', ')}; the document describes ${r.specResponses.join(', ')}${where(r, root)}`
      );
    }
  }
  if (accepted) {
    lines.push('', `Accepted by the baseline (${accepted}, not a failure):`);
    for (const r of result.accepted?.missingInSpec ?? []) lines.push(`  ${verb(r.method)} ${r.path}${where(r, root)} — ${IN_CODE}`);
    for (const r of result.accepted?.missingInCode ?? [])
      lines.push(`  ${verb(r.method)} ${r.path}${r.operationId ? ` (${r.operationId})` : ''} — ${IN_SPEC}`);
  }
  if (resolved.length) {
    lines.push('', `No longer drifting, to take out of the baseline (${resolved.length}):`);
    for (const entry of resolved) lines.push(`  ${entry}`);
  }
  if (ignored) lines.push('', `Left out by the ignore patterns: ${ignored}.`);
  lines.push('');
  if (total) lines.push(`${plural(total, 'drift')}${accepted ? `, and ${accepted} accepted by the baseline` : ''}.`);
  else if (accepted) lines.push(`No new drift: ${accepted} accepted by the baseline.`);
  else if (details) lines.push('No drift in the routes; what differs is in what the operations take and answer.');
  else lines.push('No drift: the document and the code agree.');
  if (strict && details) lines.push(`${plural(details, 'difference')} fail${details === 1 ? 's' : ''} the run (--strict).`);
  return lines.join('\n') + '\n';
}

/** The result as Markdown (a pull request comment, a job summary). */
export function markdownReport(result: DriftResult, { spec, source, root, app, strict = false }: ReportContext): string {
  const lines: string[] = [];
  const total = result.missingInSpec.length + result.missingInCode.length;
  const details = result.queryMismatch.length + result.statusMismatch.length;
  const aside = strict ? '' : ' (not a failure)';
  const codes = (list: (string | number)[]): string => list.map((x) => `\`${x}\``).join(', ');
  const { accepted, ignored, resolved } = setAside(result);
  lines.push(`## OpenAPI drift: ${total ? plural(total, 'drift') : 'none'}`, '');
  lines.push(
    `\`${spec}\`: ${plural(result.counts.spec, 'operation')}${result.base ? ` under \`${result.base}\`` : ''} · ` +
      `\`${source}\`: ${plural(result.counts.code, 'route')}${result.prefix ? ` under \`${result.prefix}\`` : ''}`,
    ''
  );
  const read = readFromCode(app, root, (s) => `\`${s}\``);
  if (read) lines.push(`Read from the code: ${read}`, '');
  const table = (title: string, rows: string[][], cols: string[]): void => {
    if (!rows.length) return;
    lines.push(`### ${title} (${rows.length})`, '', `| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
    for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
    lines.push('');
  };
  table(
    'In the code, not in the document',
    result.missingInSpec.map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, `\`${rel(r.file, root)}:${r.line}\``, r.hint]),
    ['Route', 'Where', 'Note']
  );
  table(
    'In the document, not in the code',
    result.missingInCode.map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, r.operationId ? `\`${r.operationId}\`` : '', r.hint]),
    ['Operation', 'operationId', 'Note']
  );
  table(
    'Path parameters named differently (not a failure)',
    result.paramMismatch.map((r) => [
      `\`${r.method.toUpperCase()} ${r.path}\``,
      `\`{${r.specParams.join(', ')}}\``,
      `\`{${r.codeParams.join(', ')}}\``,
    ]),
    ['Operation', 'Document', 'Code']
  );
  table(
    `Query parameters that differ${aside}`,
    result.queryMismatch.map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, codes(r.codeOnly), codes(r.specOnly)]),
    ['Operation', 'In the code only', 'In the document only']
  );
  table(
    `Status codes that differ${aside}`,
    result.statusMismatch.map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, codes(r.codeStatuses), codes(r.specResponses)]),
    ['Operation', 'The code answers', 'The document describes']
  );
  table(
    'Accepted by the baseline, not a failure',
    [
      ...(result.accepted?.missingInSpec ?? []).map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, IN_CODE]),
      ...(result.accepted?.missingInCode ?? []).map((r) => [`\`${r.method.toUpperCase()} ${r.path}\``, IN_SPEC]),
    ],
    ['Drift', 'Where it stands']
  );
  table(
    'No longer drifting, to take out of the baseline',
    resolved.map((entry) => [`\`${entry}\``]),
    ['Entry']
  );
  if (ignored) lines.push(`Left out by the ignore patterns: ${ignored}.`, '');
  if (!total && !result.paramMismatch.length && !accepted && !details) lines.push('The document and the code agree.', '');
  if (strict && details) lines.push(`${plural(details, 'difference')} fail${details === 1 ? 's' : ''} the run (\`--strict\`).`, '');
  return lines.join('\n');
}

/** The result as JSON, file paths relative to `root`. */
export function jsonReport(result: DriftResult, { spec, source, root, app }: ReportContext): string {
  return JSON.stringify(
    {
      spec,
      source,
      base: result.base,
      prefix: result.prefix,
      ...(app ? { app: appJson(app, root) } : {}),
      counts: result.counts,
      missingInSpec: result.missingInSpec.map((r) => ({ ...r, file: rel(r.file, root) })),
      missingInCode: result.missingInCode,
      paramMismatch: result.paramMismatch.map((r) => ({ ...r, file: rel(r.file, root) })),
      queryMismatch: result.queryMismatch.map((r) => ({ ...r, file: rel(r.file, root) })),
      statusMismatch: result.statusMismatch.map((r) => ({ ...r, file: rel(r.file, root) })),
      ...(result.ignored ? { ignored: result.ignored } : {}),
      ...(result.accepted
        ? {
            accepted: {
              missingInSpec: result.accepted.missingInSpec.map((r) => ({ ...r, file: rel(r.file, root) })),
              missingInCode: result.accepted.missingInCode,
            },
          }
        : {}),
      ...(result.resolved ? { resolved: result.resolved } : {}),
    },
    null,
    2
  );
}

/** What was read from the code, file paths relative to `root`. */
export function appJson(app: AppSettings, root: string): AppSettings {
  return {
    ...(app.prefix ? { prefix: { ...app.prefix, file: rel(app.prefix.file, root) } } : {}),
    ...(app.versioning ? { versioning: { ...app.versioning, file: rel(app.versioning.file, root) } } : {}),
    notes: app.notes.map((n) => ({ ...n, file: rel(n.file, root) })),
  };
}

/** The kinds of drift, one SARIF rule each; the ids are stable, code scanning tracks alerts by them. */
const RULES = [
  { id: 'missing-in-spec', text: 'A route the code serves that the OpenAPI document does not describe', level: 'error' },
  { id: 'missing-in-code', text: 'An operation the OpenAPI document describes that no route of the code serves', level: 'error' },
  { id: 'path-param-mismatch', text: 'An operation whose path parameters are named differently in the code', level: 'note' },
  { id: 'query-mismatch', text: 'An operation whose query parameters differ between the document and the handler', level: 'note' },
  { id: 'status-mismatch', text: 'A handler that answers with a status the document does not describe', level: 'note' },
] as const;
type RuleId = (typeof RULES)[number]['id'];
type Level = 'error' | 'warning' | 'note';

/** One finding, wherever it is: a file relative to the root, and its line when known. */
interface Finding {
  rule: RuleId;
  level: Level;
  /** `GET /api/users/{id}`: what the finding is about, whatever line it moves to. */
  key: string;
  message: string;
  file: string;
  line?: number;
  /** Drift a baseline accepts. */
  accepted?: boolean;
}

/**
 * The findings of a result, with the level the run gives them: an error when it fails the run under the
 * `--fail-on` policy and `--strict`, as `hasDrift` decides; a warning for drift in the routes that does not;
 * a note for the rest (path parameters named differently, query and status differences without `--strict`,
 * drift a baseline accepts).
 */
function findings(result: DriftResult, { spec, source, root, strict = false, failOn = 'any', specLines }: ReportContext): Finding[] {
  const specFile = rel(spec, root);
  const op = (method: HttpMethod, p: string): string => `${method.toUpperCase()} ${p}`;
  const hint = (h: string): string => (h ? ` (${h})` : '');
  const fails = {
    spec: failOn === 'any' || failOn === 'spec',
    code: failOn === 'any' || failOn === 'code',
    details: strict && failOn !== 'none',
  };
  const inCode = (r: MissingInSpec, level: Level, accepted = false): Finding => ({
    rule: 'missing-in-spec',
    level,
    key: op(r.method, r.path),
    message: `${op(r.method, r.path)} is served by the code and not described in ${specFile}${hint(r.hint)}.`,
    file: rel(r.file, root),
    line: r.line,
    ...(accepted ? { accepted } : {}),
  });
  const inSpec = (r: MissingInCode, level: Level, accepted = false): Finding => {
    const line = specLines?.get(`${r.method} ${r.specPath}`);
    const id = r.operationId ? ` (${r.operationId})` : '';
    return {
      rule: 'missing-in-code',
      level,
      key: op(r.method, r.path),
      message: `${op(r.method, r.path)}${id} is described in ${specFile} and served by no route in ${source}${hint(r.hint)}.`,
      file: specFile,
      ...(line ? { line } : {}),
      ...(accepted ? { accepted } : {}),
    };
  };
  const at = (r: { method: HttpMethod; path: string; file: string; line: number }) => ({
    key: op(r.method, r.path),
    file: rel(r.file, root),
    line: r.line,
  });
  const detail: Level = fails.details ? 'error' : 'note';
  const out: Finding[] = [
    ...result.missingInSpec.map((r) => inCode(r, fails.spec ? 'error' : 'warning')),
    ...result.missingInCode.map((r) => inSpec(r, fails.code ? 'error' : 'warning')),
    ...result.paramMismatch.map((r): Finding => ({
      rule: 'path-param-mismatch',
      level: 'note',
      message: `${op(r.method, r.path)}: the path parameters are {${r.specParams.join(', ')}} in the document, {${r.codeParams.join(', ')}} in the code.`,
      ...at(r),
    })),
    ...result.queryMismatch.map((r): Finding => {
      const sides = [
        r.codeOnly.length ? `in the code only: ${r.codeOnly.join(', ')}` : '',
        r.specOnly.length ? `in the document only: ${r.specOnly.join(', ')}` : '',
      ];
      return {
        rule: 'query-mismatch',
        level: detail,
        message: `${op(r.method, r.path)}: query parameters ${sides.filter(Boolean).join('; ')}.`,
        ...at(r),
      };
    }),
    ...result.statusMismatch.map((r): Finding => ({
      rule: 'status-mismatch',
      level: detail,
      message: `${op(r.method, r.path)}: the code answers ${r.codeStatuses.join(', ')}; the document describes ${r.specResponses.join(', ')}.`,
      ...at(r),
    })),
  ];
  for (const r of result.accepted?.missingInSpec ?? []) out.push(inCode(r, 'note', true));
  for (const r of result.accepted?.missingInCode ?? []) out.push(inSpec(r, 'note', true));
  return out;
}

/**
 * The result as a SARIF 2.1.0 log, for GitHub code scanning (`github/codeql-action/upload-sarif`) and other
 * readers: a result a finding, a rule a kind of drift. Paths are relative to `root`. What only the document has
 * points at the document, at the operation's line when `specLines` gives it.
 */
export function sarifReport(result: DriftResult, ctx: ReportContext): string {
  const results = findings(result, ctx).map((f) => ({
    ruleId: f.rule,
    ruleIndex: RULES.findIndex((r) => r.id === f.rule),
    level: f.level,
    message: { text: f.accepted ? `${f.message} Accepted by the baseline.` : f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: encodeURI(f.file), uriBaseId: '%SRCROOT%' },
          ...(f.line ? { region: { startLine: f.line } } : {}),
        },
      },
    ],
    partialFingerprints: { 'openapiDrift/v1': `${f.rule} ${f.key}` },
    ...(f.accepted ? { suppressions: [{ kind: 'external', justification: 'accepted by the openapi-drift baseline' }] } : {}),
  }));
  const driver = {
    name: 'openapi-drift',
    informationUri: 'https://github.com/vannt-dev/openapi-drift',
    ...(ctx.version ? { semanticVersion: ctx.version } : {}),
    rules: RULES.map((r) => ({
      id: r.id,
      shortDescription: { text: r.text },
      defaultConfiguration: { level: r.level },
      helpUri: 'https://github.com/vannt-dev/openapi-drift#readme',
    })),
  };
  return JSON.stringify(
    { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver }, results }] },
    null,
    2
  );
}

/** `%`, CR and LF escaped for a workflow command; in a property, `:` and `,` as well. */
const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string): string => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const COMMAND: Record<Level, string> = { error: 'error', warning: 'warning', note: 'notice' };

/**
 * The result as GitHub Actions workflow commands (`::error file=...,line=...::message`), one a finding, so that
 * drift shows on the lines of a pull request without code scanning. Drift a baseline accepts is left out.
 */
export function githubReport(result: DriftResult, ctx: ReportContext): string {
  return findings(result, ctx)
    .filter((f) => !f.accepted)
    .map((f) => {
      const props = [`file=${escapeProperty(f.file)}`, ...(f.line ? [`line=${f.line}`] : []), `title=openapi-drift/${f.rule}`];
      return `::${COMMAND[f.level]} ${props.join(',')}::${escapeData(f.message)}\n`;
    })
    .join('');
}
