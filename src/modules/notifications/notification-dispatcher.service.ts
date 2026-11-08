import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ModerationActionKind, NotificationType } from '../../generated/prisma/enums';
import { RealtimePublisher } from './realtime.publisher';
import type { OutboxEvents, OutboxEventType } from './outbox';

export const NOTIFICATION_EMAIL_QUEUE = Symbol('NOTIFICATION_EMAIL_QUEUE');
export const NOTIFICATION_EMAIL_QUEUE_NAME = 'notification-email';

/** Gives up on an event after this many failed attempts; a Super Admin can retry it. */
export const MAX_EVENT_ATTEMPTS = 8;

type Tx = Prisma.TransactionClient;

/** One notification to create: who gets it, and what it links to. */
interface Planned {
  recipientId: string;
  type: NotificationType;
  reportPublicId: string | null;
  organizationId: string | null;
  assignmentId: string | null;
}

/** Which email setting covers each notification type. */
export const EMAIL_GROUP: Record<
  NotificationType,
  'emailMyReports' | 'emailMyTasks' | 'emailOrganization'
> = {
  REPORT_UNDER_REVIEW: 'emailMyReports',
  INFORMATION_REQUESTED: 'emailMyReports',
  REPORT_ACCEPTED: 'emailMyReports',
  REPORT_REJECTED: 'emailMyReports',
  REPORT_TRANSFERRED: 'emailMyReports',
  REPORT_ASSIGNED: 'emailMyReports',
  WORK_STARTED: 'emailMyReports',
  REPORT_RESOLVED: 'emailMyReports',
  REPORT_REOPENED: 'emailMyReports',
  REPORT_CLOSED: 'emailMyReports',
  PUBLIC_UPDATE_POSTED: 'emailMyReports',
  NEW_REPORT: 'emailOrganization',
  INFORMATION_PROVIDED: 'emailOrganization',
  REPORT_WITHDRAWN: 'emailOrganization',
  TASK_DECLINED: 'emailOrganization',
  TASK_RETURNED: 'emailOrganization',
  WORK_SUBMITTED: 'emailOrganization',
  NOT_FIXED_FEEDBACK: 'emailOrganization',
  ACCEPTANCE_OVERDUE: 'emailOrganization',
  TASK_ASSIGNED: 'emailMyTasks',
  TASK_CANCELLED: 'emailMyTasks',
  MORE_EVIDENCE_NEEDED: 'emailMyTasks',
  WORK_APPROVED: 'emailMyTasks',
  REPORT_DUPLICATE: 'emailMyReports',
  REPORT_HIDDEN: 'emailMyReports',
  CORRECTION_REQUESTED: 'emailMyReports',
  MODERATION_WARNING: 'emailMyReports',
};

/** Moderation actions that the affected citizen is told about. */
const MODERATION_NOTICES: Partial<Record<ModerationActionKind, NotificationType>> = {
  HIDE_REPORT: 'REPORT_HIDDEN',
  REQUEST_CORRECTION: 'CORRECTION_REQUESTED',
  WARN_USER: 'MODERATION_WARNING',
};

/** Status changes that concern the reporting citizen, and how they are told. */
const CITIZEN_TRANSITIONS: Record<string, NotificationType> = {
  startReview: 'REPORT_UNDER_REVIEW',
  requestInformation: 'INFORMATION_REQUESTED',
  accept: 'REPORT_ACCEPTED',
  reject: 'REPORT_REJECTED',
  transfer: 'REPORT_TRANSFERRED',
  assign: 'REPORT_ASSIGNED',
  startWork: 'WORK_STARTED',
  approveWork: 'REPORT_RESOLVED',
  reopen: 'REPORT_REOPENED',
  close: 'REPORT_CLOSED',
  markDuplicate: 'REPORT_DUPLICATE',
};

/** Status changes that concern the handling organization's reviewers. */
const REVIEWER_TRANSITIONS: Record<string, NotificationType> = {
  provideInformation: 'INFORMATION_PROVIDED',
  withdraw: 'REPORT_WITHDRAWN',
  submitForVerification: 'WORK_SUBMITTED',
  // A transfer is a new report for the receiving organization.
  transfer: 'NEW_REPORT',
};

const backoffMs = (attempts: number) => Math.min(2 ** attempts * 10_000, 3_600_000);

