import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Global per-client request limit. Endpoint-specific limits (login, registration, uploads)
 * are added with @Throttle() on those routes as they are built.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, REDIS_CLIENT],
      useFactory: (config: AppConfig, redis: Redis) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.rateLimit.windowSeconds * 1000,
            limit: config.rateLimit.maxRequests,
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
