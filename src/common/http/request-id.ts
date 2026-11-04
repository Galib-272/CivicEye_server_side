import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept caller-supplied IDs (e.g. from a load balancer) only if they are short and inert.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

type RequestWithId = IncomingMessage & { id?: unknown };

/**
 * Resolves the request ID: reuses one already assigned to this request, else a safe incoming
 * header, else a new UUID. It is echoed on the response so clients can quote it in support
 * requests. Also used as pino-http's genReqId so log lines carry the same ID.
 */
export function resolveRequestId(req: RequestWithId, res: ServerResponse): string {
  if (typeof req.id === 'string') {
    return req.id;
  }
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}

/** Express middleware; registered first so even body-parser errors have a request ID. */
export function assignRequestId(req: RequestWithId, res: ServerResponse, next: () => void): void {
  req.id = resolveRequestId(req, res);
  next();
}

export function getRequestId(req: { id?: unknown }): string {
  return typeof req.id === 'string' ? req.id : 'unknown';
}
