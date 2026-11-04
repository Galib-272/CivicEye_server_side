import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformRole } from '../../generated/prisma/enums';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { generateToken, sha256Hex } from './crypto';

const HOUR = 60 * 60 * 1000;

/** Approved session lifetimes (Phase 2). */
export const SESSION_LIFETIMES: Record<PlatformRole, { absoluteMs: number; idleMs: number }> = {
  CITIZEN: { absoluteMs: 7 * 24 * HOUR, idleMs: 24 * HOUR },
  SUPER_ADMIN: { absoluteMs: 12 * HOUR, idleMs: 30 * 60 * 1000 },
};

/** How often last-seen time is written to PostgreSQL (Redis is updated on every request). */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * none: no two-factor configured; pending: password accepted, code still required;
 * setup_required: two-factor is mandatory but not yet set up; verified: code accepted.
 */
export type MfaState = 'none' | 'pending' | 'setup_required' | 'verified';

export interface SessionRecord {
  sessionId: string;
  userId: string;
  csrfToken: string;
  mfa: MfaState;
  absoluteExpiresAt: number;
  idleMs: number;
  lastPersistedAt: number;
}

export interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
}

export type RevokeReason =
  | 'logout'
  | 'user_revoked'
  | 'password_changed'
  | 'password_reset'
  | 'account_status_changed'
  | 'superseded';

/**
 * Server-managed sessions (approved decision). The browser holds an opaque random token in an
 * HttpOnly cookie. Redis stores the live session under SHA-256(token) with a sliding idle
 * timeout capped by an absolute lifetime; PostgreSQL keeps metadata so users can list and
 * revoke their sessions. Redis being unavailable makes authentication fail closed.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  cookieName(): string {
    // The __Host- prefix makes browsers reject the cookie unless it is Secure, host-only and path=/.
    return this.config.session.cookieSecure ? '__Host-civiceye_session' : 'civiceye_session';
  }

  async create(
    user: { id: string; platformRole: PlatformRole },
    mfa: MfaState,
    client: ClientInfo,
  ): Promise<{ token: string; record: SessionRecord }> {
    const lifetime = SESSION_LIFETIMES[user.platformRole];
    const now = Date.now();
    const token = generateToken();
    const absoluteExpiresAt = now + lifetime.absoluteMs;

    const row = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256Hex(token),
        ipAddress: client.ipAddress?.slice(0, 45),
        userAgent: client.userAgent?.slice(0, 255),
        absoluteExpiresAt: new Date(absoluteExpiresAt),
      },
      select: { id: true },
    });

    const record: SessionRecord = {
      sessionId: row.id,
      userId: user.id,
      csrfToken: generateToken(),
      mfa,
      absoluteExpiresAt,
      idleMs: lifetime.idleMs,
      lastPersistedAt: now,
    };
    await this.write(token, record);
    return { token, record };
  }

  /** Looks up a session token, extending its idle timeout. Returns null if absent or expired. */
  async resolve(token: string): Promise<SessionRecord | null> {
    const key = this.key(token);
    const raw = await this.redisCall(() => this.redis.get(key));
    if (!raw) return null;

    const record = JSON.parse(raw) as SessionRecord;
    const now = Date.now();
    if (now >= record.absoluteExpiresAt) {
      await this.redisCall(() => this.redis.del(key));
      return null;
    }

    if (now - record.lastPersistedAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      record.lastPersistedAt = now;
      await this.prisma.userSession
        .update({ where: { id: record.sessionId }, data: { lastSeenAt: new Date(now) } })
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'Could not update session last-seen time'),
        );
    }
    await this.write(token, record);
    return record;
  }

  /**
   * Issues a new token for the same session (after login-state changes such as completing
   * two-factor), so a token observed before the change cannot be reused.
   */
  async rotate(
    oldToken: string,
    record: SessionRecord,
    changes: Partial<Pick<SessionRecord, 'mfa'>>,
  ) {
    const token = generateToken();
    const updated: SessionRecord = { ...record, ...changes, csrfToken: generateToken() };
    await this.prisma.userSession.update({
      where: { id: record.sessionId },
      data: { tokenHash: sha256Hex(token) },
    });
    await this.redisCall(() => this.redis.del(this.key(oldToken)));
    await this.write(token, updated);
    return { token, record: updated };
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    const row = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { tokenHash: true, revokedAt: true },
    });
    if (!row || row.revokedAt) return;
    await this.redisCall(() => this.redis.del(this.keyFromHash(row.tokenHash)));
    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Ends every session of a user, optionally keeping one (e.g. the session changing the password). */
  async revokeAllForUser(userId: string, reason: RevokeReason, exceptSessionId?: string) {
    const rows = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true, tokenHash: true },
    });
    if (rows.length === 0) return 0;
    await this.redisCall(() =>
      this.redis.del(...rows.map((row) => this.keyFromHash(row.tokenHash))),
    );
    await this.prisma.userSession.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return rows.length;
  }

  /** Sessions that are still usable (present in Redis), newest first. */
  async listActive(userId: string) {
    const rows = await this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        tokenHash: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
      },
    });
    if (rows.length === 0) return [];
    const live = await this.redisCall(() =>
      Promise.all(rows.map((row) => this.redis.exists(this.keyFromHash(row.tokenHash)))),
    );
    return rows.filter((_, index) => live[index] === 1).map(({ tokenHash: _hash, ...row }) => row);
  }

  private async write(token: string, record: SessionRecord): Promise<void> {
    const ttl = Math.max(1, Math.min(record.idleMs, record.absoluteExpiresAt - Date.now()));
    await this.redisCall(() => this.redis.set(this.key(token), JSON.stringify(record), 'PX', ttl));
  }

  private key(token: string): string {
    return this.keyFromHash(sha256Hex(token));
  }

  private keyFromHash(tokenHash: string): string {
    return `civiceye:session:${tokenHash}`;
  }

  /** Session storage failures fail closed with SERVICE_UNAVAILABLE. */
  private async redisCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error({ err: error }, 'Session store unavailable');
      throw new AppException(ErrorCode.SERVICE_UNAVAILABLE);
    }
  }
}
