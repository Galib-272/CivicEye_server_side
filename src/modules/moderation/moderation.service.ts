import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Paginated } from '../../common/http/api-response';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ModerationReason } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import { AuthLimits, AuthRateLimiter } from '../auth/auth-rate-limiter.service';
import { SessionService } from '../auth/session.service';
import { recordEvent } from '../notifications/outbox';
import {
  OPEN_STATUSES,
  type ActionInput,
  type ActionKind,
  type CaseDetail,
  type CaseQuery,
  type EscalateInput,
  type FlagInput,
} from './moderation.schemas';

type Tx = Prisma.TransactionClient;
const OPEN: ReadonlySet<string> = new Set(OPEN_STATUSES);

/**
 * Moderation (PRD §28): anyone signed in can flag public content, organizations can escalate
 * their reports, and Super Admins decide. Every decision has a written reason and is audited.
 * Nothing happens automatically: flags never hide content or suspend anyone by themselves.
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly limiter: AuthRateLimiter,
    private readonly sessions: SessionService,
  ) {}

  // ─── Flags ──────────────────────────────────────────────────────────────────

  /** A signed-in user flags a public report, or one of its visible public updates. */
  async flag(
    publicId: string,
    updateId: string | null,
    input: FlagInput,
    userId: string,
    request: Request,
  ) {
    await this.limiter.consume(AuthLimits.flagsPerUserHour, userId);
    const report = await this.prisma.report.findUnique({
      where: { publicId },
      select: {
        id: true,
        citizenId: true,
        visibility: true,
        status: true,
        moderationHiddenAt: true,
      },
    });
    const visible =
      report &&
      report.visibility === 'PUBLIC' &&
      report.status !== 'WITHDRAWN' &&
      !report.moderationHiddenAt;
    if (!visible) throw new AppException(ErrorCode.NOT_FOUND);
    if (updateId) {
      const update = await this.prisma.reportPublicUpdate.findFirst({
        where: { id: updateId, reportId: report.id, hiddenAt: null },
        select: { id: true },
      });
      if (!update) throw new AppException(ErrorCode.NOT_FOUND);
    } else if (report.citizenId === userId) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'You cannot flag your own report.');
    }
    await this.addFlag(
      report.id,
      updateId,
      input.reason,
      input.details ?? null,
      userId,
      null,
      request,
    );
    return { received: true as const };
  }

  /** An organization reviewer asks the Super Admins to look at a report the organization handles. */
  async escalate(
    organizationId: string,
    publicId: string,
    input: EscalateInput,
    userId: string,
    request: Request,
  ) {
    const report = await this.prisma.report.findFirst({
      where: { publicId, organizationId },
      select: { id: true },
    });
    if (!report) throw new AppException(ErrorCode.NOT_FOUND);
    await this.addFlag(
      report.id,
      null,
      input.reason,
      input.details,
      userId,
      organizationId,
      request,
    );
    return { received: true as const };
  }

  private async addFlag(
    reportId: string,
    updateId: string | null,
    reason: ModerationReason,
    details: string | null,
    reporterId: string,
    organizationId: string | null,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const caseId = await this.openCase(tx, reportId, updateId);
      const existing = await tx.moderationFlag.findUnique({
        where: { caseId_reporterId: { caseId, reporterId } },
        select: { id: true },
      });
      if (existing) {
        throw new AppException(ErrorCode.CONFLICT, 'You have already reported this.');
      }
      await tx.moderationFlag.create({
        data: { caseId, reporterId, organizationId, reason, details },
      });
      await tx.moderationCase.update({
        where: { id: caseId },
        data: { flagCount: { increment: 1 }, escalated: organizationId ? true : undefined },
      });
      await this.audit.record(
        {
          action: organizationId ? 'moderation.escalated' : 'moderation.flagged',
          result: 'SUCCESS',
          actorUserId: reporterId,
          targetType: 'moderation_case',
          targetId: caseId,
          metadata: { reportId, publicUpdateId: updateId, reason, organizationId },
        },
        request,
        tx,
      );
    });
  }

  /** The open case for this content, created if there is none (one per target). */
  private async openCase(tx: Tx, reportId: string, updateId: string | null): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO moderation_cases (id, target_type, report_id, public_update_id, updated_at)
      VALUES (${randomUUID()}::uuid,
              ${updateId ? 'PUBLIC_UPDATE' : 'REPORT'}::"ModerationTargetType",
              ${reportId}::uuid, ${updateId}::uuid, now())
      ON CONFLICT (report_id, (COALESCE(public_update_id, '00000000-0000-0000-0000-000000000000'::uuid)))
        WHERE status IN ('OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED')
      DO NOTHING`;
    const found = await tx.moderationCase.findFirstOrThrow({
      where: { reportId, publicUpdateId: updateId, status: { in: [...OPEN_STATUSES] } },
      select: { id: true },
    });
    return found.id;
  }

  // ─── Super Admin queue ──────────────────────────────────────────────────────

  async list(query: CaseQuery) {
    const where: Prisma.ModerationCaseWhereInput =
      query.status === 'all'
        ? {}
        : query.status === 'open'
          ? { status: { in: [...OPEN_STATUSES] } }
          : { status: query.status };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.moderationCase.count({ where }),
      this.prisma.moderationCase.findMany({
        where,
        // Escalations first, then the most flagged, then the oldest.
        orderBy: [{ escalated: 'desc' }, { flagCount: 'desc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          targetType: true,
          status: true,
          flagCount: true,
          escalated: true,
          createdAt: true,
          updatedAt: true,
          report: { select: { publicId: true, title: true } },
          flags: { select: { reason: true } },
        },
      }),
    ]);
    return new Paginated(
      rows.map((row) => ({
        id: row.id,
        targetType: row.targetType,
        status: row.status,
        flagCount: row.flagCount,
        escalated: row.escalated,
        reasons: [...new Set(row.flags.map((flag) => flag.reason))],
        report: row.report,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  async detail(caseId: string): Promise<CaseDetail> {
    const row = await this.prisma.moderationCase.findUnique({
      where: { id: caseId },
      include: {
        report: {
          select: {
            publicId: true,
            title: true,
            description: true,
            status: true,
            visibility: true,
            moderationHiddenAt: true,
            organization: { select: { name: true } },
            citizen: { select: { id: true, name: true, status: true, platformRole: true } },
          },
        },
        publicUpdate: {
          select: {
            id: true,
            body: true,
            hiddenAt: true,
            organization: { select: { name: true } },
          },
        },
        flags: {
          orderBy: { createdAt: 'asc' },
          include: { reporter: { select: { name: true } } },
        },
        actions: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } } },
      },
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    const organizationIds = [
      ...new Set(row.flags.flatMap((flag) => (flag.organizationId ? [flag.organizationId] : []))),
    ];
    const organizations = new Map(
      (
        await this.prisma.organization.findMany({
          where: { id: { in: organizationIds } },
          select: { id: true, name: true },
        })
      ).map((org) => [org.id, org.name]),
    );
    return {
      id: row.id,
      targetType: row.targetType,
      status: row.status,
      flagCount: row.flagCount,
      escalated: row.escalated,
      reasons: [...new Set(row.flags.map((flag) => flag.reason))],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      report: {
        publicId: row.report.publicId,
        title: row.report.title,
        description: row.report.description,
        status: row.report.status,
        visibility: row.report.visibility,
        hiddenFromPublic: row.report.moderationHiddenAt !== null,
        organizationName: row.report.organization?.name ?? null,
        citizen: {
          id: row.report.citizen.id,
          name: row.report.citizen.name,
          status: row.report.citizen.status,
        },
      },
      publicUpdate: row.publicUpdate
        ? {
            id: row.publicUpdate.id,
            body: row.publicUpdate.body,
            organizationName: row.publicUpdate.organization.name,
            hidden: row.publicUpdate.hiddenAt !== null,
          }
        : null,
      flags: row.flags.map((flag) => ({
        reason: flag.reason,
        details: flag.details,
        source: flag.organizationId ? ('organization' as const) : ('user' as const),
        reporterName: flag.reporter.name,
        organizationName: flag.organizationId
          ? (organizations.get(flag.organizationId) ?? null)
          : null,
        createdAt: flag.createdAt.toISOString(),
      })),
      actions: row.actions.map((action) => ({
        kind: action.kind,
        reason: action.reason,
        message: action.message,
        actorName: action.actor.name,
        createdAt: action.createdAt.toISOString(),
      })),
      allowedActions: allowedActions({
        status: row.status,
        targetType: row.targetType,
        reportHidden: row.report.moderationHiddenAt !== null,
        updateHidden: row.publicUpdate ? row.publicUpdate.hiddenAt !== null : null,
        citizenStatus: row.report.citizen.status,
        citizenIsSuperAdmin: row.report.citizen.platformRole === 'SUPER_ADMIN',
      }),
    };
  }

  /** A moderator's decision. Checked against the case as it is now, inside one transaction. */
  async act(caseId: string, input: ActionInput, actorId: string, request: Request) {
    const suspended = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM moderation_cases WHERE id = ${caseId}::uuid FOR UPDATE`;
      if (!locked) throw new AppException(ErrorCode.NOT_FOUND);
      const row = await tx.moderationCase.findUniqueOrThrow({
        where: { id: caseId },
        include: {
          report: {
            select: {
              id: true,
              citizenId: true,
              moderationHiddenAt: true,
              citizen: { select: { status: true, platformRole: true } },
            },
          },
          publicUpdate: { select: { id: true, hiddenAt: true } },
        },
      });
      const allowed = allowedActions({
        status: row.status,
        targetType: row.targetType,
        reportHidden: row.report.moderationHiddenAt !== null,
        updateHidden: row.publicUpdate ? row.publicUpdate.hiddenAt !== null : null,
        citizenStatus: row.report.citizen.status,
        citizenIsSuperAdmin: row.report.citizen.platformRole === 'SUPER_ADMIN',
      });
      if (!allowed.includes(input.kind)) {
        throw new AppException(ErrorCode.CONFLICT, 'This action is not possible for the case now.');
      }
      const citizenId = row.report.citizenId;
      if (input.kind === 'SUSPEND_USER' && citizenId === actorId) {
        throw new AppException(ErrorCode.FORBIDDEN, 'You cannot suspend your own account.');
      }
      const now = new Date();
      switch (input.kind) {
        case 'HIDE_REPORT':
          await tx.report.update({
            where: { id: row.report.id },
            data: { moderationHiddenAt: now, moderationHiddenReason: input.reason },
          });
          break;
        case 'RESTORE_REPORT':
          await tx.report.update({
            where: { id: row.report.id },
            data: { moderationHiddenAt: null, moderationHiddenReason: null },
          });
          break;
        case 'HIDE_UPDATE':
          if (!row.publicUpdate) throw new AppException(ErrorCode.CONFLICT);
          await tx.reportPublicUpdate.update({
            where: { id: row.publicUpdate.id },
            data: { hiddenAt: now, hiddenById: actorId, hiddenReason: input.reason },
          });
          break;
        case 'SUSPEND_USER':
          await tx.user.update({ where: { id: citizenId }, data: { status: 'SUSPENDED' } });
          break;
        default:
          break;
      }
      const concernsCitizen: ActionKind[] = [
        'HIDE_REPORT',
        'RESTORE_REPORT',
        'REQUEST_CORRECTION',
        'WARN_USER',
        'SUSPEND_USER',
      ];
      const targetUserId =
        row.targetType === 'REPORT' && concernsCitizen.includes(input.kind) ? citizenId : null;
      await tx.moderationAction.create({
        data: {
          caseId,
          actorId,
          kind: input.kind,
          reason: input.reason,
          message: input.message ?? null,
          targetUserId,
        },
      });
      const next = nextStatus(row.status, input.kind);
      if (next !== row.status) {
        await tx.moderationCase.update({
          where: { id: caseId },
          data: {
            status: next,
            closedAt: next === 'RESOLVED' || next === 'DISMISSED' ? now : undefined,
          },
        });
      }
      await recordEvent(tx, 'moderation.action', {
        caseId,
        reportId: row.report.id,
        kind: input.kind,
        targetUserId,
        actorUserId: actorId,
      });
      await this.audit.record(
        {
          action: `moderation.${input.kind.toLowerCase()}`,
          result: 'SUCCESS',
          actorUserId: actorId,
          targetType: 'moderation_case',
          targetId: caseId,
          reason: input.reason,
          metadata: { reportId: row.report.id, targetUserId, from: row.status, to: next },
        },
        request,
        tx,
      );
      return input.kind === 'SUSPEND_USER' ? citizenId : null;
    });
    if (suspended) await this.sessions.revokeAllForUser(suspended, 'account_status_changed');
    return this.detail(caseId);
  }
}