/**
 * Turns outbox events into notifications (PRD §9.3): finds the recipients from the current
 * data, creates at most one notification per event, person and type (database unique key),
 * then queues emails and live updates. Failures are retried with growing delays; after
 * MAX_EVENT_ATTEMPTS the event is marked FAILED for a Super Admin to retry.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
    @Inject(NOTIFICATION_EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  /** Processes due events, one transaction each. Returns how many were handled. */
  async dispatchDue(limit = 50): Promise<number> {
    const due = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let handled = 0;
    for (const { id } of due) {
      if (await this.dispatchOne(id)) handled += 1;
    }
    return handled;
  }

  private async dispatchOne(eventId: string): Promise<boolean> {
    let created: Array<{ id: string; recipientId: string; type: NotificationType }>;
    let rooms: string[];
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // SKIP LOCKED: several workers can run without handling the same event twice.
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM outbox_events
          WHERE id = ${eventId}::uuid AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
        if (!locked) return null;
        const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
        const { planned, changedRooms } = await this.plan(
          tx,
          event.type as OutboxEventType,
          event.payload as never,
        );
        if (planned.length > 0) {
          await tx.notification.createMany({
            data: planned.map((item) => ({ ...item, eventId })),
            skipDuplicates: true,
          });
        }
        await tx.outboxEvent.update({
          where: { id: eventId },
          data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
        });
        const notifications = await tx.notification.findMany({
          where: { eventId },
          select: { id: true, recipientId: true, type: true },
        });
        return { notifications, changedRooms };
      });
      if (!result) return false;
      created = result.notifications;
      rooms = result.changedRooms;
    } catch (error) {
      await this.recordFailure(eventId, error);
      return false;
    }
    // After commit. Each email job has a stable ID, so retries never send twice.
    await this.queueEmails(created);
    await this.publish(created, rooms);
    return true;
  }

  private async recordFailure(eventId: string, error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 480) : 'Unknown error';
    this.logger.error({ err: error, eventId }, 'Outbox event failed');
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: { attempts: true },
    });
    if (!event) return;
    const attempts = event.attempts + 1;
    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        attempts,
        lastError: message,
        status: attempts >= MAX_EVENT_ATTEMPTS ? 'FAILED' : 'PENDING',
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      },
    });
  }

  private async queueEmails(
    notifications: Array<{ id: string; recipientId: string; type: NotificationType }>,
  ) {
    if (notifications.length === 0) return;
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: [...new Set(notifications.map((item) => item.recipientId))] } },
    });
    const byUser = new Map(preferences.map((item) => [item.userId, item]));
    for (const notification of notifications) {
      const preference = byUser.get(notification.recipientId);
      const wanted = preference ? preference[EMAIL_GROUP[notification.type]] : true;
      if (!wanted) continue;
      await this.emailQueue
        .add('send', { notificationId: notification.id }, { jobId: `email-${notification.id}` })
        .catch((error: unknown) =>
          this.logger.error(
            { err: error, notificationId: notification.id },
            'Could not queue email',
          ),
        );
    }
  }

  private async publish(notifications: Array<{ recipientId: string }>, rooms: string[]) {
    const users = [...new Set(notifications.map((item) => `user:${item.recipientId}`))];
    await this.realtime.publish(users, 'notifications.changed');
    await this.realtime.publish(rooms, 'data.changed');
  }

  /** Recipients and links for one event, from the data as it is now. */
  private async plan<T extends OutboxEventType>(
    tx: Tx,
    type: T,
    payload: OutboxEvents[T],
  ): Promise<{ planned: Planned[]; changedRooms: string[] }> {
    const planned: Planned[] = [];
    const changedRooms = new Set<string>();
    const add = (item: Planned, actorUserId: string | null | undefined) => {
      if (item.recipientId !== actorUserId) planned.push(item);
    };

    const reportEvent = async (reportId: string) => {
      const report = await tx.report.findUniqueOrThrow({
        where: { id: reportId },
        select: { publicId: true, citizenId: true, organizationId: true },
      });
      changedRooms.add(`user:${report.citizenId}`);
      if (report.organizationId) changedRooms.add(`org:${report.organizationId}`);
      return report;
    };
    const assignmentEvent = async (assignmentId: string) => {
      const assignment = await tx.reportAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: {
          id: true,
          workerId: true,
          organizationId: true,
          report: { select: { publicId: true, citizenId: true } },
        },
      });
      changedRooms.add(`user:${assignment.workerId}`);
      changedRooms.add(`org:${assignment.organizationId}`);
      return assignment;
    };
    const toReviewers = async (
      organizationId: string,
      notification: NotificationType,
      reportPublicId: string,
      actorUserId: string | null,
      assignmentId: string | null = null,
    ) => {
      for (const recipientId of await this.reviewers(tx, organizationId)) {
        add(
          { recipientId, type: notification, reportPublicId, organizationId, assignmentId },
          actorUserId,
        );
      }
    };

    switch (type) {
      case 'report.status_changed': {
        const event = payload as OutboxEvents['report.status_changed'];
        const report = await reportEvent(event.reportId);
        const citizenType = CITIZEN_TRANSITIONS[event.transition];
        if (citizenType) {
          add(
            {
              recipientId: report.citizenId,
              type: citizenType,
              reportPublicId: report.publicId,
              organizationId: null,
              assignmentId: null,
            },
            event.actorUserId,
          );
        }
        const reviewerType = REVIEWER_TRANSITIONS[event.transition];
        if (reviewerType && event.organizationId) {
          await toReviewers(event.organizationId, reviewerType, report.publicId, event.actorUserId);
        }
        break;
      }
      case 'moderation.action': {
        const event = payload as OutboxEvents['moderation.action'];
        const report = await reportEvent(event.reportId);
        const notice = MODERATION_NOTICES[event.kind];
        if (notice && event.targetUserId) {
          add(
            {
              recipientId: event.targetUserId,
              type: notice,
              reportPublicId: report.publicId,
              organizationId: null,
              assignmentId: null,
            },
            event.actorUserId,
          );
        }
        break;
      }
      case 'report.submitted': {
        const event = payload as OutboxEvents['report.submitted'];
        const report = await reportEvent(event.reportId);
        if (report.organizationId) {
          await toReviewers(report.organizationId, 'NEW_REPORT', report.publicId, report.citizenId);
        }
        break;
      }
      case 'report.routed': {
        const event = payload as OutboxEvents['report.routed'];
        const report = await reportEvent(event.reportId);
        await toReviewers(event.organizationId, 'NEW_REPORT', report.publicId, event.actorUserId);
        break;
      }
      case 'report.update_posted': {
        const event = payload as OutboxEvents['report.update_posted'];
        const report = await reportEvent(event.reportId);
        add(
          {
            recipientId: report.citizenId,
            type: 'PUBLIC_UPDATE_POSTED',
            reportPublicId: report.publicId,
            organizationId: null,
            assignmentId: null,
          },
          event.actorUserId,
        );
        break;
      }
      case 'report.not_fixed': {
        const event = payload as OutboxEvents['report.not_fixed'];
        const report = await reportEvent(event.reportId);
        if (report.organizationId) {
          await toReviewers(
            report.organizationId,
            'NOT_FIXED_FEEDBACK',
            report.publicId,
            report.citizenId,
          );
        }
        break;
      }
      case 'assignment.created': {
        const event = payload as OutboxEvents['assignment.created'];
        const assignment = await assignmentEvent(event.assignmentId);
        add(
          {
            recipientId: assignment.workerId,
            type: 'TASK_ASSIGNED',
            reportPublicId: assignment.report.publicId,
            organizationId: assignment.organizationId,
            assignmentId: assignment.id,
          },
          event.actorUserId,
        );
        break;
      }
      case 'assignment.ended': {
        const event = payload as OutboxEvents['assignment.ended'];
        const assignment = await assignmentEvent(event.assignmentId);
        if (event.kind === 'CANCELLED') {
          add(
            {
              recipientId: assignment.workerId,
              type: 'TASK_CANCELLED',
              reportPublicId: assignment.report.publicId,
              organizationId: assignment.organizationId,
              assignmentId: assignment.id,
            },
            event.actorUserId,
          );
        } else {
          await toReviewers(
            assignment.organizationId,
            event.kind === 'DECLINED' ? 'TASK_DECLINED' : 'TASK_RETURNED',
            assignment.report.publicId,
            event.actorUserId,
            assignment.id,
          );
        }
        break;
      }
      case 'assignment.verified': {
        const event = payload as OutboxEvents['assignment.verified'];
        const assignment = await assignmentEvent(event.assignmentId);
        add(
          {
            recipientId: assignment.workerId,
            type: event.outcome === 'APPROVED' ? 'WORK_APPROVED' : 'MORE_EVIDENCE_NEEDED',
            reportPublicId: assignment.report.publicId,
            organizationId: assignment.organizationId,
            assignmentId: assignment.id,
          },
          event.actorUserId,
        );
        break;
      }
      case 'assignment.overdue': {
        const event = payload as OutboxEvents['assignment.overdue'];
        const assignment = await assignmentEvent(event.assignmentId);
        await toReviewers(
          assignment.organizationId,
          'ACCEPTANCE_OVERDUE',
          assignment.report.publicId,
          null,
          assignment.id,
        );
        break;
      }
      default:
        throw new Error(`Unknown outbox event type: ${String(type)}`);
    }
    return { planned, changedRooms: [...changedRooms] };
  }

  /** Active Org Admins and Reviewers of an active organization. */
  private async reviewers(tx: Tx, organizationId: string): Promise<string[]> {
    const members = await tx.organizationMember.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        role: { in: ['ORG_ADMIN', 'ORG_REVIEWER'] },
        organization: { isActive: true },
      },
      select: { userId: true },
    });
    return members.map((member) => member.userId);
  }
}
