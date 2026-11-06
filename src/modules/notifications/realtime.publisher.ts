import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/** Redis channel from background workers to the API processes that hold the live connections. */
export const REALTIME_CHANNEL = 'civiceye:realtime';

export interface RealtimeMessage {
  rooms: string[];
  event: 'notifications.changed' | 'data.changed';
}

/**
 * Announces that something changed for some rooms ("user:<id>", "org:<id>"). Messages carry no
 * data at all: browsers react by re-fetching through the normal, authorized API. A lost message
 * only delays an update (pages also refresh on focus and the bell polls every minute).
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(rooms: string[], event: RealtimeMessage['event']): Promise<void> {
    if (rooms.length === 0) return;
    const message: RealtimeMessage = { rooms, event };
    await this.redis
      .publish(REALTIME_CHANNEL, JSON.stringify(message))
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Could not publish live update'));
  }
}
