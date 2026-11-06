import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { z } from 'zod';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Paginated } from '../../common/http/api-response';
import { PrismaService } from '../../database/prisma.service';
import { NOTIFICATION_EMAIL_QUEUE } from './notification-dispatcher.service';
import { notificationPath } from './notification-email.worker';
import type {
  deliveryHealthSchema,
  notificationSchema,
  NotificationsQuery,
  PreferencesInput,
} from './notifications.schemas';

/** Failed emails with at least this many attempts and no success are shown for a manual retry. */
const EMAIL_GAVE_UP_AFTER = 5;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async list(userId: string, query: NotificationsQuery) {
    const where = { recipientId: userId, ...(query.unread ? { readAt: null } : {}) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return new Paginated(
      rows.map((row): z.infer<typeof notificationSchema> => ({
        id: row.id,
        type: row.type,
        reportPublicId: row.reportPublicId,
        organizationId: row.organizationId,
        assignmentId: row.assignmentId,
        path: notificationPath(row),
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
      { page: query.page, limit: query.limit, total },
    );
  }

  async unreadCount(userId: string) {
    return {
      count: await this.prisma.notification.count({ where: { recipientId: userId, readAt: null } }),
    };
  }

  /** Marks one of the user's own notifications as read; anyone else's looks like a missing one. */
  async markRead(userId: string, notificationId: string) {
    const exists = await this.prisma.notification.count({
      where: { id: notificationId, recipientId: userId },
    });
    if (exists === 0) throw new AppException(ErrorCode.NOT_FOUND);
    await this.prisma.notification.updateMany({
      where: { id: notificationId, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return this.unreadCount(userId);
  }

  async preferences(userId: string) {
    const row = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    return {
      emailMyReports: row?.emailMyReports ?? true,
      emailMyTasks: row?.emailMyTasks ?? true,
      emailOrganization: row?.emailOrganization ?? true,
    };
  }

  async setPreferences(userId: string, input: PreferencesInput) {
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });
    return this.preferences(userId);
  }

  // ─── Super Admin: delivery health ───────────────────────────────────────────

  async health(): Promise<z.infer<typeof deliveryHealthSchema>> {
    const [pendingEvents, failedEvents, failedEmails] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.outboxEvent.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, type: true, attempts: true, lastError: true, createdAt: true },
      }),
      this.prisma.$queryRaw<
        Array<{
          notification_id: string;
          type: string;
          failed: bigint;
          last_error: string | null;
          last_attempt_at: Date;
        }>
      >`
        SELECT d.notification_id, n.type::text AS type, count(*) AS failed,
               (array_agg(d.error ORDER BY d.attempted_at DESC))[1] AS last_error,
               max(d.attempted_at) AS last_attempt_at
        FROM notification_deliveries d
        JOIN notifications n ON n.id = d.notification_id
        WHERE d.status = 'FAILED'
          AND NOT EXISTS (SELECT 1 FROM notification_deliveries s
                          WHERE s.notification_id = d.notification_id AND s.status = 'SENT')
        GROUP BY d.notification_id, n.type
        HAVING count(*) >= ${EMAIL_GAVE_UP_AFTER}
        ORDER BY max(d.attempted_at) DESC
        LIMIT 50`,
    ]);
    return {
      pendingEvents,
      failedEvents: failedEvents.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
      failedEmails: failedEmails.map((row) => ({
        notificationId: row.notification_id,
        type: row.type as z.infer<typeof deliveryHealthSchema>['failedEmails'][number]['type'],
        failedAttempts: Number(row.failed),
        lastError: row.last_error,
        lastAttemptAt: row.last_attempt_at.toISOString(),
      })),
    };
  }

  async retryEvent(eventId: string) {
    const updated = await this.prisma.outboxEvent.updateMany({
      where: { id: eventId, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (updated.count !== 1) throw new AppException(ErrorCode.NOT_FOUND);
  }

  async retryEmail(notificationId: string) {
    const exists = await this.prisma.notification.count({ where: { id: notificationId } });
    if (exists === 0) throw new AppException(ErrorCode.NOT_FOUND);
    await this.emailQueue.add(
      'send',
      { notificationId },
      { jobId: `email-${notificationId}-retry-${Date.now()}` },
    );
  }
}
