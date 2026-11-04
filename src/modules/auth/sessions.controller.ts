import { Controller, Delete, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ApiErrorResponses } from '../../common/http/openapi';
import { ApiZodResponse } from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { Permission } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from './auth-context';
import { CurrentAuth, RequirePermissions } from './auth.decorators';
import { sessionIdParamSchema, sessionSchema } from './auth.schemas';
import { clearSessionCookie } from './auth-state';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller({ path: 'auth/sessions', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class SessionsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Signed-in devices for the current user.' })
  @ApiZodResponse(z.array(sessionSchema))
  async list(@CurrentAuth() auth: AuthContext) {
    const rows = await this.sessions.listActive(auth.user.id);
    return rows.map((row) => ({
      id: row.id,
      current: row.id === auth.session.sessionId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
  }

  @Delete(':sessionId')
  @ApiOperation({ summary: 'Sign out one of the current user’s devices.' })
  @ApiZodResponse(z.object({ accepted: z.literal(true) }))
  @ApiErrorResponses(404)
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', new ZodValidationPipe(sessionIdParamSchema)) sessionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Ownership check: another user's session ID is indistinguishable from a missing one.
    const owned = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId: auth.user.id, revokedAt: null },
      select: { id: true },
    });
    if (!owned) throw new AppException(ErrorCode.NOT_FOUND);

    await this.sessions.revoke(sessionId, 'user_revoked');
    await this.audit.recordBestEffort(
      {
        action: 'session.revoked',
        result: 'SUCCESS',
        actorUserId: auth.user.id,
        targetType: 'session',
        targetId: sessionId,
      },
      request,
    );
    if (sessionId === auth.session.sessionId) {
      clearSessionCookie(response, this.sessions, this.config.session.cookieSecure);
    }
    return { accepted: true as const };
  }
}
