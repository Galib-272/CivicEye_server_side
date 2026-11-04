import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
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
import type { AuthContext } from './auth-context';
import { AllowIncompleteMfa, CurrentAuth, RequirePermissions } from './auth.decorators';
import {
  authStateSchema,
  mfaChallengeSchema,
  mfaCodeSchema,
  mfaEnabledSchema,
  mfaSetupSchema,
  type AuthState,
  type MfaChallengeInput,
} from './auth.schemas';
import { setSessionCookie, toAuthState } from './auth-state';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';

const mfaStatusSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  backupCodesRemaining: z.number().int(),
});

@ApiTags('auth')
@Controller({ path: 'auth/mfa', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @AllowIncompleteMfa()
  @ApiOperation({ summary: 'Two-factor status of the signed-in user.' })
  @ApiZodResponse(mfaStatusSchema)
  async status(@CurrentAuth() auth: AuthContext) {
    const mfa = await this.prisma.userMfa.findUnique({
      where: { userId: auth.user.id },
      select: { enabledAt: true },
    });
    return {
      enabled: !!mfa?.enabledAt,
      required: auth.user.platformRole === 'SUPER_ADMIN',
      backupCodesRemaining: mfa?.enabledAt ? await this.mfa.remainingBackupCodes(auth.user.id) : 0,
    };
  }

  @Post('setup')
  @AllowIncompleteMfa()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start two-factor setup. Returns the secret to add to an authenticator app.',
  })
  @ApiZodResponse(mfaSetupSchema)
  @ApiErrorResponses(409)
  setup(@CurrentAuth() auth: AuthContext) {
    if (auth.session.mfa === 'pending') {
      // A sign-in waiting for its two-factor code must complete that first.
      throw new AppException(ErrorCode.MFA_REQUIRED);
    }
    return this.mfa.setup(auth);
  }

  @Post('enable')
  @AllowIncompleteMfa()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm setup with a code. Returns backup codes, shown only once.',
  })
  @ApiZodBody(mfaCodeSchema)
  @ApiZodResponse(mfaEnabledSchema)
  @ApiErrorResponses(400, 409, 429)
  async enable(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(mfaCodeSchema)) input: { code: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { backupCodes, token, record } = await this.mfa.enable(auth, input.code, request);
    setSessionCookie(response, this.sessions, token, record, this.config.session.cookieSecure);
    return { backupCodes, auth: toAuthState(auth.user, record) };
  }

  @Post('challenge')
  @AllowIncompleteMfa()
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete sign-in with an authenticator code or a backup code.' })
  @ApiZodBody(mfaChallengeSchema)
  @ApiZodResponse(authStateSchema)
  @ApiErrorResponses(400, 409, 429)
  async challenge(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(mfaChallengeSchema)) input: MfaChallengeInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthState> {
    const { token, record } = await this.mfa.challenge(auth, input, request);
    setSessionCookie(response, this.sessions, token, record, this.config.session.cookieSecure);
    return toAuthState(auth.user, record);
  }
}
