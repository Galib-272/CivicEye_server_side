import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Idempotency-Key support (PRD §13.6, §14.16): repeating a request with the same key returns
 * the first response instead of performing the action again, e.g. after a double tap or a
 * retry on a flaky mobile connection.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T extends Prisma.InputJsonValue>(
    userId: string,
    route: string,
    key: string | undefined,
    request: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!key || !KEY_PATTERN.test(key)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Send an Idempotency-Key header (8–100 letters, digits, - or _).',
        [{ field: 'Idempotency-Key', message: 'Required for this request.' }],
      );
    }
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { userId_route_key: { userId, route, key } },
    });
    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (existing.responseBody === null) {
        throw new AppException(
          ErrorCode.DUPLICATE_SUBMISSION,
          'This request is still being processed.',
        );
      }
      return existing.responseBody as T;
    }

    // Claim the key first, so two simultaneous requests cannot both run the action.
    let claimId: string;
    try {
      if (existing) await this.prisma.idempotencyKey.delete({ where: { id: existing.id } });
      claimId = (
        await this.prisma.idempotencyKey.create({
          data: { userId, route, key, requestHash, expiresAt: new Date(Date.now() + KEY_TTL_MS) },
          select: { id: true },
        })
      ).id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.DUPLICATE_SUBMISSION,
          'This request is still being processed.',
        );
      }
      throw error;
    }

    try {
      const response = await action();
      await this.prisma.idempotencyKey.update({
        where: { id: claimId },
        data: { responseBody: response },
      });
      return response;
    } catch (error) {
      // A failed attempt may be retried with the same key.
      await this.prisma.idempotencyKey.delete({ where: { id: claimId } }).catch(() => undefined);
      throw error;
    }
  }
}
