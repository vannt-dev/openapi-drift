export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof METHODS)[number];

/** A route the code serves, with the path templated the OpenAPI way (`/users/{id}`). */
export interface Route {
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
}

/** An operation of an OpenAPI document, path as written under `paths`. */
export interface Operation {
  method: HttpMethod;
  path: string;
  params: string[];
  operationId?: string;
}

export type Framework = 'nestjs' | 'express';
export const FRAMEWORKS: readonly Framework[] = ['nestjs', 'express'];

export interface ExtractOptions {
  /** A prefix the code adds to every route and the source does not show (NestJS `setGlobalPrefix`). */
  prefix?: string;
}

export interface MissingInSpec extends Route {
  /** 'the path exists with GET, POST' when the document knows the path with other methods. */
  hint: string;
}

export interface MissingInCode {
  method: HttpMethod;
  /** The full path, base path included. */
  path: string;
  specPath: string;
  operationId?: string;
  hint: string;
}

export interface ParamMismatch {
  method: HttpMethod;
  path: string;
  specParams: string[];
  codeParams: string[];
  file: string;
  line: number;
}

export interface DriftResult {
  base: string;
  prefix: string;
  counts: { spec: number; code: number };
  missingInSpec: MissingInSpec[];
  missingInCode: MissingInCode[];
  paramMismatch: ParamMismatch[];
}

export type FailOn = 'any' | 'spec' | 'code' | 'none';
export const FAIL_ON: readonly FailOn[] = ['any', 'spec', 'code', 'none'];

export type Format = 'text' | 'markdown' | 'json';
export const FORMATS: readonly Format[] = ['text', 'markdown', 'json'];

export interface ReportContext {
  spec: string;
  source: string;
  /** Paths in the report are shown relative to this directory. */
  root: string;
}

/** An OpenAPI document as parsed; only what this tool reads is typed. */
export interface OpenApiDocument {
  openapi?: unknown;
  servers?: { url?: unknown }[];
  paths?: Record<string, PathItem | undefined>;
  [key: string]: unknown;
}

export interface PathItem {
  parameters?: Parameter[];
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
}

export interface OperationObject {
  operationId?: string;
  parameters?: Parameter[];
  responses?: Record<string, unknown>;
  requestBody?: { content?: unknown };
}

export interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
}
