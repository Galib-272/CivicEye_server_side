import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { ApiErrorResponses } from '../../common/http/openapi';
import {
  ApiZodBody,
  ApiZodPaginatedResponse,
  ApiZodQuery,
  ApiZodResponse,
} from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { Permission } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth, RequirePermissions } from '../auth/auth.decorators';
import { SessionService } from '../auth/session.service';

const accountStatus = z.enum([
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
  'DELETED',
]);

const listQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: accountStatus.optional(),
  role: z.enum(['CITIZEN', 'SUPER_ADMIN']).optional(),
  q: z.string().trim().min(1).max(254).optional(),
});

const adminUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  status: accountStatus,
  platformRole: z.enum(['CITIZEN', 'SUPER_ADMIN']),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
});

// Administrators can suspend, deactivate or reactivate. DELETED follows the (open) deletion policy.
const updateStatusSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  reason: z.string().trim().min(5).max(1000),
});

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  platformRole: true,
  emailVerifiedAt: true,
  createdAt: true,
  mfa: { select: { enabledAt: true } },
} as const;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;

function toAdminUser(row: AdminUserRow): z.infer<typeof adminUserSchema> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    platformRole: row.platformRole,
    emailVerified: row.emailVerifiedAt !== null,
    mfaEnabled: !!row.mfa?.enabledAt,
    createdAt: row.createdAt.toISOString(),
  };
}

@ApiTags('admin')
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(Permission.AdminUsersRead)
  @ApiOperation({ summary: 'List users (Super Admin).' })
  @ApiZodQuery(listQuerySchema)
  @ApiZodPaginatedResponse(adminUserSchema)
  @ApiErrorResponses(400, 401, 403)
  async list(
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    const where: Prisma.UserWhereInput = {
      status: query.status,
      platformRole: query.role,
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_SELECT,
        // Stable ordering for pagination: newest first, ties broken by id.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return new Paginated(rows.map(toAdminUser), { page: query.page, limit: query.limit, total });
  }

  @Patch(':userId/status')
  @RequirePermissions(Permission.AdminUsersManage)
  @ApiOperation({
    summary: 'Suspend, deactivate or reactivate a user (Super Admin). Ends their sessions.',
  })
  @ApiZodBody(updateStatusSchema)
  @ApiZodResponse(adminUserSchema)
  @ApiErrorResponses(400, 401, 403, 404, 409)
  async updateStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', new ZodValidationPipe(z.uuid())) userId: string,
    @Body(new ZodValidationPipe(updateStatusSchema)) input: z.infer<typeof updateStatusSchema>,
    @Req() request: Request,
  ) {
    if (userId === auth.user.id) {
      throw new AppException(ErrorCode.FORBIDDEN, 'You cannot change your own account status.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: { status: true, emailVerifiedAt: true },
      });
      if (!target) throw new AppException(ErrorCode.NOT_FOUND);
      if (target.status === 'DELETED') {
        throw new AppException(ErrorCode.CONFLICT, 'Deleted accounts cannot be changed.');
      }
      // Reactivating an unverified account returns it to PENDING_VERIFICATION, not ACTIVE.
      const next =
        input.status === 'ACTIVE' && !target.emailVerifiedAt
          ? 'PENDING_VERIFICATION'
          : input.status;

      // Conditional update guards against two administrators acting at the same time.
      const changed = await tx.user.updateMany({
        where: { id: userId, status: target.status },
        data: { status: next },
      });
      if (changed.count !== 1) {
        throw new AppException(ErrorCode.CONFLICT);
      }
      await this.audit.record(
        {
          action: 'admin.user_status_changed',
          result: 'SUCCESS',
          actorUserId: auth.user.id,
          targetType: 'user',
          targetId: userId,
          reason: input.reason,
          metadata: { from: target.status, to: next },
        },
        request,
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADMIN_USER_SELECT });
    });

    if (updated.status === 'SUSPENDED' || updated.status === 'DEACTIVATED') {
      await this.sessions.revokeAllForUser(userId, 'account_status_changed');
    }
    return toAdminUser(updated);
  }
}
