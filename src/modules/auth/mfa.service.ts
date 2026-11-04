import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from './auth-context';
import { AuthLimits, AuthRateLimiter } from './auth-rate-limiter.service';
import type { MfaChallengeInput } from './auth.schemas';
import { decryptSecret, encryptSecret, sha256Hex } from './crypto';
import { SessionService, type SessionRecord } from './session.service';

const PERIOD_SECONDS = 30;
const BACKUP_CODE_COUNT = 10;
// Unambiguous characters for backup codes (no 0/O, 1/I/L).
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

function generateBackupCode(): string {
  const chars = Array.from(
    { length: 10 },
    () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)],
  );
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** TOTP two-factor authentication (RFC 6238) with one-time backup codes. */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly limiter: AuthRateLimiter,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts (or restarts) setup. Not allowed once two-factor is enabled. */
  async setup(auth: AuthContext): Promise<{ otpauthUri: string; secret: string }> {
    const existing = await this.prisma.userMfa.findUnique({
      where: { userId: auth.user.id },
      select: { enabledAt: true },
    });
    if (existing?.enabledAt) {
      throw new AppException(ErrorCode.CONFLICT, 'Two-factor authentication is already enabled.');
    }

    const secret = new Secret({ size: 20 });
    const secretEncrypted = encryptSecret(secret.base32, this.config.mfaEncryptionKey);
    await this.prisma.userMfa.upsert({
      where: { userId: auth.user.id },
      create: { userId: auth.user.id, secretEncrypted },
      update: { secretEncrypted, lastUsedStep: null },
    });

    return {
      otpauthUri: this.totp(secret.base32, auth.user.email).toString(),
      secret: secret.base32,
    };
  }

  /** Confirms setup with a first code, enables two-factor, and returns one-time backup codes. */
  async enable(auth: AuthContext, code: string, request: Request) {
    await this.limiter.consume(AuthLimits.mfaPerUser, auth.user.id);
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId: auth.user.id } });
    if (!mfa) throw new AppException(ErrorCode.CONFLICT, 'Start two-factor setup first.');
    if (mfa.enabledAt)
      throw new AppException(ErrorCode.CONFLICT, 'Two-factor authentication is already enabled.');

    const step = this.matchStep(mfa.secretEncrypted, auth.user.email, code, mfa.lastUsedStep);
    if (step === null) {
      await this.audit.recordBestEffort(
        { action: 'auth.mfa_enable', result: 'FAILURE', actorUserId: auth.user.id },
        request,
      );
      throw new AppException(ErrorCode.INVALID_MFA_CODE);
    }

    const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
    await this.prisma.$transaction(async (tx) => {
      await tx.userMfa.update({
        where: { userId: auth.user.id },
        data: { enabledAt: new Date(), lastUsedStep: step },
      });
      await tx.mfaBackupCode.deleteMany({ where: { userId: auth.user.id } });
      await tx.mfaBackupCode.createMany({
        data: backupCodes.map((backupCode) => ({
          userId: auth.user.id,
          codeHash: sha256Hex(normalizeBackupCode(backupCode)),
        })),
      });
      await this.audit.record(
        { action: 'auth.mfa_enabled', result: 'SUCCESS', actorUserId: auth.user.id },
        request,
        tx,
      );
    });

    const rotated = await this.sessions.rotate(auth.token, auth.session, { mfa: 'verified' });
    return { backupCodes, ...rotated };
  }

  /** Completes sign-in for an account with two-factor enabled. */
  async challenge(auth: AuthContext, input: MfaChallengeInput, request: Request) {
    if (auth.session.mfa !== 'pending') {
      throw new AppException(ErrorCode.CONFLICT, 'No two-factor verification is pending.');
    }
    await this.limiter.consume(AuthLimits.mfaPerUser, auth.user.id);

    const mfa = await this.prisma.userMfa.findUnique({ where: { userId: auth.user.id } });
    if (!mfa?.enabledAt)
      throw new AppException(ErrorCode.CONFLICT, 'Two-factor authentication is not enabled.');

    let accepted = false;
    let method: 'totp' | 'backup_code' = 'totp';
    if ('code' in input) {
      const step = this.matchStep(
        mfa.secretEncrypted,
        auth.user.email,
        input.code,
        mfa.lastUsedStep,
      );
      if (step !== null) {
        // Conditional update rejects a second use of the same code in a concurrent request.
        const updated = await this.prisma.userMfa.updateMany({
          where: {
            userId: auth.user.id,
            OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
          },
          data: { lastUsedStep: step },
        });
        accepted = updated.count === 1;
      }
    } else {
      method = 'backup_code';
      const used = await this.prisma.mfaBackupCode.updateMany({
        where: {
          userId: auth.user.id,
          codeHash: sha256Hex(normalizeBackupCode(input.backupCode)),
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      accepted = used.count === 1;
    }

    if (!accepted) {
      await this.audit.recordBestEffort(
        {
          action: 'auth.mfa_challenge',
          result: 'FAILURE',
          actorUserId: auth.user.id,
          metadata: { method },
        },
        request,
      );
      throw new AppException(ErrorCode.INVALID_MFA_CODE);
    }

    await this.limiter.reset(AuthLimits.mfaPerUser, auth.user.id);
    await this.audit.recordBestEffort(
      {
        action: 'auth.mfa_challenge',
        result: 'SUCCESS',
        actorUserId: auth.user.id,
        metadata: { method },
      },
      request,
    );
    return this.sessions.rotate(auth.token, auth.session, { mfa: 'verified' });
  }

  async remainingBackupCodes(userId: string): Promise<number> {
    return this.prisma.mfaBackupCode.count({ where: { userId, usedAt: null } });
  }

  private totp(base32Secret: string, label: string): TOTP {
    return new TOTP({
      issuer: 'CivicEye',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(base32Secret),
    });
  }

  /**
   * Returns the time step of a valid code (allowing one step of clock drift), or null.
   * Codes at or before the last accepted step are rejected so a code cannot be replayed.
   */
  private matchStep(
    secretEncrypted: string,
    label: string,
    code: string,
    lastUsedStep: bigint | null,
  ): bigint | null {
    const secret = decryptSecret(secretEncrypted, this.config.mfaEncryptionKey);
    const delta = this.totp(secret, label).validate({ token: code, window: 1 });
    if (delta === null) return null;
    const step = BigInt(Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta);
    if (lastUsedStep !== null && step <= lastUsedStep) return null;
    return step;
  }
}

export type RotatedSession = { token: string; record: SessionRecord };
