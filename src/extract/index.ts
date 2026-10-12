import { sourceFiles, readText } from '../files.ts';
import { extractNest } from './nestjs.ts';
import { extractExpressRoutes } from './express.ts';
import { FRAMEWORKS, type AppSettings, type ExtractOptions, type Framework, type Route } from '../types.ts';

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
  /** The prefix the routes are under: the one given, or the one read from a NestJS application's code. */
  prefix: string;
  /** What was read from a NestJS application's source; absent when a prefix was given. */
  app?: AppSettings;
}

export function extractRoutes(
  dir: string,
  { framework = 'auto', prefix = '' }: ExtractOptions & { framework?: Framework | 'auto' } = {}
): ExtractResult {
  const fw = framework === 'auto' ? detectFramework(dir) : framework;
  if (fw === 'nestjs') return { framework: fw, ...extractNest(dir, { prefix }) };
  if (fw === 'express') return { framework: fw, routes: extractExpressRoutes(dir, { prefix }), prefix };
  throw new Error(`unknown framework '${String(framework)}' (${FRAMEWORKS.join(', ')} or auto)`);
}
