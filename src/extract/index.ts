import { sourceFiles, readText } from '../files.ts';
import { extractNest } from './nestjs.ts';
import { extractExpressRoutes } from './express.ts';
import { extractFastifyRoutes } from './fastify.ts';
import { FRAMEWORKS, type AppSettings, type ExtractOptions, type Framework, type Route } from '../types.ts';

const NODE_SOURCES = ['.js', '.mjs', '.cjs', '.ts', '.mts'];
const uses = (name: string): RegExp => new RegExp(`\\bfrom\\s+['"]${name}['"]|\\brequire\\s*\\(\\s*['"]${name}['"]\\s*\\)`);

/**
 * 'nestjs' when a TypeScript source file declares a `@Controller`; 'fastify' when a source file imports
 * `fastify`; otherwise 'express'.
 */
export function detectFramework(dir: string): Framework {
  for (const file of sourceFiles(dir, ['.ts', '.mts'])) {
    if (readText(file).includes('@Controller')) return 'nestjs';
  }
  const fastify = uses('fastify');
  for (const file of sourceFiles(dir, NODE_SOURCES)) {
    if (fastify.test(readText(file))) return 'fastify';
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
  if (fw === 'fastify') return { framework: fw, routes: extractFastifyRoutes(dir, { prefix }), prefix };
  throw new Error(`unknown framework '${String(framework)}' (${FRAMEWORKS.join(', ')} or auto)`);
}
