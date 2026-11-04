import { z } from 'zod';

/** The development-only key published in .env.example; rejected in staging and production. */
export const PUBLIC_PLACEHOLDER_MFA_KEY = 'ZGV2LW9ubHktcGxhY2Vob2xkZXIta2V5LTMyYnl0ZXM=';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const commaSeparatedOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

/**
 * Backend environment contract. Every variable is documented in .env.example.
 * Parsing fails fast at startup; secrets are never echoed in error messages.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_URL: z.url({ protocol: /^https?$/ }),
    CORS_EXTRA_ORIGINS: commaSeparatedOrigins.default([]),
    TRUST_PROXY: booleanString.default(false),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OPENAPI_ENABLED: booleanString.optional(),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100000).default(300),

    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(2000),

    // Secure (HTTPS-only) session cookies. Defaults to true in staging and production.
    SESSION_COOKIE_SECURE: booleanString.optional(),
    // 32 random bytes, base64-encoded. Encrypts two-factor secrets at rest.
    MFA_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be 32 bytes encoded as base64',
    }),

    EMAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
    EMAIL_FROM: z.string().min(3).max(200),
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    RESEND_API_KEY: z.string().min(10).optional(),

    // S3-compatible object storage: SeaweedFS locally, Cloudflare R2 in staging/production.
    STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }),
    STORAGE_REGION: z.string().min(1).max(50).default('auto'),
    STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid bucket name'),
    STORAGE_ACCESS_KEY_ID: z.string().min(3),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(8),
    STORAGE_FORCE_PATH_STYLE: booleanString.default(false),
    // Create the bucket on startup. For local development and tests only.
    STORAGE_CREATE_BUCKET: booleanString.default(false),

    // Run background job processors in this process (the worker entry point sets this).
    RUN_WORKERS: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    if (
      (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') &&
      env.MFA_ENCRYPTION_KEY === PUBLIC_PLACEHOLDER_MFA_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'the public placeholder from .env.example cannot be used here',
      });
    }
    if (
      (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production') &&
      env.STORAGE_CREATE_BUCKET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_CREATE_BUCKET'],
        message: 'must not be enabled in staging or production',
      });
    }
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'required when EMAIL_PROVIDER=smtp',
      });
    }
    if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'required when EMAIL_PROVIDER=resend',
      });
    }
  })
  .transform((env) => ({
    ...env,
    // API docs are on by default outside production and must be enabled explicitly in production.
    OPENAPI_ENABLED: env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production',
    SESSION_COOKIE_SECURE:
      env.SESSION_COOKIE_SECURE ?? (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production'),
  }));

export type Env = z.infer<typeof envSchema>;
