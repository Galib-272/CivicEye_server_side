import { envSchema, type Env } from './env.schema';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  isProduction: boolean;
  port: number;
  webUrl: string;
  corsOrigins: string[];
  trustProxy: boolean;
  databaseUrl: string;
  redisUrl: string;
  logLevel: Env['LOG_LEVEL'];
  openApiEnabled: boolean;
  rateLimit: { windowSeconds: number; maxRequests: number };
  healthCheckTimeoutMs: number;
  session: { cookieSecure: boolean };
  mfaEncryptionKey: Buffer;
  email:
    | { provider: 'smtp'; from: string; smtpUrl: string }
    | { provider: 'resend'; from: string; resendApiKey: string };
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parses and validates the process environment. Messages name the variable and the rule
 * that failed, never the supplied value, so secrets cannot leak into logs.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `VAR=` in an env file means "not set", so defaults apply.
  const defined = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const variable = issue.path.join('.') || '(root)';
      return `${variable}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    webUrl: env.WEB_URL,
    corsOrigins: [
      new URL(env.WEB_URL).origin,
      ...env.CORS_EXTRA_ORIGINS.map((o) => new URL(o).origin),
    ],
    trustProxy: env.TRUST_PROXY,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    logLevel: env.LOG_LEVEL,
    openApiEnabled: env.OPENAPI_ENABLED,
    rateLimit: {
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    },
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    session: { cookieSecure: env.SESSION_COOKIE_SECURE },
    mfaEncryptionKey: Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64'),
    email:
      env.EMAIL_PROVIDER === 'resend'
        ? { provider: 'resend', from: env.EMAIL_FROM, resendApiKey: env.RESEND_API_KEY ?? '' }
        : { provider: 'smtp', from: env.EMAIL_FROM, smtpUrl: env.SMTP_URL ?? '' },
  };
}
