import { sourceFiles, readText } from '../files.ts';
import { extractNest } from './nestjs.ts';
import { extractExpressRoutes } from './express.ts';
import { extractFastifyRoutes } from './fastify.ts';
import { extractSpring, hasSpringController } from './spring.ts';
import { FRAMEWORKS, type AppSettings, type ExtractOptions, type Framework, type Route } from '../types.ts';

const NODE_SOURCES = ['.js', '.mjs', '.cjs', '.ts', '.mts'];
const uses = (name: string): RegExp => new RegExp(`\\bfrom\\s+['"]${name}['"]|\\brequire\\s*\\(\\s*['"]${name}['"]\\s*\\)`);

/**
 * 'nestjs' when a TypeScript source file declares a `@Controller`; 'fastify' or 'express' when a source file
 * imports it; 'spring' when a Java or Kotlin file has a controller; otherwise 'express'.
 */
export function detectFramework(dir: string): Framework {
  for (const file of sourceFiles(dir, ['.ts', '.mts'])) {
    if (readText(file).includes('@Controller')) return 'nestjs';
  }
  const fastify = uses('fastify');
  const express = uses('express');
  let seenExpress = false;
  for (const file of sourceFiles(dir, NODE_SOURCES)) {
    const text = readText(file);
    if (fastify.test(text)) return 'fastify';
    seenExpress ||= express.test(text);
  }
  if (!seenExpress && hasSpringController(dir)) return 'spring';
  return 'express';
}

export interface ExtractResult {
  framework: Framework;
  routes: Route[];
  /** The prefix the routes are under: the one given, or the one read from a NestJS application's code. */
  prefix: string;
  /**
   * What was read from the application instead of being given (a NestJS global prefix and versioning, a Spring
   * context path), with notes on what is there and could not be read.
   */
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
  if (fw === 'spring') return { framework: fw, ...extractSpring(dir, { prefix }) };
  throw new Error(`unknown framework '${String(framework)}' (${FRAMEWORKS.join(', ')} or auto)`);
}
