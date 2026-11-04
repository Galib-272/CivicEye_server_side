import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodBody, ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { Permission } from '../access/permissions';
import type { AuthContext } from './auth-context';
import { AllowIncompleteMfa, CurrentAuth, Public, RequirePermissions } from './auth.decorators';
import {
  acceptedSchema,
  authStateSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
  type AuthState,
  type LoginInput,
  type RegisterInput,
} from './auth.schemas';
import { AuthService } from './auth.service';
import { clearSessionCookie, setSessionCookie, toAuthState } from './auth-state';
import { SessionService } from './session.service';

const ACCEPTED = { accepted: true } as const;

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Create an account. Responds identically whether or not the email is already registered.',
  })
  @ApiZodBody(registerSchema)
  @ApiZodResponse(acceptedSchema, 202)
  @ApiErrorResponses(400, 429)
  async register(
    @Body(new ZodValidationPipe(registerSchema)) input: RegisterInput,
    @Req() request: Request,
  ) {
    await this.auth.register(input, request);
    return ACCEPTED;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password. Sets the session cookie.' })
  @ApiZodBody(loginSchema)
  @ApiZodResponse(authStateSchema)
  @ApiErrorResponses(400, 401, 403, 429)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthState> {
    const cookies = request.cookies as Record<string, string | undefined>;
    const { token, record, user } = await this.auth.login(
      input,
      request,
      cookies[this.sessions.cookieName()],
    );
    setSessionCookie(response, this.sessions, token, record, this.config.session.cookieSecure);
    return toAuthState(user, record);
  }

  @Post('logout')
  @RequirePermissions(Permission.AccountSelf)
  @AllowIncompleteMfa()
  @HttpCode(200)
  @ApiOperation({ summary: 'End the current session.' })
  @ApiZodResponse(acceptedSchema)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(auth, request);
    clearSessionCookie(response, this.sessions, this.config.session.cookieSecure);
    return ACCEPTED;
  }

  @Get('me')
  @RequirePermissions(Permission.AccountSelf)
  @AllowIncompleteMfa()
  @ApiOperation({
    summary:
      'The signed-in user, the CSRF token for state-changing requests, and two-factor state.',
  })
  @ApiZodResponse(authStateSchema)
  @ApiErrorResponses(401)
  me(@CurrentAuth() auth: AuthContext): AuthState {
    return toAuthState(auth.user, auth.session);
  }

  @Post('verify-email')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email address with the token from the verification email.' })
  @ApiZodBody(tokenSchema)
  @ApiZodResponse(acceptedSchema)
  @ApiErrorResponses(400, 429)
  async verifyEmail(
    @Body(new ZodValidationPipe(tokenSchema)) input: { token: string },
    @Req() request: Request,
  ) {
    await this.auth.verifyEmail(input.token, request);
    return ACCEPTED;
  }

  @Post('resend-verification')
  @RequirePermissions(Permission.AccountSelf)
  @HttpCode(202)
  @ApiOperation({ summary: 'Send a new verification email to the signed-in user.' })
  @ApiZodResponse(acceptedSchema, 202)
  @ApiErrorResponses(401, 429)
  async resendVerification(@CurrentAuth() auth: AuthContext) {
    await this.auth.resendVerification(auth);
    return ACCEPTED;
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a password reset email. Responds identically for every address.',
  })
  @ApiZodBody(forgotPasswordSchema)
  @ApiZodResponse(acceptedSchema, 202)
  @ApiErrorResponses(400, 429)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) input: { email: string },
    @Req() request: Request,
  ) {
    await this.auth.forgotPassword(input.email, request);
    return ACCEPTED;
  }

  @Post('reset-password')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set a new password with a reset token. Signs the account out everywhere.',
  })
  @ApiZodBody(resetPasswordSchema)
  @ApiZodResponse(acceptedSchema)
  @ApiErrorResponses(400, 429)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema))
    input: { token: string; newPassword: string },
    @Req() request: Request,
  ) {
    await this.auth.resetPassword(input.token, input.newPassword, request);
    return ACCEPTED;
  }
}
