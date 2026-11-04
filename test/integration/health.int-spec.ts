import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../src/app.factory';
import { prisma, startEnvironment, type TestEnvironment } from './environment';

describe('Health endpoints against real PostgreSQL and Redis', () => {
  let env: TestEnvironment;
  let app: NestExpressApplication;

  beforeAll(async () => {
    env = await startEnvironment();
    const deploy = prisma(['migrate', 'deploy'], env.databaseUrl);
    if (deploy.status !== 0) throw new Error(`migrate deploy failed:\n${deploy.output}`);
    app = await createApp(env.config());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.stop();
  });

  it('GET /api/v1/health/live returns the success envelope with a request ID', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toEqual({
      success: true,
      data: { status: 'ok' },
      meta: { requestId: response.headers['x-request-id'] as string },
    });
  });

  it('GET /api/v1/health/ready reports both dependencies up', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'ok', checks: { database: 'up', redis: 'up' } },
    });
  });

  it('unknown routes return the standard NOT_FOUND error without internals', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', details: [] },
    });
    expect(JSON.stringify(response.body)).not.toContain('does-not-exist');
  });

  it('sets security headers and does not advertise the framework', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/live');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('allows CORS only for the configured web origin', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const denied = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('Origin', 'https://attacker.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  // Runs last: stopping containers is irreversible for this suite.
  describe('when dependencies fail', () => {
    it('returns 503 SERVICE_UNAVAILABLE when Redis is down', async () => {
      await env.redis.stop();
      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          details: expect.arrayContaining([
            expect.objectContaining({ component: 'redis', status: 'down' }),
            expect.objectContaining({ component: 'database', status: 'up' }),
          ]) as unknown,
        },
      });
    });

    it('returns 503 with the database reported down when PostgreSQL is down', async () => {
      await env.postgres.stop();
      const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: 'database', status: 'down' }),
        ]),
      );
      expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|password|postgres:\/\//i);
    });

    it('keeps liveness healthy while dependencies are down', async () => {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    });
  });
});
