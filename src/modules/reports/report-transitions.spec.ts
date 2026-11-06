import { REPORT_STATUSES } from './reports.schemas';
import {
  canTransition,
  EDITABLE_STATUSES,
  TRANSITIONS,
  type TransitionActor,
  type TransitionName,
} from './report-transitions';

const ACTORS: TransitionActor[] = [
  'owner',
  'super_admin',
  'org_reviewer',
  'assigned_worker',
  'system',
];

/** The approved policy, written out independently of the rule table it checks. */
const EXPECTED: Record<TransitionName, { from: string[]; actors: TransitionActor[]; to: string }> =
  {
    withdraw: { from: ['SUBMITTED', 'NEEDS_INFORMATION'], actors: ['owner'], to: 'WITHDRAWN' },
    startReview: { from: ['SUBMITTED'], actors: ['org_reviewer'], to: 'UNDER_REVIEW' },
    requestInformation: {
      from: ['UNDER_REVIEW'],
      actors: ['org_reviewer'],
      to: 'NEEDS_INFORMATION',
    },
    provideInformation: { from: ['NEEDS_INFORMATION'], actors: ['owner'], to: 'UNDER_REVIEW' },
    accept: { from: ['UNDER_REVIEW'], actors: ['org_reviewer'], to: 'ACCEPTED' },
    reject: { from: ['UNDER_REVIEW'], actors: ['org_reviewer'], to: 'REJECTED' },
    transfer: {
      from: ['SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'ACCEPTED'],
      actors: ['org_reviewer'],
      to: 'SUBMITTED',
    },
    assign: { from: ['ACCEPTED', 'REOPENED'], actors: ['org_reviewer'], to: 'ASSIGNED' },
    reassign: { from: ['ASSIGNED', 'IN_PROGRESS'], actors: ['org_reviewer'], to: 'ASSIGNED' },
    releaseAssignment: {
      from: ['ASSIGNED', 'IN_PROGRESS'],
      actors: ['assigned_worker', 'org_reviewer', 'system'],
      to: 'ACCEPTED',
    },
    startWork: { from: ['ASSIGNED'], actors: ['assigned_worker'], to: 'IN_PROGRESS' },
    completeWork: { from: ['IN_PROGRESS'], actors: ['assigned_worker'], to: 'WORK_COMPLETED' },
    submitForVerification: {
      from: ['WORK_COMPLETED'],
      actors: ['system'],
      to: 'PENDING_VERIFICATION',
    },
    approveWork: { from: ['PENDING_VERIFICATION'], actors: ['org_reviewer'], to: 'RESOLVED' },
    rejectWork: { from: ['PENDING_VERIFICATION'], actors: ['org_reviewer'], to: 'IN_PROGRESS' },
    reopen: { from: ['RESOLVED'], actors: ['org_reviewer'], to: 'REOPENED' },
    close: { from: ['RESOLVED'], actors: ['org_reviewer', 'system'], to: 'CLOSED' },
  };

describe('report transition rules', () => {
  it('has exactly the approved transitions', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  // Exhaustive: every transition × every status × every actor.
  const cases = (Object.keys(EXPECTED) as TransitionName[]).flatMap((name) =>
    REPORT_STATUSES.flatMap((status) => ACTORS.map((actor) => [name, status, actor] as const)),
  );
  it.each(cases)('%s from %s by %s follows the approved policy', (name, status, actor) => {
    const rule = EXPECTED[name];
    const expected = rule.actors.includes(actor) && rule.from.includes(status);
    expect(canTransition(name, status, actor)).toBe(expected);
    expect(TRANSITIONS[name].to).toBe(rule.to);
  });

  it('never lets a citizen resolve, accept or reject a report', () => {
    for (const rule of Object.values(TRANSITIONS)) {
      if ((rule.actors as readonly TransitionActor[]).includes('owner')) {
        expect(['RESOLVED', 'ACCEPTED', 'REJECTED', 'CLOSED']).not.toContain(rule.to);
      }
    }
  });

  it('never lets a worker verify work or resolve a report', () => {
    for (const rule of Object.values(TRANSITIONS)) {
      if ((rule.actors as readonly TransitionActor[]).includes('assigned_worker')) {
        expect(['RESOLVED', 'CLOSED', 'PENDING_VERIFICATION']).not.toContain(rule.to);
      }
    }
  });

  it('never moves a rejected or withdrawn report anywhere', () => {
    for (const rule of Object.values(TRANSITIONS)) {
      expect(rule.from).not.toContain('REJECTED');
      expect(rule.from).not.toContain('WITHDRAWN');
    }
  });

  it('allows citizen edits only while SUBMITTED', () => {
    expect([...EDITABLE_STATUSES]).toEqual(['SUBMITTED']);
  });
});
