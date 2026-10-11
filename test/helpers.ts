import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'openapi-drift.js');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const fixture = (...parts: string[]): string => path.join(FIXTURES, ...parts);

const tempDirs: string[] = [];
export function tempDir(prefix = 'openapi-drift-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI (`npm run build` first) in `cwd`. */
export function cli(args: string[], cwd: string = ROOT): Run {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
