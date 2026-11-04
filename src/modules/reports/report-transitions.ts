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
 * other way to change a report's status. Phases 5–6 add the review, assignment and
 * verification rules here once their policies are approved.
 */
export const TRANSITIONS = {
  withdraw: {
    // Approved policy: immediate withdrawal while SUBMITTED or NEEDS_INFORMATION only.
    from: ['SUBMITTED', 'NEEDS_INFORMATION'],
    to: 'WITHDRAWN',
    actors: ['owner'],
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
