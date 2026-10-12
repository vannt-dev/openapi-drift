export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
export type HttpMethod = (typeof METHODS)[number];

/** A route the code serves, with the path templated the OpenAPI way (`/users/{id}`). */
export interface Route {
  method: HttpMethod;
  path: string;
  file: string;
  line: number;
  /**
   * The query parameters the handler reads by name, when the source shows them. `complete` says the list is
   * all of them (a NestJS signature where every `@Query` has a name); otherwise it is only what was seen
   * (an Express handler written in place).
   */
  query?: { names: string[]; complete: boolean };
  /**
   * The statuses the handler is seen to answer with: for NestJS the one of a successful answer (`@HttpCode`,
   * or 201 for a POST and 200 for the rest), for Express the ones written as numbers in the handler.
   */
  statuses?: number[];
  /**
   * Served by the framework without being written (Fastify answers HEAD wherever there is a GET). Such a route
   * matches an operation of the document that describes it, and is not drift when the document does not.
   */
  implicit?: boolean;
}

/** An operation of an OpenAPI document, path as written under `paths`. */
export interface Operation {
  method: HttpMethod;
  path: string;
  params: string[];
  operationId?: string;
  /** The names of its `in: query` parameters, the path's included. */
  query: string[];
  /** The keys of its `responses`: `200`, `2XX`, `default`. */
  responses: string[];
}

export type Framework = 'nestjs' | 'express' | 'fastify';
export const FRAMEWORKS: readonly Framework[] = ['nestjs', 'express', 'fastify'];

export interface ExtractOptions {
  /**
   * A prefix the code adds to every route and the source does not show. Given, it is used as it is and nothing
   * is read from the code (`/` for no prefix at all). Left out or empty, a NestJS application's own settings
   * are read from its source: `setGlobalPrefix` and URI versioning.
   */
  prefix?: string;
}

/** A route `setGlobalPrefix(..., { exclude })` leaves out of the prefix; without a method, every method. */
export interface ExcludedRoute {
  path: string;
  method?: HttpMethod;
}

/** A setting that is in the code and could not be read; the routes are as if it were not set. */
export interface AppNote {
  file: string;
  line: number;
  message: string;
}

/** What a NestJS application sets for all of its routes, as read from its source. */
export interface AppSettings {
  /** `app.setGlobalPrefix('api', { exclude: [...] })`. */
  prefix?: { value: string; exclude: ExcludedRoute[]; file: string; line: number };
  /**
   * `app.enableVersioning({ type: VersioningType.URI })`: a version is a path segment, `prefix` in front of it
   * (`v`). `defaults` are the versions of a route that declares none; `''` in it stands for `VERSION_NEUTRAL`.
   */
  versioning?: { prefix: string; defaults: string[]; file: string; line: number };
  notes: AppNote[];
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

/** An operation both sides know, whose query parameters differ. */
export interface QueryMismatch {
  method: HttpMethod;
  path: string;
  /** Read by the code, not described by the document. */
  codeOnly: string[];
  /** Described by the document, not read by the handler; empty when the code's list need not be whole. */
  specOnly: string[];
  file: string;
  line: number;
}

/** An operation both sides know, where the code answers with a status the document does not describe. */
export interface StatusMismatch {
  method: HttpMethod;
  path: string;
  codeStatuses: number[];
  /** Everything the document describes for the operation. */
  specResponses: string[];
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
  /** Reported, and a failure only under `strict`. */
  queryMismatch: QueryMismatch[];
  /** Reported, and a failure only under `strict`. */
  statusMismatch: StatusMismatch[];
  /** How much drift the ignore patterns left out, when there were any. */
  ignored?: { missingInSpec: number; missingInCode: number };
  /** Drift a baseline accepts: reported, never a failure. */
  accepted?: { missingInSpec: MissingInSpec[]; missingInCode: MissingInCode[] };
  /** Entries of the baseline that drift no more. */
  resolved?: string[];
}

/** Drift that is known and accepted, as `--update-baseline` writes it: `GET /api/health`, one entry a drift. */
export interface Baseline {
  version: 1;
  missingInSpec: string[];
  missingInCode: string[];
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
  /** What was read from the code instead of being given, for the report to say so. */
  app?: AppSettings;
  /** Whether differences in query parameters and status codes fail the run; the report words them accordingly. */
  strict?: boolean;
}

/** An OpenAPI document as parsed; only what this tool reads is typed. */
export interface OpenApiDocument {
  openapi?: unknown;
  servers?: { url?: unknown }[];
  paths?: Record<string, PathItem | undefined>;
  components?: { parameters?: Record<string, Parameter | undefined> };
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
  $ref?: string;
}
