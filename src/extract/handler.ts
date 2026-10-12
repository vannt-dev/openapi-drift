/**
 * What the source shows of one handler beyond its route: the query parameters it reads by name and the statuses
 * it answers with. Both are left out when the source does not show them, so that nothing is compared on a guess.
 */
export interface HandlerDetails {
  query?: { names: string[]; complete: boolean };
  statuses?: number[];
}

/** The details as the optional fields of a route: nothing is set to undefined. */
export function detailsOf({
  query,
  statuses,
}: {
  query?: HandlerDetails['query'] | undefined;
  statuses?: number[] | undefined;
}): HandlerDetails {
  return { ...(query ? { query } : {}), ...(statuses ? { statuses } : {}) };
}

/** `HttpStatus.NO_CONTENT` and its like, for a status given by name. */
export const HTTP_STATUS: Readonly<Record<string, number>> = {
  CONTINUE: 100,
  SWITCHING_PROTOCOLS: 101,
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NON_AUTHORITATIVE_INFORMATION: 203,
  NO_CONTENT: 204,
  RESET_CONTENT: 205,
  PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

/**
 * What an Express handler written in place is seen to do: `req.query.name`, `req.query['name']` and
 * `const { a, b } = req.query` for the query, `res.status(201)` and `res.sendStatus(204)` for the statuses.
 * The request and the response are the first two parameters of a function written there, whatever their names,
 * so that `db.query.users` is not taken for a query parameter. It is what was seen, not all there is: a handler
 * may read more through a helper, and may answer with a status it computes.
 *
 * `statusCalls` are the methods of the response that set the status with a number.
 */
export function inlineHandlerDetails(text: string, statusCalls: readonly string[] = ['status', 'sendStatus']): HandlerDetails {
  const requests = new Set<string>();
  const responses = new Set<string>();
  // `(req, res) =>`, `async (req: Request, res: Response, next): Promise<void> => {`, `function (req, res) {`
  for (const m of text.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?::[^,()]*)?,\s*([A-Za-z_$][\w$]*)[^()]*\)\s*(?::[^={]*)?(?:=>|\{)/g)) {
    requests.add(m[1] as string);
    responses.add(m[2] as string);
  }
  // a handler that takes the request alone: `(request) =>`, `request =>`
  for (const m of text.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?::[^,()]*)?\)\s*(?::[^={]*)?=>|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    requests.add((m[1] ?? m[2]) as string);
  }
  if (!requests.size) return {};
  const either = (names: Set<string>): string => [...names].map((n) => n.replace(/\$/g, '\\$')).join('|');
  const req = `(?:${either(requests)})`;
  // no response by name: nothing can be seen of the status
  const res = responses.size ? `(?:${either(responses)})` : '(?!)';

  const names: string[] = [];
  const add = (name: string): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  // in source order, whatever the form
  const forms = new RegExp(
    `\\{([^{}]*)\\}\\s*=\\s*${req}\\.query\\b` +
      `|(?<![\\w$.])${req}\\.query\\s*\\.\\s*([A-Za-z_$][\\w$]*)` +
      `|(?<![\\w$.])${req}\\.query\\s*\\[\\s*(['"\`])([^'"\`]+)\\3\\s*\\]`,
    'g'
  );
  for (const m of text.matchAll(forms)) {
    if (m[1] !== undefined) {
      for (const part of m[1].split(',')) {
        // `page`, `size = 20`, `sort: order`; a rest element names no parameter
        const key = part.trim().split(/[:=]/)[0]?.trim() ?? '';
        if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key);
        else if (/^(['"`]).+\1$/.test(key)) add(key.slice(1, -1));
      }
    } else add((m[2] ?? m[4]) as string);
  }
  const statuses: number[] = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${res}\\s*\\.\\s*(?:${statusCalls.join('|')})\\s*\\(\\s*(\\d{3})\\s*\\)`, 'g'))) {
    const status = Number(m[1]);
    if (!statuses.includes(status)) statuses.push(status);
  }
  return detailsOf({
    ...(names.length ? { query: { names, complete: false } } : {}),
    ...(statuses.length ? { statuses } : {}),
  });
}
