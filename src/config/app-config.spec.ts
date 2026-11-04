import { ConfigValidationError, loadConfig } from './app-config';

const validEnv = {
  NODE_ENV: 'development',
  WEB_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/civiceye',
  REDIS_URL: 'redis://localhost:6379',
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
});
