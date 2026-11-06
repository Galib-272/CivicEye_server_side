import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { applyTransition } from '../reports/report-workflow';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { recordEvent } from './outbox';

/** Approved policy: resolved reports close automatically after 14 days unless reopened. */
export const AUTO_CLOSE_AFTER_MS = 14 * 24 * 3600 * 1000;
/** Approved policy: reviewers are reminded once when a task is not accepted within 48 hours. */
export const ACCEPTANCE_REMINDER_AFTER_MS = 48 * 3600 * 1000;

const DISPATCH_INTERVAL_MS = 2_000;
const HOURLY_MS = 3600 * 1000;

/**
 * Background work for processes with RUN_WORKERS=true: dispatching the outbox every 2 seconds,
 * and hourly auto-closing and acceptance reminders. Each loop skips a tick while still busy,
 * and every step is safe to run in several workers at once (row locks).
 */
@Injectable()
export class MaintenanceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceWorker.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    if (!this.config.runWorkers) return;
    this.every('dispatch', DISPATCH_INTERVAL_MS, () => this.dispatcher.dispatchDue());
    this.every('hourly', HOURLY_MS, async () => {
      await this.autoCloseResolved();
      await this.remindUnacceptedTasks();
    });
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  private every(name: string, intervalMs: number, task: () => Promise<unknown>) {
    const run = async () => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await task();
      } catch (error) {
        this.logger.error({ err: error, task: name }, 'Background task failed');
      } finally {
        this.busy.delete(name);
      }
    };
    void run();
    this.timers.push(setInterval(() => void run(), intervalMs));
  }

  /** Closes reports resolved more than 14 days ago. Returns how many were closed. */
  async autoCloseResolved(now = new Date()): Promise<number> {
    const due = await this.prisma.report.findMany({
      where: {
        status: 'RESOLVED',
        resolvedAt: { lte: new Date(now.getTime() - AUTO_CLOSE_AFTER_MS) },
      },
      select: { id: true },
      take: 200,
    });
    let closed = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM reports WHERE id = ${id}::uuid AND status = 'RESOLVED' FOR UPDATE SKIP LOCKED`;
        if (!locked) return false;
        const report = await tx.report.findUniqueOrThrow({
          where: { id },
          select: { id: true, status: true, version: true },
        });
        await applyTransition(tx, report, 'close', 'system', {
          actorUserId: null,
          actorContext: 'system',
          data: { closedAt: now },
        });
        return true;
      });
      if (done) closed += 1;
    }
    return closed;
  }

  /** Reminds reviewers once about tasks not accepted within 48 hours. */
  async remindUnacceptedTasks(now = new Date()): Promise<number> {
    const due = await this.prisma.reportAssignment.findMany({
      where: {
        state: 'PENDING',
        reminderSentAt: null,
        assignedAt: { lte: new Date(now.getTime() - ACCEPTANCE_REMINDER_AFTER_MS) },
      },
      select: { id: true },
      take: 200,
    });
    let reminded = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.reportAssignment.updateMany({
          where: { id, state: 'PENDING', reminderSentAt: null },
          data: { reminderSentAt: now },
        });
        if (updated.count !== 1) return false;
        await recordEvent(tx, 'assignment.overdue', { assignmentId: id });
        return true;
      });
      if (done) reminded += 1;
    }
    return reminded;
  }
}
