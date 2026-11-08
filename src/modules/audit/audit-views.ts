import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Paginated } from '../../common/http/api-response';
import {
  ApiZodPaginatedResponse,
  ApiZodQuery,
  ApiZodResponse,
} from '../../common/http/zod-openapi';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { OrganizationPermission, Permission } from '../access/permissions';
import { RequireOrganizationPermission, RequirePermissions } from '../auth/auth.decorators';

const DAY_MS = 86_400_000;

export const auditQuerySchema = z.strictObject({
  action: z.string().trim().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
  targetType: z.string().trim().min(1).max(50).optional(),
  targetId: z.string().trim().min(1).max(100).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  /** Bangladesh dates (YYYY-MM-DD), inclusive. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  result: z.string(),
  actor: z.object({ id: z.uuid(), name: z.string(), email: z.string() }).nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  metadata: z.unknown(),
  /** Super Admin view only. */
  ipAddress: z.string().nullable().optional(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

function timeFilter(query: AuditQuery): Prisma.DateTimeFilter | undefined {
  if (!query.from && !query.to) return undefined;
  return {
    gte: query.from ? new Date(`${query.from}T00:00:00+06:00`) : undefined,
    lt: query.to ? new Date(new Date(`${query.to}T00:00:00+06:00`).getTime() + DAY_MS) : undefined,
  };
}

const SELECT = {
  id: true,
  action: true,
  result: true,
  targetType: true,
  targetId: true,
  reason: true,
  metadata: true,
  ipAddress: true,
  requestId: true,
  createdAt: true,
  actor: { select: { id: true, name: true, email: true } },
} as const;

type Row = Prisma.AuditLogGetPayload<{ select: typeof SELECT }>;

function present(row: Row, withIp: boolean) {
  return {
    id: row.id,
    action: row.action,
    result: row.result,
    actor: row.actor,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    metadata: row.metadata,
    ...(withIp ? { ipAddress: row.ipAddress } : {}),
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The whole audit log, newest first, for Super Admins (PRD Phase 10: audit views). */
@ApiTags('admin')
@Controller({ path: 'admin/audit', version: '1' })
@RequirePermissions(Permission.AdminAuditRead)
export class AdminAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Audit log entries, newest first, with filters.' })
  @ApiZodQuery(auditQuerySchema)
  @ApiZodPaginatedResponse(auditEntrySchema)
  async list(@Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      action: query.action,
      actorUserId: query.actorId,
      targetType: query.targetType,
      targetId: query.targetId,
      result: query.result,
      createdAt: timeFilter(query),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: SELECT,
      }),
    ]);
    return new Paginated(
      rows.map((row) => present(row, true)),
      { page: query.page, limit: query.limit, total },
    );
  }

  @Get('actions')
  @ApiOperation({ summary: 'Every action name in the log, for the filter.' })
  @ApiZodResponse(z.array(z.string()))
  async actions() {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });
    return rows.map((row) => row.action);
  }
}

/**
 * An organization's own history, for its Org Admins: actions on the organization itself (members,
 * invitations, profile, service areas), on reports it handles now by its own members, and on
 * its public updates. IP addresses are not shown.
 */
@ApiTags('organizations')
@Controller({ path: 'organizations/:organizationId/audit', version: '1' })
@RequirePermissions(Permission.AccountSelf)
export class OrganizationAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireOrganizationPermission(OrganizationPermission.ManageMembers)
  @ApiOperation({ summary: 'Your organization’s audit history, newest first (Org Admins).' })
  @ApiZodQuery(auditQuerySchema.omit({ actorId: true, targetId: true }))
  @ApiZodPaginatedResponse(auditEntrySchema)
  async list(
    @Param('organizationId', new ZodValidationPipe(z.uuid())) organizationId: string,
    @Query(new ZodValidationPipe(auditQuerySchema.omit({ actorId: true, targetId: true })))
    query: Omit<AuditQuery, 'actorId' | 'targetId'>,
  ) {
    const [members, reports, updates] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId },
        select: { userId: true },
      }),
      this.prisma.report.findMany({ where: { organizationId }, select: { id: true } }),
      this.prisma.reportPublicUpdate.findMany({ where: { organizationId }, select: { id: true } }),
    ]);
    const where: Prisma.AuditLogWhereInput = {
      action: query.action,
      targetType: query.targetType,
      result: query.result,
      createdAt: timeFilter(query),
      OR: [
        { targetType: 'organization', targetId: organizationId },
        {
          targetType: 'report',
          targetId: { in: reports.map((report) => report.id) },
          actorUserId: { in: members.map((member) => member.userId) },
        },
        {
          targetType: 'report_public_update',
          targetId: { in: updates.map((update) => update.id) },
        },
      ],
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: SELECT,
      }),
    ]);
    return new Paginated(
      rows.map((row) => present(row, false)),
      { page: query.page, limit: query.limit, total },
    );
  }
}
