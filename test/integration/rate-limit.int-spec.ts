import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { RedisThrottlerStorage } from '../../src/rate-limit/redis-throttler.storage';
import { startEnvironment, type TestEnvironment } from './environment';

// Phase 1 has no throttled business endpoints yet, so the suite mounts a probe route.
@Controller({ path: 'rate-limit-probe', version: '1' })
class ProbeController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('Rate limiting backed by Redis', () => {
  let env: TestEnvironment;
  let app: NestExpressApplication;
  let redis: Redis;

  beforeAll(async () => {
    env = await startEnvironment();
    redis = new Redis(env.redisUrl);
    const config = env.config({ rateLimit: { windowSeconds: 60, maxRequests: 3 } });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app, config);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await env?.stop();
  });

  it('allows requests up to the limit, then returns 429 RATE_LIMITED', async () => {
    const server = app.getHttpServer();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(server).get('/api/v1/rate-limit-probe').expect(200);
    }
    const limited = await request(server).get('/api/v1/rate-limit-probe').expect(429);
    expect(limited.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(limited.headers['retry-after']).toEqual(expect.any(String));
  });

  it('does not throttle health checks', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    }
  });

  it('stores counters in Redis with an expiry', async () => {
    const keys = await redis.keys('civiceye:throttle:*');
    expect(keys.length).toBeGreaterThan(0);
    const ttl = await redis.pttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(0);
  });

  it('storage blocks after the limit and reports time remaining', async () => {
    const storage = new RedisThrottlerStorage(redis);
    const results = [];
    for (let hit = 0; hit < 3; hit += 1) {
      results.push(await storage.increment('direct-test', 10_000, 2, 5_000, 'unit'));
    }
    expect(results.map((r) => [r.totalHits, r.isBlocked])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(results[2]?.timeToBlockExpire).toBeGreaterThan(0);
    expect(results[2]?.timeToBlockExpire).toBeLessThanOrEqual(5);
  });
});
