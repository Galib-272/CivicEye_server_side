import type { Prisma } from '../../generated/prisma/client';
import type { ReportStatus } from '../../generated/prisma/enums';

/**
 * Events recorded in the transactional outbox (PRD §9.3). Payloads hold IDs and states only,
 * never titles, descriptions, messages or names: the dispatcher looks up whatever it needs,
 * and nothing private can leak through a queue or a log.
 */
export interface OutboxEvents {
  /** Every report status change (written by applyTransition). */
  'report.status_changed': {
    reportId: string;
    transition: string;
    from: ReportStatus;
    to: ReportStatus;
    /** The organization handling the report after the change. */
    organizationId: string | null;
    actorUserId: string | null;
  };
  'report.submitted': { reportId: string };
  'report.routed': { reportId: string; organizationId: string; actorUserId: string };
  'report.update_posted': { reportId: string; actorUserId: string };
  'report.not_fixed': { reportId: string };
  'assignment.created': { assignmentId: string; actorUserId: string };
  'assignment.ended': {
    assignmentId: string;
    kind: 'DECLINED' | 'RETURNED' | 'CANCELLED';
    actorUserId: string | null;
  };
  'assignment.verified': {
    assignmentId: string;
    outcome: 'APPROVED' | 'REJECTED' | 'NEEDS_MORE_EVIDENCE';
    actorUserId: string;
  };
  'assignment.overdue': { assignmentId: string };
}
export type OutboxEventType = keyof OutboxEvents;

/** Records an event inside the caller's transaction: it exists only if the change commits. */
export async function recordEvent<T extends OutboxEventType>(
  tx: Prisma.TransactionClient,
  type: T,
  payload: OutboxEvents[T],
): Promise<void> {
  await tx.outboxEvent.create({
    data: { type, payload },
  });
}
