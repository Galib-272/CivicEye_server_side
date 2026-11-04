import { Body, Controller, Get, HttpCode, Inject, Patch, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodBody, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { Permission } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { AUTH_USER_SELECT, type AuthContext } from '../auth/auth-context';
import { AuthLimits, AuthRateLimiter } from '../auth/auth-rate-limiter.service';
import { CurrentAuth, RequirePermissions } from '../auth/auth.decorators';
import { authStateSchema, selfUserSchema, type AuthState } from '../auth/auth.schemas';
import { setSessionCookie, toAuthState, toSelfUser } from '../auth/auth-state';
import { PASSWORD_MAX_LENGTH } from '../auth/password-policy';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';

// Only these fields are editable by the user. Role, status and email are never accepted here.
const updateProfileSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    preferredLocale: z.enum(['en', 'bn']).optional(),
  })
  .refine((value) => value.name !== undefined || value.preferredLocale !== undefined, {
    message: 'Provide at least one field to update.',
  });

const changePasswordSchema = z.strictObject({
  currentPassword: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4),
  newPassword: z
    .string()
    .min(1)
    .max(PASSWORD_MAX_LENGTH * 4),
});

@ApiTags('users')
@Controller({ path: 'users/me', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limiter: AuthRateLimiter,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in user’s profile.' })
  @ApiZodResponse(selfUserSchema)
  profile(@CurrentAuth() auth: AuthContext) {
    return toSelfUser(auth.user);
  }

  @Patch()
  @ApiOperation({ summary: 'Update the signed-in user’s name or language.' })
  @ApiZodBody(updateProfileSchema)
  @ApiZodResponse(selfUserSchema)
  @ApiErrorResponses(400)
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateProfileSchema)) input: z.infer<typeof updateProfileSchema>,
    @Req() request: Request,
  ) {
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: auth.user.id },
        data: input,
        select: AUTH_USER_SELECT,
      });
      await this.audit.record(
        {
          action: 'user.profile_updated',
          result: 'SUCCESS',
          actorUserId: auth.user.id,
          targetType: 'user',
          targetId: auth.user.id,
          metadata: { fields: Object.keys(input) },
        },
        request,
        tx,
      );
      return updated;
    });
    return toSelfUser(user);
  }

  @Patch('password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change password. Signs out all other devices and renews the current session.',
  })
  @ApiZodBody(changePasswordSchema)
  @ApiZodResponse(authStateSchema)
  @ApiErrorResponses(400, 401, 429)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordSchema)) input: z.infer<typeof changePasswordSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthState> {
    await this.limiter.consume(AuthLimits.changePasswordPerUser, auth.user.id);
    const { passwordHash } = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.user.id },
      select: { passwordHash: true },
    });
    if (!(await this.passwords.verify(passwordHash, input.currentPassword))) {
      await this.audit.recordBestEffort(
        {
          action: 'user.password_changed',
          result: 'FAILURE',
          actorUserId: auth.user.id,
          reason: 'wrong_current_password',
        },
        request,
      );
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, 'The current password is incorrect.');
    }
    this.passwords.assertAcceptable(input.newPassword, auth.user, 'newPassword');
    const newHash = await this.passwords.hash(input.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: auth.user.id },
        data: { passwordHash: newHash, passwordChangedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'user.password_changed',
          result: 'SUCCESS',
          actorUserId: auth.user.id,
          targetType: 'user',
          targetId: auth.user.id,
        },
        request,
        tx,
      );
    });

    await this.sessions.revokeAllForUser(auth.user.id, 'password_changed', auth.session.sessionId);
    const { token, record } = await this.sessions.rotate(auth.token, auth.session, {});
    setSessionCookie(response, this.sessions, token, record, this.config.session.cookieSecure);
    this.email.sendInBackground(auth.user, { name: 'password-changed' });
    return toAuthState(auth.user, record);
  }
}
