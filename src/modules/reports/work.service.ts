import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { AssignmentEventKind } from '../../generated/prisma/enums';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth-context';
import { AssignmentViews } from './assignment-views.service';
import { OPEN_ASSIGNMENT_STATES } from './assignment-workflow';
import { recordEvent } from '../notifications/outbox';
import { applyTransition, lockReport } from './report-workflow';
import { ReportsService } from './reports.service';
import { ReviewService } from './review.service';
import {
  TASK_GROUPS,
  type AssignInput,
  type CompleteInput,
  type FeedbackInput,
  type ProgressInput,
  type ReassignInput,
  type taskItemSchema,
  type TasksQuery,
  type TaskView,
  type VerifyInput,
  type workerSchema,
  type workMembershipSchema,
} from './work.schemas';

type Tx = Prisma.TransactionClient;

/**
 * Phase 6 (PRD §8): assigning workers, the worker's own task flow, verification by someone
 * other than the worker, reopening and closing, and the citizen's "Is it fixed?" feedback.
 * Every report status change goes through applyTransition; assignment changes are recorded as
 * append-only events.
 */
@Injectable()
export class WorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly views: AssignmentViews,
    private readonly review: ReviewService,
    private readonly reports: ReportsService,
  ) {}

  // ─── Organization: workers and assignment ──────────────────────────────────

  /** Active workers of the organization, with availability and current workload. */
  async workers(organizationId: string) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: 'WORKER', status: 'ACTIVE' },
      orderBy: { user: { name: 'asc' } },
      select: { userId: true, available: true, user: { select: { name: true } } },
    });
    const load = await this.prisma.reportAssignment.groupBy({
      by: ['workerId'],
      where: { organizationId, state: { in: OPEN_ASSIGNMENT_STATES } },
      _count: { _all: true },
    });
    const tasks = new Map(load.map((row) => [row.workerId, row._count._all]));
    return members.map((member): z.infer<typeof workerSchema> => ({
      userId: member.userId,
      name: member.user.name,
      available: member.available,
      activeTasks: tasks.get(member.userId) ?? 0,
    }));
  }

  async assign(
    organizationId: string,
    publicId: string,
    version: number,
    input: AssignInput,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await this.assertAssignableWorker(tx, organizationId, input.workerId);
      await applyTransition(tx, report, 'assign', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
      });
      await this.createAssignment(tx, report.id, organizationId, input, actorId);
      await this.record(tx, request, actorId, report.id, 'report.assigned', {
        organizationId,
        workerId: input.workerId,
      });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  async reassign(
    organizationId: string,
    publicId: string,
    version: number,
    input: ReassignInput,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      const current = await this.openAssignment(tx, report.id);
      if (current.workerId === input.workerId) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, 'Choose a different worker.');
      }
      await this.assertAssignableWorker(tx, organizationId, input.workerId);
      await applyTransition(tx, report, 'reassign', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason: input.reason,
      });
      await this.endAssignment(tx, current.id, 'CANCELLED', 'CANCELLED', input.reason, actorId);
      await this.createAssignment(tx, report.id, organizationId, input, actorId);
      await this.record(tx, request, actorId, report.id, 'report.reassigned', {
        organizationId,
        fromWorkerId: current.workerId,
        toWorkerId: input.workerId,
      });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  async cancelAssignment(
    organizationId: string,
    publicId: string,
    version: number,
    reason: string,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      const current = await this.openAssignment(tx, report.id);
      await applyTransition(tx, report, 'releaseAssignment', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason,
      });
      await this.endAssignment(tx, current.id, 'CANCELLED', 'CANCELLED', reason, actorId);
      await this.record(tx, request, actorId, report.id, 'report.assignment_cancelled', {
        organizationId,
        workerId: current.workerId,
      });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  // ─── Organization: verification, reopening, closing ───────────────────────

  /**
   * Checks the latest completion evidence. The verifier can never be the worker who did the
   * job (PRD §6.3), whatever their role is now.
   */
  async verify(
    organizationId: string,
    publicId: string,
    version: number,
    input: VerifyInput,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      const assignment = await tx.reportAssignment.findFirst({
        where: { reportId: report.id, state: 'COMPLETED' },
        select: { id: true, workerId: true },
      });
      const submission = assignment
        ? await tx.completionSubmission.findFirst({
            where: { assignmentId: assignment.id, verification: null },
            orderBy: { createdAt: 'desc' },
            select: { id: true, workerId: true },
          })
        : null;
      if (!assignment || !submission) {
        throw new AppException(ErrorCode.INVALID_STATE_TRANSITION, 'There is no work to verify.');
      }
      if (assignment.workerId === actorId || submission.workerId === actorId) {
        throw new AppException(ErrorCode.FORBIDDEN, 'You cannot verify your own work.');
      }
      const approved = input.outcome === 'APPROVED';
      await applyTransition(tx, report, approved ? 'approveWork' : 'rejectWork', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason: input.reason ?? null,
        data: approved ? { resolvedAt: new Date() } : {},
      });
      await tx.workVerification.create({
        data: {
          reportId: report.id,
          assignmentId: assignment.id,
          submissionId: submission.id,
          verifierId: actorId,
          outcome: input.outcome,
          reason: input.reason ?? null,
        },
      });
      await tx.reportAssignment.update({
        where: { id: assignment.id },
        data: approved
          ? { state: 'VERIFIED', endedAt: new Date() }
          : { state: 'IN_PROGRESS', completedAt: null },
      });
      const kind: AssignmentEventKind = approved
        ? 'APPROVED'
        : input.outcome === 'REJECTED'
          ? 'REJECTED'
          : 'MORE_EVIDENCE_NEEDED';
      await tx.assignmentEvent.create({
        data: { assignmentId: assignment.id, actorId, kind, message: input.reason ?? null },
      });
      await recordEvent(tx, 'assignment.verified', {
        assignmentId: assignment.id,
        outcome: input.outcome,
        actorUserId: actorId,
      });
      await this.record(tx, request, actorId, report.id, 'report.work_verified', {
        organizationId,
        outcome: input.outcome,
      });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  async reopen(
    organizationId: string,
    publicId: string,
    version: number,
    reason: string,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await applyTransition(tx, report, 'reopen', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        reason,
        data: { resolvedAt: null },
      });
      await this.record(tx, request, actorId, report.id, 'report.reopened', { organizationId });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  async close(
    organizationId: string,
    publicId: string,
    version: number,
    actorId: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const report = await this.lockForOrganization(tx, publicId, organizationId);
      await applyTransition(tx, report, 'close', 'org_reviewer', {
        actorUserId: actorId,
        actorContext: 'org_reviewer',
        expectedVersion: version,
        data: { closedAt: new Date() },
      });
      await this.record(tx, request, actorId, report.id, 'report.closed', { organizationId });
    });
    return this.review.view(publicId, { kind: 'organization', organizationId });
  }

  // ─── Worker: own tasks ─────────────────────────────────────────────────────

  /** Organizations where the user is an active worker, with their availability. */
  async memberships(userId: string) {
    const members = await this.prisma.organizationMember.findMany({
      where: { userId, role: 'WORKER', status: 'ACTIVE', organization: { isActive: true } },
      orderBy: { organization: { name: 'asc' } },
      select: { organizationId: true, available: true, organization: { select: { name: true } } },
    });
    return members.map((member): z.infer<typeof workMembershipSchema> => ({
      organizationId: member.organizationId,
      organizationName: member.organization.name,
      available: member.available,
    }));
  }

  async setAvailability(userId: string, organizationId: string, available: boolean) {
    const updated = await this.prisma.organizationMember.updateMany({
      where: { userId, organizationId, role: 'WORKER', status: 'ACTIVE' },
      data: { available },
    });
    if (updated.count !== 1) throw new AppException(ErrorCode.NOT_FOUND);
    return this.memberships(userId);
  }

  async tasks(userId: string, query: TasksQuery) {
    const where: Prisma.ReportAssignmentWhereInput = {
      workerId: userId,
      state: { in: [...TASK_GROUPS[query.group]] },
      // Only organizations the user still works for.
      organization: {
        isActive: true,
        members: { some: { userId, role: 'WORKER', status: 'ACTIVE' } },
      },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.reportAssignment.count({ where }),
      this.prisma.reportAssignment.findMany({
        where,
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          state: true,
          assignedAt: true,
          organization: { select: { name: true } },
          report: {
            select: {
              publicId: true,
              title: true,
              status: true,
              locationDescription: true,
              category: { select: { id: true, slug: true, nameEn: true, nameBn: true } },
            },
          },
        },
      }),
    ]);
    return new Paginated(
      rows.map((row): z.infer<typeof taskItemSchema> => ({
        id: row.id,
        state: row.state,
        organizationName: row.organization.name,
        publicId: row.report.publicId,
        title: row.report.title,
        category: row.report.category,
        reportStatus: row.report.status,
        locationDescription: row.report.locationDescription,
        assignedAt: row.assignedAt.toISOString(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  /** One of the worker's own tasks; anything else (or a former employer's task) is NOT_FOUND. */
  async task(userId: string, assignmentId: string): Promise<TaskView> {
    const row = await this.prisma.reportAssignment.findFirst({
      where: {
        id: assignmentId,
        workerId: userId,
        organization: {
          isActive: true,
          members: { some: { userId, role: 'WORKER', status: 'ACTIVE' } },
        },
      },
      select: {
        id: true,
        state: true,
        organizationId: true,
        organization: { select: { name: true } },
        report: {
          select: {
            id: true,
            publicId: true,
            title: true,
            description: true,
            status: true,
            latitude: true,
            longitude: true,
            locationDescription: true,
            category: { select: { id: true, slug: true, nameEn: true, nameBn: true } },
            media: { orderBy: { position: 'asc' }, select: { id: true } },
          },
        },
      },
    });
    if (!row) throw new AppException(ErrorCode.NOT_FOUND);
    const { report } = row;
    const working = row.state === 'IN_PROGRESS' && report.status === 'IN_PROGRESS';
    return {
      assignment: await this.views.one(row.id),
      organizationId: row.organizationId,
      organizationName: row.organization.name,
      report: {
        publicId: report.publicId,
        title: report.title,
        description: report.description,
        category: report.category,
        status: report.status,
        latitude: report.latitude.toNumber(),
        longitude: report.longitude.toNumber(),
        locationDescription: report.locationDescription,
        photos: await this.views.photos(report.media.map((item) => item.id)),
      },
      actions: {
        accept: row.state === 'PENDING',
        decline: row.state === 'PENDING' || row.state === 'ACCEPTED',
        start: row.state === 'ACCEPTED' && report.status === 'ASSIGNED',
        progress: working,
        returnTask: working,
        complete: working,
      },
    };
  }

  async accept(user: AuthenticatedUser, assignmentId: string, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'PENDING') throw this.invalid();
      await tx.reportAssignment.update({
        where: { id: assignment.id },
        data: { state: 'ACCEPTED', acceptedAt: new Date() },
      });
      await tx.assignmentEvent.create({
        data: { assignmentId: assignment.id, actorId: user.id, kind: 'ACCEPTED' },
      });
      await this.record(tx, request, user.id, report.id, 'assignment.accepted', {});
    });
    return this.task(user.id, assignmentId);
  }

  async decline(user: AuthenticatedUser, assignmentId: string, reason: string, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'PENDING' && assignment.state !== 'ACCEPTED') throw this.invalid();
      await applyTransition(tx, report, 'releaseAssignment', 'assigned_worker', {
        actorUserId: user.id,
        actorContext: 'worker',
        reason,
      });
      await this.endAssignment(tx, assignment.id, 'DECLINED', 'DECLINED', reason, user.id);
      await this.record(tx, request, user.id, report.id, 'assignment.declined', {});
    });
    return this.task(user.id, assignmentId);
  }

  async start(user: AuthenticatedUser, assignmentId: string, request: Request) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'ACCEPTED') throw this.invalid();
      await applyTransition(tx, report, 'startWork', 'assigned_worker', {
        actorUserId: user.id,
        actorContext: 'worker',
      });
      await tx.reportAssignment.update({
        where: { id: assignment.id },
        data: { state: 'IN_PROGRESS', startedAt: new Date() },
      });
      await tx.assignmentEvent.create({
        data: { assignmentId: assignment.id, actorId: user.id, kind: 'STARTED' },
      });
      await this.record(tx, request, user.id, report.id, 'assignment.started', {});
    });
    return this.task(user.id, assignmentId);
  }

  /** A progress note, optionally with photos. Changes no status. */
  async progress(user: AuthenticatedUser, assignmentId: string, input: ProgressInput) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'IN_PROGRESS' || report.status !== 'IN_PROGRESS') {
        throw this.invalid();
      }
      const mediaIds = await this.attachWorkPhotos(tx, user.id, assignment.id, input.mediaIds);
      await tx.assignmentEvent.create({
        data: {
          assignmentId: assignment.id,
          actorId: user.id,
          kind: 'PROGRESS',
          message: input.message,
          mediaIds,
        },
      });
    });
    return this.task(user.id, assignmentId);
  }

  /** The worker hands the task back (unsafe, inaccessible, partly done...), with a reason. */
  async returnTask(
    user: AuthenticatedUser,
    assignmentId: string,
    reason: string,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'IN_PROGRESS') throw this.invalid();
      await applyTransition(tx, report, 'releaseAssignment', 'assigned_worker', {
        actorUserId: user.id,
        actorContext: 'worker',
        reason,
      });
      await this.endAssignment(tx, assignment.id, 'RETURNED', 'RETURNED', reason, user.id);
      await this.record(tx, request, user.id, report.id, 'assignment.returned', {});
    });
    return this.task(user.id, assignmentId);
  }

  /**
   * Completion evidence: a description and 1–5 after photos. The report records "work
   * completed" and then moves straight to verification (approved policy).
   */
  async complete(
    user: AuthenticatedUser,
    assignmentId: string,
    input: CompleteInput,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { assignment, report } = await this.lockOwnTask(tx, user.id, assignmentId);
      if (assignment.state !== 'IN_PROGRESS') throw this.invalid();
      const mediaIds = await this.attachWorkPhotos(tx, user.id, assignment.id, input.mediaIds);
      await tx.completionSubmission.create({
        data: {
          assignmentId: assignment.id,
          workerId: user.id,
          description: input.description,
          mediaIds,
        },
      });
      const version = await applyTransition(tx, report, 'completeWork', 'assigned_worker', {
        actorUserId: user.id,
        actorContext: 'worker',
      });
      await applyTransition(
        tx,
        { ...report, status: 'WORK_COMPLETED', version },
        'submitForVerification',
        'system',
        { actorUserId: null, actorContext: 'system' },
      );
      await tx.reportAssignment.update({
        where: { id: assignment.id },
        data: { state: 'COMPLETED', completedAt: new Date() },
      });
      await tx.assignmentEvent.create({
        data: {
          assignmentId: assignment.id,
          actorId: user.id,
          kind: 'COMPLETED',
          message: input.description,
          mediaIds,
        },
      });
      await this.record(tx, request, user.id, report.id, 'assignment.completed', {
        photos: mediaIds.length,
      });
    });
    return this.task(user.id, assignmentId);
  }

  // ─── Citizen: "Is it fixed?" ───────────────────────────────────────────────

  /** Feedback only (PRD §8.6): recorded for the organization, never changes the status. */
  async giveFeedback(
    publicId: string,
    input: FeedbackInput,
    citizen: AuthenticatedUser,
    request: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const id = await lockReport(tx, publicId, { citizenId: citizen.id });
      const report = await tx.report.findUniqueOrThrow({
        where: { id },
        select: { status: true, resolvedAt: true },
      });
      if (report.status !== 'RESOLVED' || !report.resolvedAt) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Feedback is possible once the report is resolved.',
        );
      }
      const given = await tx.citizenFeedback.count({
        where: { reportId: id, createdAt: { gte: report.resolvedAt } },
      });
      if (given > 0) {
        throw new AppException(ErrorCode.CONFLICT, 'You already gave feedback on this fix.');
      }
      if (!input.fixed) await recordEvent(tx, 'report.not_fixed', { reportId: id });
      await tx.citizenFeedback.create({
        data: {
          reportId: id,
          citizenId: citizen.id,
          fixed: input.fixed,
          comment: input.comment ?? null,
        },
      });
      await this.record(tx, request, citizen.id, id, 'report.feedback_given', {
        fixed: input.fixed,
      });
    });
    return (await this.reports.findForViewer(publicId, citizen)).report;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async lockForOrganization(tx: Tx, publicId: string, organizationId: string) {
    const id = await lockReport(tx, publicId, { organizationId });
    return tx.report.findUniqueOrThrow({
      where: { id },
      select: { id: true, status: true, version: true },
    });
  }

  /** Locks the report behind the user's own task, so concurrent actions are serialized. */
  private async lockOwnTask(tx: Tx, userId: string, assignmentId: string) {
    const found = await tx.reportAssignment.findFirst({
      where: {
        id: assignmentId,
        workerId: userId,
        organization: {
          isActive: true,
          members: { some: { userId, role: 'WORKER', status: 'ACTIVE' } },
        },
      },
      select: { reportId: true },
    });
    if (!found) throw new AppException(ErrorCode.NOT_FOUND);
    await tx.$queryRaw`SELECT id FROM reports WHERE id = ${found.reportId}::uuid FOR UPDATE`;
    const [assignment, report] = await Promise.all([
      tx.reportAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: { id: true, state: true },
      }),
      tx.report.findUniqueOrThrow({
        where: { id: found.reportId },
        select: { id: true, status: true, version: true },
      }),
    ]);
    return { assignment, report };
  }

  private async openAssignment(tx: Tx, reportId: string) {
    const current = await tx.reportAssignment.findFirst({
      where: { reportId, state: { in: OPEN_ASSIGNMENT_STATES } },
      select: { id: true, workerId: true },
    });
    if (!current) throw this.invalid('This report has no open assignment.');
    return current;
  }

  /** Approved rule: only active, available workers of this organization can be assigned. */
  private async assertAssignableWorker(tx: Tx, organizationId: string, workerId: string) {
    const member = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: workerId } },
      select: { role: true, status: true, available: true },
    });
    if (!member || member.role !== 'WORKER' || member.status !== 'ACTIVE') {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'workerId', message: 'Choose an active worker of your organization.' },
      ]);
    }
    if (!member.available) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'workerId', message: 'This worker is marked unavailable.' },
      ]);
    }
  }

  private async createAssignment(
    tx: Tx,
    reportId: string,
    organizationId: string,
    input: AssignInput,
    actorId: string,
  ) {
    const assignment = await tx.reportAssignment.create({
      data: {
        reportId,
        organizationId,
        workerId: input.workerId,
        assignedById: actorId,
        note: input.note ?? null,
      },
      select: { id: true },
    });
    await tx.assignmentEvent.create({
      data: {
        assignmentId: assignment.id,
        actorId,
        kind: 'ASSIGNED',
        message: input.note ?? null,
      },
    });
    await recordEvent(tx, 'assignment.created', {
      assignmentId: assignment.id,
      actorUserId: actorId,
    });
  }

  private async endAssignment(
    tx: Tx,
    assignmentId: string,
    state: 'DECLINED' | 'RETURNED' | 'CANCELLED',
    kind: AssignmentEventKind,
    reason: string,
    actorId: string,
  ) {
    await tx.reportAssignment.update({
      where: { id: assignmentId },
      data: { state, endedAt: new Date(), endReason: reason },
    });
    await tx.assignmentEvent.create({ data: { assignmentId, actorId, kind, message: reason } });
    await recordEvent(tx, 'assignment.ended', { assignmentId, kind: state, actorUserId: actorId });
  }

  /** Links the worker's own processed WORK_PHOTO uploads to the assignment. */
  private async attachWorkPhotos(
    tx: Tx,
    userId: string,
    assignmentId: string,
    mediaIds: readonly string[],
  ): Promise<string[]> {
    const unique = [...new Set(mediaIds)];
    for (const mediaId of unique) {
      const attached = await tx.reportMedia.updateMany({
        where: {
          id: mediaId,
          uploaderId: userId,
          purpose: 'WORK_PHOTO',
          status: 'PROCESSED',
          reportId: null,
          assignmentId: null,
        },
        data: { assignmentId },
      });
      if (attached.count !== 1) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, undefined, [
          {
            field: 'mediaIds',
            message: 'A photo was not found, is still being checked, or is already used.',
          },
        ]);
      }
    }
    return unique;
  }

  private invalid(message = 'This task cannot do that now.') {
    return new AppException(ErrorCode.INVALID_STATE_TRANSITION, message);
  }

  private record(
    tx: Tx,
    request: Request,
    actorUserId: string,
    reportId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        action,
        result: 'SUCCESS',
        actorUserId,
        targetType: 'report',
        targetId: reportId,
        metadata: metadata as Prisma.InputJsonValue,
      },
      request,
      tx,
    );
  }
}