/** What a moderator may do with a case in its current state. */
export function allowedActions(state: {
  status: string;
  targetType: 'REPORT' | 'PUBLIC_UPDATE';
  reportHidden: boolean;
  updateHidden: boolean | null;
  citizenStatus: string;
  citizenIsSuperAdmin: boolean;
}): ActionKind[] {
  const open = OPEN.has(state.status);
  const actions: ActionKind[] = [];
  // Restoring a hidden report is possible even after the case closed (a mistake can be undone).
  if (state.targetType === 'REPORT' && state.reportHidden) actions.push('RESTORE_REPORT');
  if (!open) return actions;
  if (state.status === 'OPEN') actions.push('START_REVIEW');
  if (state.targetType === 'REPORT') {
    if (!state.reportHidden) actions.push('HIDE_REPORT');
    actions.push('REQUEST_CORRECTION', 'WARN_USER');
    if (
      !state.citizenIsSuperAdmin &&
      (state.citizenStatus === 'ACTIVE' || state.citizenStatus === 'PENDING_VERIFICATION')
    ) {
      actions.push('SUSPEND_USER');
    }
  } else if (state.updateHidden === false) {
    actions.push('HIDE_UPDATE');
  }
  actions.push('RESOLVE', 'DISMISS');
  return actions;
}

/** Case state after an action (PRD §28.2). */
export function nextStatus(status: string, kind: ActionKind) {
  if (kind === 'RESOLVE') return 'RESOLVED';
  if (kind === 'DISMISS') return 'DISMISSED';
  if (!OPEN.has(status)) return status as 'RESOLVED' | 'DISMISSED';
  if (kind === 'REQUEST_CORRECTION') return 'ACTION_REQUIRED';
  // Any other decision on a new case means a moderator is now looking at it.
  return status === 'OPEN' ? 'UNDER_REVIEW' : (status as 'UNDER_REVIEW' | 'ACTION_REQUIRED');
}
