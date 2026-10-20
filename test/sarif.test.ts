import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sarifReport, githubReport, operationLines } from '../src/index.ts';
import type { DriftResult, FailOn, ReportContext } from '../src/index.ts';
import { cli, fixture, tempDir } from './helpers.ts';

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: { physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string }; region?: { startLine: number } } }[];
  partialFingerprints?: Record<string, string>;
  suppressions?: { kind: string; justification?: string }[];
}
interface SarifLog {
  $schema: string;
  version: string;
  runs: {
    tool: {
      driver: {
        name: string;
        semanticVersion?: string;
        informationUri?: string;
        rules: { id: string; shortDescription: { text: string } }[];
      };
    };
    results: SarifResult[];
  }[];
}

const LEVELS = ['none', 'note', 'warning', 'error'];

/** The parts of SARIF 2.1.0 that GitHub code scanning and other readers rely on. */
function assertShape(log: SarifLog): SarifResult[] {
  assert.equal(log.version, '2.1.0');
  assert.match(log.$schema, /sarif-2\.1\.0/);
  assert.equal(log.runs.length, 1);
  const run = log.runs[0]!;
  assert.equal(run.tool.driver.name, 'openapi-drift');
  const ids = run.tool.driver.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  for (const rule of run.tool.driver.rules) assert.ok(rule.shortDescription.text, `${rule.id} has a description`);
  for (const r of run.results) {
    assert.equal(ids[r.ruleIndex], r.ruleId, 'ruleIndex points at the rule');
    assert.ok(LEVELS.includes(r.level), r.level);
    assert.ok(r.message.text.length > 0);
    assert.equal(r.locations.length, 1);
    const loc = r.locations[0]!.physicalLocation;
    assert.ok(!path.isAbsolute(loc.artifactLocation.uri) && !loc.artifactLocation.uri.includes('\\'), loc.artifactLocation.uri);
    if (loc.region) assert.ok(Number.isInteger(loc.region.startLine) && loc.region.startLine >= 1);
  }
  return run.results;
}

const root = path.resolve('/repo');
const at = (file: string): string => path.join(root, file);
const RESULT: DriftResult = {
  base: '/api',
  prefix: '/api',
  counts: { spec: 4, code: 4 },
  missingInSpec: [{ method: 'get', path: '/api/health', file: at('src/health.ts'), line: 5, hint: '' }],
  missingInCode: [
    { method: 'post', path: '/api/orders', specPath: '/orders', operationId: 'createOrder', hint: 'the path exists with GET' },
  ],
  paramMismatch: [
    { method: 'get', path: '/api/orders/{id}', specParams: ['id'], codeParams: ['orderId'], file: at('src/orders.ts'), line: 9 },
  ],
  queryMismatch: [{ method: 'get', path: '/api/users', codeOnly: ['page'], specOnly: [], file: at('src/users.ts'), line: 3 }],
  statusMismatch: [{ method: 'post', path: '/api/users', codeStatuses: [201], specResponses: ['200'], file: at('src/users.ts'), line: 8 }],
  accepted: { missingInSpec: [{ method: 'get', path: '/api/old', file: at('src/old.ts'), line: 2, hint: '' }], missingInCode: [] },
};
const ctx = (failOn: FailOn, strict = false): ReportContext => ({
  spec: path.join(root, 'openapi.yaml'),
  source: 'src',
  root,
  failOn,
  strict,
  specLines: new Map([['post /orders', 12]]),
  version: '9.9.9',
});
const levels = (results: SarifResult[]): Record<string, string> =>
  Object.fromEntries(results.map((r) => [r.suppressions ? `${r.ruleId} (accepted)` : r.ruleId, r.level]));

test('sarif: one result per finding, a stable rule each, levels as the run fails', () => {
  const log = JSON.parse(sarifReport(RESULT, ctx('any'))) as SarifLog;
  const results = assertShape(log);
  assert.equal(log.runs[0]!.tool.driver.semanticVersion, '9.9.9');
  assert.deepEqual(levels(results), {
    'missing-in-spec': 'error',
    'missing-in-code': 'error',
    'path-param-mismatch': 'note',
    'query-mismatch': 'note',
    'status-mismatch': 'note',
    'missing-in-spec (accepted)': 'note',
  });
  const health = results.find((r) => r.ruleId === 'missing-in-spec' && !r.suppressions)!;
  assert.deepEqual(health.locations[0]!.physicalLocation.artifactLocation, { uri: 'src/health.ts', uriBaseId: '%SRCROOT%' });
  assert.deepEqual(health.locations[0]!.physicalLocation.region, { startLine: 5 });
  assert.match(health.message.text, /GET \/api\/health/);
  // what exists only in the document points at the document, at the operation's line
  const order = results.find((r) => r.ruleId === 'missing-in-code')!;
  assert.equal(order.locations[0]!.physicalLocation.artifactLocation.uri, 'openapi.yaml');
  assert.deepEqual(order.locations[0]!.physicalLocation.region, { startLine: 12 });
  assert.match(order.message.text, /POST \/api\/orders \(createOrder\).*the path exists with GET/);
  const accepted = results.find((r) => r.suppressions)!;
  assert.equal(accepted.suppressions![0]!.kind, 'external');
  // the fingerprint follows the drift, not the line
  assert.equal(health.partialFingerprints!['openapiDrift/v1'], 'missing-in-spec GET /api/health');
});

