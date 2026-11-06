import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { NotificationType } from '../../generated/prisma/enums';
import { bullmqConnection } from '../../jobs/queue-connection';
import { EmailService } from '../email/email.service';
import { EMAIL_GROUP, NOTIFICATION_EMAIL_QUEUE_NAME } from './notification-dispatcher.service';

/** Where a notification opens in the web app, by who it is for. */
export function notificationPath(notification: {
  type: NotificationType;
  reportPublicId: string | null;
  organizationId: string | null;
  assignmentId: string | null;
}): string {
  const group = EMAIL_GROUP[notification.type];
  if (group === 'emailMyTasks' && notification.assignmentId) {
    return `/work/${notification.assignmentId}`;
  }
  if (group === 'emailOrganization' && notification.organizationId && notification.reportPublicId) {
    return `/organizations/${notification.organizationId}/reports/${notification.reportPublicId}`;
  }
  return notification.reportPublicId ? `/reports/${notification.reportPublicId}` : '/notifications';
}

/**
 * Sends notification emails (only in processes with RUN_WORKERS=true). Every attempt is recorded;
 * BullMQ retries failures 5 times with growing delays. Inactive or unverified addresses get
 * in-app notifications only.
 */
@Injectable()
export class NotificationEmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEmailWorker.name);
  private worker: Worker | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  onModuleInit(): void {
    if (!this.config.runWorkers) return;
    this.worker = new Worker<{ notificationId: string }, void>(
      NOTIFICATION_EMAIL_QUEUE_NAME,
      async (job) => this.send(job.data.notificationId),
      { connection: bullmqConnection(this.config), concurrency: 4 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.warn(
        { err: error, jobId: job?.id, attempts: job?.attemptsMade },
        'Notification email failed',
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  async send(notificationId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        type: true,
        reportPublicId: true,
        organizationId: true,
        assignmentId: true,
        recipient: {
          select: {
            email: true,
            name: true,
            preferredLocale: true,
            status: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
    if (!notification) return;
    const { recipient } = notification;
    if (recipient.status !== 'ACTIVE' || !recipient.emailVerifiedAt) return;
    // Already delivered (e.g. the job was retried after a crash): never send twice.
    const sent = await this.prisma.notificationDelivery.count({
      where: { notificationId, status: 'SENT' },
    });
    if (sent > 0) return;
    try {
      await this.email.send(recipient, {
        name: 'notification',
        type: notification.type,
        reportPublicId: notification.reportPublicId,
        link: this.email.webLink(recipient.preferredLocale, notificationPath(notification)),
      });
      await this.prisma.notificationDelivery.create({
        data: { notificationId, status: 'SENT' },
      });
    } catch (error) {
      await this.prisma.notificationDelivery.create({
        data: {
          notificationId,
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 480) : 'Unknown error',
        },
      });
      throw error;
    }
  }
}
