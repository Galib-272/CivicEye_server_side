import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../generated/prisma/client';
import type { ReportStatus } from '../../generated/prisma/enums';
import { recordEvent } from '../notifications/outbox';
import {
  canTransition,
  TRANSITIONS,
  type TransitionActor,
  type TransitionName,
} from './report-transitions';

export interface LockedReport {
  id: string;
  status: ReportStatus;
  version: number;
}

export interface TransitionOptions {
  /** Null for system actions. */
  actorUserId: string | null;
  /** Recorded in the history, e.g. "citizen", "org_reviewer". */
  actorContext: string;
  /** Required by rules with requiresReason. Shown only to the reporting citizen. */
  reason?: string | null;
  /** Shown to everyone who can see the report. */
  publicMessage?: string | null;
  /** The version the caller saw (If-Match). A different current version is a conflict. */
  expectedVersion?: number;
  /** Other report fields that change together with the status. */
  data?: Prisma.ReportUncheckedUpdateInput;
}

/**
 * The only place a report's status changes: checks the rule table, the caller's version and
 * the required reason, then updates the report and writes the immutable history entry — all
 * inside the caller's transaction, on a row the caller has locked.
 */
export async function applyTransition(
  tx: Prisma.TransactionClient,
  report: LockedReport,
  name: TransitionName,
  actor: TransitionActor,
  options: TransitionOptions,
): Promise<number> {
  const rule = TRANSITIONS[name];
  if (options.expectedVersion !== undefined && options.expectedVersion !== report.version) {
    throw new AppException(
      ErrorCode.CONFLICT,
      'The report was changed by someone else. Reload it and try again.',
    );
  }
  if (!canTransition(name, report.status, actor)) {
    throw new AppException(ErrorCode.INVALID_STATE_TRANSITION);
  }
  if (rule.requiresReason && !options.reason?.trim()) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, 'A reason is required.');
  }
  const version = report.version + 1;
  const updated = await tx.report.update({
    where: { id: report.id },
    data: { ...options.data, status: rule.to, version },
    select: { organizationId: true },
  });
  await tx.reportStatusHistory.create({
    data: {
      reportId: report.id,
      fromStatus: report.status,
      toStatus: rule.to,
      actorUserId: options.actorUserId,
      actorContext: options.actorContext,
      reason: options.reason ?? null,
      publicMessage: options.publicMessage ?? null,
    },
  });
  // Same transaction: the notification exists only if the change commits.
  await recordEvent(tx, 'report.status_changed', {
    reportId: report.id,
    transition: name,
    from: report.status,
    to: rule.to,
    organizationId: updated.organizationId,
    actorUserId: options.actorUserId,
  });
  return version;
}

/** Locks a report row for the rest of the transaction; NOT_FOUND unless it matches `scope`. */
export async function lockReport(
  tx: Prisma.TransactionClient,
  publicId: string,
  scope: { citizenId?: string; organizationId?: string },
): Promise<string> {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM reports
    WHERE public_id = ${publicId}
      AND (${scope.citizenId ?? null}::uuid IS NULL OR citizen_id = ${scope.citizenId ?? null}::uuid)
      AND (${scope.organizationId ?? null}::uuid IS NULL
           OR organization_id = ${scope.organizationId ?? null}::uuid)
    FOR UPDATE`;
  if (!locked) throw new AppException(ErrorCode.NOT_FOUND);
  return locked.id;
}
