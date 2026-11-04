import type { ConnectionOptions } from 'bullmq';
import type { AppConfig } from '../config/app-config';

/**
 * BullMQ connection settings. Queues and their processors are introduced with the features
 * that need them (media processing in Phase 4, notifications in Phase 7, AI in Phase 9).
 *
 * BullMQ workers require `maxRetriesPerRequest: null` so blocking commands are not aborted;
 * this is why queues use their own connection rather than the shared REDIS_CLIENT.
 */
export function bullmqConnection(config: AppConfig): ConnectionOptions {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Defaults every queue starts from; individual queues tune attempts and backoff explicitly. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: false,
} as const;
