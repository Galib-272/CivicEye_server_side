import type { Prisma } from '../../generated/prisma/client';
import type { AssignmentState } from '../../generated/prisma/enums';
import { recordEvent } from '../notifications/outbox';
import { applyTransition } from './report-workflow';

/** Assignments a worker is still responsible for (before evidence is submitted). */
export const OPEN_ASSIGNMENT_STATES: AssignmentState[] = ['PENDING', 'ACCEPTED', 'IN_PROGRESS'];
/** Assignments that block a new one on the same report (database unique index). */
export const ACTIVE_ASSIGNMENT_STATES: AssignmentState[] = [...OPEN_ASSIGNMENT_STATES, 'COMPLETED'];

/**
 * Cancels a worker's open assignments in one organization and sends the reports back to
 * ACCEPTED, e.g. when the worker leaves the organization or stops being a worker. Runs inside
 * the caller's transaction. Work already submitted for verification is left for the verifier.
 */
export async function releaseOpenAssignments(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; workerId: string; reason: string; actorId: string | null },
): Promise<number> {
  const open = await tx.reportAssignment.findMany({
    where: {
      organizationId: input.organizationId,
      workerId: input.workerId,
      state: { in: OPEN_ASSIGNMENT_STATES },
    },
    select: { id: true, reportId: true },
  });
  for (const assignment of open) {
    await tx.$queryRaw`SELECT id FROM reports WHERE id = ${assignment.reportId}::uuid FOR UPDATE`;
    const report = await tx.report.findUniqueOrThrow({
      where: { id: assignment.reportId },
      select: { id: true, status: true, version: true },
    });
    await tx.reportAssignment.update({
      where: { id: assignment.id },
      data: { state: 'CANCELLED', endedAt: new Date(), endReason: input.reason },
    });
    await tx.assignmentEvent.create({
      data: {
        assignmentId: assignment.id,
        actorId: input.actorId,
        kind: 'CANCELLED',
        message: input.reason,
      },
    });
    await recordEvent(tx, 'assignment.ended', {
      assignmentId: assignment.id,
      kind: 'CANCELLED',
      actorUserId: input.actorId,
    });
    await applyTransition(tx, report, 'releaseAssignment', 'system', {
      actorUserId: input.actorId,
      actorContext: 'system',
      reason: input.reason,
    });
  }
  return open.length;
}
