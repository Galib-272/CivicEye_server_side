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
 * other way to change a report's status. Phase 6 adds the assignment and verification rules.
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
