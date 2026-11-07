import type { ReportStatus } from '../../generated/prisma/enums';

/** Who is acting on a report, as far as the transition rules are concerned. */
export type TransitionActor =
  'owner' | 'super_admin' | 'org_reviewer' | 'assigned_worker' | 'system';

export interface TransitionRule {
  from: ReportStatus[];
  to: ReportStatus;
  actors: TransitionActor[];
  requiresReason: boolean;
}

/**
 * The single table of allowed report status changes (PRD §6.2). Every status change in the
 * application goes through ReportTransitionService, which consults this table; there is no
 * other way to change a report's status.
 */
export const TRANSITIONS = {
  withdraw: {
    // Approved policy: immediate withdrawal while SUBMITTED or NEEDS_INFORMATION only.
    from: ['SUBMITTED', 'NEEDS_INFORMATION'],
    to: 'WITHDRAWN',
    actors: ['owner'],
    requiresReason: true,
  },
  // ─── Review (Phase 5, PRD §6.2) ───────────────────────────────────────────────
  startReview: {
    from: ['SUBMITTED'],
    to: 'UNDER_REVIEW',
    actors: ['org_reviewer'],
    requiresReason: false,
  },
  requestInformation: {
    from: ['UNDER_REVIEW'],
    to: 'NEEDS_INFORMATION',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  provideInformation: {
    from: ['NEEDS_INFORMATION'],
    to: 'UNDER_REVIEW',
    actors: ['owner'],
    // The answer itself is stored in report_information_responses.
    requiresReason: false,
  },
  accept: {
    from: ['UNDER_REVIEW'],
    to: 'ACCEPTED',
    actors: ['org_reviewer'],
    requiresReason: false,
  },
  reject: {
    from: ['UNDER_REVIEW'],
    to: 'REJECTED',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  /**
   * Approved transfer policy: a report not yet assigned to a worker moves to another
   * organization (or back to Super Admin triage) and restarts at SUBMITTED there.
   */
  transfer: {
    from: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'ACCEPTED'],
    to: 'SUBMITTED',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  // ─── Assignment and verification (Phase 6, PRD §6.2, §8) ──────────────────────
  assign: {
    from: ['ACCEPTED', 'REOPENED'],
    to: 'ASSIGNED',
    actors: ['org_reviewer'],
    requiresReason: false,
  },
  /** A supervisor moves the task to another worker. */
  reassign: {
    from: ['ASSIGNED', 'IN_PROGRESS'],
    to: 'ASSIGNED',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  /**
   * The task goes back to the organization: the worker declines or returns it (unsafe,
   * inaccessible, partly done), a supervisor cancels it, or the worker left (system).
   */
  releaseAssignment: {
    from: ['ASSIGNED', 'IN_PROGRESS'],
    to: 'ACCEPTED',
    actors: ['assigned_worker', 'org_reviewer', 'system'],
    requiresReason: true,
  },
  startWork: {
    from: ['ASSIGNED'],
    to: 'IN_PROGRESS',
    actors: ['assigned_worker'],
    requiresReason: false,
  },
  /** The evidence itself is stored in completion_submissions. */
  completeWork: {
    from: ['IN_PROGRESS'],
    to: 'WORK_COMPLETED',
    actors: ['assigned_worker'],
    requiresReason: false,
  },
  /** Approved policy: valid evidence goes straight to verification. */
  submitForVerification: {
    from: ['WORK_COMPLETED'],
    to: 'PENDING_VERIFICATION',
    actors: ['system'],
    requiresReason: false,
  },
  approveWork: {
    from: ['PENDING_VERIFICATION'],
    to: 'RESOLVED',
    actors: ['org_reviewer'],
    requiresReason: false,
  },
  /** Verification failed or needs more evidence: the same worker continues. */
  rejectWork: {
    from: ['PENDING_VERIFICATION'],
    to: 'IN_PROGRESS',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  reopen: {
    from: ['RESOLVED'],
    to: 'REOPENED',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
  /** By a reviewer, or automatically 14 days after resolution (approved policy). */
  close: {
    from: ['RESOLVED'],
    to: 'CLOSED',
    actors: ['org_reviewer', 'system'],
    requiresReason: false,
  },
  // ─── Duplicates (Phase 8, PRD §6.3) ──────────────────────────────────────────
  /**
   * Approved policy: from SUBMITTED up to ACCEPTED, always with a link to the original
   * (enforced in the database) and a reason. DUPLICATE is final.
   */
  markDuplicate: {
    from: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'ACCEPTED'],
    to: 'DUPLICATE',
    actors: ['org_reviewer'],
    requiresReason: true,
  },
} as const satisfies Record<string, TransitionRule>;

export type TransitionName = keyof typeof TRANSITIONS;

export function canTransition(
  name: TransitionName,
  current: ReportStatus,
  actor: TransitionActor,
): boolean {
  const rule: TransitionRule = TRANSITIONS[name];
  return rule.from.includes(current) && rule.actors.includes(actor);
}

/** Statuses in which the reporting citizen may still edit the report (approved policy). */
export const EDITABLE_STATUSES: ReadonlySet<ReportStatus> = new Set(['SUBMITTED']);
