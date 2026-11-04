import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

// Fixed-window counter with an optional block period, executed atomically in Redis.
// Returns [totalHits, windowTtlMs, isBlocked (0|1), blockTtlMs].
const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, redis.call('PTTL', KEYS[1]), 1, blockTtl}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}
`;

const KEY_PREFIX = 'civiceye:throttle';

/**
 * Redis-backed storage so limits hold across multiple API instances.
 *
 * This general-purpose limiter fails open: if Redis is unreachable the request is allowed and
 * a warning is logged, so a Redis outage degrades protection rather than taking the API down.
 * Security-critical limits (login, password reset — Phase 2) must use a fail-closed limiter.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `${KEY_PREFIX}:${throttlerName}:${key}`;
    try {
      const [totalHits, windowTtlMs, blocked, blockTtlMs] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        2,
        hitsKey,
        `${hitsKey}:blocked`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];

      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(windowTtlMs / 1000)),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.max(0, Math.ceil(blockTtlMs / 1000)),
      };
    } catch (error) {
      this.logger.warn(
        { err: error, throttlerName },
        'Rate-limit storage unavailable; allowing request',
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
