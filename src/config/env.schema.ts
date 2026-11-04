import { z } from 'zod';

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
  })
  .transform((env) => ({
    ...env,
    // API docs are on by default outside production and must be enabled explicitly in production.
    OPENAPI_ENABLED: env.OPENAPI_ENABLED ?? env.NODE_ENV !== 'production',
  }));

export type Env = z.infer<typeof envSchema>;
