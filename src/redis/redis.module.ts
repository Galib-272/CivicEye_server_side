import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const logger = new Logger('Redis');

export function createRedisClient(config: AppConfig): Redis {
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: config.healthCheckTimeoutMs,
    // Fail commands quickly while disconnected instead of queueing them indefinitely.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
  });

  // ioredis reconnects automatically and emits an error per attempt; log once per outage.
  let reportedOutage = false;
  client.on('error', (error: Error) => {
    if (!reportedOutage) {
      reportedOutage = true;
      logger.warn({ err: error }, 'Redis connection error; reconnecting');
    }
  });
  client.on('ready', () => {
    if (reportedOutage) {
      logger.log('Redis connection restored');
    }
    reportedOutage = false;
  });
  return client;
}

/** Shared Redis connection for rate limiting, sessions (Phase 2) and the Socket.IO adapter (Phase 7). */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createRedisClient(config),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