test('sarif: --fail-on and --strict decide what is an error', () => {
  assert.deepEqual(levels(assertShape(JSON.parse(sarifReport(RESULT, ctx('spec'))) as SarifLog)), {
    'missing-in-spec': 'error',
    'missing-in-code': 'warning',
    'path-param-mismatch': 'note',
    'query-mismatch': 'note',
    'status-mismatch': 'note',
    'missing-in-spec (accepted)': 'note',
  });
  const strict = levels(assertShape(JSON.parse(sarifReport(RESULT, ctx('code', true))) as SarifLog));
  assert.deepEqual(
    [strict['missing-in-spec'], strict['missing-in-code'], strict['query-mismatch'], strict['status-mismatch']],
    ['warning', 'error', 'error', 'error']
  );
  const none = levels(assertShape(JSON.parse(sarifReport(RESULT, ctx('none', true))) as SarifLog));
  assert.deepEqual([none['missing-in-spec'], none['missing-in-code'], none['query-mismatch']], ['warning', 'warning', 'note']);
});

test('sarif: without the lines of the document, a finding of the document points at the file', () => {
  const rest = ctx('any');
  delete rest.specLines;
  const results = assertShape(JSON.parse(sarifReport(RESULT, rest)) as SarifLog);
  const order = results.find((r) => r.ruleId === 'missing-in-code')!;
  assert.equal(order.locations[0]!.physicalLocation.artifactLocation.uri, 'openapi.yaml');
  assert.equal(order.locations[0]!.physicalLocation.region, undefined);
});

test('github: a workflow command a finding, escaped, the accepted left out', () => {
  const lines = githubReport(RESULT, ctx('spec')).trimEnd().split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /^::error file=src\/health\.ts,line=5,title=openapi-drift\/missing-in-spec::GET \/api\/health /);
  assert.ok(lines.some((l) => /^::warning file=openapi\.yaml,line=12,title=openapi-drift\/missing-in-code::POST \/api\/orders/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('::notice file=src/users.ts,line=3,')));
  const odd: DriftResult = { ...RESULT, missingInSpec: [{ ...RESULT.missingInSpec[0]!, path: '/a%b', file: at('src/x,y:z.ts') }] };
  const first = githubReport(odd, ctx('any')).split('\n')[0]!;
  assert.match(first, /^::error file=src\/x%2Cy%3Az\.ts,line=5,.*::GET \/a%25b /);
});

test('operationLines: the line of each method key, in YAML and in JSON', () => {
  const yaml = fs.readFileSync(fixture('nestjs', 'openapi.yaml'), 'utf8');
  const lines = operationLines(yaml);
  assert.equal(lines.get('get /users'), 9);
  assert.equal(lines.get('post /orders'), 62);
  assert.equal(lines.get('get /users/{id}/avatar'), 44);
  const json = operationLines('{\n  "openapi": "3.0.0",\n  "paths": {\n    "/ping": {\n      "get": {"responses": {}}\n    }\n  }\n}\n');
  assert.equal(json.get('get /ping'), 5);
  assert.equal(operationLines('not: [valid').size, 0);
});

test('check --format sarif and github on a fixture: written to --output, exit code as for the other formats', () => {
  const cwd = fixture('nestjs');
  const out = path.join(tempDir(), 'drift.sarif');
  const r = cli(['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api', '--format', 'sarif', '--output', out], cwd);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), r.stdout);
  const results = assertShape(JSON.parse(r.stdout) as SarifLog);
  // 7 drifts and one path parameter named differently
  assert.equal(results.length, 8);
  assert.equal(results.filter((x) => x.level === 'error').length, 7);
  const del = results.find((x) => x.message.text.startsWith('DELETE /api/users/{id}'))!;
  assert.deepEqual(del.locations[0]!.physicalLocation.artifactLocation.uri, 'src/users/users.controller.ts');
  assert.deepEqual(del.locations[0]!.physicalLocation.region, { startLine: 27 });
  const avatar = results.find((x) => x.message.text.startsWith('GET /api/users/{id}/avatar'))!;
  assert.equal(avatar.locations[0]!.physicalLocation.artifactLocation.uri, 'openapi.yaml');
  assert.deepEqual(avatar.locations[0]!.physicalLocation.region, { startLine: 44 });

  const gh = cli(
    ['check', '--spec', 'openapi.yaml', '--source', 'src', '--prefix', '/api', '--format', 'github', '--fail-on', 'none'],
    cwd
  );
  assert.equal(gh.status, 0, gh.stderr);
  const commands = gh.stdout.trimEnd().split('\n');
  assert.equal(commands.length, 8);
  assert.ok(
    commands.every((l) => /^::(warning|notice) file=[^,]+(,line=\d+)?,title=openapi-drift\/[a-z-]+::\S/.test(l)),
    gh.stdout
  );
});
