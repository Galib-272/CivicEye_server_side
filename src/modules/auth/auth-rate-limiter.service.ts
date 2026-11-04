import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { sha256Hex } from './crypto';

// Atomic fixed-window counter. Returns [hits, windowTtlMs].
const CONSUME_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {hits, redis.call('PTTL', KEYS[1])}
`;

export interface LimitRule {
  /** Logical bucket, e.g. "login:email". */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/** Approved limits for security-sensitive endpoints. */
export const AuthLimits = {
  loginPerIp: { bucket: 'login:ip', limit: 50, windowSeconds: 15 * 60 },
  loginPerEmail: { bucket: 'login:email', limit: 10, windowSeconds: 15 * 60 },
  registerPerIp: { bucket: 'register:ip', limit: 10, windowSeconds: 60 * 60 },
  forgotPerIp: { bucket: 'forgot:ip', limit: 20, windowSeconds: 60 * 60 },
  forgotPerEmail: { bucket: 'forgot:email', limit: 5, windowSeconds: 60 * 60 },
  resetPerIp: { bucket: 'reset:ip', limit: 20, windowSeconds: 60 * 60 },
  verifyPerIp: { bucket: 'verify:ip', limit: 30, windowSeconds: 60 * 60 },
  resendVerificationPerUser: { bucket: 'verify-resend:user', limit: 5, windowSeconds: 60 * 60 },
  changePasswordPerUser: { bucket: 'password-change:user', limit: 10, windowSeconds: 15 * 60 },
  mfaPerUser: { bucket: 'mfa:user', limit: 10, windowSeconds: 15 * 60 },
  // Approved report limits (Phase 4) and photo uploads to match (5 photos per report).
  reportsPerUserHour: { bucket: 'reports:user:hour', limit: 10, windowSeconds: 60 * 60 },
  reportsPerUserDay: { bucket: 'reports:user:day', limit: 30, windowSeconds: 24 * 60 * 60 },
  mediaUploadsPerUser: { bucket: 'media:user', limit: 60, windowSeconds: 60 * 60 },
} satisfies Record<string, LimitRule>;

/**
 * Rate limiter for authentication endpoints. Unlike the global limiter it FAILS CLOSED: if
 * Redis is unavailable the request is refused, so an outage cannot be used to brute-force
 * passwords or two-factor codes.
 */
@Injectable()
export class AuthRateLimiter {
  private readonly logger = new Logger(AuthRateLimiter.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(rule: LimitRule, subject: string): Promise<void> {
    // Subjects (emails, IPs) are hashed so Redis never holds them in plain text.
    const key = `civiceye:authlimit:${rule.bucket}:${sha256Hex(subject.toLowerCase())}`;
    let hits: number;
    try {
      [hits] = (await this.redis.eval(CONSUME_SCRIPT, 1, key, rule.windowSeconds * 1000)) as [
        number,
        number,
      ];
    } catch (error) {
      this.logger.error({ err: error, bucket: rule.bucket }, 'Auth rate limiter unavailable');
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE);
    }
    if (hits > rule.limit) {
      throw new AppException(ErrorCode.RATE_LIMITED);
    }
  }

  async reset(rule: LimitRule, subject: string): Promise<void> {
    const key = `civiceye:authlimit:${rule.bucket}:${sha256Hex(subject.toLowerCase())}`;
    await this.redis.del(key).catch(() => undefined);
  }
}
