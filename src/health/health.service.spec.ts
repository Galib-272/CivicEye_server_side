import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { loadConfig } from '../config/app-config';
import type { PrismaService } from '../database/prisma.service';
import { HealthService } from './health.service';

const config = {
  ...loadConfig({
    NODE_ENV: 'test',
    WEB_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EMAIL_FROM: 'CivicEye <test@example.test>',
    SMTP_URL: 'smtp://127.0.0.1:1025',
  }),
  healthCheckTimeoutMs: 50,
};

function service(ping: () => Promise<void>, redisPing: () => Promise<string>) {
  const prisma = { ping } as unknown as PrismaService;
  const redis = { status: 'ready', ping: redisPing, connect: jest.fn() } as unknown as Redis;
  return new HealthService(config, prisma, redis);
}

describe('HealthService.readiness', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('is ready when both dependencies respond', async () => {
    const health = service(
      () => Promise.resolve(),
      () => Promise.resolve('PONG'),
    );
    await expect(health.readiness()).resolves.toEqual({
      ready: true,
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports a failing dependency without exposing the error', async () => {
    const health = service(
      () => Promise.reject(new Error('password authentication failed for user "civiceye"')),
      () => Promise.resolve('PONG'),
    );
    const report = await health.readiness();
    expect(report).toEqual({ ready: false, checks: { database: 'down', redis: 'up' } });
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('marks a hanging dependency as down after the timeout', async () => {
    const health = service(
      () => Promise.resolve(),
      () => new Promise<string>(() => undefined),
    );
    await expect(health.readiness()).resolves.toEqual({
      ready: false,
      checks: { database: 'up', redis: 'down' },
    });
  });
});
