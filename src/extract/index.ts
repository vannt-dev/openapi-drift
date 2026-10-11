import { sourceFiles, readText } from '../files.ts';
import { extractNestRoutes } from './nestjs.ts';
import { extractExpressRoutes } from './express.ts';
import { FRAMEWORKS, type ExtractOptions, type Framework, type Route } from '../types.ts';

/** 'nestjs' when a TypeScript source file declares a `@Controller`, otherwise 'express'. */
export function detectFramework(dir: string): Framework {
  for (const file of sourceFiles(dir, ['.ts', '.mts'])) {
    if (readText(file).includes('@Controller')) return 'nestjs';
  }
  return 'express';
}

export interface ExtractResult {
  framework: Framework;
  routes: Route[];
}

export function extractRoutes(
  dir: string,
  { framework = 'auto', prefix = '' }: ExtractOptions & { framework?: Framework | 'auto' } = {}
): ExtractResult {
  const fw = framework === 'auto' ? detectFramework(dir) : framework;
  if (fw === 'nestjs') return { framework: fw, routes: extractNestRoutes(dir, { prefix }) };
  if (fw === 'express') return { framework: fw, routes: extractExpressRoutes(dir, { prefix }) };
  throw new Error(`unknown framework '${String(framework)}' (${FRAMEWORKS.join(', ')} or auto)`);
}
