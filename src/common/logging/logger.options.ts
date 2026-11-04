import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../../config/app-config';
import { resolveRequestId } from '../http/request-id';

/**
 * Paths removed from every log line. Logs must never contain passwords, tokens, session
 * identifiers or other secrets (PRD §12.3, §30.1). Extend this list when adding new
 * sensitive fields rather than relying on callers to omit them.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
];

const QUIET_PATHS = new Set(['/api/v1/health/live', '/api/v1/health/ready']);

export function buildLoggerOptions(config: AppConfig): Params {
  const prettyTransport =
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } }
      : undefined;

  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: resolveRequestId,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
      base: { service: 'civiceye-api', env: config.nodeEnv },
      autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(req.url ?? '') },
      // Query strings can carry identifiers; log the path only.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
      },
      transport: prettyTransport,
    },
  };
}
