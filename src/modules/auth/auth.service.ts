import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { PreferredLocale } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { AUTH_USER_SELECT, SIGN_IN_ALLOWED_STATUSES, type AuthContext } from './auth-context';
import { AuthLimits, AuthRateLimiter } from './auth-rate-limiter.service';
import type { LoginInput, RegisterInput } from './auth.schemas';
import { generateToken, sha256Hex } from './crypto';
import { PasswordService } from './password.service';
import { SessionService, type MfaState, type SessionRecord } from './session.service';

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function clientInfo(request: Request) {
  return { ipAddress: request.ip, userAgent: request.headers['user-agent'] };
}

function clientIp(request: Request): string {
  return request.ip ?? 'unknown';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: AuthRateLimiter,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Always answers the same way, whether or not the address is already registered, so the
   * endpoint cannot be used to discover accounts. Existing owners get an informational email.
   */
  async register(input: RegisterInput, request: Request): Promise<void> {
    await this.limiter.consume(AuthLimits.registerPerIp, clientIp(request));
    this.passwords.assertAcceptable(input.password, { email: input.email, name: input.name });

    // Hash before looking up the email so both branches take the same time.
    const passwordHash = await this.passwords.hash(input.password);
    const locale: PreferredLocale = input.preferredLocale ?? 'en';

    const existing = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, name: true, email: true, preferredLocale: true },
    });
    if (existing) {
      this.notifyExistingAccount(existing);
      await this.audit.recordBestEffort(
        {
          action: 'auth.register',
          result: 'FAILURE',
          targetType: 'user',
          targetId: existing.id,
          reason: 'email_in_use',
        },
        request,
      );
      return;
    }

    let created: { id: string; email: string; name: string; preferredLocale: PreferredLocale };
    let token: string;
    try {
      ({ created, token } = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash, preferredLocale: locale },
          select: { id: true, email: true, name: true, preferredLocale: true },
        });
        const verificationToken = await this.issueVerificationToken(tx, user.id);
        await this.audit.record(
          {
            action: 'auth.register',
            result: 'SUCCESS',
            actorUserId: user.id,
            targetType: 'user',
            targetId: user.id,
          },
          request,
          tx,
        );
        return { created: user, token: verificationToken };
      }));
    } catch (error) {
      // A concurrent registration for the same address won the race: respond identically.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }

    this.sendVerificationEmail(created, token);
  }

  async login(
    input: LoginInput,
    request: Request,
    existingToken: string | undefined,
  ): Promise<{ token: string; record: SessionRecord; user: AuthContext['user'] }> {
    await this.limiter.consume(AuthLimits.loginPerIp, clientIp(request));
    await this.limiter.consume(AuthLimits.loginPerEmail, input.email);

    const found = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { ...AUTH_USER_SELECT, passwordHash: true, mfa: { select: { enabledAt: true } } },
    });
    const passwordOk = found
      ? await this.passwords.verify(found.passwordHash, input.password)
      : await this.passwords.verifyAgainstDummy(input.password);

    if (!found || !passwordOk) {
      await this.audit.recordBestEffort(
        {
          action: 'auth.login',
          result: 'FAILURE',
          actorUserId: found?.id,
          reason: 'invalid_credentials',
        },
        request,
      );
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    const { passwordHash: _hash, mfa, ...user } = found;
    if (!SIGN_IN_ALLOWED_STATUSES.has(user.status)) {
      await this.audit.recordBestEffort(
        {
          action: 'auth.login',
          result: 'FAILURE',
          actorUserId: user.id,
          reason: `status_${user.status.toLowerCase()}`,
        },
        request,
      );
      throw new AppException(ErrorCode.ACCOUNT_INACTIVE);
    }

    const mfaState: MfaState = mfa?.enabledAt
      ? 'pending'
      : user.platformRole === 'SUPER_ADMIN'
        ? 'setup_required'
        : 'none';

    // Never reuse a session that existed before sign-in (session fixation).
    if (existingToken) {
      const previous = await this.sessions.resolve(existingToken);
      if (previous) await this.sessions.revoke(previous.sessionId, 'superseded');
    }

    const { token, record } = await this.sessions.create(user, mfaState, clientInfo(request));
    await this.limiter.reset(AuthLimits.loginPerEmail, input.email);
    await this.audit.recordBestEffort(
      {
        action: 'auth.login',
        result: 'SUCCESS',
        actorUserId: user.id,
        metadata: { mfa: mfaState },
      },
      request,
    );
    return { token, record, user };
  }

  async logout(auth: AuthContext, request: Request): Promise<void> {
    await this.sessions.revoke(auth.session.sessionId, 'logout');
    await this.audit.recordBestEffort(
      { action: 'auth.logout', result: 'SUCCESS', actorUserId: auth.user.id },
      request,
    );
  }

  async verifyEmail(token: string, request: Request): Promise<void> {
    await this.limiter.consume(AuthLimits.verifyPerIp, clientIp(request));
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const record = await tx.emailVerificationToken.findUnique({
        where: { tokenHash: sha256Hex(token) },
        select: {
          id: true,
          userId: true,
          usedAt: true,
          expiresAt: true,
          user: { select: { status: true } },
        },
      });
      if (!record || record.usedAt || record.expiresAt <= now) {
        throw new AppException(ErrorCode.INVALID_TOKEN);
      }
      // Conditional update: a concurrent request using the same token cannot also succeed.
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new AppException(ErrorCode.INVALID_TOKEN);

      await tx.emailVerificationToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.user.update({
        where: { id: record.userId },
        data: {
          emailVerifiedAt: now,
          ...(record.user.status === 'PENDING_VERIFICATION' ? { status: 'ACTIVE' } : {}),
        },
      });
      await this.audit.record(
        {
          action: 'auth.email_verified',
          result: 'SUCCESS',
          actorUserId: record.userId,
          targetType: 'user',
          targetId: record.userId,
        },
        request,
        tx,
      );
    });
  }

  async resendVerification(auth: AuthContext): Promise<void> {
    if (auth.user.emailVerifiedAt) return;
    await this.limiter.consume(AuthLimits.resendVerificationPerUser, auth.user.id);
    const token = await this.prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.updateMany({
        where: { userId: auth.user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return this.issueVerificationToken(tx, auth.user.id);
    });
    this.sendVerificationEmail(auth.user, token);
  }

  /** Same response for every address; only eligible accounts receive an email. */
  async forgotPassword(email: string, request: Request): Promise<void> {
    await this.limiter.consume(AuthLimits.forgotPerIp, clientIp(request));
    await this.limiter.consume(AuthLimits.forgotPerEmail, email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, status: true, preferredLocale: true },
    });
    if (!user || !SIGN_IN_ALLOWED_STATUSES.has(user.status)) return;

    const token = generateToken();
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });
      await this.audit.record(
        {
          action: 'auth.password_reset_requested',
          result: 'SUCCESS',
          targetType: 'user',
          targetId: user.id,
        },
        request,
        tx,
      );
    });

    this.email.sendInBackground(user, {
      name: 'reset-password',
      link: this.email.webLink(user.preferredLocale, '/reset-password', { token }),
    });
  }

  /**
   * Sets a new password from a reset link, ends every session of the account, and marks the
   * email as verified (following the link proves control of the inbox).
   */
  async resetPassword(token: string, newPassword: string, request: Request): Promise<void> {
    await this.limiter.consume(AuthLimits.resetPerIp, clientIp(request));
    const now = new Date();

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            status: true,
            preferredLocale: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
    if (
      !record ||
      record.usedAt ||
      record.expiresAt <= now ||
      !SIGN_IN_ALLOWED_STATUSES.has(record.user.status)
    ) {
      throw new AppException(ErrorCode.INVALID_TOKEN);
    }
    const { user } = record;
    this.passwords.assertAcceptable(
      newPassword,
      { email: user.email, name: user.name },
      'newPassword',
    );
    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new AppException(ErrorCode.INVALID_TOKEN);
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
          ...(user.status === 'PENDING_VERIFICATION' ? { status: 'ACTIVE' } : {}),
        },
      });
      await this.audit.record(
        {
          action: 'auth.password_reset',
          result: 'SUCCESS',
          actorUserId: user.id,
          targetType: 'user',
          targetId: user.id,
        },
        request,
        tx,
      );
    });

    await this.sessions.revokeAllForUser(user.id, 'password_reset');
    this.email.sendInBackground(user, { name: 'password-changed' });
  }

  private async issueVerificationToken(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const token = generateToken();
    await tx.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
      },
    });
    return token;
  }

  private sendVerificationEmail(
    user: { email: string; name: string; preferredLocale: PreferredLocale },
    token: string,
  ): void {
    this.email.sendInBackground(user, {
      name: 'verify-email',
      link: this.email.webLink(user.preferredLocale, '/verify-email', { token }),
    });
  }

  private notifyExistingAccount(user: {
    email: string;
    name: string;
    preferredLocale: PreferredLocale;
  }): void {
    this.email.sendInBackground(user, {
      name: 'registration-attempt',
      signInLink: this.email.webLink(user.preferredLocale, '/sign-in'),
      resetLink: this.email.webLink(user.preferredLocale, '/forgot-password'),
    });
  }
}
