import { ConfigValidationError, loadConfig } from './app-config';
import { PUBLIC_PLACEHOLDER_MFA_KEY } from './env.schema';

const validEnv = {
  NODE_ENV: 'development',
  WEB_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/civiceye',
  REDIS_URL: 'redis://localhost:6379',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  EMAIL_FROM: 'CivicEye <test@example.test>',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  STORAGE_ENDPOINT: 'http://127.0.0.1:8333',
  STORAGE_BUCKET: 'civiceye-test',
  STORAGE_ACCESS_KEY_ID: 'test-access',
  STORAGE_SECRET_ACCESS_KEY: 'test-secret-value',
};

function captureError(env: NodeJS.ProcessEnv): ConfigValidationError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      port: 4000,
      logLevel: 'info',
      trustProxy: false,
      openApiEnabled: true,
      rateLimit: { windowSeconds: 60, maxRequests: 300 },
      corsOrigins: ['http://localhost:3000'],
    });
  });

  it('treats empty values as unset so defaults apply', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '',
      OPENAPI_ENABLED: '',
      CORS_EXTRA_ORIGINS: '',
    });
    expect(config.port).toBe(4000);
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
  });

  it('disables API docs in production unless explicitly enabled', () => {
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).openApiEnabled).toBe(false);
    expect(
      loadConfig({ ...validEnv, NODE_ENV: 'production', OPENAPI_ENABLED: 'true' }).openApiEnabled,
    ).toBe(true);
  });

  it('normalizes CORS origins and rejects non-URL entries', () => {
    const config = loadConfig({
      ...validEnv,
      WEB_URL: 'http://localhost:3000/app',
      CORS_EXTRA_ORIGINS: 'https://staging.example.org/, https://preview.example.org',
    });
    expect(config.corsOrigins).toEqual([
      'http://localhost:3000',
      'https://staging.example.org',
      'https://preview.example.org',
    ]);
    expect(captureError({ ...validEnv, CORS_EXTRA_ORIGINS: 'not a url' }).issues[0]).toMatch(
      /^CORS_EXTRA_ORIGINS/,
    );
  });

  it('reports every missing required variable', () => {
    const error = captureError({ NODE_ENV: 'development' });
    const variables = error.issues.map((issue) => issue.split(':')[0]);
    expect(variables).toEqual(expect.arrayContaining(['WEB_URL', 'DATABASE_URL', 'REDIS_URL']));
  });

  it('rejects URLs with the wrong scheme', () => {
    const error = captureError({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' });
    expect(error.issues[0]).toMatch(/^DATABASE_URL/);
  });

  it('rejects out-of-range numbers', () => {
    expect(captureError({ ...validEnv, PORT: '70000' }).issues[0]).toMatch(/^PORT/);
    expect(captureError({ ...validEnv, RATE_LIMIT_MAX_REQUESTS: '0' }).issues[0]).toMatch(
      /^RATE_LIMIT_MAX_REQUESTS/,
    );
  });

  it('never includes supplied values in error messages', () => {
    const secret = 'postgresql-but-not-really-s3cr3t-value';
    const error = captureError({ ...validEnv, DATABASE_URL: secret });
    expect(error.message).not.toContain(secret);
  });

  it('defaults secure session cookies on only in staging and production', () => {
    expect(loadConfig(validEnv).session.cookieSecure).toBe(false);
    expect(loadConfig({ ...validEnv, NODE_ENV: 'staging' }).session.cookieSecure).toBe(true);
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).session.cookieSecure).toBe(true);
  });

  it('requires a 32-byte two-factor encryption key', () => {
    const error = captureError({
      ...validEnv,
      MFA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
    });
    expect(error.issues[0]).toMatch(/^MFA_ENCRYPTION_KEY/);
  });

  it('rejects the public placeholder key outside development and test', () => {
    const env = { ...validEnv, MFA_ENCRYPTION_KEY: PUBLIC_PLACEHOLDER_MFA_KEY };
    expect(() => loadConfig(env)).not.toThrow();
    expect(captureError({ ...env, NODE_ENV: 'production' }).issues[0]).toMatch(
      /^MFA_ENCRYPTION_KEY/,
    );
  });

  it('requires the settings of the selected email provider', () => {
    const { SMTP_URL: _smtp, ...withoutSmtp } = validEnv;
    expect(captureError(withoutSmtp).issues[0]).toMatch(/^SMTP_URL/);
    expect(captureError({ ...validEnv, EMAIL_PROVIDER: 'resend' }).issues[0]).toMatch(
      /^RESEND_API_KEY/,
    );
    expect(
      loadConfig({ ...validEnv, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_0123456789' })
        .email,
    ).toEqual({
      provider: 'resend',
      from: 'CivicEye <test@example.test>',
      resendApiKey: 're_test_0123456789',
    });
  });

  it('reads storage settings and refuses bucket creation in staging and production', () => {
    expect(loadConfig({ ...validEnv, STORAGE_CREATE_BUCKET: 'true' }).storage).toMatchObject({
      endpoint: 'http://127.0.0.1:8333',
      region: 'auto',
      bucket: 'civiceye-test',
      createBucket: true,
    });
    expect(
      captureError({ ...validEnv, NODE_ENV: 'production', STORAGE_CREATE_BUCKET: 'true' })
        .issues[0],
    ).toMatch(/^STORAGE_CREATE_BUCKET/);
    expect(captureError({ ...validEnv, STORAGE_BUCKET: 'Bad_Bucket' }).issues[0]).toMatch(
      /^STORAGE_BUCKET/,
    );
  });
});
