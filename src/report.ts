import path from 'node:path';
import type { DriftResult, ReportContext } from './types.ts';

const rel = (file: string, root: string): string => path.relative(root, file).replace(/\\/g, '/');
const where = (x: { file?: string; line?: number }, root: string): string => (x.file ? ` (${rel(x.file, root)}:${x.line})` : '');
const verb = (m: string): string => m.toUpperCase().padEnd(7);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The result as plain text for a terminal. */
export function textReport(result: DriftResult, { spec, source, root }: ReportContext): string {
  const lines: string[] = [];
  const total = result.missingInSpec.length + result.missingInCode.length;
  lines.push(`${spec}: ${plural(result.counts.spec, 'operation')}${result.base ? ` under ${result.base}` : ''}`);
  lines.push(`${source}: ${plural(result.counts.code, 'route')}${result.prefix ? ` under ${result.prefix}` : ''}`);
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
  lines.push('', total ? `${plural(total, 'drift')}.` : 'No drift: the document and the code agree.');
  return lines.join('\n') + '\n';
}

/** The result as Markdown (a pull request comment, a job summary). */
export function markdownReport(result: DriftResult, { spec, source, root }: ReportContext): string {
  const lines: string[] = [];
  const total = result.missingInSpec.length + result.missingInCode.length;
  lines.push(`## OpenAPI drift: ${total ? plural(total, 'drift') : 'none'}`, '');
  lines.push(
    `\`${spec}\`: ${plural(result.counts.spec, 'operation')}${result.base ? ` under \`${result.base}\`` : ''} · ` +
      `\`${source}\`: ${plural(result.counts.code, 'route')}${result.prefix ? ` under \`${result.prefix}\`` : ''}`,
    ''
  );
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
  if (!total && !result.paramMismatch.length) lines.push('The document and the code agree.', '');
  return lines.join('\n');
}

/** The result as JSON, file paths relative to `root`. */
export function jsonReport(result: DriftResult, { spec, source, root }: ReportContext): string {
  return JSON.stringify(
    {
      spec,
      source,
      base: result.base,
      prefix: result.prefix,
      counts: result.counts,
      missingInSpec: result.missingInSpec.map((r) => ({ ...r, file: rel(r.file, root) })),
      missingInCode: result.missingInCode,
      paramMismatch: result.paramMismatch.map((r) => ({ ...r, file: rel(r.file, root) })),
    },
    null,
    2
  );
}
